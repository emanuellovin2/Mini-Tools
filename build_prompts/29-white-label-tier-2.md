# Task #29 — White-label Tier 2 (vendor reseller-openness toggle + per-offer WL branding)

> **Before starting:** read `ENGINEERING.md`, `SPEC.md` §3, §4b, §6, §7, §11. Read [build_prompts/27-manual-vendor-commission-override.md](build_prompts/27-manual-vendor-commission-override.md) and [build_prompts/28-security-hardening-v2.md](build_prompts/28-security-hardening-v2.md) — both must be shipped first.
> **Definition of Done:** schema + RLS in place, `computeResellerSplit` rewritten with two-stream math + property-based invariant test, vendor toggle UI (3-state), reseller Tier 2 upgrade flow with per-offer Stripe subscription + 14-day trial, brand auto-approval with homoglyph deny-list, subdomain storefront routing in `proxy.ts`, Stripe Connect branding sync, Tier 2 email branding (subject prefix + header logo), buyer dashboard stays platform-branded, migration backfills existing reseller subscriptions to grandfathered 0% vendor cut, comprehensive tests on every money path + adversarial RLS checks, SPEC.md updated, Verify step passes.

**Phase 4 — Wave 7. Depends on: #27 (admin override precedence stays unchanged — confirms our `getVendorCutBps` precedence is still correct), #28 (CSP, audit log helper, rate limiting must be live before opening new attack surface via host-based routing). Blocks: #30 (custom domain CNAME + email domain — explicitly deferred).**

---

## Context

Today reseller sales work as follows ([SPEC §4b](SPEC.md), [lib/stripe/transfers.ts → computeResellerSplit](lib/stripe/transfers.ts)):
- Reseller pays $19/mo flat (platform Stripe subscription on platform account, NOT Connect)
- On reseller invoice: vendor gets exact `vendor_floor_snapshot_cents`, platform takes 5% of markup, reseller keeps the rest
- Storefront is `/r/<reseller-slug>/<offer-slug>` (path-based, full platform branding)
- [SPEC.md:140](SPEC.md:140) says **"No white-label / rebranding."** — this task reverses that decision.

**Three changes are introduced:**

### (A) Vendor toggle — 3-state, default `open_to_resellers`

Vendor controls whether resellers can list their apps and at which tier. **Default is Tier 1 open** (matches the current implicit behavior — any app with `min_price_cents` set is reseller-eligible). The vendor cut applies **only to reseller sales** — direct sales **always** use the 12/8/5/3% tier system (status quo, unchanged).

| Toggle | Direct sales cut | Tier 1 reseller? | Tier 2 (WL) reseller? | Vendor cut on reseller sales |
|---|---|---|---|---|
| `closed` | 12/8/5/3% | ❌ | ❌ | n/a |
| `open_to_resellers` (default) | 12/8/5/3% | ✅ | ❌ | **3%** of vendor's floor |
| `open_to_wl` | 12/8/5/3% | ✅ | ✅ | **0%** (on Tier 1 AND Tier 2) |

`open_to_wl` is a strict superset of `open_to_resellers` + carrot: zero vendor-side tax on **both** tiers. Strong incentive to fully open up.

**No per-reseller approval, no engagement guard, no markup share.** Resellers self-enroll. Vendor's toggle is the only gate.

### (B) Reseller Tier 2 upgrade (per-offer)

- Reseller pays an additional $29/mo per Tier 2 WL'd offer (separate Stripe subscription per upgrade, on the platform account)
- 14-day free trial **per offer** (each upgrade has its own `trial_end`)
- Platform cut on markup drops from 5% → 2.5% for Tier 2 sales
- Reseller uploads logo (PNG/JPG/WebP only) + brand color (`#RRGGBB`) + display name → applied to:
  - Storefront subdomain (`<reseller-slug>.<base-host>`)
  - Stripe Checkout (via Connect branding API)
  - Buyer email subject prefix + header logo
