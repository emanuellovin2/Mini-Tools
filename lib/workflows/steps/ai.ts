/**
 * AI step — calls the configured provider via the owner's BYOK key (gateway vault).
 *
 * Per #41 requirement: AI steps route through the BYOK key from the vault;
 * platform pays zero compute cost. Usage is billed via recordUsage().
 *
 * Config:
 *   {
 *     "provider": "openai",          // openai | anthropic | openai_compat
 *     "model": "gpt-4o",
 *     "system_prompt": "You are...", // optional; prepended
 *     "user_template": "{{context.step_key.field}}", // expanded before call
 *     "provider_key_id": "uuid",     // optional explicit key override
 *     "max_tokens": 1024,
 *     "meter_id": "uuid"             // optional per-step metering (in addition to per-run)
 *   }
 *
 * Key resolution: step config `provider_key_id` → deployment effective config
 * `byok_provider_key_id` / `agency_provider_key_id` → error (BYOK required).
 */

import { createAdminClient } from "@/lib/services/supabase";
import { decryptSecret, type EncryptedSecret } from "@/lib/gateway/crypto";
import { expandTemplate } from "./transform";
import { recordUsage } from "@/lib/services/usage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdmin = any;

export interface AiConfig {
  provider: "openai" | "anthropic" | "openai_compat";
  model: string;
  system_prompt?: string | null;
  user_template: string;
  provider_key_id?: string | null;
  max_tokens?: number;
  meter_id?: string | null;
  /** #55 — knowledge base IDs to retrieve context from before the call */
  knowledge_base_ids?: string[] | null;
  /** #56 — when set, resolve system prompt via instruction sets instead of static system_prompt */
  instruction_set_id?: string | null;
}

export interface AiInput {
  context: Record<string, unknown>;
  /** Deployment-level provider key ID (from effective config, fallback). */
  deploymentProviderKeyId?: string | null;
  /** Org that owns the workflow (for usage metering). */
  ownerOrgId: string;
  /** Buyer ID for usage metering. */
  buyerId: string;
  /** Run ID for idempotency key on usage record. */
  runId: string;
  /** Step key for idempotency key. */
  stepKey: string;
  /** #56 — deployment ID for instruction set resolution. */
  deploymentId?: string | null;
  /** #56 — client org ID for instruction set resolution. */
  clientOrgId?: string | null;
}

export interface AiOutput {
  content: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

const OPENAI_BASE = "https://api.openai.com/v1";
const ANTHROPIC_BASE = "https://api.anthropic.com/v1";
const MAX_TOKENS_CAP = 8192;

async function resolveProviderKey(keyId: string): Promise<string> {
  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin
    .from("provider_keys")
    .select("ciphertext, dek_wrapped, key_version")
    .eq("id", keyId)
    .single();
  if (error || !data) throw new Error(`ai step: provider key ${keyId} not found`);
  return decryptSecret(data as EncryptedSecret);
}

async function callOpenAI(args: {
  model: string;
  systemPrompt: string | null | undefined;
  userMessage: string;
  maxTokens: number;
  apiKey: string;
  baseUrl?: string;
}): Promise<{ content: string; input_tokens: number; output_tokens: number }> {
  const messages: Array<{ role: string; content: string }> = [];
  if (args.systemPrompt) messages.push({ role: "system", content: args.systemPrompt });
  messages.push({ role: "user", content: args.userMessage });

  const res = await fetch(`${args.baseUrl ?? OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify({ model: args.model, messages, max_tokens: args.maxTokens }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ai step: OpenAI error ${res.status}: ${errText}`);
  }

  const json = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    content: json.choices[0]?.message?.content ?? "",
    input_tokens: json.usage?.prompt_tokens ?? 0,
    output_tokens: json.usage?.completion_tokens ?? 0,
  };
}

async function callAnthropic(args: {
  model: string;
  systemPrompt: string | null | undefined;
  userMessage: string;
  maxTokens: number;
  apiKey: string;
}): Promise<{ content: string; input_tokens: number; output_tokens: number }> {
  const body: Record<string, unknown> = {
    model: args.model,
    max_tokens: args.maxTokens,
    messages: [{ role: "user", content: args.userMessage }],
  };
  if (args.systemPrompt) body.system = args.systemPrompt;

  const res = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": args.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ai step: Anthropic error ${res.status}: ${errText}`);
  }

  const json = (await res.json()) as {
    content: Array<{ type: string; text: string }>;
    usage?: { input_tokens: number; output_tokens: number };
  };

  const text = json.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return {
    content: text,
    input_tokens: json.usage?.input_tokens ?? 0,
    output_tokens: json.usage?.output_tokens ?? 0,
  };
}

