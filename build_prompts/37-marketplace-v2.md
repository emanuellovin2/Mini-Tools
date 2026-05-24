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

---

## Data layer additions

```ts
// lib/services/apps.ts
listMarketplaceApps({ q, cat, priceMin, priceMax, ratingMin, hasAffiliate, hasTrial, verifiedOnly, sort, page, limit })
getFeaturedApps(limit): App[]
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
- [ ] Lighthouse SEO ≥95.