- Buyer dashboard remains platform-branded — anti-poaching boundary preserved (SPEC §6)

**Auto-approval with homoglyph deny-list.** No manual admin review. Reseller is liable per TOS for trademark infringement.

### (C) Two-stream payment split (independent, non-cumulative)

On a reseller invoice, platform receives TWO independent cuts:
- **Reseller-side cut** = 5% of markup (Tier 1) or 2.5% (Tier 2) — taxed on reseller's share of markup
- **Vendor-side cut** = 3% (open_to_resellers) or 0% (open_to_wl) — taxed on vendor's floor

These are independent line items, not a single combined fee.

Worked example ($50 sell, $20 floor, $30 markup):

| Scenario | Vendor net | Reseller net | Platform |
|---|---|---|---|
| Tier 1, vendor=open_to_resellers | $20 − $0.60 = **$19.40** | $30 − $1.50 = **$28.50** | $0.60 + $1.50 = **$2.10** |
| Tier 1, vendor=open_to_wl | **$20** | **$28.50** | **$1.50** |
| Tier 2, vendor=open_to_wl | **$20** | $30 − $0.75 = **$29.25** | **$0.75** (+ $29/mo metered) |

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
  'Vendor toggle for reseller program. closed = no resellers; open_to_resellers (default) = Tier 1 only, vendor pays 3% of floor on reseller sales; open_to_wl = Tier 1 + Tier 2, vendor pays 0% of floor on reseller sales. Direct sales always use the 12/8/5/3% tier system regardless of this toggle.';

-- Index for vendors filtering by openness (e.g., reseller browsing marketplace for listable apps)
CREATE INDEX profiles_reseller_openness_idx ON public.profiles (reseller_openness)
  WHERE role = 'vendor';

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
-- (D) Migration backfill — grandfather existing reseller subs at 0% vendor cut
-- ===========================================================
-- Existing reseller subscriptions paid 0% vendor cut (status quo: vendor got exact floor).
-- Marking them as open_to_wl preserves that for the lifetime of each subscription.
-- The vendor's profile default (open_to_resellers) applies only to NEW subs after this migration.
UPDATE public.subscriptions
  SET reseller_wl_tier_snapshot = 1,
      vendor_openness_snapshot  = 'open_to_wl'    -- grandfather: 0% vendor cut for old subs
  WHERE reseller_id IS NOT NULL
    AND reseller_wl_tier_snapshot IS NULL;
```

### 2. `lib/stripe/transfers.ts` — `computeResellerSplit()` rewrite (two-stream math)

```ts
export interface ResellerSplit {
  vendorShareCents: number;
  platformCutCents: number;     // = platformFromReseller + platformFromVendor
  resellerShareCents: number;
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
  // Migration backfill grandfathers historical subs at open_to_wl; the only way to get here
  // with (wlTier=2, vendorOpenness=open_to_resellers) is a logic bug. Refuse to compute money.
  if (wlTier === 2 && vendorOpenness !== 'open_to_wl') {
    throw new Error(`invariant: Tier 2 sale requires vendorOpenness=open_to_wl, got ${vendorOpenness}`);
  }

  const markup = amountCents - vendorFloorCents;
  const resellerSideBps = wlTier === 2 ? 250 : 500;                    // 2.5% Tier 2, 5% Tier 1
  const vendorSideBps = vendorOpenness === 'open_to_wl' ? 0 : 300;     // 0% WL, 3% open_to_resellers

  // Two independent cuts, both floored (integer-safe)
  const platformFromReseller = Math.floor((markup * resellerSideBps) / 10_000);
  const platformFromVendor   = Math.floor((vendorFloorCents * vendorSideBps) / 10_000);

  const vendorShare = vendorFloorCents - platformFromVendor;
  const platformCut = platformFromReseller + platformFromVendor;
  const resellerShare = amountCents - vendorShare - platformCut;

