# Prompt #9 — Buyer dashboard

> **Before starting:** read `SPEC.md` §2, §8.
> **Definition of Done:** strict TS, Zod at boundaries, tests on money/access paths, RLS + RLS tests for new tables, Verify step passes, Progress checklist ticked.

---

Build `/dashboard/buyer`: list every app the buyer is subscribed to with its status, a **Launch** button using #8's token flow, and a **cancel** option that sets `cancel_at_period_end` (access continues until `current_period_end`; show that date). Surface a clear **pending** state for a just-subscribed app awaiting webhook confirmation. Wire discovery→subscription end to end from the marketplace detail page.

## Verify

A buyer subscribes from the marketplace, sees a pending then active state, the app appears in the dashboard, Launch redirects with a valid token, and Cancel sets cancel-at-period-end (Stripe shows it, access persists until period end, then access stops). Past-due subs show as suspended.
