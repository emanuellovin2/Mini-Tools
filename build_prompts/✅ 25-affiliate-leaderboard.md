# Task #25 — Affiliate leaderboard + badges + public profiles (gamification)

**Wave 5 — sticky features. Depends on: #18 (`affiliate_active_mrr_cents` column), #26 (Card + Badge + Table). Blocks: nothing.** See `00-EXECUTION-ORDER.md`.

## Context
Affiliates work harder when there's public status to win, not just money. Three additions:
1. **Public leaderboard** at `/affiliates/top` (top N affiliates by MRR generated, monthly + all-time).
2. **Badge tiers** based on milestones (MRR generated, # active subs, longevity).
3. **Public affiliate profile** at `/affiliates/<slug>` showing earned badges, total MRR (rounded), top apps promoted — no PII.

This compounds with task #18 (affiliate model redesign) which tracks `affiliate_active_mrr_cents` for tier determination. The leaderboard reads the same column.

## What changes

### DB

#### profiles
Add fields for affiliates:
```sql
ALTER TABLE profiles
  ADD COLUMN affiliate_bio text CHECK (length(affiliate_bio) <= 500),
  ADD COLUMN affiliate_avatar_url text,           -- optional uploaded avatar
  ADD COLUMN affiliate_lifetime_mrr_cents bigint NOT NULL DEFAULT 0 CHECK (affiliate_lifetime_mrr_cents >= 0);
```
- `affiliate_lifetime_mrr_cents` = cumulative MRR ever generated (never decreases). Drives "lifetime" badges.
- `affiliate_active_mrr_cents` (from #18) = current MRR. Drives current rank + commission tier.
- `slug` (already exists on profiles for resellers) — reuse for affiliates too. Add the UNIQUE constraint check if needed.

#### affiliate_badges (lookup table — static)
```sql
CREATE TABLE affiliate_badges (
  id text PRIMARY KEY,                  -- e.g. 'rookie', 'silver', 'gold', 'platinum'
  display_name text NOT NULL,
  description text NOT NULL,
  threshold_kind text NOT NULL CHECK (threshold_kind IN ('lifetime_mrr', 'active_mrr', 'active_subs', 'tenure_days')),
  threshold_value bigint NOT NULL,
  icon_emoji text,
  sort_order int NOT NULL
);

INSERT INTO affiliate_badges VALUES
  ('rookie',     'Rookie',     'Generated first $100 in MRR', 'lifetime_mrr', 10000,    '🌱', 10),
  ('silver',     'Silver',     'Hit $1k lifetime MRR',         'lifetime_mrr', 100000,   '🥈', 20),
  ('gold',       'Gold',       'Hit $5k lifetime MRR',         'lifetime_mrr', 500000,   '🥇', 30),
  ('platinum',   'Platinum',   'Hit $20k lifetime MRR',        'lifetime_mrr', 2000000,  '💎', 40),
  ('hot',        'On Fire',    '$1k+ active MRR right now',    'active_mrr',   100000,   '🔥', 50),
  ('veteran',    'Veteran',    '1 year as an affiliate',       'tenure_days',  365,      '🏛️',60);
```

Badges are derived (not stored per-affiliate) — the leaderboard view joins thresholds against the affiliate's stats. This avoids stale state.

### Leaderboard view
```sql
CREATE OR REPLACE VIEW affiliate_leaderboard AS
SELECT
  p.id,
  p.slug,
  p.display_name,
  p.affiliate_avatar_url,
  p.affiliate_active_mrr_cents,
  p.affiliate_lifetime_mrr_cents,
  EXTRACT(DAY FROM (now() - p.created_at))::int AS tenure_days,
  RANK() OVER (ORDER BY p.affiliate_active_mrr_cents DESC) AS active_rank,
  RANK() OVER (ORDER BY p.affiliate_lifetime_mrr_cents DESC) AS lifetime_rank
FROM profiles p
WHERE p.role = 'affiliate'
  AND p.slug IS NOT NULL                  -- opted into public profile
  AND p.affiliate_lifetime_mrr_cents > 0; -- exclude empty profiles
```

Public — no RLS restriction on this view.

### Earned badges helper
```sql
CREATE OR REPLACE FUNCTION affiliate_earned_badges(p_affiliate_id uuid)
RETURNS SETOF affiliate_badges
LANGUAGE sql STABLE
AS $$
  SELECT b.* FROM affiliate_badges b, profiles p
  WHERE p.id = p_affiliate_id AND p.role = 'affiliate'
    AND (
      (b.threshold_kind = 'lifetime_mrr' AND p.affiliate_lifetime_mrr_cents >= b.threshold_value) OR
      (b.threshold_kind = 'active_mrr'   AND p.affiliate_active_mrr_cents   >= b.threshold_value) OR
      (b.threshold_kind = 'tenure_days'  AND EXTRACT(DAY FROM (now() - p.created_at)) >= b.threshold_value)
    )
  ORDER BY b.sort_order;
$$;
```

### Webhook handler (lib/stripe/webhook-handlers.ts)
On affiliate-attributed `invoice.paid`, increment BOTH counters:
```ts
await admin.rpc('increment_affiliate_mrr', {
  p_affiliate_id: affiliateId,
  p_net_amount_cents: netAmountCents,
});
```
The RPC updates both `affiliate_active_mrr_cents` (depends on #18 logic) and `affiliate_lifetime_mrr_cents += netAmountCents` (monotonic).

### Public pages

#### app/affiliates/top/page.tsx
Server component. Reads `affiliate_leaderboard` view. Shows top 50 by active MRR (default) with toggle for lifetime. Each row: rank, avatar, display name, MRR (rounded to nearest $100 for privacy), badges, link to profile.

#### app/affiliates/[slug]/page.tsx
Public profile page. Reads profile by slug. Shows:
- Avatar, display_name, bio
- Earned badges (from RPC)
- Stats: lifetime MRR (rounded), active MRR (rounded), tenure
- Top 3 apps promoted (count of active subs per app — from `subscriptions` join, anonymized)

NO buyer data, NO email, NO link breakdowns.

#### app/affiliate/page.tsx — dashboard updates
Add:
- Current rank ("You're #14 in active MRR")
- Next badge progress ("$340 more to Gold")
- "Public profile" toggle — show/hide on leaderboard (sets/clears `slug`)
- Avatar upload + bio editor

### Tests
- Leaderboard rank ordering correct (higher MRR = lower rank number).
- Badge derivation: affiliate with $1.5k lifetime → earns Rookie + Silver, not Gold.
- Hidden affiliate (slug NULL) does not appear in leaderboard view.
- Public profile page renders for affiliate with public slug; 404 for one without.

## Verify
1. Seed 5 affiliates with varying MRR → leaderboard ranks them correctly.
2. One affiliate hits $5k lifetime → Gold badge appears on their profile and leaderboard row.
3. Toggle "Hide from leaderboard" → affiliate disappears from `/affiliates/top` and their `/affiliates/<slug>` returns 404 (or "private").
4. Numbers shown publicly are rounded ($1,234 → "$1.2k" or "$1k+").

## Caution
- **MRR rounding for public display.** Showing exact MRR ($4,387) lets competitors back-calculate sub counts. Round to nearest $100 or use bands ("$1k-$5k", "$5k-$10k"). Decide before launch.
- **Slug collisions with resellers.** Both roles use `profiles.slug`. Confirm the UNIQUE constraint is global, so an affiliate cannot claim a slug already used by a reseller.
- **Privacy escape hatch.** Some affiliates may not want public visibility. The slug-as-opt-in approach handles this naturally — slug NULL = not on leaderboard.
- **Gaming.** If commission/tier upgrades depend on lifetime MRR, an affiliate could refund-attack: cause many subscriptions and refund them to inflate lifetime counter. The counter is updated on `invoice.paid` only — refunds do NOT decrement lifetime. Mitigation: decrement `lifetime_mrr_cents` on refund too, OR only count payments ≥ N days old. Recommendation: decrement on refund to keep lifetime "honest", and add a 7-day delay before badges/tier upgrades take effect.
- **No buyer PII anywhere.** Even on the affiliate's own dashboard, MRR is aggregate. Public profile shows only app-level info.
