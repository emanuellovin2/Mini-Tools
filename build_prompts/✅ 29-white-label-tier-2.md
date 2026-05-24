# Task #29 — White-label Tier 2 (vendor reseller-openness toggle + per-offer WL branding)

> **Before starting:** read `ENGINEERING.md`, `SPEC.md` §3, §4b, §6, §7, §11. Read [build_prompts/27-manual-vendor-commission-override.md](build_prompts/27-manual-vendor-commission-override.md) and [build_prompts/28-security-hardening-v2.md](build_prompts/28-security-hardening-v2.md) — both must be shipped first.
> **Definition of Done:** schema + RLS in place, `computeResellerSplit` rewritten with single-commission + WL kickback math (`VENDOR_WL_KICKBACK_BPS=3333`) + property-based invariant test (sum invariant + non-negative platform cut), vendor toggle UI (3-state), reseller Tier 2 upgrade flow with per-offer Stripe subscription + 14-day trial, brand auto-approval with homoglyph deny-list, subdomain storefront routing in `proxy.ts`, Stripe Connect branding sync, Tier 2 email branding (subject prefix + header logo), buyer dashboard stays platform-branded, migration backfills existing reseller subscriptions to grandfathered `open_to_resellers` (exact-floor status quo, no surprise kickback), comprehensive tests on every money path + adversarial RLS checks, SPEC.md updated, Verify step passes.

**Phase 4 — Wave 7. Depends on: #27 (admin override precedence stays unchanged — confirms our `getVendorCutBps` precedence is still correct), #28 (CSP, audit log helper, rate limiting must be live before opening new attack surface via host-based routing). Blocks: #30 (custom domain CNAME + email domain — explicitly deferred).**

---

## Context

