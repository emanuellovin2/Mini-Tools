# Prompt #11 — Testing & security hardening pass

> **Before starting:** read `ENGINEERING.md`.
> **Definition of Done:** strict TS, Zod at boundaries, tests on money/access paths, RLS + RLS tests for new tables, Verify step passes, Progress checklist ticked.

---

With features in place, harden cross-cutting concerns:

- **RLS test suite:** automated tests proving cross-vendor denial, buyer isolation, the role-escalation guard, and that no vendor-facing path reaches `buyer_id`/PII.
- **Critical-path tests** consolidated and green: token verify, split math, tier boundaries, webhook idempotency + out-of-order, refund/dispute reversal, status→access mapping.
- **Input-validation audit:** every API route and server action parses input with Zod; reject unknown fields.
- **Rate limiting** on auth and `/api/verify`; basic abuse protection on subscribe.
- **Secret/dependency hygiene:** confirm no server-only secret reaches the client bundle; run a dependency audit; confirm Storage bucket policies and content-type restrictions.

## Verify

The full test suite passes; a scripted attempt to escalate role, read another vendor's data, reach a buyer id, or hit `/api/verify` past the rate limit all fail; no secret appears in the client bundle.
