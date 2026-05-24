# Task #41 — AI Gateway (BYOK) — the door

> **Before starting:** read `SPEC.md` §6 (anti-poaching), §11, [build_prompts/40-usage-metering-billing.md](build_prompts/40-usage-metering-billing.md), [lib/utils/rate-limit.ts](lib/utils/rate-limit.ts), [lib/validation/env.ts](lib/validation/env.ts).
> **Definition of Done:** an authenticated proxy that forwards AI requests to providers (OpenAI / Anthropic / OpenAI-compatible) using the **customer's own encrypted key**, records one `usage_event` per call via #40, applies the platform+vendor fee, streams the response back. The platform pays **zero** provider compute. This is the first usage-revenue engine.

**Phase 6 — Wave 9. Depends on: #40. Parallel with #43 after #40. Feeds #42, #44.**

---

## Cost-to-owner principle
BYOK is the whole point: the **buyer (or vendor/reseller running the product) supplies the provider API key**; the provider bills THEM directly. The platform meters the call and charges only its `platform_fee_cents` (+ vendor's per-unit price) against prepaid credits (#40). The platform never holds or pays a provider invoice. The only platform cost is the proxy's serverless time — covered by the per-call fee.

## Attractiveness (why each role wants this)
- **Vendor:** ship an "AI agent" product without hosting any infra — define a system prompt + model + per-call price; earn recurring usage revenue. Bigger TAM than redirect-only apps.
- **Reseller:** resell a vendor's agent with a per-call markup (reuses #40 split).
- **Affiliate:** earn a recurring % of the platform fee on every call their referral makes — grows with consumption, not a one-time bounty.
- **Buyer:** one key, one bill, spend caps, full audit — safer than wiring keys into N tools.

---

## Sections to build

### 1. Provider key vault (`provider_keys`) — envelope encryption + rotation from day one
`id`, `owner_id` → profiles, `provider` (`openai|anthropic|openai_compat` enum), `label`, `ciphertext` (bytea), `dek_wrapped` (bytea — the per-record data key, wrapped by the active master key), `key_version` (int — which master key wrapped this DEK), `last4` (text — display), `created_at`. **Use envelope encryption, NOT a single symmetric key:** each record gets its own random data key (DEK) that encrypts the secret (AES-256-GCM); the DEK is wrapped by a master key held in env (`KEY_VAULT_MASTER_KEYS` — a versioned set, e.g. `{ "1": "<base64>", "2": "..." }`, active version in `KEY_VAULT_ACTIVE_VERSION`). **Why:** rotating the master key only re-wraps DEKs (cheap), never re-encrypts every secret; a leaked master version is bounded. Ship a `rotateMasterKey()` admin path that re-wraps all DEKs to the new version. **Never** return plaintext to the client; decrypt only server-side at proxy time. RLS: owner-only metadata; ciphertext/`dek_wrapped` service-role only. Add the env vars to the Zod schema. **This `lib/gateway/crypto.ts` envelope module is the shared crypto reused by #43 connector tokens — design it generically (`encryptSecret(plaintext)` / `decryptSecret(record)`).**

### 2. Proxy endpoint `POST /api/gateway/[provider]`
- Auth: Supabase session or a scoped gateway API token (see §6).
- **Client idempotency:** accept an `Idempotency-Key` header. A retried request with the same key returns the cached result and **never double-meters** (store key → result ref on the `usage_events` idempotency_key).
- Resolve the `usage_meter` for the target product. Metering is **reserve-then-settle** (the only correct model for token billing where the true quantity is known post-response):
  1. **Reserve** an estimated max cost against the wallet (hold), under the wallet row lock (#40). If insufficient → `402 Payment Required`, do not forward.
  2. **Forward** the request through the resolved key (streaming passthrough — `ReadableStream`), return provider response verbatim.
  3. **Settle**: read the provider's returned `usage` block, record the true quantity via `recordUsage()`, release the unused reservation. If the call fails/aborts mid-stream, release the full reservation (no charge for a failed call).
- This makes a crash-between-reserve-and-settle safe: an orphaned reservation expires (a sweep releases holds older than N minutes).

### 3. Spend caps + abuse protection (protect the buyer's real provider account)
Per-buyer daily/monthly spend cap (cents) **and** per-gateway-token cap (a leaked token must not be able to drain the buyer's BYOK provider account). Anomaly guard: a sudden spike vs trailing average pauses the token and notifies. Reuse `checkRateLimit()` (always `await`). Gateway is NOT webhook-exempt — rate-limit it.

### 4. Provider adapter abstraction + product type
- **Adapter interface** (`lib/gateway/providers/{openai,anthropic,compat}.ts`): each provider implements `forward(req, key) → stream` and `parseUsage(response) → { unit, quantity }` and `priceModel(model) → providerCostResolver`. Per-model provider cost lives in config, not hardcoded in the proxy. Adding a provider = new adapter file, **no proxy rewrite**.
- **Vendor "AI agent" product** — extend `apps` (or `gateway_products`): `model`, `system_prompt` (nullable), `meter_id`, `cost_mode` (`byok|managed` — from #40 §8). **`byok`** = buyer/vendor key, platform cost zero. **`managed`** = platform key, buyer prepays provider cost + margin (chosen strategy: offer both; default `byok`, `managed` as a one-click option to remove the "I don't have an API key" friction). Approval reuses the admin gate + `charges_enabled`.

### 5. Privacy / logging
Log call **metadata only** (owner, meter, quantity, latency, status) via `lib/logger.ts`. Do **NOT** persist prompt/response bodies by default (PII + cost). Opt-in debug logging behind a flag, redacted. Client visibility follows the **`acquired_by` boundary (SPEC §13)**: usage products default to `acquired_by='partner'`, so the **acquiring partner** (`partner_owner_id`) owns and may see their own client; **every other counterparty still sees only `anon_user_id`** (a vendor whose agent is resold by an agency never sees the agency's client). Card/payment data is never exposed to anyone but platform + Stripe.

### 6. Gateway tokens
`gateway_tokens` — hashed, scoped per buyer×product, revocable — so a buyer can call the gateway from their own code/app, not only the browser. Verify like an API key (hash compare), rate-limited.

### 7. Dashboard surface
Buyer: gateway usage chart + spend vs cap + credit balance + manage keys. Vendor/reseller/affiliate: gateway revenue KPI (from #40 `getUsageRevenue`).

---

## Data layer additions
```ts
// lib/services/gateway.ts (new)
storeProviderKey(ownerId, provider, plaintext): { last4 }   // encrypts, never echoes plaintext
listProviderKeys(ownerId): { id, provider, label, last4 }[]
resolveAndForward(req): Response   // the proxy core; calls recordUsage()
createGatewayToken(buyerId, productId, scopes): { token }   // returned once
getGatewayUsage(buyerId, days): { byProduct, spentCents, capCents }
// lib/gateway/crypto.ts — encrypt/decrypt with KEY_VAULT_SECRET (AES-256-GCM)
```

## Acceptance criteria
- [ ] Provider key stored with **envelope encryption** (per-record DEK wrapped by versioned master key); plaintext never leaves the server, never in any response or log.
- [ ] `rotateMasterKey()` re-wraps all DEKs to the new version WITHOUT re-encrypting secrets or downtime; old version still decrypts until drained.
- [ ] Client `Idempotency-Key` retries return cached result, never double-meter.
- [ ] Reserve-then-settle: a failed/aborted call charges nothing (reservation released); crash leaves an expiring hold, not a stuck balance.
- [ ] Per-token spend cap prevents a leaked token from draining the buyer's BYOK provider account; anomaly spike pauses the token.
- [ ] Adding a new provider is a new adapter file only — no change to the proxy core.
- [ ] `managed` cost_mode bills provider cost + margin from prepaid credits; platform never fronts money; `byok` incurs zero platform provider cost.
- [ ] Every forwarded call records exactly one `usage_event` (idempotent); token meters record true token count from the provider response.
- [ ] No credits → `402`, request NOT forwarded, no provider call made.
- [ ] Streaming responses pass through without buffering the whole body.
- [ ] Spend cap enforced; rate limit enforced (awaited).
- [ ] Platform incurs zero provider cost in `buyer_key` mode (verified: provider call uses buyer's key).
- [ ] Vendor sees only `anon_user_id`, never buyer PII (SPEC §6).
- [ ] Gateway token auth works from a non-browser client; revocation takes effect immediately.
- [ ] RLS: nobody can read another owner's `provider_keys` ciphertext.
- [ ] Tests: split math, idempotent metering, 402 on no-credits, encryption round-trip.
