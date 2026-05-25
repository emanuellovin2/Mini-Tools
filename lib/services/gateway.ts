/**
 * AI Gateway service layer — provider key vault, token management, usage logging.
 *
 * Privacy invariants:
 *   - Plaintext keys NEVER leave the server (never returned, never logged).
 *   - Call metadata only is logged (no prompt/response bodies).
 *   - Vendor sees only anon_user_id, never buyer PII (SPEC §6/§13).
 */
import { nanoid } from "nanoid";
import { createAdminClient } from "@/lib/services/supabase";
import { writeAuditLog } from "@/lib/services/admin";
import { enforceQuota } from "@/lib/quotas/enforce";
import { checkRateLimit } from "@/lib/utils/rate-limit";
import { encryptSecret, decryptSecret, type EncryptedSecret } from "@/lib/gateway/crypto";
import { getAdapter, type ProviderName } from "@/lib/gateway/providers";
import { getEffectiveConfig } from "@/lib/services/deployments";
import { getEffectiveInstructions } from "@/lib/services/instructions";
import { recordUsage } from "@/lib/services/usage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdmin = any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderKey {
  id: string;
  owner_id: string;
  provider: ProviderName;
  label: string;
  last4: string;
  key_version: number;
  created_at: string;
}

export interface GatewayProduct {
  id: string;
  solution_id: string;
  meter_id: string;
  provider: ProviderName;
  model: string;
  system_prompt: string | null;
  cost_mode: "byok" | "managed";
  max_tokens_cap: number;
  default_key_id: string | null;
  created_at: string;
}

