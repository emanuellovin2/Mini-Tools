# Task #33 — Affiliate dashboard v2 (funnel + discover apps + earnings per app)

> **Before starting:** read `SPEC.md` §4a, [lib/services/affiliate.ts](lib/services/affiliate.ts), [app/affiliate/page.tsx](app/affiliate/page.tsx), `mockups/index.html` (affiliate view). Read [build_prompts/31-design-system-v2.md](build_prompts/31-design-system-v2.md).
> **Definition of Done:** affiliate sees conversion funnel per link, can browse apps to promote with commission rates and projected earnings, sees earnings per app, has Stripe Connect status visible, payout history accessible, refund clawbacks transparent. All data tied to real services. Tests + SPEC.md §4a updated.

**Phase 5 — Wave 8. Depends on: #31. Parallel with #32, #34–#37.**

---

## Sections to build

### 1. Hero card (KEEP, refine)
Gradient banner with Active MRR + tier band + countdown to next tier + leaderboard rank. Already in mockup — keep as-is.

### 2. KPI strip
Lifetime earned · Active referrals · Clicks 30d · Next payout. With sparklines.

### 3. Conversion funnel card (NEW) — top priority
Per-link or aggregate funnel: Clicks → Checkouts started → Paid → Active at 30d → Active at 90d. Visualized as horizontal funnel bars with % drop at each step. Tells affiliate WHERE they're losing.

Data: needs new event tracking on checkout-started + subscription-still-active-after-N-days. Add events to `affiliate_attribution` table or new `affiliate_funnel_event`.

### 4. Earnings per app card (NEW)
Table: app · commission rate (e.g. 50%) · sales · earnings · avg per sale. Sorted by earnings. Tells affiliate which apps actually pay best.

Service: `getAffiliateEarningsByApp(affiliateId, days)`.

### 5. Apps to promote (NEW TAB — biggest gap)
New sidebar entry. List all apps with `affiliate_commission_bps > 0` AND status=live:
- App card with screenshot preview.
- Commission % badge prominent.
- Projected earnings calculator: "at your avg 3.3% conversion, 100 clicks → $X/mo".
- "Generate link" CTA inline (one-click).
- Filter by category, sort by commission %, "potential earnings", trending.

### 6. Links table (KEEP, expand)
Existing columns + add:
- Last sale ago (freshness indicator — red if >30d).
- Conversion rate % (clicks → paid).
- Sticky % (paid → still active at 90d).
- Each row → drawer with link's own funnel + suggested copy.

### 7. Stripe Connect status banner (NEW)
If not onboarded: red banner "Connect Stripe to get paid". Otherwise small status chip in header.

### 8. Payout history (NEW)
Drawer or dedicated section: list of weekly Friday payouts with date · amount · # sales · Stripe payout ID link.

Service: `getAffiliatePayouts(affiliateId)` — query Stripe via Connect account.

### 9. Pending earnings card (NEW)
"$X confirmed, paid out next Friday. $Y still in clawback window (will be added if no refund in 14d)." Transparency on cash flow.

### 10. Refund clawbacks card (NEW)
Last 30d: $ clawed back, count, list with link to original sale. Sets honest expectations.

### 11. Sticky referrals card (NEW)
"From referrals 6mo ago, X% still active. Industry avg: ~40%." Loyalty signal. Single number + cohort mini-chart.

### 12. Share kit (per link, in drawer)
- Big QR code (downloadable PNG).
- Swipe copy: "Tweet this" / "Email this" / "Post on LinkedIn" templates with link injected.
- Embed widget HTML snippet.
- UTM tag generator.
- Short URL via Bitly-style internal redirect (optional).

### 13. Badges (KEEP)
Grid stays as-is; add hover tooltip with exact requirement to unlock.

### 14. Public profile editor (NEW)
Inline card: display name · bio · slug · avatar · "Hide from leaderboard" toggle (sets `slug=NULL`). Link to view live `/affiliates/<slug>`.

---

## Data layer additions

```ts
// lib/services/affiliate.ts new exports
getAffiliateFunnel(affiliateId, days, linkId?): { clicks, checkouts, paid, active30, active90 }
getAffiliateEarningsByApp(affiliateId, days): { app, rate_bps, sales, earnings }[]
getAffiliatePayouts(affiliateId): StripePayout[]
getAffiliatePendingEarnings(affiliateId): { confirmed, in_clawback_window }
getAffiliateClawbacks(affiliateId, days): ClawbackRow[]
getAffiliateRetention(affiliateId, monthsAgo): { active_now, original_count }
getPromotableApps(affiliateId): App[] // all live apps with commission_bps > 0, sortable
```

---

## Acceptance criteria

- [ ] Funnel card renders with real event counts (not mocked).
- [ ] "Apps to promote" lists every live app with commission, filterable.
- [ ] One-click "Generate link" from promote-apps tab creates link and shows it inline.
- [ ] Earnings-per-app sums match aggregate lifetime.
- [ ] Connect status accurately reflects Stripe.
- [ ] Refund clawback shown if `affiliate_active_mrr_cents` decremented (per #19).
- [ ] Public profile edits persist + reflect immediately at `/affiliates/<slug>`.
- [ ] Drawer with QR code downloads as 1024×1024 PNG.
- [ ] Mobile responsive.
- [ ] Tests on all new service functions + RLS (affiliate cannot read another affiliate's data).
