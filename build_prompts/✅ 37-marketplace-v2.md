# Task #37 — Marketplace v2 (search, filters, sort, categories, screenshots)

> **Before starting:** read [lib/services/apps.ts](lib/services/apps.ts), [app/marketplace/page.tsx](app/marketplace/page.tsx), [build_prompts/30-app-screenshots-gallery.md](build_prompts/30-app-screenshots-gallery.md), [build_prompts/31-design-system-v2.md](build_prompts/31-design-system-v2.md).
> **Definition of Done:** marketplace is browseable like a real store — search with debounce, category nav, filters (price range, rating, has-affiliate-program, has-free-trial), sort (trending/new/price/rating), pagination, first-screenshot cards, app detail uses lightbox from #30. SEO-friendly URLs. Tests + SPEC.md §3 updated.

**Phase 5 — Wave 8. Depends on: #30, #31. Parallel with #32–#36.**

---

## Sections to build

### 1. Search bar (NEW)
Debounced (300ms), full-text on `app.name + description + tags`. URL-bound (`?q=...`). Clears via X.

### 2. Category nav (NEW)
Horizontal pill bar: All · Trending · Productivity · Developer · Marketing · Finance · AI · New. URL `?cat=...`. Source: `listMarketplaceCategories()`.

### 3. Filter sidebar (NEW — desktop) / sheet (mobile)
- Price range slider ($0–$200/mo).
- Rating ≥ (3 / 4 / 4.5).
- Has affiliate program (commission >0).
- Has free trial.
- Vendor verified.
URL-bound for shareability.

### 4. Sort dropdown
- Trending (default) = subs growth × recency.
- Newest.
- Price low→high / high→low.
- Rating.

### 5. App cards (UPGRADE from #30)
Replace gradient blocks with first screenshot (16:10 cover). Card shows: name · category · price · rating · subs count · "Affiliate %" badge if applicable.

### 6. Featured carousel (NEW)
Top of page: 3-5 hand-picked or trending apps in a hero carousel. Admin can set `apps.featured_until` to schedule.

### 7. App detail page (USES #30 lightbox)
Already covered in #30 — gallery + lightbox + sticky pricing card + vendor card.

### 8. SEO
- Server-rendered with Next.js metadata API.
- OG image = first screenshot.
- Structured data (Product + Offer schema.org).
- URL: `/app/<slug>` (slug already exists or add).

### 9. Pagination / infinite scroll
24 per page. URL `?page=...`. Or infinite scroll with cursor.

### 10. Empty state
"No apps match your filters" + "Clear filters" CTA.

### 11. Reviews & ratings (NEW — foundational, the rest of this task already assumes ratings exist)
Reputation is non-portable stickiness (a vendor's track record lives here) **and** trust/desirability for buyers. Nothing builds it yet — add it now.
- **`app_reviews`** — `id`, `app_id` → apps, `buyer_id` → profiles, `subscription_id` → subscriptions (UNIQUE per `(app_id, buyer_id)` — **only a real subscriber can review**, anti-fake), `rating` (int 1–5, CHECK), `title` (nullable), `body` (nullable), `vendor_response` (text, nullable — vendor may reply once), `status` (`published|hidden` — admin moderation), `created_at`, `updated_at`. RLS: anyone reads `published`; buyer writes own (must own an active/past sub); vendor (org member) writes only `vendor_response`; admin moderates.
- **Denormalized aggregates on `apps`**: `rating_avg` (numeric), `rating_count` (int), maintained by trigger on review insert/update — so marketplace sort/filter by rating is cheap (no live aggregation).
- Display: stars + count on cards + detail page; review list with vendor replies on detail; "leave a review" only for entitled buyers; verified-purchase badge.
- Keep buyer reviews public but **never expose buyer PII to the vendor beyond display_name** (SPEC §6/§7 — a reviewer is identified by display_name only, and only for `acquired_by='platform'` marketplace subs; partner-acquired clients are not auto-enrolled as public reviewers).

---

## Data layer additions

```ts
// lib/services/apps.ts
listMarketplaceApps({ q, cat, priceMin, priceMax, ratingMin, hasAffiliate, hasTrial, verifiedOnly, sort, page, limit })
getFeaturedApps(limit): App[]
// reviews
createReview(buyerId, appId, { rating, title, body }): Review   // entitlement-checked
listReviews(appId, { page }): Review[]
respondToReview(orgMemberId, reviewId, response): void          // vendor org
moderateReview(adminId, reviewId, status): void
```

Index: `create index on apps using gin (to_tsvector('english', name || ' ' || description));` for full-text.

---

## Acceptance criteria

- [ ] Search returns results within 300ms.
- [ ] All filters URL-bound (shareable).
- [ ] First screenshot from #30 shown on every card.
- [ ] Lightbox works on app detail.
- [ ] SEO meta + OG image valid (verify with curl).
- [ ] Mobile filter sheet usable.
- [ ] Empty state with CTA.
- [ ] Only entitled subscribers can review (one per app); fake reviews blocked by the subscription_id constraint.
- [ ] `rating_avg`/`rating_count` maintained by trigger; sort/filter by rating is cheap.
- [ ] Vendor can reply once; admin can hide; reviewer shows display_name only (no PII leak).
- [ ] Lighthouse SEO ≥95.
