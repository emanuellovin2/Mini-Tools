/**
 * Agent step — a role-driven LLM agent with tools, knowledge, instructions,
 * and a hard cost/iteration ceiling.
 *
 * Design invariants:
 *   - ONE iteration per executor invocation (never a long-running function).
 *   - State (messages, spent_cents, iteration) is stored as the output of the
 *     virtual iteration run_step row (`<step_key>:iter:<N>`), so crashes resume
 *     from the last completed checkpoint with zero duplicate side effects.
 *   - ALL LLM calls go through the gateway reserve→call→settle pattern.
 *   - Budget and loop guards are checked BEFORE each LLM call.
 *
 * Virtual iteration keys
 * ──────────────────────
 * The graph stores one `agent` step definition (e.g. "researcher").  The
 * executor's next_step_key cycles through:
 *   researcher:iter:0 → researcher:iter:1 → … → handoff_step
 * resolveAgentStepKey() in the executor maps virtual → base step.
 *
 * Config shape (stored in workflow_versions.graph):
 * {
 *   role, system_prompt?, instruction_set_id?, knowledge_base_ids?,
 *   tools: ToolRef[], model, max_iterations, budget_cents,
 *   output_schema?, handoff, provider?, provider_key_id?
 * }
 */

import { createAdminClient } from "@/lib/services/supabase";
import { decryptSecret, type EncryptedSecret } from "@/lib/gateway/crypto";
import { expandTemplate } from "./transform";
import { runConnectorStep } from "./connector";
import { runHttpStep } from "./http";
import { checkBudget, estimateCents } from "@/lib/workflows/agent/budget";
import { checkIterationCap, detectNoProgress, hashArgs } from "@/lib/workflows/agent/loop";
import { truncateScratchpad, emptyState, type AgentState, type ChatMessage } from "@/lib/workflows/agent/scratchpad";
import { validateHandoff, type JsonSchema } from "@/lib/workflows/agent/handoff";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdmin = any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolRef =
  | { type: "connector"; connector_id: string; account_id: string; actions: string[] }
  | { type: "http"; label: string; url?: string; method?: string }
  | { type: "knowledge.retrieve"; base_ids: string[] }
  | { type: "sub_workflow"; workflow_id: string };

export interface AgentStepConfig {
  role: string;
  /** Provider key from vault; falls back to deployment effective config */
  provider_key_id?: string | null;
  provider?: "openai" | "anthropic" | "openai_compat";
  model: string;
  /** Resolved via #56 getEffectiveInstructions; else falls back to system_prompt */
  instruction_set_id?: string | null;
  system_prompt?: string | null;
  knowledge_base_ids?: string[] | null;
  tools: ToolRef[];
  max_iterations: number;
  budget_cents: number;
  /** Optional per-step usage meter (enables reserve→settle credit wallet pattern) */
  meter_id?: string | null;
  output_schema?: JsonSchema;
  /** next_step_key to advance to after this agent finishes */
  handoff: string;
}

export interface AgentInput {
  /** Accumulated outputs from prior steps, keyed by step_key */
  context: Record<string, unknown>;
  /** Deployment-level provider key (fallback from effective config) */
  deploymentProviderKeyId?: string | null;
  ownerOrgId: string;
  buyerId: string;
  runId: string;
  /** Base step_key (e.g. "researcher"), not the virtual key */
  stepKey: string;
  /** 0-based iteration index, parsed from virtual key */
  iterationIndex: number;
  deploymentId?: string | null;
  clientOrgId?: string | null;
  /** Depth from root workflow run (bounds sub-workflow recursion) */
  subworkflowDepth?: number;
}

export interface AgentIterationResult {
  output: AgentState;
  /** When true, caller should advance to the next iteration virtual key */
  continuing: boolean;
  /** When !continuing, this is the final handoff payload (validated) */
  handoffPayload?: unknown;
  /** next_step_key for the executor */
  nextStepKeyOverride: string;
}

