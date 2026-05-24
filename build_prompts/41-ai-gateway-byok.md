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

### 1. Provider key vault (`provider_keys`)
`id`, `owner_id` → profiles, `provider` (`openai|anthropic|openai_compat` enum), `label`, `ciphertext` (bytea — AES-GCM encrypted with a server-only `KEY_VAULT_SECRET`), `last4` (text — for display), `created_at`. **Never** return plaintext to the client; decrypt only server-side at proxy time. RLS: owner-only read of metadata; ciphertext never selectable by anon/auth roles (service role only). Add `KEY_VAULT_SECRET` to env Zod schema.

### 2. Proxy endpoint `POST /api/gateway/[provider]`
- Auth: Supabase session or a scoped gateway API token (see §6).
- Resolve the `usage_meter` for the target product; call `recordUsage()` (#40) **before** forwarding for a fixed-cost unit, or reserve-then-reconcile for token-based (estimate, then adjust quantity post-response from the provider's usage block).
- If `blocked` (no credits) → `402 Payment Required`, do not forward.
- Decrypt the owner's provider key, forward the request (streaming passthrough — `ReadableStream`), return provider response verbatim.
- On token-based meters, read the provider's returned `usage` and record the true quantity (idempotent adjust).

### 3. Spend caps + rate limiting
Per-buyer daily/monthly spend cap (cents) and per-key rate limit. Reuse `checkRateLimit()` (always `await`). Gateway is NOT webhook-exempt — rate-limit it.

### 4. Vendor "AI app" product type
Extend `apps` (or a `gateway_products` table) so a vendor can publish a gateway-backed product: `model`, `system_prompt` (nullable), `meter_id`, `byok_mode` (`buyer_key|vendor_key` — default `buyer_key` for zero vendor infra cost). Approval reuses the existing admin gate + `charges_enabled`.

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
- [ ] Provider key stored encrypted; plaintext never leaves the server, never in any API response or log.
- [ ] Every forwarded call records exactly one `usage_event` (idempotent); token-based meters record true token count from the provider response.
- [ ] No credits → `402`, request NOT forwarded, no provider call made.
- [ ] Streaming responses pass through without buffering the whole body.
- [ ] Spend cap enforced; rate limit enforced (awaited).
- [ ] Platform incurs zero provider cost in `buyer_key` mode (verified: provider call uses buyer's key).
- [ ] Vendor sees only `anon_user_id`, never buyer PII (SPEC §6).
- [ ] Gateway token auth works from a non-browser client; revocation takes effect immediately.
- [ ] RLS: nobody can read another owner's `provider_keys` ciphertext.
- [ ] Tests: split math, idempotent metering, 402 on no-credits, encryption round-trip.
