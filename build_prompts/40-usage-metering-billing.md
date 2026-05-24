# Task #40 — Usage metering ledger + usage-based billing (the meter)

> **Before starting:** read `SPEC.md` §3, §11, [lib/stripe/transfers.ts](lib/stripe/transfers.ts), [lib/services/reseller.ts](lib/services/reseller.ts), [supabase/migrations/20260522000007_vendor_revenue_events_net.sql](supabase/migrations/20260522000007_vendor_revenue_events_net.sql). Read `ENGINEERING.md` (money section) in full.
> **Definition of Done:** a single generic usage ledger that ANY metered product (gateway #41, workflow #42, connector #43) writes to; a prepaid credit wallet so the platform never fronts money; a settlement job that turns unsettled usage into Stripe charges + Separate Charges & Transfers splits (vendor / platform / reseller / affiliate). Pure money math + tests + RLS.

**Phase 6 — Wave 9. Depends on: nothing new (extends existing billing). BLOCKS #41, #42, #43, #44.**

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

### 1. `usage_meters` table
Defines one billable unit for one product. Columns: `id`, `owner_id` → profiles (vendor/reseller who owns the product), `product_type` (`gateway|workflow|connector|custom` enum), `unit` (text — `'token'|'run'|'call'|'row'`), `vendor_unit_price_cents` (bigint ≥0), `platform_fee_cents` (bigint ≥0), `active` (bool), `created_at`, `updated_at`. RLS: owner reads/writes own; service role full.

### 2. `usage_events` append-only ledger
`id`, `meter_id` → usage_meters, `buyer_id` → profiles, `subscription_id` (nullable → subscriptions for attribution: affiliate/reseller inheritance), `quantity` (bigint), `provider_cost_cents` (bigint, default 0 — informational only, BYOK paid externally), `billable_cents` (bigint — what we draw from credits), `vendor_share_cents`, `platform_share_cents`, `reseller_share_cents` (nullable), `affiliate_share_cents` (nullable), `idempotency_key` (text UNIQUE — `(source, source_id)`), `occurred_at`, `settled_at` (nullable). Immutable: insert-only, no UPDATE/DELETE policy. Index `(buyer_id, settled_at)`, `(meter_id)`.

### 3. Prepaid credit wallet
`credit_wallets` — `id`, `buyer_id` → profiles UNIQUE, `balance_cents` (bigint ≥0), `updated_at`. `credit_transactions` — `id`, `wallet_id`, `type` (`topup|drawdown|refund`), `amount_cents`, `usage_event_id` (nullable), `stripe_payment_intent_id` (nullable), `created_at`. Draw-down happens in the **same transaction** as the `usage_events` insert (RPC). Top-up = Stripe Checkout/PaymentIntent → webhook credits the wallet.

### 4. `recordUsage()` RPC (atomic, idempotent)
Single Postgres function: given `(meter_id, buyer_id, quantity, idempotency_key)` → compute splits via the shared pure function, insert `usage_events`, draw down `credit_wallets`, write `credit_transactions`, write `audit_log` — all in one transaction. Returns `{ ok, remaining_balance, blocked }`. If balance < billable → `blocked=true`, no draw-down, caller (gateway/workflow) refuses the call.

### 5. Settlement job (Edge Function cron — `usage-settlement-cron`)
Periodic (daily or threshold-based). Aggregate unsettled `usage_events` per `(buyer, vendor, attribution)` → create Stripe transfers to vendor/reseller/affiliate (Separate Charges & Transfers, idempotency key per batch), mark events `settled_at`. Because credits were already collected at top-up, this only **distributes** already-held money — the platform is merchant of record on the top-up, then fans out shares. Reuse `transferVendorShare` / `transferResellerShare` / `transferAffiliateShare`.

### 6. Client-ownership columns (SPEC §13)
Add `subscriptions.acquired_by` (enum `platform | partner`, default `platform`, immutable) and `subscriptions.partner_owner_id` (uuid → profiles, nullable) with CHECK `(acquired_by='partner') = (partner_owner_id IS NOT NULL)`. Existing rows backfill to `platform` (marketplace default). Written only by the service role at subscribe time. Usage-economy subscriptions (#41/#42/#44) set `partner` + the acquiring partner's id; marketplace stays `platform`. The §6/§7 anti-poaching stat views branch on `acquired_by`: `platform` → anon only; `partner` → the `partner_owner_id` party sees its own client, every other counterparty still anon. Do NOT fork the views — one code path that reads the column.

### 7. Pure split function + thin dashboard surface
`lib/usage/split.ts` — `computeUsageSplit(args)` pure function (vendor/platform/reseller/affiliate cents; sum invariant `=== billable_cents`; non-negative platform fee; throws on violation — mirror `computeResellerSplit`). Add a small "Usage & credits" card to the buyer dashboard (balance + top-up) and a "Usage revenue" KPI to vendor/reseller/affiliate dashboards.

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
- [ ] Zero/low balance → `blocked=true`, no draw-down.
- [ ] `computeUsageSplit` sum invariant holds; CI fuzz test (1000 iters) — platform fee always ≥0, sum === billable.
- [ ] Settlement creates exactly one transfer per recipient per batch (idempotent re-run safe).
- [ ] Platform never inserts a `provider_cost_cents` it pays — BYOK; field is informational.
- [ ] Affiliate/reseller attribution inherited from the linked subscription, mutually exclusive (reuse §4 CHECK logic).
- [ ] RLS: buyer reads only own wallet; vendor/reseller/affiliate read only own usage revenue; nobody reads another buyer's events.
- [ ] SPEC.md gains a §14 "Usage metering & credits" section (§13 is client ownership / `acquired_by`).