  // Sum invariant — assertion (must hold by construction)
  if (resellerShare < 0) {
    throw new Error(`computeResellerSplit: negative reseller share (amount=${amountCents}, vendor=${vendorShare}, platform=${platformCut})`);
  }
  if (vendorShare + platformCut + resellerShare !== amountCents) {
    throw new Error(`computeResellerSplit: sum invariant broken (sum=${vendorShare + platformCut + resellerShare}, expected=${amountCents})`);
  }

  return { vendorShareCents: vendorShare, platformCutCents: platformCut, resellerShareCents: resellerShare };
}
```

**Tests required** ([lib/stripe/__tests__/reseller.test.ts](lib/stripe/__tests__/reseller.test.ts)) — replace existing tests:

```ts
// Worked examples
it("Tier 1 open_to_resellers: $50 sell, $20 floor → $19.40 / $28.50 / $2.10", () => {});
it("Tier 1 open_to_wl: $50 sell, $20 floor → $20 / $28.50 / $1.50", () => {});
it("Tier 2 open_to_wl: $50 sell, $20 floor → $20 / $29.25 / $0.75", () => {});

// Edge cases
it("amount < floor (Stripe fee edge): vendor gets full amount", () => {});
it("amount == floor (no markup): vendor=amount, platform=vendor-side-only, reseller=0", () => {});
it("1¢ markup: floors gracefully, all parties non-negative", () => {});

// Invariant guard
it("throws when wlTier=2 but vendorOpenness=open_to_resellers (logic bug)", () => {});