const MAX_TOKENS_DEFAULT = 2048;
const OPENAI_BASE = "https://api.openai.com/v1";
const ANTHROPIC_BASE = "https://api.anthropic.com/v1";
const NO_PROGRESS_REPEAT_LIMIT = 3;

// ---------------------------------------------------------------------------
// Provider key resolution
// ---------------------------------------------------------------------------

async function resolveKey(keyId: string): Promise<string> {
  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin
    .from("provider_keys")
    .select("ciphertext, dek_wrapped, key_version")
    .eq("id", keyId)
    .single();
  if (error || !data) throw new Error(`agent step: provider key ${keyId} not found`);
  return decryptSecret(data as EncryptedSecret);
}

// ---------------------------------------------------------------------------
// LLM call helpers (OpenAI function-calling format)
// ---------------------------------------------------------------------------

type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type LLMResponse =
  | { type: "text"; content: string; input_tokens: number; output_tokens: number }
  | {
      type: "tool_call";
      tool_call_id: string;
      name: string;
      args: unknown;
      input_tokens: number;
      output_tokens: number;
    };

async function callOpenAIWithTools(args: {
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxTokens: number;
  apiKey: string;
  baseUrl?: string;
}): Promise<LLMResponse> {
  const messages = args.messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool" as const,
        tool_call_id: m.tool_result?.tool_call_id ?? "tc_unknown",
        content: typeof m.tool_result?.result === "string"
          ? m.tool_result.result
          : JSON.stringify(m.tool_result?.result ?? ""),
      };
    }
    if (m.role === "assistant" && m.tool_call) {
      return {
        role: "assistant" as const,
        content: m.content || null,
        tool_calls: [
          {
            id: m.tool_call.id ?? "tc_0",
            type: "function",
            function: {
              name: m.tool_call.name,
              arguments: JSON.stringify(m.tool_call.args ?? {}),
            },
          },
        ],
      };
    }
    return { role: m.role as "system" | "user" | "assistant", content: m.content };
  });

  const body: Record<string, unknown> = {
    model: args.model,
    messages,
    max_tokens: args.maxTokens,
  };
  if (args.tools.length > 0) {
    body.tools = args.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  const res = await fetch(`${args.baseUrl ?? OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${args.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`agent step: OpenAI error ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as {
    choices: Array<{
      message: {
        content?: string | null;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
    }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  const msg = json.choices[0]?.message;
  const input_tokens = json.usage?.prompt_tokens ?? 0;
  const output_tokens = json.usage?.completion_tokens ?? 0;

  if (msg?.tool_calls?.[0]) {
    const tc = msg.tool_calls[0];
    let parsedArgs: unknown = {};
    try { parsedArgs = JSON.parse(tc.function.arguments); } catch { parsedArgs = {}; }
    return { type: "tool_call", tool_call_id: tc.id, name: tc.function.name, args: parsedArgs, input_tokens, output_tokens };
  }

  return { type: "text", content: msg?.content ?? "", input_tokens, output_tokens };
}

async function callAnthropicWithTools(args: {
  model: string;
  messages: ChatMessage[];
  systemPrompt: string | null | undefined;
  tools: ToolDefinition[];
  maxTokens: number;
  apiKey: string;
}): Promise<LLMResponse> {
  const msgs = args.messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "tool") {
        return {
          role: "user" as const,
          content: [
            {
              type: "tool_result",
              tool_use_id: m.tool_result?.tool_call_id ?? "tu_0",
              content: typeof m.tool_result?.result === "string"
                ? m.tool_result.result
                : JSON.stringify(m.tool_result?.result ?? ""),
            },
          ],
        };
      }
      if (m.role === "assistant" && m.tool_call) {
        return {
          role: "assistant" as const,
          content: [
            {
              type: "tool_use",
              id: m.tool_call.id ?? "tu_0",
              name: m.tool_call.name,
              input: m.tool_call.args ?? {},
            },
          ],
        };
      }
      return { role: m.role as "user" | "assistant", content: m.content };
    });

  const body: Record<string, unknown> = {
    model: args.model,
    max_tokens: args.maxTokens,
    messages: msgs,
  };
  if (args.systemPrompt) body.system = args.systemPrompt;
  if (args.tools.length > 0) {
    body.tools = args.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  const res = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": args.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`agent step: Anthropic error ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as {
    content: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: unknown }
    >;
    usage?: { input_tokens: number; output_tokens: number };
  };

  const input_tokens = json.usage?.input_tokens ?? 0;
  const output_tokens = json.usage?.output_tokens ?? 0;

  const toolUse = json.content.find((b) => b.type === "tool_use") as
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | undefined;

  if (toolUse) {
    return { type: "tool_call", tool_call_id: toolUse.id, name: toolUse.name, args: toolUse.input, input_tokens, output_tokens };
  }

  const textBlock = json.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
  return { type: "text", content: textBlock?.text ?? "", input_tokens, output_tokens };
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeTool(
  toolRef: ToolRef,
  args: Record<string, unknown>,
  input: AgentInput,
  apiKey: string
): Promise<unknown> {
  switch (toolRef.type) {
    case "connector": {
      const action = (args.action as string | undefined) ?? toolRef.actions[0] ?? "";
      return runConnectorStep(
        {
          connector_id: toolRef.connector_id,
          action,
          account_id: toolRef.account_id,
          input_mapping: args,
        },
        {
          context: input.context,
          ownerOrgId: input.ownerOrgId,
          buyerId: input.buyerId,
          runId: input.runId,
          stepKey: input.stepKey,
        }
      );
    }

    case "http": {
      return runHttpStep(
        {
          url: (args.url as string | undefined) ?? toolRef.url ?? "",
          method: ((args.method as string | undefined) ?? toolRef.method ?? "GET") as
            | "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
          headers: args.headers as Record<string, string> | undefined,
          body_template: args.body as string | undefined,
        },
        { context: input.context }
      );
    }

    case "knowledge.retrieve": {
      if (process.env.KNOWLEDGE_ENABLED !== "true") {
        return { results: [] };
      }
      const { retrieve } = await import("@/lib/services/knowledge");
      const query = (args.query as string | undefined) ?? "";
      const chunks = await retrieve({
        orgId: input.ownerOrgId,
        baseIds: toolRef.base_ids,
        query,
        topK: (args.top_k as number | undefined) ?? 5,
        plaintextApiKey: apiKey,
      });
      return { results: chunks.map((c) => ({ content: c.content, score: c.score })) };
    }

    case "sub_workflow": {
      const maxDepth = parseInt(
        process.env.AGENT_MAX_SUBWORKFLOW_DEPTH ?? "3",
        10
      );
      const depth = input.subworkflowDepth ?? 0;
      if (depth >= maxDepth) {
        throw new Error(
          `agent step: sub-workflow recursion depth ${depth} >= max ${maxDepth}`
        );
      }
      const { enqueueRun } = await import("@/lib/services/workflows");
      const { runId: subRunId } = await enqueueRun(
        toolRef.workflow_id,
        { ...(args as Record<string, unknown>), _parent_run_id: input.runId, _depth: depth + 1 },
        `subwf:${input.runId}:${toolRef.workflow_id}:${Date.now()}`
      );
      return { sub_run_id: subRunId, status: "enqueued" };
    }

    default:
      throw new Error(`agent step: unknown tool type "${(toolRef as ToolRef).type}"`);
  }
}

