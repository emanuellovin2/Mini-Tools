# Execution order for tasks #15-#26

Read this before starting any task. The order matters — some changes are foundational and others depend on them. Doing things out of order = rework and broken state mid-flight.

## TL;DR — execute in waves

| Wave | Tasks | What it gives you | Blocks the next wave? |
|------|-------|-------------------|----------------------|
| 1 | #20, #22 | Quick wins, isolated Stripe config | No (parallel-able with Wave 2) |
| 2 | #15 → #16 → #17 | Backend pricing model updated; net amount becomes the new basis | YES — #17 must precede #18/#24 |
| 3 | #26 | Design system primitives + reference page (`/buyer` only) | YES — must precede Wave 4-5 UI work |
| 4 | #18 → #19 | Affiliate model redesign + matching refund policy | YES — #18 unblocks #25; #19 depends on #18 metadata |
| 5 | #23, #24, #25 | Sticky features (pause, vendor analytics, affiliate gamification) | No (can run in parallel within the wave) |
| 6 | #21 | Final docs sync (SPEC.md, CLAUDE.md, BUILD_PROMPTS.md) | — |

---

## Wave 1 — Quick wins (parallel-able, no blockers)

### #20 Weekly Friday payouts
**Scope:** Stripe Connect setting at onboarding. No DB, no UI.
**Risk:** Near zero. Reversible by setting `interval: 'daily'`.
**Estimated time:** 30 min.

### #22 Reseller 30-day free trial
**Scope:** `trial_period_days: 30` on Stripe Checkout for reseller plan.
**Risk:** Near zero. New trials only — existing reseller subs unaffected.
**Estimated time:** 1 hour.

**Why first:** Zero coupling to anything else. Ship them on day 1 to get momentum and immediate metrics (signup velocity, payout cadence).

---

## Wave 2 — Backend pricing model (MUST be sequential)

### #15 Vendor tier 4 levels (12/8/5/3%)
**Scope:** `computeTier()`, vendor_billing CHECK constraint, PL/pgSQL function, all related tests.
**Depends on:** nothing.
**Blocks:** nothing strictly, but logical to ship before #17.
**Risk:** Medium. Two sources of truth (TS + SQL) must be updated together — easy to miss.
**Estimated time:** 3 hours including tests.

### #16 Reseller fee from markup (not gross)
**Scope:** `computeResellerSplit()`, tests.
**Depends on:** nothing.
**Risk:** Low. Pure function change.
**Estimated time:** 1 hour.

### #17 Net amount basis (after Stripe fees)
**Scope:** Webhook handlers fetch `balance_transaction.net`, `vendor_revenue_events` gets `net_amount_cents` column, PL/pgSQL function sums net.
**Depends on:** #15 (uses same vendor_revenue_events function — change together to avoid double migration).
**Blocks:** #18 (affiliate split uses net), #24 (analytics sum net).
**Risk:** High. Touches ALL money math. Every test that mocked `amount_paid` needs review.
**Estimated time:** 1-2 days.

**🚨 Confirm with user before starting:**
- Are tier thresholds applied to NET or GROSS? (3% economic difference)

After Wave 2: new pricing model lives in production. No UI changes yet — all dashboards still look the same.

---

## Wave 3 — Design system (MUST come before Wave 4-5 UI)

### #26 Design system foundation
**Scope:** Tokens, 10 primitives in `components/ui/`, layout shell in `components/layout/`, migrate `/buyer` as reference page.
**Depends on:** nothing.
**Blocks:** #18 vendor calculator UI, #23 pause modal, #24 analytics charts, #25 leaderboard.
**Risk:** Very low (additive — old UI untouched except `/buyer`).
**Estimated time:** 2-3 days.

**Why here and not earlier:** running #26 before #15-#17 is fine but wasted parallelism — backend changes don't conflict, and you might as well let `/buyer` accumulate any small changes from Wave 2 (none expected). Running #26 AFTER #18/#23/#24/#25 = rework all those new pages. Sweet spot: between Wave 2 and Wave 4.

**Why low risk:** primitives are additive. Only `/buyer` gets visual refresh; `/admin`, `/vendor`, `/affiliate`, `/reseller` look identical until each is migrated as part of its own feature task.

---

## Wave 4 — Affiliate redesign + refund policy (sequential)