// Property-based fuzz — 1000 random tuples, sum invariant must hold
it("[fuzz 1000×] vendor + platform + reseller === amount for all valid inputs", () => {
  // amount: 100..10_000_000
  // floor: 0..amount
  // wlTier: 1 or 2
  // openness: open_to_resellers (Tier 1 only) | open_to_wl
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
- Open to resellers (default) — "Resellers can sell your apps with their own pricing markup. You pay 3% of your floor on reseller sales. Direct sales unchanged."
- Open to white-label — "Same as above, plus resellers can upgrade individual offers to Tier 2 (own branding). You pay 0% of your floor on ALL reseller sales (Tier 1 + Tier 2)."

Server action `setResellerOpennessAction({ openness })`:
- Validates with Zod (enum)
- Writes to `profiles.reseller_openness`
- Audit log via `writeAuditLog` from #28: action=`vendor_reseller_openness_changed`, metadata: `{old, new}`
- **No effect on existing reseller subscriptions** — they keep their `vendor_openness_snapshot`. Only new subscribes use the new value.

UI also shows a list of "Active reseller partners" — read-only display (no approval flow):
- Reseller display_name, app, tier badge, MRR via this offer (from `subscription_stats` view, no buyer PII)

**Flipping from open_to_wl back to open_to_resellers:** UI confirmation modal: "X existing Tier 2 subscriptions will continue at 0% vendor cut. New Tier 2 upgrades will be blocked. Continue?" Set on profile; existing Tier 2 offers remain `wl_tier=2` and continue running.

**Flipping to closed:** confirmation: "Y active reseller offers will continue serving existing subscribers, but new sales through them will be blocked." On flip, set `reseller_offers.status='paused'` for all offers on this vendor's apps. Existing subscriptions are NOT canceled (anti-buyer-disruption).

### 5. Reseller Tier 2 upgrade — `app/reseller/offers/actions.ts` + UI

Each offer card on `/reseller/offers` shows:
- Tier 1 badge with "Upgrade to white-label ($29/mo, 14-day free trial)"
- On click → modal with:
  - Logo upload (PNG/JPG/WebP, max 1MB, magic-bytes verified)
  - Brand color picker (`#RRGGBB`)
  - Display name input (2-60 chars)
  - Auto-validation against deny-list before submit (instant client-side feedback + server-side enforcement)

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
  // 1. Validate: reseller owns offer; their $19/mo base sub is active|trialing
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
  //    Reseller already has card on file from $19 base sub — no checkout needed
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

- Look up offer by `(reseller.slug, offer.slug)` AND `wl_tier=2` AND `wl_status IN ('trialing','active')` AND reseller's $19 base sub is `active|trialing` AND vendor of app has `reseller_openness='open_to_wl'`
- If ANY condition fails, return `notFound()` from `next/navigation` — don't leak whether slug exists
- Render with branding from `wl_logo_url` / `wl_brand_color` / `wl_display_name`
- `<title>` = display_name (no platform name)
- NO "Powered by [PLATFORM]" — data not in HTML at all, can't be discovered via view-source
- Footer: small "Hosted by [PLATFORM]" (legal disclosure that the merchant of record is the platform; required for consumer protection without revealing the platform brand prominently)

**Buyer dashboard** (`/buyer`): if accessed via subdomain `<slug>.<base-host>/buyer`, redirect to canonical `<base-host>/buyer` (anti-poaching — buyer dashboard is NEVER WL-branded).

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

Currently ([SPEC §8](SPEC.md)) publishing a `reseller_offer` to `active` requires the reseller's $19 base sub to be `active|trialing`. Extend: a Tier 2 offer ALSO requires its OWN `wl_status` to be `trialing` or `active`. If the WL subscription lapses (`past_due`), the offer remains visible (don't break customer experience) but is flagged in the reseller's dashboard with a Fix-billing CTA.

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
2. Reseller A signs up, completes $19/mo base (with 30-day trial from #22) + Connect onboarding
3. Reseller A creates offer for Vendor X's app: floor $20, sell $50
4. Reseller A clicks "Upgrade to WL" → uploads `acme-logo.png` (real PNG, <1MB) + picks `#FF6B00` + display name "AcmeApps"
5. Deny-list check passes ("AcmeApps" not in list)
6. New Stripe subscription created on platform account: $29/mo, `trial_period_days: 14`, reseller's card on file from base sub
7. Stripe Connect branding synced (logo uploaded to Stripe Files, account branding updated)
8. `reseller_offers.wl_tier=2, wl_status='trialing', wl_trial_end=now+14d, wl_stripe_subscription_id` set
9. Buyer hits `acme.platform.local/<offer-slug>` → sees WL storefront with AcmeApps branding, no "Powered by"
10. Buyer subscribes → Stripe Checkout shows AcmeApps logo (Connect branding) → checkout completes
11. Subscription created with `reseller_wl_tier_snapshot=2, vendor_openness_snapshot='open_to_wl'`
12. Webhook `invoice.paid` ($50 net): vendor receives **$20**, reseller receives **$29.25**, platform retains **$0.75**. Sum invariant ✓
13. Buyer's receipt email: subject `[AcmeApps] Your receipt for <app>`, header shows AcmeApps logo, footer "Hosted by [PLATFORM]"
14. Day 15: Stripe charges reseller $29 (trial ended) → webhook flips `wl_status` to `active`
15. Vendor X's dashboard: direct sales section shows 12/8/5/3% tier (unchanged); reseller program section shows 1 active Tier 2 partner with MRR (no buyer PII)

### Toggle transitions

- Vendor X flips `open_to_wl` → `open_to_resellers`: existing Tier 2 sub keeps `vendor_openness_snapshot='open_to_wl'`, future invoices still split at 0% vendor cut. NEW Tier 2 upgrades for Vendor X's apps are blocked. Vendor X's `reseller_openness='open_to_resellers'`.
- Vendor X flips `open_to_resellers` → `closed`: all `reseller_offers.status='paused'` for X's apps; existing subscriptions continue serving buyers.
- Vendor Y is `closed` (manually toggled). Reseller tries to create offer on Y's app → rejected with "vendor is not open to resellers".

### Refund / dispute (SPEC §11 — unchanged policy, new math)

- Tier 2 voluntary refund $50: reverse vendor transfer ($20) only. Platform $0.75 stays. Reseller $29.25 stays.
- Tier 2 dispute lost: reverse all transfers (vendor + reseller). Platform $0.75 absorbed.

### Adversarial / RLS

1. Reseller A tries to set own `wl_status='active'` directly via REST → blocked (no UPDATE policy)
2. Reseller A uploads SVG as logo → rejected by magic-bytes ([lib/utils/magic-bytes.ts](lib/utils/magic-bytes.ts))
3. Reseller A submits display name "Stripe Inc" → rejected by deny-list
4. Reseller A submits "5tripе" (digit `5` + Cyrillic `е`) → after normalization becomes "stripe" → rejected
5. Reseller A submits display name 200 chars → rejected by length check
6. Anonymous hits `evil.platform.local` (no such reseller) → 404, no info leak
7. Anonymous hits `acme.platform.local/<offer-slug>` where offer exists but `wl_status='canceled'` → 404
8. Buyer logged in tries `/buyer` via `acme.platform.local` subdomain → 301 to canonical `platform.local/buyer`
9. Reseller B (no base sub) tries to upgrade an offer to Tier 2 → rejected (base sub not active|trialing)
10. Reseller A tries to upgrade an offer to Tier 2 where vendor is `open_to_resellers` → rejected
11. Vendor X tries to read another vendor's `reseller_openness` → SELECT is allowed (it's not sensitive — vendors can see who's open), but UPDATE on other rows is blocked by existing profile RLS

### Migration backfill correctness

```sql
-- After migration, every existing reseller subscription should have:
--   reseller_wl_tier_snapshot = 1
--   vendor_openness_snapshot = 'open_to_wl'   ← grandfathered at 0% vendor cut
-- And every vendor profile should have reseller_openness = 'open_to_resellers' (default).
SELECT COUNT(*) FROM subscriptions
  WHERE reseller_id IS NOT NULL
    AND (reseller_wl_tier_snapshot IS NULL OR vendor_openness_snapshot IS NULL);
-- expected: 0

SELECT reseller_openness, COUNT(*) FROM profiles WHERE role='vendor' GROUP BY 1;
-- expected: all vendors → open_to_resellers (unless explicitly set otherwise)
```

---

## Caution

- **Two-stream math sum invariant is non-negotiable.** Property-based fuzz test (1000 random tuples) must always satisfy `vendor + platform + reseller === amount`. Off-by-one in `Math.floor` historically caused MRR drift (commit bf2dcf3). The resellerShare residual absorbs all rounding.
- **Snapshots are immutable.** Once a subscription is created, `reseller_wl_tier_snapshot` and `vendor_openness_snapshot` NEVER change. Vendor flipping their toggle does not retroactively re-price existing subscriptions. This preserves MRR sanity and lets buyers trust their pricing.
- **Migration backfill: grandfather existing reseller subs at `open_to_wl` (0% vendor cut).** Today's status quo: vendor gets exact floor on reseller sales (0% vendor tax). The migration MUST preserve that — `UPDATE subscriptions SET vendor_openness_snapshot = 'open_to_wl' WHERE reseller_id IS NOT NULL`. New subs created after migration use the live vendor toggle. If you forget this backfill, every existing reseller-sold subscription suddenly costs vendors 3% they never agreed to.
- **`open_to_resellers` is the default.** Migration sets `profiles.reseller_openness = 'open_to_resellers'` for all existing vendor rows (matches `NOT NULL DEFAULT`). Vendors who want to opt OUT must explicitly switch to `closed`. Communicate this in a release announcement before deploy (vendors implicitly become subject to the 3% on new reseller sales unless they switch to `closed` — but the migration backfill grandfathers existing subs).
- **Tier 2 brand auto-approval is risk-shifted, not risk-free.** Deny-list catches obvious phishing (Stripe, PayPal, etc.). It does NOT catch novel infringement (a vendor's own trademark). Have a clear takedown procedure: an admin can force-downgrade any Tier 2 offer via `setWLTierAction({offerId, tier: 1, reason})` writing an audit_log entry. TOS must place liability on reseller for uploaded brand assets.
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
> Each vendor has `reseller_openness ∈ {closed, open_to_resellers, open_to_wl}`, default `open_to_resellers`. The toggle **only** affects vendor cuts on **reseller sales**; direct sales always use the 4-tier system. Vendor cut on reseller sales is 3% of floor (open_to_resellers) or 0% (open_to_wl, both Tier 1 and Tier 2). Toggle changes affect only NEW reseller subscriptions; existing subs keep their snapshot.

Update §4b (Reseller economics) — replace the formula:
> Reseller sale split:
> - `vendor_share = vendor_floor_snapshot − floor(vendor_floor_snapshot × vendor_side_bps / 10000)`
>   where `vendor_side_bps = 0` if `vendor_openness_snapshot='open_to_wl'` else `300`
> - `platform_share = floor(markup × reseller_side_bps / 10000) + floor(vendor_floor_snapshot × vendor_side_bps / 10000)`
>   where `reseller_side_bps = 250` if `reseller_wl_tier_snapshot=2` else `500`
> - `reseller_share = amount − vendor_share − platform_share`  (absorbs rounding)

Update §11 — Tier 2 refunds/disputes follow the same policy as Tier 1 (vendor-only on refund, all-reverse on dispute), with the new split.

## CLAUDE.md updates

Under "Folder structure":
- `app/_wl/[reseller-slug]/page.tsx` — WL storefront landing (subdomain rewrite target)
- `app/_wl/[reseller-slug]/[offer-slug]/page.tsx` — WL storefront offer page
- `lib/services/reseller.ts` — add `upgradeOfferToWLTier2, cancelWLTier2`
- `lib/validation/wl-brand.ts` — homoglyph deny-list + `validateWLBrand()`
- `lib/stripe/connect.ts` — add `syncResellerConnectBranding`

Add to "Environment variables":
```
STRIPE_WL_TIER2_PRICE_ID=             # required from #29 — $29/mo recurring price for Tier 2 per-offer upgrades
```

Under "Reseller data model" section (new — paralleling the affiliate one):
- `profiles.reseller_openness` (closed | open_to_resellers | open_to_wl; default `open_to_resellers`)
- `reseller_offers.wl_tier` (1 | 2)
- `reseller_offers.wl_logo_url / wl_brand_color / wl_display_name`
- `reseller_offers.wl_stripe_subscription_id` (UNIQUE per-offer subscription on platform account)
- `reseller_offers.wl_trial_end / wl_status` (trialing → active → canceled)
- `subscriptions.reseller_wl_tier_snapshot / vendor_openness_snapshot` (both immutable after subscribe)

Add to "Guardrails":
- Vendor cut on **direct sales** = always 12/8/5/3% per tier (and admin override from #27); the reseller_openness toggle does NOT affect direct sales.
- Vendor cut on **reseller sales** = `vendor_openness_snapshot` (0% open_to_wl, 3% open_to_resellers). Snapshot taken at subscribe time, immutable.
- Tier 2 subscribe requires live check: `vendor.reseller_openness='open_to_wl'`. Snapshot stays even if vendor flips later.
- `computeResellerSplit` enforces invariant: Tier 2 sale → vendorOpenness MUST be `open_to_wl`. Throws on mismatch (logic bug detector).
- Brand uploads: PNG/JPG/WebP only (no SVG), 1MB max, magic-bytes verified, display name passes homoglyph-normalized deny-list.
- Subdomain storefront enumeration: non-existent or inactive Tier 2 → 404. Buyer dashboard NEVER WL-branded (anti-poaching).
- Reserved subdomains hardcoded in `proxy.ts`: www/api/admin/auth/app/dashboard/support/help/mail/email/ftp/ns1/ns2/staging/dev/test/prod.
