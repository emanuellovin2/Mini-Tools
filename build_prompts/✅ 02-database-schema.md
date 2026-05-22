# Prompt #2 — Database schema, RLS, and the anti-poaching boundary

> **Before starting:** read `SPEC.md` §7 and §8.
> **Definition of Done:** strict TS, Zod at boundaries, tests on money/access paths, RLS + RLS tests for new tables, Verify step passes, Progress checklist ticked.

---

Create all core tables as Supabase **migrations** (never dashboard edits): `apps`, `subscriptions`, `vendor_billing`, `webhook_events`, `audit_log`, and the Phase-2 `affiliate_links` / `affiliate_attributions` / `reseller_offers` / `reseller_subscriptions` (defined now, unused but with full RLS). The `profiles.role` enum must already include `affiliate` and `reseller` (`admin|vendor|buyer|affiliate|reseller`). Requirements:

- Money columns are `bigint` cents with `CHECK (>= 0)`; percentages stored as `int` basis points. Status/role columns are Postgres enums or `CHECK` constraints. Add `created_at` everywhere and `updated_at` (with trigger) on mutable tables. Index every FK and every column used in RLS/filtering.
- **Status enum for `subscriptions` must include all Stripe values** the state machine handles: `incomplete`, `incomplete_expired`, `active`, `trialing`, `past_due`, `unpaid`, `canceled`, `paused` (SPEC §8 table).
- **Constraints that prevent bugs:** partial unique on `subscriptions(buyer_id, app_id)` where `status IN ('incomplete','active','trialing','past_due')` (no double active sub); `UNIQUE(subscriptions.stripe_subscription_id)`; **no UNIQUE on `subscriptions.anon_user_id`** (intentionally repeated across rows for the same buyer×app — see SPEC §6); `UNIQUE(vendor_billing.vendor_id, period_start)`; `webhook_events.id` (Stripe event id) as PK; on `subscriptions` add `CHECK NOT (affiliate_id IS NOT NULL AND reseller_id IS NOT NULL)` (mutually exclusive attribution), `CHECK ((reseller_id IS NULL) = (reseller_offer_id IS NULL))`, `CHECK ((reseller_id IS NULL) = (vendor_floor_snapshot_cents IS NULL))`; on `reseller_offers`: `UNIQUE(reseller_id, slug)`, `UNIQUE(reseller_id, app_id)`, `CHECK (sell_price_cents >= vendor_floor_snapshot_cents)`; on `apps`: `CHECK (min_price_cents IS NULL OR min_price_cents <= price_cents)`; `UNIQUE(profiles.slug)` (nullable).
- `subscriptions.price_cents` is a **snapshot** (editing an app's price must not change existing subscriptions).
- **RLS for every table.** Vendors read/write only their own `apps`; buyers read only their own `subscriptions`; admin reads everything. **Profiles UPDATE policy must forbid changing your own `role`** (`WITH CHECK` new role = old role); `role`, Stripe, Connect, and `charges_enabled`/`payouts_enabled` columns are writable only by the service role. `display_name` and `slug` are self-writable by the owning user (slug subject to format/uniqueness validation server-side). Phase-2 tables:
  - `affiliate_links`: affiliate SELECT/INSERT own rows only.
  - `affiliate_attributions`: service-role write; affiliate SELECT own rows only; never readable by vendors/resellers.
  - `reseller_offers`: reseller SELECT/INSERT/UPDATE own rows; buyers SELECT only `status='active'`; vendors SELECT rows referencing their own apps (read-only); admin all.
  - `reseller_subscriptions`: reseller SELECT own row; service-role writes from webhooks.
- **Anti-poaching boundary (critical):** vendors get **no direct read** on `subscriptions`. Create a `vendor_subscription_stats` view/RPC exposing only `app_id`, `anon_user_id`, `status`, `price_cents`, `current_period_end` for the vendor's own apps — never `buyer_id` or anything joinable to buyer identity. Likewise, **resellers** get a `reseller_sale_stats` view/RPC exposing the same columns + `vendor_floor_snapshot_cents` for subscriptions tied to their own offers, **never** `buyer_id`. **Affiliates** read only an aggregated `affiliate_stats` view (counts, MRR, payouts) — never per-buyer rows. `webhook_events` and `audit_log` are service-role/admin only; `audit_log` is append-only (revoke UPDATE/DELETE for every role).
- Seed realistic test data: vendors with `charges_enabled=true` AND `=false`; apps in each status; **canceled subscriptions across multiple months** (needed for churn in #10); at least one buyer who canceled + resubscribed to the same app (so #6's anon_user_id reuse can be tested).

## Verify

Migrations apply cleanly locally (`supabase db reset`); RLS blocks cross-vendor `apps` access; a vendor querying `subscriptions` directly gets nothing, but `vendor_subscription_stats` returns their rows **without** `buyer_id`; a buyer cannot UPDATE their own `role` (write an RLS test proving this); a buyer cannot UPDATE their own `charges_enabled` (RLS test); seed data is queryable; the canceled-then-resubscribed buyer has the SAME `anon_user_id` on both subscription rows.
