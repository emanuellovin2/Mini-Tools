# Task #47 — Organizations & multi-seat foundation (the ownership model)

> **Before starting:** read `SPEC.md` §2, §7, §8, §11, `ENGINEERING.md` (RLS), [lib/auth/roles.ts](lib/auth/roles.ts), [supabase/migrations/](supabase/migrations/), and skim how `vendor_id` / `reseller_id` / `affiliate_id` ownership is used today.
> **Definition of Done:** every ownership, payout, and billing entity is owned by an **organization**, not a bare user. Every user gets a **personal org** on signup; existing rows backfill to the owner's personal org. Teams can invite members with roles. Stripe Connect / payouts move to org level. RLS is rewritten to check **org membership**, not `user_id`. This is the load-bearing refactor — do it pre-launch (no live data, migrations can clean-break per platform status) so it never has to be redone.

**Phase 6 — Wave 9. Runs FIRST in the wave — BLOCKS #40–#46 (all new tables are org-owned from the start). Pre-launch only; after launch this becomes a data migration with contracts.**

---

## Why this is the foundation (and why now)
Agencies, resellers, and serious vendors are **teams**, not individuals. Retrofitting org-scoping later means rewriting every ownership reference, every RLS policy, and the entire payout model — the single most painful refactor a platform can face. Multi-seat is also a top stickiness + expansion-revenue lever (invites, per-seat pricing, NRR > 100%). The standard pattern (GitHub/Vercel/Stripe): a **personal account is just an org with one member**, so ownership is *uniformly* org-based and there is no polymorphic "user-or-org" branching.

## Core principle
**One ownership type: `org_id`.** No `owner_type` discriminator, no "user or org" union. Every user has exactly one personal org (auto-created); teams are orgs with >1 member. All product/money entities reference `org_id`.

---

## Sections to build

### 1. Schema
- `organizations` — `id`, `name`, `slug` (UNIQUE, nullable for personal), `type` (`personal|team`), `created_at`, `updated_at`. The Connect/payout columns (`stripe_account_id`, `charges_enabled`, `payouts_enabled`) **move here from `profiles`** — payouts go to the org.
- `org_members` — `id`, `org_id`, `user_id` → profiles, `role` (`owner|admin|member`), `created_at`. UNIQUE `(org_id, user_id)`. `owner` = full control incl. billing + delete; `admin` = manage products/members; `member` = operate (run workflows, view), no billing.
- `org_invitations` — `id`, `org_id`, `email`, `role`, `token` (hashed), `invited_by`, `expires_at`, `accepted_at` (nullable), `created_at`.
- Keep `profiles.role` as the user's **platform role** (admin/vendor/buyer/affiliate/reseller) for capabilities; ownership/permissions within work come from `org_members.role`.