export interface GatewayToken {
  id: string;
  owner_id: string;
  product_id: string;
  label: string;
  prefix: string;
  spend_cap_cents_daily: number | null;
  spend_cap_cents_monthly: number | null;
  spent_today_cents: number;
  spent_month_cents: number;
  paused_at: string | null;
  paused_reason: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Provider key vault
// ---------------------------------------------------------------------------

/**
 * Encrypt and store a provider API key. Returns metadata only — plaintext is discarded.
 */
export async function storeProviderKey(args: {
  ownerOrgId: string;
  provider: ProviderName;
  label: string;
  plaintext: string;
  actorUserId: string;
  actorOrgId: string;
}): Promise<ProviderKey> {
  await enforceQuota(args.ownerOrgId, "provider_keys");

  const sealed = await encryptSecret(args.plaintext);
  const last4 = args.plaintext.slice(-4);

  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin
    .from("provider_keys")
    .insert({
      owner_id: args.ownerOrgId,
      provider: args.provider,
      label: args.label,
      ciphertext: sealed.ciphertext,
      dek_wrapped: sealed.dek_wrapped,
      key_version: sealed.key_version,
      last4,
    })
    .select("id, owner_id, provider, label, last4, key_version, created_at")
    .single();

  if (error) throw new Error(`storeProviderKey: ${error.message}`);

  await writeAuditLog({
    actorId: args.actorUserId,
    actorRole: "vendor",
    action: "provider_key.stored",
    entityType: "provider_key",
    entityId: data.id,
    actorOrgId: args.actorOrgId,
    metadata: { provider: args.provider, label: args.label },
  });

  return data as ProviderKey;
}

export async function listProviderKeys(ownerOrgId: string): Promise<ProviderKey[]> {
  const admin = createAdminClient() as AnyAdmin;
  // Never select ciphertext/dek_wrapped — metadata only
  const { data, error } = await admin
    .from("provider_keys")
    .select("id, owner_id, provider, label, last4, key_version, created_at")
    .eq("owner_id", ownerOrgId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listProviderKeys: ${error.message}`);
  return (data ?? []) as ProviderKey[];
}

export async function deleteProviderKey(
  id: string,
  ownerOrgId: string,
  actorUserId: string,
  actorOrgId: string
): Promise<void> {
  const admin = createAdminClient() as AnyAdmin;
  const { error } = await admin
    .from("provider_keys")
    .delete()
    .eq("id", id)
    .eq("owner_id", ownerOrgId);
  if (error) throw new Error(`deleteProviderKey: ${error.message}`);

  await writeAuditLog({
    actorId: actorUserId,
    actorRole: "vendor",
    action: "provider_key.deleted",
    entityType: "provider_key",
    entityId: id,
    actorOrgId,
  });
}

/** Internal use only — never expose result to clients. */
async function decryptProviderKey(keyId: string): Promise<string> {
  const admin = createAdminClient() as AnyAdmin;
  // Service-role client bypasses RLS to read ciphertext + dek_wrapped
  const { data, error } = await admin
    .from("provider_keys")
    .select("ciphertext, dek_wrapped, key_version")
    .eq("id", keyId)
    .single();
  if (error || !data) throw new Error(`decryptProviderKey: key ${keyId} not found`);

  return decryptSecret(data as EncryptedSecret);
}

// ---------------------------------------------------------------------------
// Gateway products
// ---------------------------------------------------------------------------

export async function createGatewayProduct(args: {
  solutionId: string;
  meterId: string;
  provider: ProviderName;
  model: string;
  systemPrompt?: string | null;
  costMode?: "byok" | "managed";
  maxTokensCap?: number;
  defaultKeyId?: string | null;
}): Promise<GatewayProduct> {
  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin
    .from("gateway_products")
    .insert({
      solution_id: args.solutionId,
      meter_id: args.meterId,
      provider: args.provider,
      model: args.model,
      system_prompt: args.systemPrompt ?? null,
      cost_mode: args.costMode ?? "byok",
      max_tokens_cap: args.maxTokensCap ?? 4096,
      default_key_id: args.defaultKeyId ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(`createGatewayProduct: ${error.message}`);
  return data as GatewayProduct;
}

export async function getGatewayProduct(productId: string): Promise<GatewayProduct | null> {
  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin
    .from("gateway_products")
    .select("*")
    .eq("id", productId)
    .maybeSingle();
  if (error) throw new Error(`getGatewayProduct: ${error.message}`);
  return data as GatewayProduct | null;
}

export async function getGatewayProductBySolution(
  solutionId: string
): Promise<GatewayProduct | null> {
  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin
    .from("gateway_products")
    .select("*")
    .eq("solution_id", solutionId)
    .maybeSingle();
  if (error) throw new Error(`getGatewayProductBySolution: ${error.message}`);
  return data as GatewayProduct | null;
}

// ---------------------------------------------------------------------------
// Gateway tokens (non-browser API access)
// ---------------------------------------------------------------------------

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Create a gateway token. The raw token is returned exactly once — store it.
 */
export async function createGatewayToken(args: {
  ownerOrgId: string;
  productId: string;
  label?: string;
  spendCapCentsDaily?: number | null;
  spendCapCentsMonthly?: number | null;
  actorUserId: string;
  actorOrgId: string;
}): Promise<{ token: GatewayToken; plaintext: string }> {
  await enforceQuota(args.ownerOrgId, "gateway_tokens");

  const prefix = `gw_${nanoid(8)}`;
  const secret = nanoid(32);
  const plaintext = `${prefix}_${secret}`;
  const hashed = await sha256Hex(plaintext);

  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin
    .from("gateway_tokens")
    .insert({
      owner_id: args.ownerOrgId,
      product_id: args.productId,
      label: args.label ?? "",
      hashed_token: hashed,
      prefix,
      spend_cap_cents_daily: args.spendCapCentsDaily ?? null,
      spend_cap_cents_monthly: args.spendCapCentsMonthly ?? null,
    })
    .select(
      "id, owner_id, product_id, label, prefix, spend_cap_cents_daily, spend_cap_cents_monthly, spent_today_cents, spent_month_cents, paused_at, paused_reason, last_used_at, revoked_at, created_at"
    )
    .single();

  if (error) throw new Error(`createGatewayToken: ${error.message}`);

  await writeAuditLog({
    actorId: args.actorUserId,
    actorRole: "vendor",
    action: "gateway_token.created",
    entityType: "gateway_token",
    entityId: data.id,
    actorOrgId: args.actorOrgId,
    metadata: { product_id: args.productId },
  });

  return { token: data as GatewayToken, plaintext };
}

export async function listGatewayTokens(ownerOrgId: string): Promise<GatewayToken[]> {
  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin
    .from("gateway_tokens")
    .select(
      "id, owner_id, product_id, label, prefix, spend_cap_cents_daily, spend_cap_cents_monthly, spent_today_cents, spent_month_cents, paused_at, paused_reason, last_used_at, revoked_at, created_at"
    )
    .eq("owner_id", ownerOrgId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listGatewayTokens: ${error.message}`);
  return (data ?? []) as GatewayToken[];
}

export async function revokeGatewayToken(
  id: string,
  ownerOrgId: string,
  actorUserId: string,
  actorOrgId: string
): Promise<void> {
  const admin = createAdminClient() as AnyAdmin;
  const { error } = await admin
    .from("gateway_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("owner_id", ownerOrgId)
    .is("revoked_at", null);
  if (error) throw new Error(`revokeGatewayToken: ${error.message}`);

  await writeAuditLog({
    actorId: actorUserId,
    actorRole: "vendor",
    action: "gateway_token.revoked",
    entityType: "gateway_token",
    entityId: id,
    actorOrgId,
  });
}

export interface ValidatedGatewayToken {
  tokenId: string;
  ownerOrgId: string;
  productId: string;
  spendCapCentsDaily: number | null;
  spendCapCentsMonthly: number | null;
  spentTodayCents: number;
  spentMonthCents: number;
}

/**
 * Verify a raw gateway token; returns null if invalid/revoked/paused.
 * Revocation takes effect immediately (hash compare on every call).
 */
export async function validateGatewayToken(
  rawToken: string
): Promise<ValidatedGatewayToken | null> {
  const hashed = await sha256Hex(rawToken);
  const admin = createAdminClient() as AnyAdmin;

  const { data, error } = await admin
    .from("gateway_tokens")
    .select(
      "id, owner_id, product_id, spend_cap_cents_daily, spend_cap_cents_monthly, spent_today_cents, spent_month_cents, spent_today_reset_at, spent_month_reset_at, paused_at, revoked_at"
    )
    .eq("hashed_token", hashed)
    .maybeSingle();

  if (error || !data || data.revoked_at || data.paused_at) return null;

  // Touch last_used_at (fire-and-forget)
  admin
    .from("gateway_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(() => {});

  return {
    tokenId: data.id,
    ownerOrgId: data.owner_id,
    productId: data.product_id,
    spendCapCentsDaily: data.spend_cap_cents_daily,
    spendCapCentsMonthly: data.spend_cap_cents_monthly,
    spentTodayCents: data.spent_today_cents,
    spentMonthCents: data.spent_month_cents,
  };
}

// ---------------------------------------------------------------------------
// Anomaly detection — spike vs trailing average
// ---------------------------------------------------------------------------

const SPIKE_MULTIPLIER = 5; // pause token if this call would be >5× the daily average
const SPIKE_MIN_CALLS = 10; // don't trigger until we have enough samples

async function checkSpike(tokenId: string, estimatedCents: number): Promise<boolean> {
  const admin = createAdminClient() as AnyAdmin;
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Approximate daily average from usage_events — best-effort, not blocking critical path
  const { data: events } = await admin
    .from("usage_events")
    // gateway_tokens do not directly link usage_events yet; skip spike check for now
    // This is a seam for #44 when token → subscription linkage is complete
    .select("billable_cents")
    .eq("idempotency_key", `token:${tokenId}`) // placeholder linkage
    .gte("created_at", since);

  if (!events || events.length < SPIKE_MIN_CALLS) return false;

  const totalCents = events.reduce(
    (s: number, e: { billable_cents: number }) => s + e.billable_cents,
    0
  );
  const avgDailyCents = totalCents / 7;
  return estimatedCents > avgDailyCents * SPIKE_MULTIPLIER;
}

async function pauseGatewayToken(tokenId: string, reason: string): Promise<void> {
  const admin = createAdminClient() as AnyAdmin;
  await admin
    .from("gateway_tokens")
    .update({ paused_at: new Date().toISOString(), paused_reason: reason })
    .eq("id", tokenId);
}

// ---------------------------------------------------------------------------
// resolveAndForward — the proxy core
// ---------------------------------------------------------------------------

export interface ForwardArgs {
  /** Authenticated buyer (or owner of the gateway token). */
  buyerId: string;
  buyerOrgId: string;
  /** The deployment this call is scoped to (required — gateway calls are per-deployment). */
  deploymentId: string;
  /** Raw parsed request body from the client. */
  body: unknown;
  /** Idempotency-Key header value, if provided. */
  idempotencyKey?: string;
  /** If authenticated via gateway token, pass validated token for spend-cap enforcement. */
  gatewayToken?: ValidatedGatewayToken | null;
}

export interface ForwardResponse {
  /** Streaming response to pipe back to the client. */
  stream: ReadableStream<Uint8Array>;
  /** Response headers to forward (content-type, transfer-encoding, etc.). */
  headers: Record<string, string>;
  /** HTTP status code from the provider. */
  status: number;
}

/**
 * Full proxy flow:
 *   1. Load effective config for the deployment (cached LRU + Redis).
 *   2. Resolve provider key (buyer BYOK > agency key > vendor default).
 *   3. Rate-limit check.
 *   4. Spend-cap check (per token and per wallet).
 *   5. Reserve estimated cost against the credit wallet.
 *   6. Forward request via provider adapter (streaming passthrough).
 *   7. After stream ends: settle actual usage, release reservation excess.
 *   8. On failure: release full reservation (no charge for a failed call).
 */
export async function resolveAndForward(args: ForwardArgs): Promise<ForwardResponse> {
  const admin = createAdminClient() as AnyAdmin;

  // 1. Effective deployment config (ONLY source per CLAUDE.md / #50 requirement)
  const effectiveCfg = await getEffectiveConfig(args.deploymentId);
  if (effectiveCfg.status !== "active") {
    throw new GatewayError(403, "deployment_inactive", "Deployment is not active");
  }

  const cfg = effectiveCfg.config;

  // 2. Resolve product config (provider, model, meter, system_prompt)
  const solutionId = cfg.solution_id as string | undefined;
  if (!solutionId) throw new GatewayError(400, "no_solution", "Deployment has no solution_id");

  const { data: product, error: prodErr } = await admin
    .from("gateway_products")
    .select("*")
    .eq("solution_id", solutionId)
    .maybeSingle();
  if (prodErr || !product) {
    throw new GatewayError(400, "no_gateway_product", "No gateway product configured for this solution");
  }

  // 3. Resolve which provider key to use:
  //    Buyer BYOK (from config override) > Agency key > Vendor default
  const byokKeyId =
    (cfg.byok_provider_key_id as string | undefined) ??
    (cfg.agency_provider_key_id as string | undefined) ??
    product.default_key_id;

  if (!byokKeyId && product.cost_mode === "byok") {
    throw new GatewayError(402, "no_provider_key", "No BYOK provider key configured for this deployment");
  }

  // 4. Rate limiting (gateway is NOT webhook-exempt — always rate-limit)
  const rl = await checkRateLimit(`gateway:${args.buyerId}`, 60, 60_000);
  if (!rl.allowed) {
    throw new GatewayError(429, "rate_limited", "Too many requests");
  }

  // 5. Spend cap enforcement for gateway tokens
  if (args.gatewayToken) {
    const { spendCapCentsDaily, spentTodayCents, spendCapCentsMonthly, spentMonthCents, tokenId } =
      args.gatewayToken;
    const reqBody = args.body as Record<string, unknown>;
    const estimatedTokens = (reqBody.max_tokens as number | undefined) ?? product.max_tokens_cap;
    const estimatedCents = Math.ceil(estimatedTokens * 0.001); // rough 1-cent-per-1k estimate

    if (spendCapCentsDaily != null && spentTodayCents + estimatedCents > spendCapCentsDaily) {
      throw new GatewayError(402, "daily_cap_exceeded", "Daily spend cap exceeded");
    }
    if (spendCapCentsMonthly != null && spentMonthCents + estimatedCents > spendCapCentsMonthly) {
      throw new GatewayError(402, "monthly_cap_exceeded", "Monthly spend cap exceeded");
    }

    // Anomaly guard: spike detection
    const isSpike = await checkSpike(tokenId, estimatedCents);
    if (isSpike) {
      await pauseGatewayToken(tokenId, "anomaly_spike");
      throw new GatewayError(402, "token_paused_anomaly", "Token paused due to anomalous spend spike");
    }
  }

  // 6. Reserve estimated cost against wallet (reserve-then-settle)
  const reqBody = args.body as Record<string, unknown>;
  const estimatedTokens = (reqBody.max_tokens as number | undefined) ?? product.max_tokens_cap;

  const adapter = getAdapter(product.provider as ProviderName);
  const costPerKToken = adapter.modelCostCentsPerKToken(product.model) ?? 0;
  const estimatedCents = Math.max(1, Math.ceil((estimatedTokens / 1000) * costPerKToken));

  const { data: reserveResult, error: reserveErr } = await admin.rpc("reserve_credits", {
    p_buyer_id: args.buyerId,
    p_meter_id: product.meter_id,
    p_estimated_cents: estimatedCents,
    p_idempotency_key: args.idempotencyKey ? `reserve:${args.idempotencyKey}` : null,
  });

  if (reserveErr) throw new Error(`reserve_credits RPC failed: ${reserveErr.message}`);

  const reservation = reserveResult as {
    ok: boolean;
    blocked: boolean;
    reason?: string;
    reservation_id?: string;
    deduped?: boolean;
    available_cents?: number;
  };

  if (!reservation.ok) {
    if (reservation.reason === "insufficient_credits") {
      throw new GatewayError(402, "insufficient_credits", "Insufficient prepaid credits");
    }
    throw new GatewayError(402, reservation.reason ?? "blocked", "Payment required");
  }

  const reservationId = reservation.reservation_id!;

  // 7. Decrypt provider key and forward (streaming passthrough)
  let plaintextKey = "";
  if (byokKeyId) {
    plaintextKey = await decryptProviderKey(byokKeyId);
  }

  // 7a. Instruction set resolution (#56) — gated by INSTRUCTION_SETS_ENABLED; falls back to static system_prompt
  let resolvedSystemPrompt: string | null = product.system_prompt as string | null;
  if (process.env.INSTRUCTION_SETS_ENABLED === "true") {
    try {
      const instrOrgId = effectiveCfg.agency_org_id ?? args.buyerOrgId;
      const instrResult = await getEffectiveInstructions({
        orgId: instrOrgId,
        clientOrgId: effectiveCfg.client_org_id,
        deploymentId: args.deploymentId,
      });
      if (instrResult.systemPrompt) resolvedSystemPrompt = instrResult.systemPrompt;
    } catch (err) {
      console.error(JSON.stringify({ event: "gateway.instruction_resolution_error", error: String(err) }));
    }
  }

  // 7b. Knowledge retrieval injection (#55) — gated by KNOWLEDGE_ENABLED
  const knowledgeBaseIds = (product as Record<string, unknown>).knowledge_base_ids as string[] | null;
  if (process.env.KNOWLEDGE_ENABLED === "true" && knowledgeBaseIds?.length) {
    try {
      const { retrieve } = await import("@/lib/services/knowledge");
      const reqBody = args.body as Record<string, unknown>;
      const userQuery = extractLastUserMessage(reqBody);
      if (userQuery) {
        const chunks = await retrieve({
          orgId: args.buyerOrgId,
          baseIds: knowledgeBaseIds,
          query: userQuery,
          topK: 5,
          plaintextApiKey: plaintextKey || process.env.OPENAI_API_KEY,
        });
        if (chunks.length > 0) {
          const context = chunks.map((c) => c.content).join("\n\n---\n\n");
          const contextHeader = "Relevant context from the knowledge base:\n\n";
          resolvedSystemPrompt = resolvedSystemPrompt
            ? `${resolvedSystemPrompt}\n\n${contextHeader}${context}`
            : `${contextHeader}${context}`;
        }
      }
    } catch (err) {
      // Retrieval failure is non-fatal — log and continue without context
      console.error(JSON.stringify({ event: "gateway.knowledge_retrieval_error", error: String(err) }));
    }
  }

  let forwardResult;
  try {
    forwardResult = await adapter.forward(
      args.body,
      plaintextKey,
      resolvedSystemPrompt,
      product.max_tokens_cap
    );
  } catch (err) {
    // Provider call failed before streaming — release reservation, no charge
    await admin.rpc("release_reservation", { p_reservation_id: reservationId });
    throw err;
  }

  // 8. Settle after stream: wrap client stream so we settle on completion
  const { stream: rawStream, usage: usagePromise } = forwardResult;

  const settleAfterStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    async flush() {
      // Stream has ended — settle actual usage
      try {
        const usageResult = await usagePromise;
        const actualCents = Math.ceil(
          (usageResult.quantity / 1000) * (adapter.modelCostCentsPerKToken(product.model) ?? 0)
        );

        // Mark reservation as settled
        await admin
          .from("gateway_reservations")
          .update({ status: "settled", settled_cents: actualCents })
          .eq("id", reservationId);

        // Record the usage event (deduped if same idempotency key)
        if (usageResult.quantity > 0) {
          await recordUsage({
            meterId: product.meter_id,
            buyerId: args.buyerId,
            quantity: usageResult.quantity,
            idempotencyKey: args.idempotencyKey,
            providerCostCentsPerUnit:
              product.cost_mode === "managed"
                ? (usageResult.providerCostCentsEstimate ?? 0) / Math.max(usageResult.quantity, 1)
                : 0,
            actorOrgId: args.buyerOrgId,
          });
        }

        // Update token spend counters (fire-and-forget)
        if (args.gatewayToken) {
          admin
            .from("gateway_tokens")
            .update({
              spent_today_cents: admin.rpc("coalesce_add", {
                col: "spent_today_cents",
                val: actualCents,
              }),
              spent_month_cents: admin.rpc("coalesce_add", {
                col: "spent_month_cents",
                val: actualCents,
              }),
            })
            .eq("id", args.gatewayToken.tokenId)
            .then(() => {});
        }
      } catch {
        // Settle failed — reservation will expire via sweep. No double-charge.
      }
    },
  });

  const settledStream = rawStream.pipeThrough(settleAfterStream);

  return {
    stream: settledStream,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    status: 200,
  };
}

// ---------------------------------------------------------------------------
// Gateway usage analytics
// ---------------------------------------------------------------------------

export async function getGatewayUsage(
  buyerId: string,
  days = 30
): Promise<{
  byProduct: Array<{ productId: string; totalCents: number; totalTokens: number }>;
  spentCents: number;
  capCents: number | null;
}> {
  const admin = createAdminClient() as AnyAdmin;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data: events, error } = await admin
    .from("usage_events")
    .select("meter_id, billable_cents, quantity")
    .eq("buyer_id", buyerId)
    .gte("created_at", since);

