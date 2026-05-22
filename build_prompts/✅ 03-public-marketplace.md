# Prompt #3 — Public marketplace

> **Before starting:** read `SPEC.md` §1, §7, §8.
> **Definition of Done:** strict TS, Zod at boundaries, tests on money/access paths, RLS + RLS tests for new tables, Verify step passes, Progress checklist ticked.

---

Build the public marketplace: a landing page, a `/marketplace` page listing apps with `status = 'approved'` **and** vendor `charges_enabled = true` (never surface an app whose vendor can't receive funds), with category filtering and text search, and an `/app/[id]` detail page (name, description, category, monthly price formatted from cents, vendor display name). Requirements:

- **Paginate** the listing from the start; no unbounded query. Use an indexed search (full-text or `ILIKE` on indexed columns) and a single query with a join for vendor info (no N+1).
- Non-approved apps are never reachable, including by direct id.

## Verify

Seeded approved apps from charges-enabled vendors appear; filtering, search, and pagination work; an approved app from a not-charges-enabled vendor is hidden; non-approved app ids 404; price renders correctly from cents.