### 2. Personal org bootstrap + backfill
- On user signup (existing flow), create a personal org (`type='personal'`) + an `org_members` row (`role='owner'`). Add to the post-signup server path.
- **Backfill migration (pre-launch clean-break):** for every existing profile, create a personal org, make them owner, and **repoint all existing ownership** (`apps.vendor_id`, `reseller_offers.reseller_id`, `affiliate_links.affiliate_id`, `reseller_subscriptions.reseller_id`, `profiles.stripe_account_id` → org) to the personal org. Migration pattern (per #48 §5.4, **mandatory even pre-launch so the muscle memory is correct from day 1**): add nullable `org_id` column → batched `UPDATE` backfill → `CREATE INDEX CONCURRENTLY` → `ALTER TABLE ... SET NOT NULL` once verified. No `ADD COLUMN NOT NULL DEFAULT <expr>` shortcuts; no plain `CREATE INDEX`.

### 3. Ownership migration of existing tables
Add `org_id → organizations` to: `apps` (replaces vendor_id as the owner; keep a `created_by_user_id` for attribution), `reseller_offers`, `affiliate_links`, `reseller_subscriptions`, `vendor_billing`, `vendor_revenue_events`, **`audit_log` (BOTH `actor_user_id` AND `actor_org_id` — every admin row backfills `actor_org_id=NULL`, every member-driven row going forward stamps the org doing the action)**, and the Connect-bearing path. Reseller `$19/mo` and WL subs bill the **org**. The marketplace/anti-poaching stat views key on `org_id`.

### 3a. Team activity feed (audit_log RLS, NEW — pairs with §3)
Today `audit_log` is admin-read-only. With teams, every org needs **its own activity log** ("Alice paused offer X 2h ago", "Bob rotated API key", "Carol invited Dave") — this is what makes multi-seat feel like real teamwork instead of shared credentials, and it's the only honest way to track who did what when something goes wrong. Add an RLS policy: org members (role≥`admin`) read rows where `actor_org_id = <their org>`; admin still reads all. Surface at `/settings/organization/activity` (chronological list, filter by member/action, paginated). Every server action and `/api/v1/*` mutating endpoint that writes `audit_log` MUST include `actor_org_id` from `getActiveOrg(session)` — wire this via the `writeAuditLog` helper signature so it can't be forgotten. **Why now:** without `actor_org_id` from day 1, the team activity feed becomes a backfill nightmare (you can't infer which org an old admin action belonged to).

### 4. RLS rewrite (org-membership based) — **performance is foundational, not polish**
Replace `user_id = auth.uid()` ownership checks with **"caller is a member of the owning org"** via a SQL helper `is_org_member(org_id, min_role)`. Every owner-facing policy on the tables above (and all #40–#46 tables) uses it. Buyer/admin/anti-poaching boundaries (§7) are unchanged in spirit — vendors still get no path to `subscriptions.buyer_id`; now "vendor" means "member of the vendor org."

**Performance contract (load-bearing — see #48 §5.3):**
- `is_org_member` MUST be declared `STABLE SECURITY DEFINER` so Postgres caches its result within a query (otherwise it runs per row → O(n) on hot tables = death at scale).
- Add composite index `org_members (user_id, org_id) INCLUDE (role)` so the helper is one indexed lookup.
- Also expose a `my_org_ids()` `STABLE SETOF uuid` helper; policies on hot tables prefer `org_id = ANY(SELECT my_org_ids())` (single inline lookup) over scalar `is_org_member(org_id)` per row.
- Acceptance: `EXPLAIN ANALYZE` on a hot org-scoped query (`SELECT * FROM usage_events WHERE org_id = $1 LIMIT 100`) shows index-only on `org_members` lookup + partition pruning on `usage_events`, NOT a seq scan or repeated function call.

### 5. Permissions model
A small pure `lib/auth/permissions.ts`: `can(member, action)` mapping `org_members.role` → allowed actions (`manage_billing`, `manage_members`, `create_product`, `manage_payouts`, `operate`, `view`). Used by server actions + API. Owners-only: billing, delete org, change payout account. One source of truth — never inline role checks.

### 6. Team UX (minimal but real)
- `/settings/organization`: members list (role, last active), invite by email + role, change role, remove, leave/transfer ownership.
- Org switcher in the topbar (personal ↔ teams the user belongs to). The **active org** is held in session and scopes every query.
- Invitation accept flow (`/invite/[token]`).

### 7. Active-org context
A server helper `getActiveOrg(session)` resolves the current org + the caller's role in it; every service-layer call is scoped by it. This is the single seam every dashboard reads — get it right once.

---

## Data layer additions
```ts
// lib/services/org.ts (new)
createPersonalOrg(userId): Org            // called at signup
createTeamOrg(userId, name): Org
inviteMember(orgId, email, role, byUserId): { token }
acceptInvite(token, userId): void
listMembers(orgId) / setMemberRole / removeMember / transferOwnership
getActiveOrg(session): { org, role }
// lib/auth/permissions.ts (pure) — can(memberRole, action): boolean
// SQL: is_org_member(org_id uuid, min_role text) returns boolean (security definer, used in RLS)
```

## Acceptance criteria
- [ ] Every user has exactly one personal org after signup; backfill repoints all existing ownership with zero orphans.
- [ ] Ownership is uniformly `org_id` — no `owner_type` union anywhere.
- [ ] Connect account + payouts are org-level; the $19/mo reseller sub bills the org.
- [ ] RLS uses `is_org_member`; a non-member cannot read/write another org's products, payouts, or analytics.
- [ ] Role permissions enforced: `member` cannot touch billing/payouts; `owner` can transfer/delete.
- [ ] Invite → accept → member appears with correct role; expired/used token rejected.
- [ ] Org switcher scopes all dashboards to the active org.
- [ ] Anti-poaching (§7) holds with org semantics: no org gets a path to buyer PII it didn't acquire (§13).
- [ ] All #40–#46 tables reference `org_id` from the start (no later migration).
- [ ] `audit_log.actor_org_id` populated by `writeAuditLog` on every mutation; org admins see their own org's activity at `/settings/organization/activity`; cross-org reads denied by RLS.
- [ ] Tests: backfill correctness, RLS membership (cross-org denied), permission matrix, invite lifecycle, team activity feed scoping.
