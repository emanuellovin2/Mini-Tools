# Task #27 — Manual per-vendor commission override

> **Before starting:** read `ENGINEERING.md` and `SPEC.md` §3, §8, §11.
> **Definition of Done:** override column added with constraint + RLS, `getVendorCutBps()` reads override first, admin UI works end-to-end with mandatory reason + audit log entry, transfers respect override, vendor dashboard shows effective cut, full test coverage, typecheck clean, Verify step passes, Progress checklist ticked.

**Phase 4 — Wave 7. Depends on: nothing. Blocks: #29 (white-label tiered) — that prompt assumes this primitive exists so vendor toggle states can set fixed cut_bps cleanly.**

---

## Context

Today, `getVendorCutBps(vendorId)` in [lib/stripe/transfers.ts:29-43](lib/stripe/transfers.ts) reads `vendor_billing.cut_bps` (auto-computed from the 4-tier model in [lib/stripe/billing.ts](lib/stripe/billing.ts)) or defaults to `1200` (Tier 1, 12%) when no billing row exists.

**Business need:** the platform owner wants to manually set a different cut for specific vendors — e.g.:
- Strategic launch partner: 0% commission for 6 months
- Vendor that committed to bring volume: 1% custom rate
- Vendor on a legacy contract: locked at 5% regardless of tier
- (Future) "Open to resellers" toggle = 3% fixed, "Open to white-label" = 0% fixed (set by vendor's own toggle in #29, but reuses the same override field)

This is **not** a tier change — it's a per-vendor manual override that bypasses tier calculation entirely.

---

## What changes

### 1. Schema — `supabase/migrations/YYYYMMDD_vendor_cut_override.sql`

```sql
-- Per-vendor manual cut override. NULL = use auto-tier from vendor_billing.
-- Range: 0 bps (free) to 5000 bps (50% — sanity cap; anything higher is almost certainly a bug).
ALTER TABLE public.profiles
  ADD COLUMN vendor_cut_bps_override smallint
    CHECK (vendor_cut_bps_override IS NULL OR vendor_cut_bps_override BETWEEN 0 AND 5000);

COMMENT ON COLUMN public.profiles.vendor_cut_bps_override IS
  'Manual platform cut override for direct sales (in bps). NULL = use auto-tier from vendor_billing. Set by admin only — see audit_log entries with action=vendor_cut_override_set.';

-- RLS: only admins can read or write this column.
-- (profiles already has RLS; we add a column-level guard via a policy on UPDATE.)
-- The simplest safe approach: keep the existing UPDATE policy on profiles restricted to self for non-admin columns,
-- and rely on the existing admin-only path (server actions using service-role client) to mutate this column.
-- Vendor must NEVER be able to set this themselves (privilege escalation).
-- Confirm via test: a vendor calling supabase.from('profiles').update({ vendor_cut_bps_override: 0 }).eq('id', self) MUST fail.

-- If the current UPDATE policy on profiles is "authenticated user can update their own row" without column restriction,
-- this prompt MUST add a trigger that REJECTS any non-admin update touching vendor_cut_bps_override:
CREATE OR REPLACE FUNCTION public.guard_vendor_cut_override()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.vendor_cut_bps_override IS DISTINCT FROM OLD.vendor_cut_bps_override THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    ) THEN
      RAISE EXCEPTION 'vendor_cut_bps_override can only be modified by admin';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER guard_vendor_cut_override_trigger
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  WHEN (OLD.vendor_cut_bps_override IS DISTINCT FROM NEW.vendor_cut_bps_override)
  EXECUTE FUNCTION public.guard_vendor_cut_override();
```

### 2. `lib/stripe/transfers.ts` — `getVendorCutBps()`

Read override first, fall back to vendor_billing, fall back to default:

```ts
export async function getVendorCutBps(vendorId: string): Promise<number> {
  const admin = createAdminClient();

  // 1. Manual override (admin-set) takes precedence — bypasses tier entirely
  const { data: profile } = await admin
    .from("profiles")
    .select("vendor_cut_bps_override")
    .eq("id", vendorId)
    .maybeSingle();

  if (profile?.vendor_cut_bps_override !== null && profile?.vendor_cut_bps_override !== undefined) {
    return profile.vendor_cut_bps_override;
  }

  // 2. Auto-tier from latest vendor_billing row
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await admin
    .from("vendor_billing")
    .select("cut_bps")
    .eq("vendor_id", vendorId)
    .lte("period_start", today)
    .order("period_start", { ascending: false })
    .limit(1)
    .maybeSingle();

  // 3. Default — Tier 1 (SPEC §8)
  return data?.cut_bps ?? 1_200;
}
```

**CRITICAL — also patch the SQL duplicate:** the monthly billing cron uses a PL/pgSQL function ([supabase/migrations/20260522000005_vendor_billing_tier_4.sql](supabase/migrations/20260522000005_vendor_billing_tier_4.sql) → updated copy of `20260522000003_vendor_revenue_events.sql`) that re-computes `cut_bps` from gross. That cron writes a **per-period** `vendor_billing` row used for that period's settlement and reporting, NOT for live transfers. Live transfers always go through `getVendorCutBps()`.

**Decision:** the override does NOT alter what gets written to `vendor_billing.cut_bps` by the cron (keep tier history clean and auditable). Only live transfers and the vendor dashboard "effective cut" display read the override. Document this distinction in the migration comment.

### 3. New service — `lib/services/admin.ts`

Add:

```ts
export async function setVendorCutOverride({
  adminId,
  vendorId,
  newBps,           // number | null
  reason,           // required, min 10 chars
}: {
  adminId: string;
  vendorId: string;
  newBps: number | null;
  reason: string;
}): Promise<void> {
  if (reason.trim().length < 10) {
    throw new Error("reason is required and must be ≥10 characters");
  }
  if (newBps !== null && (newBps < 0 || newBps > 5000)) {
    throw new Error("newBps must be 0..5000 or null");
  }

  const admin = createAdminClient();

  // Read OLD value for audit
  const { data: before } = await admin
    .from("profiles")
    .select("vendor_cut_bps_override, role")
    .eq("id", vendorId)
    .maybeSingle();

  if (!before) throw new Error("vendor not found");
  if (before.role !== "vendor") throw new Error("target user is not a vendor");

  // Update (admin client bypasses RLS, trigger is SECURITY DEFINER and checks auth.uid())
  // Because we're using service role, the trigger won't fire as a non-admin — but be explicit:
  // wrap in a transaction that also writes the audit log atomically.
  const { error: updErr } = await admin.rpc("admin_set_vendor_cut_override", {
    p_admin_id: adminId,
    p_vendor_id: vendorId,
    p_new_bps: newBps,
    p_reason: reason,
    p_old_bps: before.vendor_cut_bps_override,
  });
  if (updErr) throw new Error(`setVendorCutOverride: ${updErr.message}`);
}

export async function getVendorsWithCutInfo() {
  // Returns { vendor_id, display_name, cut_bps_override, auto_tier_cut_bps, effective_cut_bps }
  // for the admin dashboard listing.
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("admin_get_vendors_cut_info");
  if (error) throw new Error(`getVendorsWithCutInfo: ${error.message}`);
  return data;
}
```

### 4. RPC — same migration file

```sql
-- Atomic set: update profile + write audit log in one transaction.
CREATE OR REPLACE FUNCTION public.admin_set_vendor_cut_override(
  p_admin_id uuid,
  p_vendor_id uuid,
  p_new_bps smallint,
  p_reason text,
  p_old_bps smallint
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Defensive: re-check actor is admin
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND role = 'admin') THEN
    RAISE EXCEPTION 'caller is not admin';
  END IF;

  UPDATE public.profiles
    SET vendor_cut_bps_override = p_new_bps,
        updated_at = now()
    WHERE id = p_vendor_id AND role = 'vendor';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor % not found', p_vendor_id;
  END IF;

  INSERT INTO public.audit_log (actor_id, actor_role, action, entity_type, entity_id, metadata)
  VALUES (
    p_admin_id,
    'admin',
    'vendor_cut_override_set',
    'profile',
    p_vendor_id::text,
    jsonb_build_object(
      'old_bps', p_old_bps,
      'new_bps', p_new_bps,
      'reason', p_reason
    )
  );
END $$;

-- Read helper for admin dashboard
CREATE OR REPLACE FUNCTION public.admin_get_vendors_cut_info()
RETURNS TABLE (
  vendor_id uuid,
  display_name text,
  cut_bps_override smallint,
  auto_tier_cut_bps int,
  effective_cut_bps int
) LANGUAGE sql SECURITY DEFINER AS $$
  SELECT
    p.id,
    p.display_name,
    p.vendor_cut_bps_override,
    COALESCE(
      (SELECT cut_bps FROM public.vendor_billing
       WHERE vendor_id = p.id AND period_start <= current_date
       ORDER BY period_start DESC LIMIT 1),
      1200
    ) AS auto_tier_cut_bps,
    COALESCE(
      p.vendor_cut_bps_override::int,
      (SELECT cut_bps FROM public.vendor_billing
       WHERE vendor_id = p.id AND period_start <= current_date
       ORDER BY period_start DESC LIMIT 1),
      1200
    ) AS effective_cut_bps
  FROM public.profiles p
  WHERE p.role = 'vendor'
  ORDER BY p.display_name NULLS LAST;
$$;

-- Lock down: only admins can call these
REVOKE EXECUTE ON FUNCTION public.admin_set_vendor_cut_override FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_get_vendors_cut_info FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_vendor_cut_override TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_vendors_cut_info TO service_role;
```

### 5. Admin UI — `app/admin/_components/VendorCutOverride.tsx` (new) + `app/admin/actions.ts`

In `app/admin/page.tsx`, add a new section "Vendor commission overrides" between the existing Vendors table and Subscriptions table. List shows:

| Vendor | Auto-tier cut | Override | Effective | Action |
|---|---|---|---|---|
| AcmeApps | 8% (Tier 2) | — | **8%** | [Set override] |
| LaunchPartner | 5% (Tier 3) | **0%** | **0%** | [Edit] [Clear] |

Click [Set override] / [Edit] → modal with:
- Input: cut in bps (or % with conversion shown)
- Textarea: reason (required, ≥10 chars)
- Save → calls server action `setVendorCutOverrideAction({ vendorId, newBps, reason })`
- "Clear override" sets bps to null

Server action signature in `app/admin/actions.ts`:
```ts
"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { setVendorCutOverride } from "@/lib/services/admin";

const Schema = z.object({
  vendorId: z.string().uuid(),
  newBps: z.number().int().min(0).max(5000).nullable(),
  reason: z.string().min(10).max(500),
});

export async function setVendorCutOverrideAction(input: z.infer<typeof Schema>) {
  const parsed = Schema.parse(input);
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("unauthenticated");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (profile?.role !== "admin") throw new Error("forbidden");

  await setVendorCutOverride({
    adminId: user.id,
    vendorId: parsed.vendorId,
    newBps: parsed.newBps,
    reason: parsed.reason,
  });

  revalidatePath("/admin");
}
```

### 6. Vendor dashboard — show effective cut transparently

In `app/vendor/page.tsx` (or earnings section), display the effective platform cut. If override is active, show a small badge:

```tsx
{effectiveCut.override !== null ? (
  <Badge variant="info">
    Custom rate {(effectiveCut.bps / 100).toFixed(2)}% (set by admin)
  </Badge>
) : (
  <span>Tier {tier} — {(effectiveCut.bps / 100).toFixed(2)}%</span>
)}
```

The vendor MUST be able to see what cut they're actually paying. No silent overrides.

### 7. Tests — `lib/stripe/__tests__/transfers.test.ts` + `lib/services/__tests__/admin.test.ts` (new)

```ts
// transfers.test.ts — new cases
it("getVendorCutBps returns override when set, ignoring vendor_billing", async () => {
  // Seed: vendor with vendor_billing tier 1 (1200) AND override = 0
  // Expect: 0
});

it("getVendorCutBps returns vendor_billing.cut_bps when override is null", async () => {
  // Seed: vendor with tier 2 (800) and override null
  // Expect: 800
});

it("transferVendorShare uses override cut_bps correctly (0% case)", async () => {
  // Seed override = 0 → vendor gets 100% of amount
  // amount=10000, cutBps=0 → vendorShareCents = 10000
});

// admin.test.ts — new file
it("setVendorCutOverride writes profile + audit_log atomically", async () => {});
it("setVendorCutOverride rejects reason <10 chars", async () => {});
it("setVendorCutOverride rejects bps outside 0..5000", async () => {});
it("setVendorCutOverride rejects when target is not a vendor", async () => {});

// rls.test.ts — add
it("non-admin user CANNOT update vendor_cut_bps_override on their own profile", async () => {
  // Login as vendor. Try .update({ vendor_cut_bps_override: 0 }).eq('id', self).
  // Expect: error from trigger.
});

it("non-admin user CANNOT update vendor_cut_bps_override on another profile", async () => {});
```

### 8. SPEC.md updates

Add to §3 (Vendor pricing):
> **Manual override.** Admin may set a per-vendor `vendor_cut_bps_override` (0–5000 bps) that bypasses tier calculation entirely. The override is read by live transfers and the vendor dashboard but does NOT alter `vendor_billing.cut_bps` written by the monthly cron (preserves tier history). Every change writes an `audit_log` entry with old/new values and required reason. Only admins can set; vendors cannot self-set (RLS trigger enforces).

Add to §8 (defaults):
> Order of precedence for vendor cut: (1) `profiles.vendor_cut_bps_override` if non-null, (2) latest `vendor_billing.cut_bps` ≤ today, (3) Tier 1 default (1200 bps).

### 9. CLAUDE.md updates

Under "Folder structure" → `lib/services/admin.ts`: add `setVendorCutOverride, getVendorsWithCutInfo`.
Under "Guardrails" → add:
> Vendor cut precedence: `profiles.vendor_cut_bps_override` (admin-set, audited) → `vendor_billing.cut_bps` (auto-tier) → 1200 default. Vendors cannot self-set the override (DB trigger blocks).

---

## Verify

```bash
supabase db reset                                    # apply new migration
npm run types                                        # regen types/supabase.ts
npm run typecheck
npm test -- --run lib/stripe/__tests__/transfers.test.ts
npm test -- --run lib/services/__tests__/admin.test.ts
npm test -- --run lib/services/__tests__/rls.test.ts
npm run dev                                          # smoke test admin UI
```

Manual smoke:
1. Log in as admin → /admin → see "Vendor commission overrides" section
2. Set vendor X to 0% with reason "Launch partner contract Q2 2026" → save → vendor row shows "0%" badge
3. Trigger a test invoice for vendor X → confirm transfer math gives vendor 100% of net
4. Log in as vendor X → /vendor → see "Custom rate 0.00% (set by admin)" badge
5. Log in as vendor X → open Supabase Studio → try to update own `vendor_cut_bps_override` → fails with trigger error
6. /admin → click "Clear override" on vendor X → effective cut returns to auto-tier
7. Open audit log → see both set + clear entries with reason

## Caution

- **Don't forget the SQL trigger.** Without it, a vendor with a valid Supabase JWT can `update profiles set vendor_cut_bps_override = 0 where id = self`. The trigger is the only thing preventing privilege escalation here — RLS column-level grants on Supabase Postgres are not granular enough for safe handling alone.
- **Don't backfill existing `vendor_billing` rows.** Override is forward-only and orthogonal to historical billing. Touching past `vendor_billing` rows would break tier history and reconciliation.
- **Reseller and affiliate flows are unaffected.** Reseller sales use `min_price + markup` math (current model); affiliate sales clamp by vendor's `affiliate_commission_bps`. The override only changes the platform's cut on **direct sales** (and, after #29, the implicit cut when vendor sets their WL toggle).
- **The 0% case is real and must work.** Test it explicitly — `cutBps = 0` means `transferVendorShare` sends 100% of the charge amount to the vendor. Don't introduce a `> 0` guard anywhere.
- **The 5000 bps cap is a sanity guard, not a business rule.** If someone tries to set 7000 (70%), it's almost certainly a typo (7% intended → should be 700). Reject it loudly.
- **Audit log entries must be immutable.** Don't add an UPDATE policy on `audit_log` — once written, only admin reads, never edits.