### #18 Affiliate model redesign
**Scope:** New DB columns (`apps.affiliate_commission_bps`, `subscriptions.affiliate_commission_snapshot_bps`, `profiles.affiliate_active_mrr_cents`), new `computeAffiliateSplit()`, new `getAffiliateCommissionBps()`, vendor dashboard calculator UI (uses #26 primitives).
**Depends on:** #17 (net amount), #26 (UI primitives for calculator).
**Blocks:** #19 (refund needs final transfer metadata convention), #25 (leaderboard reads `affiliate_active_mrr_cents`).
**Risk:** High. Biggest economic + DB + UI change.
**Estimated time:** 3-5 days.

**🚨 Confirm with user before starting:**
- "MRR generated" = cumulative lifetime OR current active MRR?
- Backward-compat with old affiliate subscriptions or clean break?

### #19 Refund vendor-only
**Scope:** `reverseTransfers()` filters by metadata; only vendor's transfer reversed on `charge.refunded`; ALL transfers still reversed on `charge.dispute.closed` (lost).
**Depends on:** #18 (consistent metadata tagging across all transfer types).
**Risk:** Medium. Dispute handling is risky — wrong logic = real money lost.
**Estimated time:** 4 hours including tests.

**🚨 Confirm with user before starting:**
- Vendor-only policy on disputes too, or only on voluntary refunds?

After Wave 4: economic model fully aligned with the new spec. Vendor dashboard has affiliate commission calculator. Refunds behave correctly.

---

## Wave 5 — Sticky features (parallel-able)

### #23 Subscription pause
**Scope:** `paused_until` column on subscriptions, `pause_collection` API on Stripe, pause/resume buttons in `/buyer` (uses #26).
**Depends on:** #26.
**Risk:** Medium. New state machine path (access flips based on `paused_until`).
**Estimated time:** 2-3 days.

### #24 Vendor analytics (MRR, churn, cohort, LTV)
**Scope:** Views/RPCs in DB, service functions, dashboard cards/charts in `/vendor` (uses #26).
**Depends on:** #17 (uses `net_amount_cents`), #26 (Card, Table, Skeleton primitives).
**Risk:** Low-medium. Read-only — no money math.
**Estimated time:** 3-4 days (charts are the slow part).

### #25 Affiliate leaderboard + badges
**Scope:** Public leaderboard at `/affiliates/top`, public profile at `/affiliates/<slug>`, badges in dashboard (uses #26).
**Depends on:** #18 (uses `affiliate_active_mrr_cents`), #26.
**Risk:** Low. Read-only public pages.
**Estimated time:** 2-3 days.

After Wave 5: platform has all sticky features. Multiple dashboards now use the design system.

---

## Wave 6 — Final docs

### #21 Docs sync
**Scope:** Rewrite SPEC.md §3/§4a/§4b/§8/§11, update CLAUDE.md "Economics" section, add #15-#26 to BUILD_PROMPTS.md.
**Depends on:** all prior waves.
**Risk:** Zero (docs only).
**Estimated time:** 2 hours.

---

## Rules to avoid breakage

1. **Never run two waves in parallel** unless this doc says you can.
2. **Within a sequential wave (2, 4), finish one task fully — including tests — before starting the next.**
3. **Migrate `/admin`, `/vendor`, `/affiliate`, `/reseller` to #26 design system ONLY as part of their feature tasks** (#18 migrates `/vendor`, #25 migrates `/affiliate`, etc.). Don't do a separate "migrate all dashboards" sweep — it's the riskiest possible thing to do alone.
4. **After every wave, run the full test suite + manually click through each dashboard.** Don't stack waves on a broken base.
5. **Update CLAUDE.md "Progress" checklist** as each task completes. Future you (or another contributor) needs to know what's actually shipped.

## Decisions (LOCKED — 2026-05-22)

| Decision | Resolution |
|---|---|
| Tier thresholds basis | **GROSS** — sum `invoice.amount_paid` for tier brackets. `vendor_billing` schema unchanged. |
| Commission math basis | **NET** — `balance_transaction.net` is what gets multiplied by cut_bps in transfer functions. |
| Affiliate "MRR generated" | **Active MRR** (sum of `price_cents` for status active/trialing, paused excluded). Recomputed on subscription state changes + nightly safety job. |
| Refund policy | **Vendor-only reversal** on `charge.refunded`. |
| Dispute policy | **ALL transfers reversed** on `charge.dispute.closed` outcome=lost. |
| Backward compat | **Clean break**. Old affiliate subs migrated to default 2000 bps. Old "50% of platform cut" formula deleted entirely. |
| Platform status | **Pre-launch** — no real customer commitments to honor on migration. |
