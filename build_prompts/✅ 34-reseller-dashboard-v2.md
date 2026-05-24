# Task #34 — Reseller dashboard v2 (browse apps + per-offer analytics + alerts)

> **Before starting:** read `SPEC.md` §4b, §11, [lib/services/reseller.ts](lib/services/reseller.ts), [app/reseller/page.tsx](app/reseller/page.tsx), `mockups/index.html` (reseller view). Read [build_prompts/31-design-system-v2.md](build_prompts/31-design-system-v2.md).
> **Definition of Done:** reseller can browse resellable apps with vendor openness signals, see per-offer analytics (traffic, conversion, MRR, churn) via drawer, gets alerts on vendor floor changes / pause / withdraw, sees WL Tier 2 trial countdowns + subdomain status, has markup simulator, sees kickback transparency. Stripe Connect status surfaced. Tests + SPEC.md §4b updated.

**Phase 5 — Wave 8. Depends on: #31. Parallel with #32, #33, #35–#37.**

---

## Sections to build

### 1. Trial / billing banner (KEEP)
30-day trial countdown if applicable, otherwise `$9.99/mo` status. Add card management CTA.

### 2. KPI strip
Storefront MRR · Markup earned · Active offers · Total buyers. With sparklines + deltas.

### 3. Browse resellable apps tab (NEW — biggest gap)
Sidebar entry: "Discover". Catalog of all apps with `vendor.reseller_openness != 'closed'`:
- App card with screenshot.
- Vendor openness badge: `Tier 1 open` vs `Tier 1 + WL Tier 2 open`.
- Min price floor visible.
- Suggested markup range.
- Projected earnings: "at $X price, $Y/sale to you after vendor + platform cuts".
- "Create offer" CTA inline.
- Filter: category, openness tier, vendor rating, sort by potential earnings.

Service: `getResellableAppsCatalog(resellerId)` extending `getResellableApps`.

### 4. Your offers (UPGRADE existing)
Card grid (keep look) but add:
- Per-card: visits 30d · conversion rate · churn rate · MRR trend.
- Click card → drawer with full analytics.
- Inline WL upgrade CTA only if vendor `open_to_wl` (live check).
- Pause/resume toggle inline.
- Copy storefront URL with QR.

### 5. Per-offer drawer (NEW)
Opens on offer click. Shows:
- Hero: name · app · status · MRR.
- Funnel: visits → checkouts → paid → active 30d (similar to affiliate funnel).
- Buyer cohort: anonymized — N active, M churned, retention %.
- Refunds/disputes on this offer.
- WL Tier 2 panel (if applicable): subdomain URL, trial countdown, last sale, brand preview.
- Markup simulator: slider for price, projected MRR + churn impact.
- Actions: pause, change price, upgrade to WL, cancel WL.

### 6. Vendor change alerts (NEW)
Banner above offers if:
- Vendor raised `min_price_cents` → "Floor change: $X→$Y. Your offer at $Z still valid; margin reduced from $A to $B."
- Vendor paused/archived app → "Vendor paused this app. Your offer auto-paused."
- Vendor changed `reseller_openness`:
  - `open_to_wl → open_to_resellers`: "Your WL Tier 2 still works for life of subscription; new WL upgrades blocked."
  - `→ closed`: "Vendor closed reselling; existing subs continue, new sales blocked."

Service: `getResellerAlerts(resellerId)` — diff against snapshots.

### 7. Tier 2 WL panel (NEW dedicated section)
For each Tier 2 offer:
- Subdomain URL clickable: `<slug>.platform.app/<offer-slug>`.
- DNS health (if custom domain — placeholder for #30 follow-up, just show ✓ for now).
- Trial countdown per offer.
- Sale frequency: last sale, auto-pause warning if inactive 60d.
- Brand preview (mini iframe of actual storefront).
- Edit branding inline.

### 8. Stripe Connect status (NEW)
Banner if not onboarded. Otherwise chip.

### 9. Refunds / disputes on your sales (NEW)
Feed: date · offer · amount · status. Reseller bears reseller-share reversal per #19.

### 10. WL kickback transparency card (NEW)
"On Tier 2 sales, platform takes 2.5%. Of that, 1.67% (33%) goes back to vendor as kickback (open_to_wl). You compete with vendor's own pricing — be aware."

Static info card with link to "How fees work" (#38).

### 11. Mini-brand (Tier 1, KEEP)
Existing global branding panel. Add: "this applies to all your /r/ Tier 1 storefronts. Tier 2 offers can override per-offer."

### 12. Comparison view (NEW)
Side-by-side table of all your offers: app · floor · your price · margin · MRR · churn · status. Sortable. Export CSV.

---

## Data layer additions

```ts
// lib/services/reseller.ts new exports
getResellableAppsCatalog(resellerId): App[] // all live + openness != closed
getOfferAnalytics(resellerId, offerId): { funnel, cohort, refunds, mrr, churn }
getResellerAlerts(resellerId): Alert[] // floor changes, vendor pauses, openness changes
getResellerKickbackToVendors(resellerId, days): { byVendor }
getResellerPayouts(resellerId): StripePayout[]
markupSimulate(offerId, newPriceCents): { projectedMrr, projectedChurn }
```

Track snapshots in `reseller_offers`: `last_observed_floor_cents`, `last_observed_openness` — populated by webhook + reconciliation, used to compute alerts.

---

## Acceptance criteria

- [ ] "Discover" tab lists all openable apps; one-click "Create offer" works.
- [ ] Vendor openness badge accurate (live check, not stale snapshot).
- [ ] Per-offer drawer shows funnel + cohort + refunds.
- [ ] Floor change triggers alert banner within next reseller dashboard load.
- [ ] WL Tier 2 trial countdown matches `reseller_offers.wl_trial_end`.
- [ ] Markup simulator changes update preview without committing.
- [ ] Comparison view exports CSV with all columns.
- [ ] Kickback math card matches `VENDOR_WL_KICKBACK_BPS=3333` from `lib/stripe/transfers.ts`.
- [ ] Connect status accurate.
- [ ] Mobile responsive.
- [ ] RLS: reseller cannot read another reseller's offers/analytics.