Today reseller sales work as follows ([SPEC §4b](SPEC.md), [lib/stripe/transfers.ts → computeResellerSplit](lib/stripe/transfers.ts)):
- **Reseller pays $9.99/mo flat base subscription** (platform Stripe subscription on platform account, NOT Connect) — lowered from the previous $19/mo to reduce entry friction. 30-day free trial unchanged (#22).
- On reseller invoice: vendor gets exact `vendor_floor_snapshot_cents`, platform takes 5% of markup, reseller keeps the rest
- Storefront is `/r/<reseller-slug>/<offer-slug>` (path-based, full platform branding)
- [SPEC.md:140](SPEC.md:140) says **"No white-label / rebranding."** — this task reverses that decision.

**Three changes are introduced:**

### (A) Vendor toggle — 3-state, default `open_to_resellers`

Vendor controls whether resellers can list their apps and at which tier. **Default is Tier 1 open** (matches the current implicit behavior — any app with `min_price_cents` set is reseller-eligible). Direct sales **always** use the 12/8/5/3% tier system (status quo, unchanged) regardless of toggle. **Vendor never pays a per-sale tax on reseller sales** — vendor always receives at least the exact `floor`.

| Toggle | Direct sales cut | Tier 1 reseller? | Tier 2 (WL) reseller? | Vendor receives per reseller sale |
|---|---|---|---|---|
| `closed` | 12/8/5/3% | ❌ | ❌ | n/a |
| `open_to_resellers` (default) | 12/8/5/3% | ✅ | ❌ | exact `floor` (status quo) |
| `open_to_wl` | 12/8/5/3% | ✅ | ✅ | `floor + 33% of platform's reseller commission` (kickback) |

`open_to_wl` is a strict superset of `open_to_resellers` + carrot: vendor receives 1/3 of platform's reseller-side commission as a kickback on every reseller sale (Tier 1 OR Tier 2). Strict improvement vs status quo on all paths — vendor never loses money by opening up further.

**No per-reseller approval, no engagement guard, no markup share, no vendor tax.** Resellers self-enroll. Vendor's toggle is the only gate. Reseller economics are identical across all toggle states (the kickback comes from platform's margin, not reseller's).

### (B) Reseller Tier 2 upgrade (per-offer)

- Reseller pays an additional $29/mo per Tier 2 WL'd offer (separate Stripe subscription per upgrade, on the platform account)
- 14-day free trial **per offer** (each upgrade has its own `trial_end`)
- Platform cut on markup drops from 5% → 2.5% for Tier 2 sales
- Reseller uploads logo (PNG/JPG/WebP only) + brand color (`#RRGGBB`) + display name **per offer** (can override the global branding from (D)) → applied to:
  - Storefront subdomain (`<reseller-slug>.<base-host>`)
  - Stripe Checkout (via Connect branding API — per-account sync, last-write-wins)
  - Buyer email subject prefix + header logo
  - "Powered by [PLATFORM]" footer hidden (small "Hosted by [PLATFORM]" legal disclosure only)
- Buyer dashboard remains platform-branded — anti-poaching boundary preserved (SPEC §6)

**Auto-approval with homoglyph deny-list.** No manual admin review. Reseller is liable per TOS for trademark infringement.

### (D) Tier 1 mini-branding (global, free)

Every reseller with an active base subscription can set **global** branding fields (logo + color + display name) on their profile — applied to **all** Tier 1 storefront pages on the platform path (`platforma.com/r/<slug>/<offer>`). No per-offer config, no extra cost.

Tier 1 mini-branding includes:
- Storefront header band with reseller logo + display name + brand color accent (above the platform navbar, below the buyer's view)
- Storefront URL stays path-based on platform domain (NOT subdomain — subdomain remains exclusive Tier 2 value)
- Stripe Checkout = **platform-branded** (no Connect sync at Tier 1 — that's $29/app Tier 2 territory because branding sync has real Stripe API + image-hosting cost)
- Email "from" + subject + template = **platform-branded** entirely (Tier 2 unlocks email customization)
- "Powered by [PLATFORM]" footer **stays visible** (Tier 1 distinction)

When a reseller upgrades an offer to Tier 2, the per-offer branding form is **pre-filled** from global values — reseller can override per offer or accept defaults. This makes Tier 2 upgrade frictionless ("you already have your logo set; just confirm").

**Validation:** global branding fields go through the same homoglyph deny-list as Tier 2 per-offer fields. Same magic-bytes check on logo upload, same color regex, same display name length limits.

**Where the value separation lives:**

| Surface | Tier 1 + global branding | Tier 2 per-offer |
|---|---|---|
| Storefront URL | `platforma.com/r/<slug>/<offer>` | `<slug>.platforma.com/<offer>` |
| Storefront header | Logo + name (global) | Full branding (per-offer, can differ from global) |
| "Powered by [PLATFORM]" | visible footer | hidden |
| Stripe Checkout branding | platform | per-reseller Connect sync |
| Email subject + header | platform | per-offer display name + logo |
| Cost | $0 (included in base) | $29/mo per offer + 14-day trial |

### (C) Payment split — single stream + WL kickback to vendor

On a reseller invoice, platform takes ONE cut from reseller-side markup. On `open_to_wl` subscriptions, platform redistributes **1/3 (3333 bps)** of that cut back to the vendor as a kickback. Reseller economics are identical regardless of vendor toggle.

- **Reseller-side platform commission** = `floor(markup × 500 / 10000)` (Tier 1) or `floor(markup × 250 / 10000)` (Tier 2)
- **WL kickback to vendor** = `floor(platform_commission × 3333 / 10000)` if `vendor_openness_snapshot = 'open_to_wl'`, else 0
- **Vendor share** = `floor + kickback`
- **Platform net** = `platform_commission − kickback`
- **Reseller share** = `amount − vendor_share − platform_net` (= `markup − platform_commission`, the residual absorbs rounding)

Worked example ($50 sell, $20 floor, $30 markup):

| Scenario | Vendor net | Reseller net | Platform |
|---|---|---|---|
| Tier 1, vendor=open_to_resellers | **$20** (status quo) | $30 − $1.50 = **$28.50** | **$1.50** |
| Tier 1, vendor=open_to_wl | $20 + $0.49 kickback = **$20.49** | **$28.50** | $1.50 − $0.49 = **$1.01** |
| Tier 2, vendor=open_to_wl | $20 + $0.24 kickback = **$20.24** | $30 − $0.75 = **$29.25** | $0.75 − $0.24 = **$0.51** (+ $29/mo metered) |

The kickback is the **only** economic difference between `open_to_resellers` and `open_to_wl` on Tier 1 sales. On Tier 2 sales (only allowed when `open_to_wl`), kickback applies on the 2.5% Tier 2 commission. Reseller's $28.50 / $29.25 numbers are independent of vendor toggle — adoption-safe.

---

## What changes

### 1. Schema — `supabase/migrations/YYYYMMDD_wl_tier2.sql`

```sql
-- ===========================================================
-- (A) Vendor reseller-openness toggle (3-state enum). Default open_to_resellers.
-- ===========================================================
CREATE TYPE public.vendor_reseller_openness AS ENUM (
  'closed', 'open_to_resellers', 'open_to_wl'
);

ALTER TABLE public.profiles
  ADD COLUMN reseller_openness public.vendor_reseller_openness
    NOT NULL DEFAULT 'open_to_resellers';

COMMENT ON COLUMN public.profiles.reseller_openness IS
  'Vendor toggle for reseller program. closed = no resellers; open_to_resellers (default) = Tier 1 only, vendor receives exact floor on reseller sales (status quo); open_to_wl = Tier 1 + Tier 2 allowed, vendor receives floor + 33% of platform commission as kickback. Direct sales always use the 12/8/5/3% tier system regardless of this toggle. Vendor never pays a per-sale tax in any state.';

-- Index for vendors filtering by openness (e.g., reseller browsing marketplace for listable apps)
CREATE INDEX profiles_reseller_openness_idx ON public.profiles (reseller_openness)
  WHERE role = 'vendor';

-- ===========================================================
-- (A.1) Reseller global mini-branding — applied to all Tier 1 storefront pages (free, included in base sub)
-- ===========================================================
ALTER TABLE public.profiles
  ADD COLUMN wl_global_logo_url     text,
  ADD COLUMN wl_global_brand_color  text
    CHECK (wl_global_brand_color IS NULL OR wl_global_brand_color ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN wl_global_display_name text
    CHECK (wl_global_display_name IS NULL
      OR (char_length(wl_global_display_name) BETWEEN 2 AND 60));

COMMENT ON COLUMN public.profiles.wl_global_logo_url IS
  'Optional reseller global logo applied to Tier 1 storefront mini-header. NULL = use platform branding. Same magic-bytes + deny-list validation as Tier 2 per-offer logos.';

-- Mini-branding is "all or nothing" — either all three set or none. Prevents weird half-states.
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_wl_global_complete CHECK (
    (wl_global_logo_url IS NULL AND wl_global_brand_color IS NULL AND wl_global_display_name IS NULL)
    OR
    (wl_global_logo_url IS NOT NULL AND wl_global_brand_color IS NOT NULL AND wl_global_display_name IS NOT NULL)
  );

-- ===========================================================
-- (B) Reseller offer — Tier 2 fields
-- ===========================================================
ALTER TABLE public.reseller_offers
  ADD COLUMN wl_tier smallint NOT NULL DEFAULT 1
    CHECK (wl_tier IN (1, 2)),
  ADD COLUMN wl_logo_url text,
  ADD COLUMN wl_brand_color text
    CHECK (wl_brand_color IS NULL OR wl_brand_color ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN wl_display_name text,
  -- Each Tier 2 offer = its own Stripe subscription on the platform account ($29/mo, 14-day trial).
  -- Separate subscription (not a quantity-based item) so each upgrade gets independent trial expiry.
  ADD COLUMN wl_stripe_subscription_id text,
  ADD COLUMN wl_trial_end timestamptz,
  ADD COLUMN wl_status text NOT NULL DEFAULT 'inactive'
    CHECK (wl_status IN ('inactive', 'trialing', 'active', 'past_due', 'canceled')),
  ADD COLUMN wl_last_sale_at timestamptz;

CREATE UNIQUE INDEX reseller_offers_wl_stripe_sub_unique
  ON public.reseller_offers (wl_stripe_subscription_id)
  WHERE wl_stripe_subscription_id IS NOT NULL;

CREATE INDEX reseller_offers_wl_tier_idx ON public.reseller_offers (wl_tier) WHERE wl_tier = 2;

-- Tier 2 requires branding + paying Stripe subscription
ALTER TABLE public.reseller_offers
  ADD CONSTRAINT reseller_offers_wl_branding_complete
    CHECK (
      wl_tier = 1
      OR (
        wl_tier = 2
        AND wl_logo_url IS NOT NULL
        AND wl_brand_color IS NOT NULL
        AND wl_display_name IS NOT NULL
        AND char_length(wl_display_name) BETWEEN 2 AND 60
        AND wl_stripe_subscription_id IS NOT NULL
        AND wl_status IN ('trialing', 'active')
      )
    );

-- ===========================================================
-- (C) Subscription snapshots — both wl_tier AND vendor's openness at subscribe time
-- ===========================================================
ALTER TABLE public.subscriptions
  ADD COLUMN reseller_wl_tier_snapshot smallint
    CHECK (reseller_wl_tier_snapshot IS NULL OR reseller_wl_tier_snapshot IN (1, 2)),
  ADD COLUMN vendor_openness_snapshot public.vendor_reseller_openness;

ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_reseller_snapshots_check
    CHECK (
      (reseller_id IS NULL AND reseller_wl_tier_snapshot IS NULL AND vendor_openness_snapshot IS NULL)
      OR
      (reseller_id IS NOT NULL AND reseller_wl_tier_snapshot IS NOT NULL AND vendor_openness_snapshot IN ('open_to_resellers','open_to_wl'))
    );

-- ===========================================================
-- (D) Migration backfill — grandfather existing reseller subs at status quo (no kickback)
-- ===========================================================
-- Existing reseller subscriptions paid 0% vendor tax and received no kickback (status quo: vendor got exact floor).
-- The model preserves vendor's exact-floor outcome on open_to_resellers, so backfill to that.
-- If a vendor later flips their profile to open_to_wl, existing grandfathered subs stay at open_to_resellers
-- (immutable snapshot) — vendor's economics on old subs do not change retroactively. Only NEW subs use the live toggle.
UPDATE public.subscriptions
  SET reseller_wl_tier_snapshot = 1,
      vendor_openness_snapshot  = 'open_to_resellers'    -- grandfather: exact-floor status quo
  WHERE reseller_id IS NOT NULL
    AND reseller_wl_tier_snapshot IS NULL;
```

### 2. `lib/stripe/transfers.ts` — `computeResellerSplit()` rewrite (single-stream + WL kickback)

```ts
// WL kickback rate: vendor receives 1/3 of platform's reseller-side commission on open_to_wl sales.
// Exposed as a const for tunability — DO NOT inline. Future adjustments (20%/50%) are a one-line config change.
export const VENDOR_WL_KICKBACK_BPS = 3333;   // 33.33% (one third)

export interface ResellerSplit {
  vendorShareCents: number;     // = floor + kickback (or = amount in Stripe-fee edge case)
  platformCutCents: number;     // = platformCommission − kickback
  resellerShareCents: number;   // = amount − vendor − platform (residual; absorbs rounding)
}

export function computeResellerSplit(args: {
  amountCents: number;                                     // net (after Stripe fees, per #17)
  vendorFloorCents: number;                                // snapshot from subscription
  wlTier: 1 | 2;                                           // snapshot
  vendorOpenness: 'open_to_resellers' | 'open_to_wl';      // snapshot — NEVER read live; uses snapshot column
}): ResellerSplit {
  const { amountCents, vendorFloorCents, wlTier, vendorOpenness } = args;

  // Stripe-fee edge: net < floor on tiny invoices (#17). Give 100% to vendor, others 0.
  if (amountCents < vendorFloorCents) {
    return { vendorShareCents: amountCents, platformCutCents: 0, resellerShareCents: 0 };
  }

  // Invariant guard: Tier 2 sales are only valid for vendors opted into WL.
  // The only way to reach here with (wlTier=2, vendorOpenness=open_to_resellers) is a logic bug.
  if (wlTier === 2 && vendorOpenness !== 'open_to_wl') {
    throw new Error(`invariant: Tier 2 sale requires vendorOpenness=open_to_wl, got ${vendorOpenness}`);
  }

  const markup = amountCents - vendorFloorCents;
  const resellerSideBps = wlTier === 2 ? 250 : 500;    // 2.5% Tier 2, 5% Tier 1

  // Platform's gross commission from reseller markup (floored, integer-safe)
  const platformCommission = Math.floor((markup * resellerSideBps) / 10_000);

  // WL kickback — only when vendor opted into WL. Math.floor caps each step independently
  // so very small commissions (e.g. on $0.10 markup) yield zero kickback; documented behavior.
  const vendorKickback = vendorOpenness === 'open_to_wl'
    ? Math.floor((platformCommission * VENDOR_WL_KICKBACK_BPS) / 10_000)
    : 0;

  const vendorShare = vendorFloorCents + vendorKickback;
  const platformCut = platformCommission - vendorKickback;
  const resellerShare = amountCents - vendorShare - platformCut;   // = markup − platformCommission (residual)

  // Sum invariant assertions (must hold by construction; runtime guard catches future regressions)
  if (resellerShare < 0) {
    throw new Error(`computeResellerSplit: negative reseller share (amount=${amountCents}, vendor=${vendorShare}, platform=${platformCut})`);
  }
  if (platformCut < 0) {
    throw new Error(`computeResellerSplit: negative platform cut (kickback > commission)`);
  }
  if (vendorShare + platformCut + resellerShare !== amountCents) {
    throw new Error(`computeResellerSplit: sum invariant broken (sum=${vendorShare + platformCut + resellerShare}, expected=${amountCents})`);
  }

  return { vendorShareCents: vendorShare, platformCutCents: platformCut, resellerShareCents: resellerShare };
}
```

**Tests required** ([lib/stripe/__tests__/reseller.test.ts](lib/stripe/__tests__/reseller.test.ts)) — replace existing tests:

```ts
// Worked examples — amounts in cents
it("Tier 1 open_to_resellers (status quo): $50/$20 → vendor=2000, platform=150, reseller=2850", () => {});
it("Tier 1 open_to_wl with kickback: $50/$20 → vendor=2049, platform=101, reseller=2850", () => {
  // markup=3000 cents; platformCommission = floor(3000*500/10000) = 150
  // kickback = floor(150*3333/10000) = floor(49.995) = 49
  // vendor = 2000 + 49 = 2049; platform = 150 - 49 = 101; reseller = 5000-2049-101 = 2850 ✓
});
it("Tier 2 open_to_wl with kickback: $50/$20 → vendor=2024, platform=51, reseller=2925", () => {
  // markup=3000; platformCommission = floor(3000*250/10000) = 75
  // kickback = floor(75*3333/10000) = floor(24.9975) = 24
  // vendor = 2024; platform = 51; reseller = 5000-2024-51 = 2925 ✓
});

// Edge cases
it("amount < floor (Stripe fee edge): vendor gets full amount, platform/reseller 0", () => {});
it("amount == floor (no markup): vendor=floor, platform=0, reseller=0", () => {});
it("1¢ markup, Tier 1 open_to_wl: kickback floors to 0, no error", () => {
  // markup=1; platformCommission = floor(1*500/10000) = 0; kickback = 0; reseller gets the 1¢
});
it("tiny markup with kickback floors to 0", () => {
  // markup=50¢, Tier 1 open_to_wl: platformCommission=2, kickback=floor(2*3333/10000)=0
  // Documented: small commissions yield zero kickback. Acceptable.
});

// Invariant guards
it("throws when wlTier=2 but vendorOpenness=open_to_resellers (logic bug)", () => {});
it("throws on negative platform cut (kickback > commission — should be impossible by construction)", () => {});

// Property-based fuzz — 1000 random tuples, sum invariant must hold
it("[fuzz 1000×] vendor + platform + reseller === amount for all valid inputs", () => {
  // amount: 100..10_000_000
  // floor: 0..amount
  // wlTier: 1 or 2 (2 only paired with open_to_wl)
  // openness: open_to_resellers (Tier 1 only) | open_to_wl (either tier)
  // ALSO assert: platformCut >= 0 always
});

// Kickback boundary
it("kickback never exceeds platformCommission (platform cut stays non-negative)", () => {
  // Hold for VENDOR_WL_KICKBACK_BPS in [0, 10000]. At 10000 (100%), kickback === commission, platform=0.
});
```

### 3. `lib/stripe/transfers.ts` — `transferResellerVendorFloor()` and `transferResellerShare()`

These already exist. Audit them to confirm they take the cents value from `computeResellerSplit` (no internal recomputation). Add a regression test: `transferResellerVendorFloor(50_00 - 30_00 × 0.03 ...)` matches the value `computeResellerSplit` returns for the same inputs.

The webhook handler ([lib/stripe/webhook-handlers.ts](lib/stripe/webhook-handlers.ts)) on `invoice.paid` for a reseller-sold subscription:
1. Read `subscriptions` row: `vendor_floor_snapshot_cents`, `reseller_wl_tier_snapshot`, `vendor_openness_snapshot`, `reseller_id`, vendor's `stripe_account_id`, reseller's `stripe_account_id`
2. Compute net (per #17) → call `computeResellerSplit`
3. Issue TWO Connect transfers:
   - `transferResellerVendorFloor`: `vendorShareCents` → vendor's account
   - `transferResellerShare`: `resellerShareCents` → reseller's account
   - Platform retains `platformCutCents`
4. Update `reseller_offers.wl_last_sale_at = now()`
5. Log via `logMoneyFlow` with `wl_tier`, `vendor_openness`, all three cents values

### 4. Vendor toggle — `app/vendor/page.tsx` + `app/vendor/actions.ts`

New section "Reseller program" with 3-state radio:
- Closed (no resellers)
- Open to resellers (default) — "Resellers can sell your apps with their own pricing markup. You receive the exact `floor` you set on every reseller sale (status quo). Direct sales unchanged."
- Open to white-label — "Same as above, PLUS resellers can upgrade individual offers to Tier 2 with their own branding (logo, color, name). You receive `floor + 1/3 of platform's commission` as a kickback on every reseller sale (Tier 1 AND Tier 2). Strict improvement vs status quo — vendor never loses by opening up."

UI shows the live math on the toggle card based on the vendor's last 30 days of reseller sales: "Estimated +$X/mo if you switch to open_to_wl (assuming same volume)." Pull from `subscription_stats` aggregate, no buyer PII.

Server action `setResellerOpennessAction({ openness })`:
- Validates with Zod (enum)
- Writes to `profiles.reseller_openness`
- Audit log via `writeAuditLog` from #28: action=`vendor_reseller_openness_changed`, metadata: `{old, new}`
- **No effect on existing reseller subscriptions** — they keep their `vendor_openness_snapshot`. Only new subscribes use the new value.

UI also shows a list of "Active reseller partners" — read-only display (no approval flow):
- Reseller display_name, app, tier badge, MRR via this offer (from `subscription_stats` view, no buyer PII)

**Flipping from open_to_wl back to open_to_resellers:** UI confirmation modal: "X existing Tier 2 subscriptions will continue with their snapshot pricing (kickback stays in effect for the lifetime of those subs). New Tier 2 upgrades will be blocked. New Tier 1 sales going forward will receive only the floor (no kickback). Continue?" Set on profile; existing Tier 2 offers remain `wl_tier=2` and continue running until canceled or wl subscription lapses.

**Flipping to closed:** confirmation: "Y active reseller offers will continue serving existing subscribers, but new sales through them will be blocked." On flip, set `reseller_offers.status='paused'` for all offers on this vendor's apps. Existing subscriptions are NOT canceled (anti-buyer-disruption).

### 5. Reseller Tier 2 upgrade — `app/reseller/offers/actions.ts` + UI

Each offer card on `/reseller/offers` shows:
- Tier 1 badge with "Upgrade to white-label ($29/mo, 14-day free trial)"
- On click → modal with:
  - Logo upload (PNG/JPG/WebP, max 1MB, magic-bytes verified) — **pre-filled from `profiles.wl_global_logo_url` if set**
  - Brand color picker (`#RRGGBB`) — **pre-filled from `profiles.wl_global_brand_color`**
  - Display name input (2-60 chars) — **pre-filled from `profiles.wl_global_display_name`**
  - Reseller can override any field per-offer or accept defaults from global → "Use global brand" toggle in the modal
  - Auto-validation against deny-list before submit (instant client-side feedback + server-side enforcement)

### 5.1. Reseller global mini-branding — `app/reseller/brand/page.tsx` + actions

New page under reseller dashboard. Single form:
- Logo upload (PNG/JPG/WebP, 1MB max)
- Brand color picker (`#RRGGBB`)
- Display name (2-60 chars)
- Either ALL three set or all cleared (matches DB constraint) — UI enforces with a single "Clear branding" button

Server action `setResellerGlobalBrandingAction({ logoFileKey, brandColor, displayName })`:
- Same validation as Tier 2 upgrade (deny-list, magic-bytes, color regex)
- Available to any reseller with active|trialing base subscription — no Tier 2 required
- Updates all 3 profile columns atomically; audit log entry via `writeAuditLog` from #28: action=`reseller_global_branding_updated`

A `clearResellerGlobalBrandingAction()` sets all 3 to NULL (storefronts revert to platform branding instantly).

**No backfill to Tier 2 offers:** updating global branding does NOT mutate already-upgraded `reseller_offers.wl_logo_url` etc. The reseller chose those per-offer at upgrade time; they're immutable inputs (only the reseller can edit per-offer branding via a separate "Edit Tier 2 branding" action). This avoids accidentally re-branding a live Tier 2 offer when reseller updates their global logo.

Server action `upgradeOfferToWLTier2Action({ offerId, logoFileKey, brandColor, displayName })`:

```ts
// In lib/services/reseller.ts
export async function upgradeOfferToWLTier2(args: {
  resellerId: string;
  offerId: string;
  logoFileKey: string;    // Supabase Storage path; URL constructed server-side
  brandColor: string;
  displayName: string;
}): Promise<void> {
  // 1. Validate: reseller owns offer; their $9.99/mo base sub is active|trialing
  // 2. Validate brand inputs:
  //    - color matches /^#[0-9a-fA-F]{6}$/
  //    - displayName passes deny-list check (see step 6 below)
  //    - logoFileKey points to a file that exists in Storage, content-type validated, magic-bytes match
  // 3. Verify the vendor of this offer's app has reseller_openness = 'open_to_wl'
  //    (if not: reject with "vendor has not opted into white-label")
  // 4. Create a NEW Stripe subscription on the platform account:
  //    {
  //      customer: reseller.stripe_customer_id,
  //      items: [{ price: STRIPE_WL_TIER2_PRICE_ID }],
  //      trial_period_days: 14,
  //      metadata: { reseller_id, offer_id, kind: 'wl_tier2' },
  //      payment_behavior: 'default_incomplete',
  //    }
  //    Reseller already has card on file from $9.99 base sub — no checkout needed
  // 5. Build public logo URL from logoFileKey (Supabase public bucket)
  // 6. UPDATE reseller_offers SET
  //      wl_tier = 2,
  //      wl_logo_url, wl_brand_color, wl_display_name,
  //      wl_stripe_subscription_id = <stripe sub id>,
  //      wl_trial_end = now() + 14 days,
  //      wl_status = 'trialing',
  //      status = 'active' (if was draft)
  //    WHERE id = offerId
  // 7. Sync Stripe Connect branding for the reseller's connected account
  //    (logo + primary_color via stripe.accounts.update — see step 7 below)
  // 8. Audit log: action='wl_tier2_upgraded', entity=reseller_offer, metadata: { offer_id, display_name }
  // 9. All in a single transaction (Supabase RPC OR Stripe-then-DB with idempotent retry on DB failure
  //    — if Stripe succeeds but DB fails, the cron in step 9 cleans up dangling Stripe subs)
}

export async function cancelWLTier2(args: { resellerId: string; offerId: string }): Promise<void> {
  // 1. Cancel the Stripe sub (at_period_end if active; immediate if still trialing)
  // 2. UPDATE reseller_offers: wl_tier=1, wl_status='canceled' (keep branding columns for audit; mark inactive)
  // 3. Storefront falls back to platform-branded path-based URL (the subdomain returns 404 for this offer)
  // 4. Audit log
}
```

### 6. Brand deny-list — `lib/validation/wl-brand.ts` (new)

Auto-approval relies on this gate. Block:
- Known platform/payment/tech brands: `stripe`, `paypal`, `square`, `apple`, `google`, `microsoft`, `meta`, `facebook`, `amazon`, `aws`, `vercel`, `supabase`, `cloudflare`, `openai`, `anthropic`, `claude`, `chatgpt`, `gpt`, `<PLATFORM>` (your platform's own name)
- Generic risky terms: `admin`, `official`, `support`, `verify`, `secure`, `security`, `billing`, `payment`
- Reserved subdomains: `www`, `api`, `admin`, `auth`, `app`, `dashboard`, `staging`, `dev`, `test`, `mail`, `ftp`

Normalization (run BEFORE deny-list lookup):
```ts
function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')                                    // decomposes Cyrillic homoglyphs to Latin where possible
    .replace(/[^a-z0-9]/g, '')                            // strip spaces, punctuation, emojis
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/5/g, 's').replace(/3/g, 'e')  // common substitutions
    .replace(/[Ѐ-ӿ]/g, '');                     // strip any remaining Cyrillic chars (foreceful)
}

export function validateWLBrand(displayName: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = displayName.trim();
  if (trimmed.length < 2 || trimmed.length > 60) return { ok: false, reason: 'length must be 2-60 chars' };

  const norm = normalize(trimmed);
  if (norm.length < 2) return { ok: false, reason: 'must contain at least 2 alphanumeric chars' };

  for (const banned of BRAND_DENY_LIST) {
    if (norm.includes(normalize(banned))) {
      return { ok: false, reason: `display name resembles a reserved/blocked brand (${banned})` };
    }
  }
  return { ok: true };
}
```

Apply in both client (instant feedback) and server (enforcement). TOS update: reseller is liable for trademark infringement on uploaded brand assets.

### 7. Stripe Connect branding sync — `lib/stripe/connect.ts`

```ts
export async function syncResellerConnectBranding(args: {
  resellerStripeAccountId: string;
  logoUrl: string;          // public URL from Supabase Storage
  brandColor: string;       // #RRGGBB
  displayName: string;
}): Promise<void> {
  // 1. Download the logo and upload to Stripe Files API (purpose: business_logo)
  //    Stripe needs the file uploaded to their service; can't reference an external URL.
  const file = await stripe.files.create({
    purpose: 'business_logo',
    file: { data: <fetched buffer>, name: 'logo.png', type: 'application/octet-stream' },
  }, { stripeAccount: args.resellerStripeAccountId });

  // 2. Update the connected account's branding
  await stripe.accounts.update(args.resellerStripeAccountId, {
    settings: {
      branding: {
        logo: file.id,
        primary_color: args.brandColor,
      },
    },
    business_profile: { name: args.displayName },
  });
}
```

Called from `upgradeOfferToWLTier2` (step 7 of that function). Idempotent on Stripe's side — repeated calls overwrite branding. If reseller has multiple Tier 2 offers, the **most recent** upgrade's branding wins on Stripe (Stripe accounts have one branding setting, not per-offer). Document this caveat in UI: "Stripe Checkout shows the branding from your most recently upgraded offer. To customize per-app branding at checkout, contact support." (deferred — future enhancement could use separate Connect sub-accounts).

### 8. Storefront subdomain routing — `proxy.ts`

```ts
const BASE_HOST = new URL(process.env.NEXT_PUBLIC_APP_URL!).host;
const RESERVED_SUBDOMAINS = new Set([
  'www', 'api', 'admin', 'auth', 'app', 'dashboard', 'support', 'help',
  'mail', 'email', 'ftp', 'ns1', 'ns2', 'staging', 'dev', 'test', 'prod',
]);

export async function middleware(req: NextRequest) {
  const host = (req.headers.get('host') ?? '').toLowerCase().split(':')[0];

  if (host !== BASE_HOST && host.endsWith(`.${BASE_HOST}`)) {
    const slug = host.slice(0, host.length - BASE_HOST.length - 1);
    if (RESERVED_SUBDOMAINS.has(slug)) {
      return NextResponse.next();    // pass through; treat as standard route
    }
    // Internal rewrite to the WL storefront route
    const url = req.nextUrl.clone();
    url.pathname = `/_wl/${slug}${url.pathname}`;
    return NextResponse.rewrite(url);
  }
  // Otherwise: existing auth + role routing
  return existingProxyLogic(req);
}
```

Add `app/_wl/[reseller-slug]/page.tsx` (root of subdomain → list of that reseller's Tier 2 offers) and `app/_wl/[reseller-slug]/[offer-slug]/page.tsx` (specific offer storefront):

- Look up offer by `(reseller.slug, offer.slug)` AND `wl_tier=2` AND `wl_status IN ('trialing','active')` AND reseller's base sub is `active|trialing` AND vendor of app has `reseller_openness='open_to_wl'`
- If ANY condition fails, return `notFound()` from `next/navigation` — don't leak whether slug exists
- Render with branding from `wl_logo_url` / `wl_brand_color` / `wl_display_name`
- `<title>` = display_name (no platform name)
- NO "Powered by [PLATFORM]" — data not in HTML at all, can't be discovered via view-source
- Footer: small "Hosted by [PLATFORM]" (legal disclosure that the merchant of record is the platform; required for consumer protection without revealing the platform brand prominently)

**Buyer dashboard** (`/buyer`): if accessed via subdomain `<slug>.<base-host>/buyer`, redirect to canonical `<base-host>/buyer` (anti-poaching — buyer dashboard is NEVER WL-branded).

**Tier 1 storefront with global mini-branding** (`app/r/[reseller-slug]/[offer-slug]/page.tsx` — path-based, existing route):
- Look up offer with normal Tier 1 rules
- If reseller has `wl_global_*` fields set (all three non-null), render a thin header band at the top of the storefront: reseller logo (left) + display name + the brand color as accent border/CTA color
- The platform navbar remains visible above the mini-header (Tier 1 distinction — buyer sees they're on the platform)
- "Powered by [PLATFORM]" footer remains visible
- Stripe Checkout = platform-branded (no Connect sync at Tier 1)
- Email = platform-branded entirely (no subject prefix change)
- `<title>` = `<offer name> — <reseller display_name>` if global branding set, else `<offer name> — [PLATFORM]`

### 9. Tier 2 email branding — `lib/email/resend.ts`

For receipts + payment-failed notices on subscriptions where `reseller_wl_tier_snapshot=2`:
- Subject: `[<wl_display_name>] Your receipt for <app name>` (instead of `[PLATFORM] Your receipt...`)
- HTML header: replace platform logo with `wl_logo_url`; accent color = `wl_brand_color`
- From: still `noreply@platforma.local` (per-reseller domain deferred to #30)
- Footer: small "Hosted by [PLATFORM]" disclosure

**Anti-XSS:** display_name and brand_color go through existing HTML escape ([per audit fix commit 275bbed](commit:275bbed)). Test that `display_name = '<script>alert(1)</script>'` renders as text in email HTML.

### 10. Stripe billing — `STRIPE_WL_TIER2_PRICE_ID`

`.env.local`:
```
STRIPE_WL_TIER2_PRICE_ID=    # Stripe Price id: recurring monthly, $29, USD. Used for the per-offer WL upgrade.
```

Add to `lib/validation/env.ts` Zod schema (required from #29).

Webhook handler ([lib/stripe/webhook-handlers.ts](lib/stripe/webhook-handlers.ts)) extensions for Tier 2 subscription events on the platform account (NOT Connect):
- `customer.subscription.updated` with `metadata.kind === 'wl_tier2'`:
  - If status → `active` (trial ended, payment succeeded): UPDATE `reseller_offers.wl_status='active'`
  - If status → `past_due` or `unpaid`: UPDATE `wl_status='past_due'`. Offer remains visible but flag in reseller dashboard.
  - If status → `canceled`: UPDATE `wl_status='canceled'`, `wl_tier=1` (downgrade). Existing buyer subscriptions through this offer continue (sticky); they keep `reseller_wl_tier_snapshot=2` so future invoices on them still split at 2.5% reseller / 0% vendor.
- `customer.subscription.deleted`: same as canceled.

### 11. Existing reseller-offer gating — extend the base-sub check

Currently ([SPEC §8](SPEC.md)) publishing a `reseller_offer` to `active` requires the reseller's $9.99 base sub to be `active|trialing` (price reduced from $19 in this prompt). Extend: a Tier 2 offer ALSO requires its OWN `wl_status` to be `trialing` or `active`. If the WL subscription lapses (`past_due`), the offer remains visible (don't break customer experience) but is flagged in the reseller's dashboard with a Fix-billing CTA.

**Existing reseller subscriptions on the old $19 price are grandfathered.** Do NOT modify their Stripe subscriptions. The migration sets a new `STRIPE_RESELLER_PLAN_PRICE_ID` to point to the $9.99 price for new signups only. Old resellers continue at $19/mo until they cancel; new resellers see $9.99. Document the price migration in CHANGELOG and in the reseller dashboard ("Existing plan grandfathered at $19/mo; new signups at $9.99/mo. Contact support to switch."). This is the cleanest path — re-pricing live subs is messy and triggers user complaints.

---

## Verify

```bash
supabase db reset
npm run types
npm run typecheck
npm test
```

### Money math (critical)

```bash
npm test -- --run lib/stripe/__tests__/reseller.test.ts
# All worked examples + fuzz must pass
```

### End-to-end Tier 2 happy path

1. Vendor X (default `open_to_resellers`) toggles to `open_to_wl` → confirmation modal → save → audit log written
2. Reseller A signs up, completes $9.99/mo base (with 30-day trial from #22) + Connect onboarding
3. Reseller A creates offer for Vendor X's app: floor $20, sell $50
4. Reseller A clicks "Upgrade to WL" → uploads `acme-logo.png` (real PNG, <1MB) + picks `#FF6B00` + display name "AcmeApps"
5. Deny-list check passes ("AcmeApps" not in list)
6. New Stripe subscription created on platform account: $29/mo, `trial_period_days: 14`, reseller's card on file from base sub
7. Stripe Connect branding synced (logo uploaded to Stripe Files, account branding updated)
8. `reseller_offers.wl_tier=2, wl_status='trialing', wl_trial_end=now+14d, wl_stripe_subscription_id` set
9. Buyer hits `acme.platform.local/<offer-slug>` → sees WL storefront with AcmeApps branding, no "Powered by"
10. Buyer subscribes → Stripe Checkout shows AcmeApps logo (Connect branding) → checkout completes
11. Subscription created with `reseller_wl_tier_snapshot=2, vendor_openness_snapshot='open_to_wl'`
12. Webhook `invoice.paid` ($50 net = 5000 cents): platformCommission = floor(3000 × 250 / 10000) = 75¢; kickback = floor(75 × 3333 / 10000) = 24¢. Vendor receives **$20.24**, reseller receives **$29.25**, platform retains **$0.51**. Sum: 2024 + 2925 + 51 = 5000 ✓
13. Buyer's receipt email: subject `[AcmeApps] Your receipt for <app>`, header shows AcmeApps logo, footer "Hosted by [PLATFORM]"
14. Day 15: Stripe charges reseller $29 (trial ended) → webhook flips `wl_status` to `active`
15. Vendor X's dashboard: direct sales section shows 12/8/5/3% tier (unchanged); reseller program section shows 1 active Tier 2 partner with MRR + total kickback YTD (no buyer PII)

### Toggle transitions

- Vendor X flips `open_to_wl` → `open_to_resellers`: existing Tier 2 sub keeps `vendor_openness_snapshot='open_to_wl'`, future invoices on that sub continue computing kickback ($0.24 per Tier 2 invoice). NEW Tier 2 upgrades for Vendor X's apps are blocked. NEW Tier 1 sales of X's apps after the flip have `vendor_openness_snapshot='open_to_resellers'` (no kickback). Vendor X's profile = `open_to_resellers`.
- Vendor X flips `open_to_resellers` → `closed`: all `reseller_offers.status='paused'` for X's apps; existing subscriptions continue serving buyers with their snapshots.
- Vendor Y is `closed` (manually toggled). Reseller tries to create offer on Y's app → rejected with "vendor is not open to resellers".

### Refund / dispute (SPEC §11 — unchanged policy, new math)

- Tier 2 voluntary refund $50 (vendor=$20.24, platform=$0.51, reseller=$29.25): reverse vendor transfer of **$20.24** (floor + kickback). Platform $0.51 stays. Reseller $29.25 stays. Vendor refund includes the kickback they received — that kickback was contingent on a successful sale; the refund unwinds the sale.
- Tier 2 dispute lost: reverse all transfers (vendor $20.24 + reseller $29.25). Platform $0.51 absorbed.

### Adversarial / RLS

1. Reseller A tries to set own `wl_status='active'` directly via REST → blocked (no UPDATE policy)
2. Reseller A uploads SVG as logo (global or per-offer) → rejected by magic-bytes ([lib/utils/magic-bytes.ts](lib/utils/magic-bytes.ts))
3. Reseller A submits display name "Stripe Inc" (global OR per-offer) → rejected by deny-list
4. Reseller A submits "5tripе" (digit `5` + Cyrillic `е`) → after normalization becomes "stripe" → rejected
5. Reseller A submits display name 200 chars → rejected by length check
6. Reseller A sets `wl_global_logo_url` but leaves `wl_global_brand_color = NULL` → blocked by `profiles_wl_global_complete` CHECK constraint (all-or-nothing)
7. Reseller B (no base sub) tries to set global branding → rejected at server action (active|trialing base sub required)
8. Anonymous hits `evil.platform.local` (no such reseller) → 404, no info leak
9. Anonymous hits `acme.platform.local/<offer-slug>` where offer exists but `wl_status='canceled'` → 404
10. Buyer logged in tries `/buyer` via `acme.platform.local` subdomain → 301 to canonical `platform.local/buyer`
11. Reseller B (no base sub) tries to upgrade an offer to Tier 2 → rejected (base sub not active|trialing)
12. Reseller A tries to upgrade an offer to Tier 2 where vendor is `open_to_resellers` → rejected
13. Vendor X tries to read another vendor's `reseller_openness` → SELECT is allowed (it's not sensitive — vendors can see who's open), but UPDATE on other rows is blocked by existing profile RLS
14. Reseller A updates `wl_global_display_name` → existing Tier 2 offers keep their per-offer snapshots (no surprise re-brand on live Tier 2 storefronts)

### Migration backfill correctness

```sql
-- After migration, every existing reseller subscription should have:
--   reseller_wl_tier_snapshot = 1
--   vendor_openness_snapshot = 'open_to_resellers'   ← grandfathered: vendor still gets exact floor (status quo, no kickback)
-- And every vendor profile should have reseller_openness = 'open_to_resellers' (default).
SELECT COUNT(*) FROM subscriptions
  WHERE reseller_id IS NOT NULL
    AND (reseller_wl_tier_snapshot IS NULL OR vendor_openness_snapshot IS NULL);
-- expected: 0

SELECT vendor_openness_snapshot, COUNT(*) FROM subscriptions WHERE reseller_id IS NOT NULL GROUP BY 1;
-- expected: all → open_to_resellers (preserves status quo exact-floor; no surprise kickback to grandfathered vendors)

SELECT reseller_openness, COUNT(*) FROM profiles WHERE role='vendor' GROUP BY 1;
-- expected: all vendors → open_to_resellers (unless explicitly set otherwise)
```

---

## Caution

- **Sum invariant is non-negotiable.** Property-based fuzz test (1000 random tuples) must always satisfy `vendor + platform + reseller === amount` AND `platformCut >= 0`. Off-by-one in `Math.floor` historically caused MRR drift (commit bf2dcf3). The `resellerShare` is computed as residual so it absorbs all rounding from the kickback floor + commission floor.
- **Snapshots are immutable.** Once a subscription is created, `reseller_wl_tier_snapshot` and `vendor_openness_snapshot` NEVER change. Vendor flipping their toggle does not retroactively re-price existing subscriptions. This preserves MRR sanity and lets buyers trust their pricing. A vendor who flipped from `open_to_wl` to `open_to_resellers` continues earning kickback on their old WL subs — and that's correct (it was the deal at subscribe time).
- **Migration backfill: grandfather existing reseller subs at `open_to_resellers` (exact-floor status quo).** Today vendor gets exact floor on reseller sales. The migration MUST preserve that — `UPDATE subscriptions SET vendor_openness_snapshot = 'open_to_resellers' WHERE reseller_id IS NOT NULL`. Backfilling to `open_to_wl` would silently grant kickback to vendors who never opted in — surprise bonus, but also platform margin loss the user never agreed to. New subs after migration use the live vendor toggle.
- **`open_to_resellers` is the default.** Migration sets `profiles.reseller_openness = 'open_to_resellers'` for all existing vendor rows (matches `NOT NULL DEFAULT`). Vendors who want to opt OUT must explicitly switch to `closed`. Since the new model has zero vendor tax in any state, this is a no-op for vendor revenue on Tier 1 sales — purely an opt-out into a new UI affordance. No release announcement strictly required, but a one-liner in the next product update email is polite.
- **The 33% kickback (`VENDOR_WL_KICKBACK_BPS = 3333`) is a tunable.** Keep it as a const, NOT hardcoded inline. If platform decides 20% or 50% later, it's a one-line change. Document the chosen number in SPEC §4b. The const must satisfy `0 ≤ VENDOR_WL_KICKBACK_BPS ≤ 10000`; CI test enforces this.
- **Kickback floors aggressively on small markups.** $0.50 markup × 5% = 2 cents commission × 33.33% = 0¢ kickback (rounded down). Acceptable — micro-amounts of money shouldn't generate sub-cent transfers. Document in vendor-facing UI: "Kickback may be $0 on very small sales due to cent rounding."
- **Tier 2 brand auto-approval is risk-shifted, not risk-free.** Deny-list catches obvious phishing (Stripe, PayPal, etc.). It does NOT catch novel infringement (a vendor's own trademark). Have a clear takedown procedure: an admin can force-downgrade any Tier 2 offer via `setWLTierAction({offerId, tier: 1, reason})` writing an audit_log entry. **Same takedown applies to global Tier 1 mini-branding** — admin can `clearResellerGlobalBranding({resellerId, reason})` which nulls all three columns and writes audit. TOS must place liability on reseller for ALL uploaded brand assets (global and per-offer).
- **Global branding is all-or-nothing.** DB CHECK enforces all three fields set or all three NULL. Prevents weird half-states ("logo without name" looks broken). Server action validates this before update.
- **Global branding updates do NOT cascade to live Tier 2 offers.** A reseller's per-offer Tier 2 branding is independent after upgrade. If reseller wants to re-brand Tier 2 offers, they edit each one. Prevents accidental brand-switching of live storefronts.
- **Tier 1 storefront with global branding stays platform-domain-rooted.** Subdomain (`<slug>.platforma.com`) is exclusive Tier 2 value. If you allow Tier 1 to also use subdomain, you erode the per-app $29 justification ("why pay $29 if my brand already shows on subdomain"). Hard line: subdomain rewrite in `proxy.ts` returns 404 for any Tier 1-only reseller (no Tier 2 offers).
- **Buyer dashboard NEVER WL-branded.** Anti-poaching boundary (SPEC §6). Resellers WILL ask. Refuse — buyer dashboard is post-purchase platform-owned territory. Pre-purchase surfaces (storefront, Stripe Checkout, receipt email) are the WL value.
- **Logos: PNG/JPG/WebP only. NEVER SVG.** SVG enables stored XSS on every storefront visit. Enforce via magic-bytes ([lib/utils/magic-bytes.ts](lib/utils/magic-bytes.ts)) + Storage bucket content-type restriction. Max 1MB.
- **Stripe Connect branding is per-account, not per-offer.** A reseller with multiple Tier 2 offers can only have ONE branding showing on Stripe Checkout (the most recently upgraded offer wins). Document this in UI; future enhancement could use separate Connect sub-accounts per offer. For launch, accept the constraint.
- **Subdomain enumeration: existent+inactive returns 404.** Don't differentiate "doesn't exist" from "exists but canceled" — both return 404. Otherwise attackers map your reseller graph.
- **Subdomain reserved list must include EVERY operational subdomain you might use.** Adding `admin` later as a real subdomain breaks if someone registered `admin` as a reseller slug. Hardcode the list now.
- **Tier 2 trial creates billing exposure.** A reseller can create offer → upgrade Tier 2 → cancel during 14-day trial → never pay $29. Acceptable for launch (per-offer trial encourages experimentation). Monitor abuse: if reseller cancels >5 Tier 2 trials in 60 days, flag for review.
- **CSP impact (#28):** `img-src https://*.supabase.co` already in CSP. Logos served from Supabase Storage public bucket. Confirm bucket policy: public read, auth-only write, content-type allowlist (no `image/svg+xml`).
- **`wl_stripe_subscription_id` UNIQUE WHERE NOT NULL.** A single Stripe sub can't be attached to two offers. Forgetting this index = double-billing risk if a reseller's code retries an upgrade.
- **The $29/app is a price point, not a contract.** If adoption is low after 60 days, the user can decide to drop to $19/app or to a quantity-based progressive scheme (first app $29, second $19, third $14, etc.). Don't hardcode the price in TS — keep it as `STRIPE_WL_TIER2_PRICE_ID` env var so swap is a config change, not a code change.

---

## SPEC.md updates

Replace [SPEC.md:140](SPEC.md:140) ("No white-label / rebranding") with new §4c:

> **(§4c) Reseller White-Label Tier 2.** Premium per-offer upgrade. Reseller pays $29/mo per Tier-2-enabled offer (separate Stripe subscription on the platform account, NOT Connect) with a 14-day free trial per upgrade. Platform cut on markup drops to 2.5% (250 bps) for Tier 2 sales. Reseller uploads logo (PNG/JPG/WebP, max 1MB) + brand color (`#RRGGBB`) + display name (2-60 chars, auto-validated against homoglyph deny-list) which apply to:
> - Storefront subdomain (`<reseller-slug>.<base-host>`)
> - Stripe Checkout (via Connect branding API: `accounts.update settings.branding.logo + primary_color`)
> - Buyer email subject prefix + header logo
>
> Buyer dashboard remains platform-branded — anti-poaching boundary preserved.
> Tier 2 requires the **vendor's** `reseller_openness='open_to_wl'` at subscribe time. After subscribe, the (tier, openness) snapshot is immutable.

Update §3 (Vendor pricing) — direct sales unchanged (12/8/5/3% tier system). Add new §3.1 "Reseller program toggle":
> Each vendor has `reseller_openness ∈ {closed, open_to_resellers, open_to_wl}`, default `open_to_resellers`. The toggle **only** affects vendor income from **reseller sales**; direct sales always use the 4-tier system. Vendor never pays a per-sale tax on reseller sales. On `open_to_wl`, vendor additionally receives a kickback equal to `VENDOR_WL_KICKBACK_BPS` (currently 3333 bps = 33.33%) of platform's reseller-side commission, paid on every reseller sale (Tier 1 OR Tier 2). Toggle changes affect only NEW reseller subscriptions; existing subs keep their snapshot.

Update §4b (Reseller economics) — replace the formula:
> Reseller sale split:
> - `platform_commission = floor(markup × reseller_side_bps / 10000)` where `reseller_side_bps = 250` if `reseller_wl_tier_snapshot=2` else `500`
> - `vendor_kickback = floor(platform_commission × VENDOR_WL_KICKBACK_BPS / 10000)` if `vendor_openness_snapshot='open_to_wl'`, else `0`
> - `vendor_share = vendor_floor_snapshot + vendor_kickback`
> - `platform_share = platform_commission − vendor_kickback`
> - `reseller_share = amount − vendor_share − platform_share` (= `markup − platform_commission`; absorbs rounding)

Update §11 — Tier 2 refunds/disputes follow the same policy as Tier 1 (vendor-only on refund, all-reverse on dispute). On voluntary refund, the reversed vendor transfer includes the kickback — the kickback was contingent on a successful sale that's now being unwound.

## CLAUDE.md updates

Under "Folder structure":
- `app/_wl/[reseller-slug]/page.tsx` — WL storefront landing (subdomain rewrite target)
- `app/_wl/[reseller-slug]/[offer-slug]/page.tsx` — WL storefront offer page
- `app/reseller/brand/page.tsx` — global mini-branding settings (Tier 1, free)
- `lib/services/reseller.ts` — add `upgradeOfferToWLTier2, cancelWLTier2, setResellerGlobalBranding, clearResellerGlobalBranding`
- `lib/validation/wl-brand.ts` — homoglyph deny-list + `validateWLBrand()` (used by both global and per-offer validation)
- `lib/stripe/connect.ts` — add `syncResellerConnectBranding`

Add to "Environment variables":
```
STRIPE_WL_TIER2_PRICE_ID=             # required from #29 — $29/mo recurring price for Tier 2 per-offer upgrades
```

Under "Reseller data model" section (new — paralleling the affiliate one):
- `profiles.reseller_openness` (closed | open_to_resellers | open_to_wl; default `open_to_resellers`)
- `profiles.wl_global_logo_url / wl_global_brand_color / wl_global_display_name` (Tier 1 mini-branding; all-or-nothing CHECK; free, applied to all Tier 1 storefronts on platform path)
- `reseller_offers.wl_tier` (1 | 2)
- `reseller_offers.wl_logo_url / wl_brand_color / wl_display_name` (Tier 2 per-offer branding, pre-filled from global at upgrade time, independent thereafter)
- `reseller_offers.wl_stripe_subscription_id` (UNIQUE per-offer subscription on platform account)
- `reseller_offers.wl_trial_end / wl_status` (trialing → active → canceled)
- `subscriptions.reseller_wl_tier_snapshot / vendor_openness_snapshot` (both immutable after subscribe)

Add to "Guardrails":
- Vendor cut on **direct sales** = always 12/8/5/3% per tier (and admin override from #27); the reseller_openness toggle does NOT affect direct sales.
- Vendor never pays a per-sale tax on **reseller sales**. Vendor income from reseller sales = `floor` (open_to_resellers, snapshot) OR `floor + 33% × platform_commission` (open_to_wl, snapshot). `vendor_openness_snapshot` is immutable after subscribe.
- Tier 2 subscribe requires live check: `vendor.reseller_openness='open_to_wl'`. Snapshot stays even if vendor flips later.
- `computeResellerSplit` enforces invariants: (1) Tier 2 sale → vendorOpenness MUST be `open_to_wl`; (2) `vendor + platform + reseller === amount`; (3) `platformCut >= 0` (kickback never exceeds commission). Throws on any violation.
- `VENDOR_WL_KICKBACK_BPS = 3333` exported const in `lib/stripe/transfers.ts`. Never inline. Tuning is a one-line config change.
- Brand uploads: PNG/JPG/WebP only (no SVG), 1MB max, magic-bytes verified, display name passes homoglyph-normalized deny-list.
- Subdomain storefront enumeration: non-existent or inactive Tier 2 → 404. Buyer dashboard NEVER WL-branded (anti-poaching).
- Reserved subdomains hardcoded in `proxy.ts`: www/api/admin/auth/app/dashboard/support/help/mail/email/ftp/ns1/ns2/staging/dev/test/prod.