  if (error) throw new Error(`getGatewayUsage: ${error.message}`);

  // Group by meter_id — lookup product_id from meters
  const grouped: Record<string, { totalCents: number; totalTokens: number }> = {};
  for (const ev of events ?? []) {
    const key = ev.meter_id as string;
    if (!grouped[key]) grouped[key] = { totalCents: 0, totalTokens: 0 };
    grouped[key].totalCents += ev.billable_cents as number;
    grouped[key].totalTokens += ev.quantity as number;
  }

  const byProduct = Object.entries(grouped).map(([productId, v]) => ({
    productId,
    totalCents: v.totalCents,
    totalTokens: v.totalTokens,
  }));

  const spentCents = byProduct.reduce((s, r) => s + r.totalCents, 0);

  return { byProduct, spentCents, capCents: null };
}

// ---------------------------------------------------------------------------
// #55 — extract the last user message text for knowledge retrieval query
// ---------------------------------------------------------------------------

function extractLastUserMessage(body: Record<string, unknown>): string | null {
  const messages = body.messages as { role: string; content: unknown }[] | undefined;
  if (!Array.isArray(messages)) return null;
  const userMsgs = messages.filter((m) => m.role === "user");
  const last = userMsgs[userMsgs.length - 1];
  if (!last) return null;
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content)) {
    const textPart = (last.content as { type: string; text?: string }[]).find((p) => p.type === "text");
    return textPart?.text ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "GatewayError";
  }
}
