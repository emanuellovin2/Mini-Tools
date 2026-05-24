# Task #40 — Usage metering ledger + usage-based billing (the meter)

> **Before starting:** read `SPEC.md` §3, §11, [lib/stripe/transfers.ts](lib/stripe/transfers.ts), [lib/services/reseller.ts](lib/services/reseller.ts), [supabase/migrations/20260522000007_vendor_revenue_events_net.sql](supabase/migrations/20260522000007_vendor_revenue_events_net.sql). Read `ENGINEERING.md` (money section) in full.
> **Definition of Done:** a single generic usage ledger that ANY metered product (gateway #41, workflow #42, connector #43) writes to; a prepaid credit wallet so the platform never fronts money; a settlement job that turns unsettled usage into Stripe charges + Separate Charges & Transfers splits (vendor / platform / reseller / affiliate). Pure money math + tests + RLS.

**Phase 6 — Wave 9. Depends on: #47 (org ownership). BLOCKS #41, #42, #43, #44, #45.**

> **Org ownership (SPEC §13 + #47):** every owner/payer reference below is an **`org_id → organizations`**, never a bare user. `usage_meters.owner_id`, `credit_wallets.owner_org_id`, and the payer side of `usage_events` are org-scoped. Each user has a personal org, so this is uniform. RLS uses `is_org_member`.

---

## Cost-to-owner principle (NON-NEGOTIABLE — design every part around this)
- The platform **NEVER fronts AI provider compute**. Compute is **BYOK** (#41) — the buyer's own provider key pays the provider directly. The meter bills only the **platform fee + the vendor's per-unit price**, never the raw provider cost.
- Buyers run on **prepaid credits**. Usage draws down a balance that was already paid. No invoicing risk, no bad debt, no float. A buyer at zero credits is blocked (soft cap) — they top up to continue.
- The platform's only real marginal cost is serverless execution; a tiny per-event `platform_fee_cents` covers it. The platform is structurally always in profit per event.

## Money model (reuses Separate Charges & Transfers, SPEC §11)
Per billable unit: `billable_cents = vendor_unit_price_cents + platform_fee_cents (+ reseller_markup_cents if reseller-sold)`.
- Vendor receives `vendor_unit_price_cents` (× quantity) on settlement.
- Platform keeps `platform_fee_cents`.
- Reseller (if attributed) keeps `reseller_markup_cents`; platform takes 5% of that markup (reuse `computeResellerSplit` shape).
- Affiliate (if attributed) earns its snapshotted % of the **platform fee** (recurring, grows with consumption).
- All amounts in **integer cents**, margins in **bps**. Reuse the transfer helpers — do NOT invent a second money path.

---

## Sections to build

### 1. `usage_meters` table — flexible pricing from day one
Defines billing for one product. Columns: `id`, `owner_id` → profiles, `product_type` (`gateway|workflow|connector|custom` enum), `unit` (text — `'token'|'run'|'call'|'row'`), `currency` (text, default `'usd'` — **seam: USD enforced at the boundary now, but the column exists so multi-currency never requires a schema change**), `pricing` (jsonb — **structured, not a single cents value**: `{ model: 'flat'|'tiered'|'volume', tiers: [{ up_to, vendor_unit_price_cents, platform_fee_cents }], included_allowance?, minimum_commitment_cents? }`), `cost_mode` (`byok|managed` enum — see §8), `active` (bool), `created_at`, `updated_at`. A pure `priceUnit(pricing, cumulativeQty, qty)` resolver computes the cents for a slice — keep it pure + tested so tiered/volume/allowance all work without a rewrite. RLS: owner reads/writes own; service role full.

### 2. `usage_events` append-only ledger
`id`, `meter_id` → usage_meters, `buyer_id` → profiles, `subscription_id` (nullable → subscriptions for attribution: affiliate/reseller inheritance), `quantity` (bigint), `provider_cost_cents` (bigint, default 0 — informational only, BYOK paid externally), `billable_cents` (bigint — what we draw from credits), `vendor_share_cents`, `platform_share_cents`, `reseller_share_cents` (nullable), `affiliate_share_cents` (nullable), `idempotency_key` (text UNIQUE — `(source, source_id)`), `occurred_at`, `settled_at` (nullable). Immutable: insert-only, no UPDATE/DELETE policy. Index `(buyer_id, settled_at)`, `(meter_id)`.

### 3. Prepaid credit wallet
`credit_wallets` — `id`, `buyer_id` → profiles UNIQUE, `currency` (text, default `'usd'` — seam), `balance_cents` (bigint ≥0), `updated_at`. `credit_transactions` — `id`, `wallet_id`, `type` (`topup|drawdown|refund|grant`), `amount_cents`, `usage_event_id` (nullable), `stripe_payment_intent_id` (nullable), `created_at`. (`grant` type covers free trial / promo credits — makes the product attractive at zero schema cost.) Draw-down happens in the **same transaction** as the `usage_events` insert (RPC). Top-up = Stripe Checkout/PaymentIntent → webhook credits the wallet.

**Concurrency (NON-NEGOTIABLE):** the wallet row MUST be locked (`SELECT ... FOR UPDATE`) inside `recordUsage` before the balance check + draw-down, so two simultaneous calls can never spend the same credits (double-spend). The check-and-decrement is one atomic step under the row lock. Add a test that fires N concurrent draw-downs and asserts the balance never goes negative and the sum of draw-downs ≤ starting balance.

### 4. `recordUsage()` RPC (atomic, idempotent)
Single Postgres function: given `(meter_id, buyer_id, quantity, idempotency_key)` → compute splits via the shared pure function, insert `usage_events`, draw down `credit_wallets`, write `credit_transactions`, write `audit_log` — all in one transaction. Returns `{ ok, remaining_balance, blocked }`. If balance < billable → `blocked=true`, no draw-down, caller (gateway/workflow) refuses the call.

### 5. Settlement job (Edge Function cron — `usage-settlement-cron`)
Periodic (daily or threshold-based). Aggregate unsettled `usage_events` per `(buyer, vendor, attribution)` → create Stripe transfers to vendor/reseller/affiliate (Separate Charges & Transfers, idempotency key per batch), mark events `settled_at`. Because credits were already collected at top-up, this only **distributes** already-held money — the platform is merchant of record on the top-up, then fans out shares. Reuse `transferVendorShare` / `transferResellerShare` / `transferAffiliateShare`.

### 5b. Credit liability + partner-payable accounting (so finance/admin is correct from day one)
Prepaid credits are a **liability** (money owed back as service), not revenue. Drawn-but-not-yet-transferred partner shares are a **payable**. Expose three numbers (read in #36 admin v2):
- **Outstanding credit liability** = Σ `credit_wallets.balance_cents` (unspent prepaid).
- **Partner payable** = Σ `usage_events` shares where `settled_at IS NULL` (owed to vendors/resellers/affiliates).
- **Recognized platform revenue** = Σ `platform_share_cents` on drawn events.
Add a **usage reconciliation** check (extend `lib/services/reconciliation.ts`): Σ topups − Σ drawdowns − Σ refunds === Σ wallet balances, and Σ settled partner shares === Σ Connect transfers for usage. Flag drift like the existing Stripe↔DB reconciliation.

### 6. Client-ownership columns (SPEC §13)
Add `subscriptions.acquired_by` (enum `platform | partner`, default `platform`, immutable) and `subscriptions.partner_owner_id` (uuid → profiles, nullable) with CHECK `(acquired_by='partner') = (partner_owner_id IS NOT NULL)`. Existing rows backfill to `platform` (marketplace default). Written only by the service role at subscribe time. Usage-economy subscriptions (#41/#42/#44) set `partner` + the acquiring partner's id; marketplace stays `platform`. The §6/§7 anti-poaching stat views branch on `acquired_by`: `platform` → anon only; `partner` → the `partner_owner_id` party sees its own client, every other counterparty still anon. Do NOT fork the views — one code path that reads the column.

### 7. Pure split function + thin dashboard surface
`lib/usage/split.ts` — `computeUsageSplit(args)` pure function (vendor/platform/reseller/affiliate cents; sum invariant `=== billable_cents`; non-negative platform fee; throws on violation — mirror `computeResellerSplit`). Add a small "Usage & credits" card to the buyer dashboard (balance + top-up) and a "Usage revenue" KPI to vendor/reseller/affiliate dashboards.

### 8. Cost modes — BYOK + managed-key (both prepaid, platform never fronts money)
`usage_meters.cost_mode`:
- **`byok`** — the buyer/owner supplies the provider key (#41); the provider bills them directly. `provider_cost_cents` on the event is **informational only** (for transparency display); `billable_cents = vendor price + platform fee (+ markup)`.
- **`managed`** — the **platform's** provider key is used. The buyer prepaid credits cover **provider cost + platform margin + vendor/partner shares**, all drawn at use time. `billable_cents` then **includes `provider_cost_cents`**, and `platform_share_cents` must stay ≥0 **after** subtracting the provider cost (the resolver throws if a misconfigured price would make the platform sell below provider cost). Because it's prepaid, the platform still never fronts money. The only residual risk (provider price drift mid-period) is bounded by recomputing provider cost from the live provider response, never from a stale estimate.

`computeUsageSplit` takes `cost_mode` + `provider_cost_cents` and enforces the right invariant per mode. Fuzz-test both modes: sum invariant holds, platform never nets negative in `managed`.

---

## Data layer additions
```ts
// lib/services/usage.ts (new)
createMeter(ownerId, args): Meter
recordUsage(meterId, buyerId, quantity, idempotencyKey): { ok, remainingBalanceCents, blocked }
getUsageBalance(buyerId): { balanceCents }
topUpCredits(buyerId, amountCents): { checkoutUrl }   // Stripe
getUsageRevenue(ownerId, days): { byMeter, totalCents }
settleUsage(): { transfersCreated }   // called by cron
// lib/usage/split.ts (pure)
computeUsageSplit(args): { vendorCents, platformCents, resellerCents, affiliateCents }
```

## Acceptance criteria
- [ ] `recordUsage` is atomic: ledger insert + wallet draw-down + audit_log in ONE transaction.
- [ ] Duplicate `idempotency_key` is a no-op (never double-draws credits).
- [ ] Wallet row is locked (`FOR UPDATE`) during check+decrement; concurrency test proves no double-spend, balance never negative.
- [ ] `priceUnit` resolver handles flat + tiered + volume + included-allowance (pure, tested).
- [ ] `managed` cost_mode: `billable_cents` includes provider cost; platform share never negative (fuzz). `byok`: provider cost is informational only.
- [ ] `currency` column present on meter/wallet/usage_events; USD enforced at boundary (seam verified — no schema change needed for future multi-currency).
- [ ] Credit liability, partner payable, recognized revenue computable; usage reconciliation flags drift.
- [ ] Zero/low balance → `blocked=true`, no draw-down.
- [ ] `computeUsageSplit` sum invariant holds; CI fuzz test (1000 iters) — platform fee always ≥0, sum === billable.
- [ ] Settlement creates exactly one transfer per recipient per batch (idempotent re-run safe).
- [ ] Platform never inserts a `provider_cost_cents` it pays — BYOK; field is informational.
- [ ] Affiliate/reseller attribution inherited from the linked subscription, mutually exclusive (reuse §4 CHECK logic).
- [ ] RLS: buyer reads only own wallet; vendor/reseller/affiliate read only own usage revenue; nobody reads another buyer's events.
- [ ] SPEC.md gains a §14 "Usage metering & credits" section (§13 is client ownership / `acquired_by`).
