# Task #46 — Engagement & analytics event capture (the data you can't backfill)

> **Before starting:** read `SPEC.md` §6, §7, §13, [lib/services/affiliate.ts](lib/services/affiliate.ts) (`getAffiliateFunnel` — today it is computed only from `subscriptions`, i.e. conversions only, no top-of-funnel), [lib/services/reseller.ts](lib/services/reseller.ts) (`getOfferAnalytics`), [proxy.ts](proxy.ts) (where `?aff=` cookies are captured). Read [build_prompts/47-organizations-multiseat.md](build_prompts/47-organizations-multiseat.md) (org ownership).
> **Definition of Done:** a single privacy-safe event ledger captures top-of-funnel engagement — marketplace impressions, product/app views, storefront visits, affiliate-link clicks, signups, checkout starts — so that **real** funnels (impression → view → click → checkout → subscribe → retained) and per-channel conversion exist for vendor, reseller, affiliate, and admin. **Critical: this data cannot be reconstructed retroactively — every day without it is permanently lost funnel history.**

**Phase 6 — Wave 9. Depends on: #47 (org scoping). Independent of the kitchens — recommend EARLY (it also upgrades the already-shipped #33/#34 funnels from conversion-only to real).**

---

## Why now, not later
Funnels today only see conversions (subscriptions). Affiliates can't see **EPC** (earnings per click) or click→sale conversion; resellers can't see storefront traffic→conversion; vendors can't see marketplace impressions→install. Those require capturing clicks/views/impressions **as they happen**. Conversions you can derive after the fact; engagement you cannot. Build the capture pipe before traffic exists.

## Privacy first (non-negotiable, ties to §6/§7/§13)
Events are **aggregate-analytics only**, never a back-channel to identity. Store a **salted daily-rotating visitor hash** (not raw IP, not a durable fingerprint), the entity touched, and the actor org where relevant — never buyer PII, never anything that lets a vendor/reseller/affiliate re-identify a person. Respect Do-Not-Track. This is GDPR-light by construction.

---

## Sections to build

### 1. `analytics_events` ledger (append-only)
`id` (bigint identity), `event_type` (enum — `impression|view|click|signup|checkout_start|checkout_complete|launch|...`), `entity_type` (`app|offer|affiliate_link|storefront|agent|workflow|marketplace`), `entity_id` (uuid/text), `owner_org_id` (→ organizations, nullable — the org whose entity was touched, for their analytics), `affiliate_id` / `reseller_id` (nullable — attribution channel), `visitor_hash` (text — salted, daily-rotating), `session_id` (text — opaque, cookie), `referrer` (text, nullable), `utm` (jsonb, nullable), `country` (text, nullable — coarse geo only), `created_at`. **`PARTITION BY RANGE (created_at)` monthly from day 1** (per #48 §5.1 convention); partition rotation handled by `partition-rotation-cron`. Indexes on `(entity_type, entity_id, created_at)`, `(affiliate_id, created_at)`, `(reseller_id, created_at)`, `(owner_org_id, created_at)`. **No UPDATE/DELETE** (append-only). **Retention: raw 90d** (per #48 §5.2), then rollup-only in `analytics_daily`; the rotation cron detaches expired partitions for archive/drop.

### 2. Capture surface
- A thin `POST /api/events` (batched, rate-limited, no auth required for public impressions/clicks; validates entity exists) + a tiny client beacon (`navigator.sendBeacon`).
- Server-side capture where it's reliable: affiliate `?aff=` click in `proxy.ts` → `click` event; marketplace/storefront page server components → `view`/`impression`; checkout routes → `checkout_start`/`checkout_complete`.
- Bot filtering (UA + heuristic) so funnels aren't polluted.

### 3. Rollups (so dashboards are fast + raw rows can be trimmed)
A cron (`analytics-rollup-cron`) aggregates raw events into `analytics_daily` (`date, entity_type, entity_id, owner_org_id, affiliate_id, reseller_id, event_type, count, unique_visitors`). Dashboards read rollups; raw kept short. Idempotent per `(date, …)`.

### 4. Real funnels (replace conversion-only)
Rewire the existing funnels + add the missing top:
- **Affiliate:** impressions/clicks (per link) → signups → checkout → subscribe → active 30/90d, plus **EPC, click→sale %, top-performing links**. Upgrades [getAffiliateFunnel](lib/services/affiliate.ts:326).
- **Reseller:** storefront visits → checkout → subscribe → retained, **per offer**, plus traffic sources. Upgrades `getOfferAnalytics`.
- **Vendor:** marketplace impressions → app views → install/subscribe, plus search-term/category discovery.
- **Admin:** acquisition funnel per role, channel attribution, traffic trends.

### 5. Pure aggregation helpers
`lib/analytics/funnel.ts` — pure functions turning rollup rows into funnel/EPC/conversion shapes, tested. No raw queries in components.

---

## Data layer additions
```ts
// lib/services/analytics.ts (new)
recordEvent(evt): void                  // server-side capture
recordEventsBatch(evts): void           // /api/events
getFunnel(scope, entityId, range): Funnel        // affiliate/reseller/vendor/admin
getEpc(affiliateId, range): { byLink, overall }
getTrafficSources(entityId, range): SourceRow[]
rollupDay(date): void                   // cron
```

## Acceptance criteria
- [ ] Clicks/views/impressions are captured from day one (server + beacon), bot-filtered.
- [ ] `visitor_hash` is salted + daily-rotating; no raw IP, no durable fingerprint, no buyer PII. DNT respected.
- [ ] Affiliate dashboard shows real EPC + click→sale conversion (not just conversions).
- [ ] Reseller dashboard shows storefront traffic→conversion per offer.
- [ ] Vendor dashboard shows impression→view→install funnel.
- [ ] Rollup cron is idempotent; dashboards read rollups; raw retention enforced.
- [ ] RLS/scoping: an org sees analytics only for its own entities; affiliates/resellers see only their channel; no cross-org leak; no re-identification path.
- [ ] Tests: funnel math, EPC, rollup idempotency, privacy (hash rotation, no PII).