// ---------------------------------------------------------------------------
// Tool catalog builder
// ---------------------------------------------------------------------------

function buildToolDefinitions(tools: ToolRef[]): ToolDefinition[] {
  return tools.map((t) => {
    switch (t.type) {
      case "connector":
        return {
          name: `connector_${t.connector_id}`,
          description: `Execute an action via the ${t.connector_id} connector. Available actions: ${t.actions.join(", ")}`,
          parameters: {
            type: "object",
            properties: {
              action: { type: "string", enum: t.actions, description: "Action to execute" },
            },
            required: ["action"],
          },
        };
      case "http":
        return {
          name: t.label.replace(/[^a-zA-Z0-9_-]/g, "_"),
          description: `Make an HTTP request to ${t.url ?? "a configured endpoint"}`,
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "Target URL" },
              method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
              body: { type: "string", description: "Request body (JSON string)" },
            },
            required: [],
          },
        };
      case "knowledge.retrieve":
        return {
          name: "knowledge_retrieve",
          description: "Retrieve relevant context chunks from the knowledge base",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
              top_k: { type: "number", description: "Number of results (default 5)" },
            },
            required: ["query"],
          },
        };
      case "sub_workflow":
        return {
          name: `run_workflow_${t.workflow_id.slice(0, 8)}`,
          description: `Trigger sub-workflow ${t.workflow_id}`,
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        };
    }
  });
}

