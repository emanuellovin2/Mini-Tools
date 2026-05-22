# Prompt #4 — Vendor dashboard

> **Before starting:** read `SPEC.md` §2, §6.
> **Definition of Done:** strict TS, Zod at boundaries, tests on money/access paths, RLS + RLS tests for new tables, Verify step passes, Progress checklist ticked.

---

Build `/dashboard/vendor`:

- A form to submit a new app (name, description, category, monthly price entered in dollars but **stored as cents**, `auth_url`, and a logo). Inserts a row with `status = 'pending'`.
- **Safe logo upload to Supabase Storage:** accept only `png/jpg/webp` (reject SVG); cap file size (e.g. 1 MB); validate the **magic bytes** server-side (not just `Content-Type` — that header is spoofable) before writing to Storage; store in a dedicated `app-logos` bucket whose Storage RLS allows `INSERT/UPDATE/DELETE` only by the owning vendor (path prefixed with `vendor_id/`) and `SELECT` public (logos are public assets); display via the returned URL.
- A form to set `display_name` on the vendor's `profiles` row (used as the public marketplace vendor name).
- A list of the vendor's own apps with status, an earnings section (placeholder until Stripe in #5–#7) sourced from `vendor_subscription_stats` (**never** buyer identity), and an "Integration status" indicator (flips to connected in #8).
- Validate `auth_url` (https only) and all inputs with Zod. Reject unknown fields.

## Verify

A vendor can submit an app, see it listed as pending, and the logo is stored and displayed; an SVG, oversized, or magic-byte-mismatched upload (e.g. a `.png`-renamed `.exe`) is rejected; a vendor cannot write to another vendor's storage path; the price round-trips correctly as cents; the earnings view exposes no buyer identity; setting `display_name` updates the marketplace listing.
