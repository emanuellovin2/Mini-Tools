# Task #32 — Vendor dashboard v2 (channel mix + cash flow + drill-down)

> **Before starting:** read `SPEC.md` §3, §4, §11, [lib/services/vendor.ts](lib/services/vendor.ts), [app/vendor/page.tsx](app/vendor/page.tsx), `mockups/index.html` (vendor view). Read [build_prompts/31-design-system-v2.md](build_prompts/31-design-system-v2.md) — primitives must be shipped.
> **Definition of Done:** vendor sees their entire business on one screen — channel mix, Stripe Connect balance & next payout, dunning queue, refunds/disputes feed, per-app drill-down via drawer, transparent fee breakdown, reseller-openness toggle with kickback earnings visible. All numbers tied to real services (no mock data left). Tests on aggregations + drawer interactions. SPEC.md §4 updated.

**Phase 5 — Wave 8. Depends on: #31. Parallel with #33–#37.**

---

## What's missing today vs target

Current `/vendor` shows: MRR, subs, churn, LTV, waterfall, cohort, app list. **Gap:** no channel breakdown, no Stripe balance, no dunning, no refund/dispute feed, no per-app drill-in, no transparent fee math, openness toggle buried elsewhere.

## Sections to build

### 1. Hero row (KPI strip)
4 cards: Net MRR · Active subs · Monthly churn · LTV/customer — with sparklines, delta chips, 30/90/12m time selector that propagates.

### 2. Revenue mix donut + table (NEW)
- Donut split: Direct / Affiliate / Reseller (% of GMV this period).
- Legend with $ values + sub counts per channel.
- Click any slice → drawer with filtered subscription list (channel-scoped).
- Data: aggregate from `subscriptions` joining `affiliate_id`/`reseller_id` flags.

### 3. Stripe Connect & cash flow card (NEW)
- Connect status: onboarded ✓ / KYC pending / payouts disabled (with CTA).
- Available balance · Pending balance · Next payout date + amount (weekly Friday from #20).
- Last 5 payouts list, click → drawer with itemized invoices.
- Service: new `getVendorBalance(vendorId)` calling Stripe `balance.retrieve` on the Connect account.

### 4. Dunning queue (NEW)
- Invoices with `payment_failed` retrying, count + $ at-risk.
- List shows: anon sub id · app · amount · retry attempt N/4 · next retry date.
- Click → drawer with timeline of attempts.
- Data: query subscriptions where `status='past_due'`.

### 5. Refunds & disputes feed (NEW)
- Last 30d: refund count + $ reversed (vendor share only per #19), dispute count + $ at-risk.
- Each row: date · type (refund/dispute) · app · amount · status (closed/won/lost/pending).
- Click → drawer with Stripe IDs + reason + linked sub.

### 6. Commission tier card (KEEP + EXPAND)
- Progress bar through 4 tiers (12/8/5/3%).
- **If admin override active**: show "Custom rate: X% (set by admin Y on date Z)" — surfaces `profiles.vendor_cut_bps_override`.
- Transparent breakdown: gross → -stripe fees → -platform cut (with %) → -refunds → payout. Each line clickable to drawer with sources.
- "How fees work →" link (see #38).

### 7. Reseller-openness panel (NEW position — surface from buried setting)
- 3-state toggle (closed / open_to_resellers / open_to_wl) with explainer per state.
- If `open_to_wl`: kickback earned this month + lifetime ("$X from 33% of platform's reseller commission across N reseller sales").
- List of resellers carrying your apps (anon if needed): slug · MRR generated · WL tier.

### 8. Apps table (UPGRADE)
- Per-row: name · status · price · subs · MRR(30d) · churn(30d) · trend sparkline · channel mix mini-donut.
- **Click row → drawer** with: full per-app KPIs, recent events, pricing edit inline, min_price_cents toggle for resellers, screenshot gallery thumb, "Pause sales" button.
- Bulk actions (multi-select): pause / archive / export selected.

### 9. Cohort retention (KEEP, IMPROVE)
- Already exists; add per-app filter dropdown, hover cell shows raw subscriber counts.

### 10. Recent events (KEEP, IMPROVE)
- Add filter chips (invoice / subscription / dispute / refund).
- Each row click → drawer with full Stripe event JSON.

### 11. Quick-action bar (sticky top)
- Buttons: Create app · Edit pricing · Connect Stripe · Export data (CSV).

---

## Data layer additions

```ts
// lib/services/vendor.ts new exports
getVendorChannelMix(vendorId, days): { direct, affiliate, reseller } in cents
getVendorBalance(vendorId): { available, pending, next_payout }
getVendorDunning(vendorId): { count, at_risk_cents, items[] }
getVendorRefundsDisputes(vendorId, days): { refunds[], disputes[] }
getVendorResellerKickback(vendorId, days): { total, byReseller[] }
getVendorAppDrillDown(vendorId, appId): { mrr, churn, ltv, events, channelMix }
```

All RLS-tested. All return tabular-numeric cents (never strings).

---

## Acceptance criteria

- [ ] Every number on the page traces to a service call (no mocked data).
- [ ] Channel mix donut sums to 100%, ticks down/up correctly when switching time range.
- [ ] Connect status accurately reflects Stripe state (test with disabled account).
- [ ] Dunning queue updates when webhook simulates `payment_failed`.
- [ ] Refund feed shows vendor-only impact (matches #19 policy).
- [ ] Admin override card path visible if `vendor_cut_bps_override IS NOT NULL`.
- [ ] Click any app row → drawer opens with that app's full detail.
- [ ] Mobile: KPIs stack 2→1, table becomes card list.
- [ ] CSV export downloads subs + payouts.
- [ ] Empty states for zero subs / zero apps / no refunds — all with CTAs.
