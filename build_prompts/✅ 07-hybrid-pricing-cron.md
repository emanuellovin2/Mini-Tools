# Prompt #7 — Vendor hybrid pricing tiers + monthly billing cron

> **Before starting:** read `SPEC.md` §3, §8.
> **Definition of Done:** strict TS, Zod at boundaries, tests on money/access paths, RLS + RLS tests for new tables, Verify step passes, Progress checklist ticked.

---

Implement tiering as **pure, tested functions** plus a scheduled job. **No monthly flat fees** — the platform's only take from a direct vendor sale is the percentage cut.

- `computeTier(grossCents)` returns `{ tier, cut_bps }` with the exact boundaries from SPEC §3 (test the `99_999/100_000/100_001` and `199_999/200_000/200_001` edges, the zero/new-vendor case, and a **negative gross floored at 0** case — a refund-heavy month must not crash or yield negative tier).
- A monthly **Supabase Edge Function (cron, UTC, 1st of month at 01:00 UTC)** — the 1-hour buffer past midnight protects against edge-of-month charges that take a few seconds to settle. For each vendor: compute `gross_revenue_cents` for the just-ended calendar month — `max(0, captures − refunds/disputes in that same month)`, cash-basis per SPEC §3, **excluding reseller-sold rows** (`WHERE subscriptions.reseller_id IS NULL`) — and write a `vendor_billing` row (idempotent via `UNIQUE(vendor_id, period_start)`). The job must be **resumable/per-vendor** (a failure on vendor 50 doesn't corrupt vendors 1–49), idempotent, and wrap each vendor's compute+insert in a single DB transaction.
- From now on, #6's transfer logic reads `cut_bps` from the current `vendor_billing` row; the tier is **frozen per period**, never recomputed live at charge time. The default-to-Tier-1 helper from #6 still applies for brand-new vendors who haven't had a cron run yet.

## Verify

- Running the cron writes one `vendor_billing` row per vendor with the correct tier/cut
- Re-running it writes nothing new (idempotent)
- Subsequent `invoice.paid` transfers use the frozen `cut_bps`
- A vendor with net-negative monthly revenue (refunds > charges) lands at Tier 1 with `gross_revenue_cents = 0` and no crash
- A vendor whose only charges in the month were reseller-sold is treated as $0 gross (Tier 1)
- Killing the job mid-loop and restarting completes the remaining vendors without redoing the done ones
- Boundary tests pass ($999.99 → Tier 1, $1000.00 → Tier 2, $1999.99 → Tier 2, $2000.00 → Tier 3)