export async function runAiStep(config: AiConfig, input: AiInput): Promise<AiOutput> {
  if (!config.provider) throw new Error("ai step: config.provider is required");
  if (!config.model) throw new Error("ai step: config.model is required");
  if (!config.user_template) throw new Error("ai step: config.user_template is required");

  // Resolve provider key: explicit step key > deployment effective config key
  const keyId = config.provider_key_id ?? input.deploymentProviderKeyId;
  if (!keyId) {
    throw new Error(
      "ai step: no provider_key_id in step config or deployment — BYOK key required"
    );
  }

  const apiKey = await resolveProviderKey(keyId);
  const userMessage = expandTemplate(config.user_template, input.context);
  const maxTokens = Math.min(config.max_tokens ?? 1024, MAX_TOKENS_CAP);

  // #56 — instruction set resolution (gated by INSTRUCTION_SETS_ENABLED)
  let resolvedSystemPrompt = config.system_prompt;
  if (process.env.INSTRUCTION_SETS_ENABLED === "true" && input.deploymentId) {
    try {
      const { getEffectiveInstructions } = await import("@/lib/services/instructions");
      const instrResult = await getEffectiveInstructions({
        orgId: input.ownerOrgId,
        clientOrgId: input.clientOrgId ?? undefined,
        deploymentId: input.deploymentId,
      });
      if (instrResult.systemPrompt) resolvedSystemPrompt = instrResult.systemPrompt;
    } catch (err) {
      console.error(JSON.stringify({ event: "ai_step.instruction_resolution_error", error: String(err) }));
    }
  }

  // #55 — knowledge retrieval injection (gated by KNOWLEDGE_ENABLED)
  if (process.env.KNOWLEDGE_ENABLED === "true" && config.knowledge_base_ids?.length) {
    try {
      const { retrieve } = await import("@/lib/services/knowledge");
      const chunks = await retrieve({
        orgId: input.ownerOrgId,
        baseIds: config.knowledge_base_ids,
        query: userMessage,
        topK: 5,
        plaintextApiKey: apiKey,
      });
      if (chunks.length > 0) {
        const context = chunks.map((c) => c.content).join("\n\n---\n\n");
        const header = "Relevant context from the knowledge base:\n\n";
        resolvedSystemPrompt = resolvedSystemPrompt
          ? `${resolvedSystemPrompt}\n\n${header}${context}`
          : `${header}${context}`;
      }
    } catch (err) {
      // Non-fatal — continue without knowledge context
      console.error(JSON.stringify({ event: "ai_step.knowledge_retrieval_error", error: String(err) }));
    }
  }

  let result: { content: string; input_tokens: number; output_tokens: number };

  if (config.provider === "anthropic") {
    result = await callAnthropic({
      model: config.model,
      systemPrompt: resolvedSystemPrompt,
      userMessage,
      maxTokens,
      apiKey,
    });
  } else {
    // openai + openai_compat
    result = await callOpenAI({
      model: config.model,
      systemPrompt: resolvedSystemPrompt,
      userMessage,
      maxTokens,
      apiKey,
    });
  }

  const totalTokens = result.input_tokens + result.output_tokens;

  // Per-step usage metering (in addition to per-run orchestration fee)
  if (config.meter_id && totalTokens > 0) {
    await recordUsage({
      meterId: config.meter_id,
      buyerId: input.buyerId,
      quantity: totalTokens,
      idempotencyKey: `workflow_ai_step:${input.runId}:${input.stepKey}`,
      actorOrgId: input.ownerOrgId,
    }).catch((err) => {
      // Non-fatal — step result is preserved; usage miss is recoverable via reconciliation
      console.error(
        JSON.stringify({ event: "workflow.ai_step.usage_record_failed", error: String(err) })
      );
    });
  }

  return {
    content: result.content,
    model: config.model,
    input_tokens: result.input_tokens,
    output_tokens: result.output_tokens,
    total_tokens: totalTokens,
  };
}