// ---------------------------------------------------------------------------
// Reserve/settle helpers (gateway credit pattern)
// ---------------------------------------------------------------------------

async function reserveCredits(
  admin: AnyAdmin,
  buyerId: string,
  meterId: string | null,
  estimatedCents: number,
  idempotencyKey: string
): Promise<{ reservationId: string | null; blocked: boolean }> {
  if (!meterId) return { reservationId: null, blocked: false };

  const { data, error } = await admin.rpc("reserve_credits", {
    p_buyer_id: buyerId,
    p_meter_id: meterId,
    p_estimated_cents: estimatedCents,
    p_idempotency_key: idempotencyKey,
  });

  if (error) throw new Error(`agent step reserve_credits: ${error.message}`);

  const result = data as { ok: boolean; blocked?: boolean; reservation_id?: string };
  if (!result.ok || result.blocked) return { reservationId: null, blocked: true };
  return { reservationId: result.reservation_id ?? null, blocked: false };
}

async function settleCredits(
  admin: AnyAdmin,
  reservationId: string | null,
  actualCents: number
): Promise<void> {
  if (!reservationId) return;
  await admin
    .from("gateway_reservations")
    .update({ status: "settled", settled_cents: actualCents })
    .eq("id", reservationId);
}

async function releaseCredits(
  admin: AnyAdmin,
  reservationId: string | null
): Promise<void> {
  if (!reservationId) return;
  await admin.rpc("release_reservation", { p_reservation_id: reservationId });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run one iteration of the agent step.
 * Called by the executor for each claimed invocation of this step.
 */
export async function runAgentStep(
  config: AgentStepConfig,
  input: AgentInput
): Promise<AgentIterationResult> {
  if (!config.model) throw new Error("agent step: model is required");
  if (!config.handoff) throw new Error("agent step: handoff is required");
  if (typeof config.budget_cents !== "number" || config.budget_cents <= 0) {
    throw new Error("agent step: budget_cents must be a positive number");
  }
  if (typeof config.max_iterations !== "number" || config.max_iterations <= 0) {
    throw new Error("agent step: max_iterations must be a positive number");
  }

  const admin = createAdminClient() as AnyAdmin;

  // 1. Resolve provider key
  const keyId = config.provider_key_id ?? input.deploymentProviderKeyId;
  if (!keyId) {
    throw new Error("agent step: no provider_key_id in step config or deployment — BYOK required");
  }
  const apiKey = await resolveKey(keyId);

  // 2. Load scratchpad from previous iteration (if any)
  const prevIterKey =
    input.iterationIndex > 0
      ? `${input.stepKey}:iter:${input.iterationIndex - 1}`
      : null;

  let state: AgentState = emptyState();
  if (prevIterKey && input.context[prevIterKey]) {
    const prev = input.context[prevIterKey] as Partial<AgentState>;
    state = {
      messages: prev.messages ?? [],
      iteration: prev.iteration ?? input.iterationIndex,
      spent_cents: prev.spent_cents ?? 0,
      tool_call_history: prev.tool_call_history ?? [],
    };
  }

  const maxRunBudgetCents = parseInt(
    process.env.AGENT_MAX_RUN_BUDGET_CENTS ?? "500",
    10
  );
  const globalIterCap = parseInt(
    process.env.AGENT_MAX_ITERATIONS_CAP ?? "12",
    10
  );

  // 3. Iteration cap check (before LLM call)
  const iterCheck = checkIterationCap(input.iterationIndex, config.max_iterations, globalIterCap);
  if (iterCheck.exceeded) {
    // Return whatever we have as the best-effort handoff
    const bestEffort = state.messages.length > 0
      ? state.messages[state.messages.length - 1]?.content ?? ""
      : "";
    const payload = { result: bestEffort, reason: iterCheck.reason };
    validateHandoff(payload, config.output_schema);
    return {
      output: { ...state, iteration: input.iterationIndex },
      continuing: false,
      handoffPayload: payload,
      nextStepKeyOverride: config.handoff,
    };
  }

  // 4. Resolve system prompt (#56 instruction sets)
  let systemPrompt = config.system_prompt ?? null;
  if (process.env.INSTRUCTION_SETS_ENABLED === "true" && input.deploymentId) {
    try {
      const { getEffectiveInstructions } = await import("@/lib/services/instructions");
      const instrResult = await getEffectiveInstructions({
        orgId: input.ownerOrgId,
        clientOrgId: input.clientOrgId ?? undefined,
        deploymentId: input.deploymentId,
      });
      if (instrResult.systemPrompt) systemPrompt = instrResult.systemPrompt;
    } catch (err) {
      console.error(JSON.stringify({ event: "agent_step.instruction_resolution_error", error: String(err) }));
    }
  }

  // Inject role and knowledge into system prompt on first iteration
  if (input.iterationIndex === 0) {
    const rolePrefix = `You are the ${config.role}. `;
    systemPrompt = systemPrompt ? `${rolePrefix}${systemPrompt}` : rolePrefix.trim();

    if (process.env.KNOWLEDGE_ENABLED === "true" && config.knowledge_base_ids?.length) {
      try {
        const { retrieve } = await import("@/lib/services/knowledge");
        const lastUserMsg = state.messages.filter((m) => m.role === "user").slice(-1)[0]?.content ?? "";
        if (lastUserMsg) {
          const chunks = await retrieve({
            orgId: input.ownerOrgId,
            baseIds: config.knowledge_base_ids,
            query: lastUserMsg,
            topK: 5,
            plaintextApiKey: apiKey,
          });
          if (chunks.length > 0) {
            const ctx = chunks.map((c) => c.content).join("\n\n---\n\n");
            systemPrompt = systemPrompt
              ? `${systemPrompt}\n\nRelevant knowledge:\n\n${ctx}`
              : `Relevant knowledge:\n\n${ctx}`;
          }
        }
      } catch (err) {
        console.error(JSON.stringify({ event: "agent_step.knowledge_injection_error", error: String(err) }));
      }
    }

    // Seed system message
    const messages: ChatMessage[] = [{ role: "system", content: systemPrompt ?? "" }];
    // Re-inject any input from the run context (trigger payload)
    const trigger = input.context.trigger;
    if (trigger) {
      messages.push({
        role: "user",
        content: `Input: ${typeof trigger === "string" ? trigger : JSON.stringify(trigger)}`,
      });
    }
    state = { ...state, messages: [...messages, ...state.messages.filter((m) => m.role !== "system")] };
  }

  // 5. Budget check
  const maxTokens = MAX_TOKENS_DEFAULT;
  const estimated = estimateCents(config.model, maxTokens);
  const budgetCheck = checkBudget({
    spentCents: state.spent_cents,
    stepBudgetCents: config.budget_cents,
    estimatedCents: estimated,
    maxRunBudgetCents,
  });
  if (!budgetCheck.allowed) {
    throw new Error(`agent step: budget exhausted — ${budgetCheck.reason}`);
  }

  // 6. Reserve credits against wallet when meter_id is configured (gateway pattern)
  const reserveKey = `agent_iter:${input.runId}:${input.stepKey}:${input.iterationIndex}`;
  const { reservationId, blocked } = await reserveCredits(
    admin,
    input.buyerId,
    config.meter_id ?? null,
    estimated,
    reserveKey
  );
  if (blocked) {
    throw new Error("agent step: insufficient credits for this iteration");
  }

  // 7. Build tool definitions (least privilege — only declared tools)
  const toolDefs = buildToolDefinitions(config.tools);

  // 8. ONE LLM call
  let llmResponse: LLMResponse;
  const isAnthropic = (config.provider ?? "openai") === "anthropic";

  try {
    if (isAnthropic) {
      llmResponse = await callAnthropicWithTools({
        model: config.model,
        messages: state.messages,
        systemPrompt,
        tools: toolDefs,
        maxTokens,
        apiKey,
      });
    } else {
      llmResponse = await callOpenAIWithTools({
        model: config.model,
        messages: state.messages,
        tools: toolDefs,
        maxTokens,
        apiKey,
      });
    }
  } catch (err) {
    await releaseCredits(admin, reservationId);
    throw err;
  }

  const actualCents = estimateCents(config.model, llmResponse.output_tokens + llmResponse.input_tokens);
  await settleCredits(admin, reservationId, actualCents);

  // Update scratchpad with the LLM's response
  const newMessages = [...state.messages];

  if (llmResponse.type === "tool_call") {
    // 9a. Tool call path — execute ONE tool, append observation, yield
    const { name: toolName, args: toolArgs, tool_call_id } = llmResponse;
    const argsHash = hashArgs(toolArgs);

    // No-progress guard
    if (detectNoProgress(state.tool_call_history, toolName, argsHash)) {
      const reason = `no-progress: tool "${toolName}" repeated with identical args ${NO_PROGRESS_REPEAT_LIMIT}+ times`;
      throw new Error(`agent step aborted — ${reason}`);
    }

    // Append assistant tool-call message
    newMessages.push({
      role: "assistant",
      content: "",
      tool_call: { id: tool_call_id, name: toolName, args: toolArgs },
    });

    // Execute the tool
    const matchedTool = config.tools.find((t) => {
      const defName = buildToolDefinitions([t])[0]?.name;
      return defName === toolName;
    });
    if (!matchedTool) throw new Error(`agent step: model requested unknown tool "${toolName}"`);

    let toolResult: unknown;
    try {
      toolResult = await executeTool(
        matchedTool,
        (toolArgs ?? {}) as Record<string, unknown>,
        input,
        apiKey
      );
    } catch (toolErr) {
      toolResult = { error: String(toolErr) };
    }

    // Append tool result (observation)
    newMessages.push({
      role: "tool",
      content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
      tool_result: { tool_call_id, name: toolName, result: toolResult },
    });

    const newState: AgentState = truncateScratchpad({
      messages: newMessages,
      iteration: input.iterationIndex + 1,
      spent_cents: state.spent_cents + actualCents,
      tool_call_history: [
        ...state.tool_call_history,
        { tool: toolName, argsHash },
      ],
    });

    return {
      output: newState,
      continuing: true,
      nextStepKeyOverride: `${input.stepKey}:iter:${input.iterationIndex + 1}`,
    };
  } else {
    // 9b. Final answer — validate handoff schema and return
    const finalContent = llmResponse.content;

    newMessages.push({ role: "assistant", content: finalContent });

    const newState: AgentState = {
      messages: newMessages,
      iteration: input.iterationIndex + 1,
      spent_cents: state.spent_cents + actualCents,
      tool_call_history: state.tool_call_history,
    };

    // Parse structured output if schema declared
    let handoffPayload: unknown = { result: finalContent };
    if (config.output_schema) {
      try {
        // Attempt to extract JSON from the response
        const jsonMatch = finalContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          handoffPayload = JSON.parse(jsonMatch[0]);
        }
      } catch {
        handoffPayload = { result: finalContent };
      }
    }

    validateHandoff(handoffPayload, config.output_schema);

    return {
      output: newState,
      continuing: false,
      handoffPayload,
      nextStepKeyOverride: config.handoff,
    };
  }
}
