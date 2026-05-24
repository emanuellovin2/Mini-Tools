# Task #30 — App screenshots gallery (3–7 per app, marketplace preview + lightbox)

> **Before starting:** read `SPEC.md` §3 (marketplace), §6 (anti-poaching), `ENGINEERING.md`. Read [lib/utils/magic-bytes.ts](lib/utils/magic-bytes.ts) and [lib/validation/wl-brand.ts](lib/validation/wl-brand.ts) — reuse the same upload validation pattern.
> **Definition of Done:** schema migration with `apps.screenshot_urls text[]` (CHECK 3–7 length), Supabase Storage bucket `app-screenshots` with RLS, vendor app form has drag-to-reorder upload grid with preview slot, marketplace card shows first screenshot, app detail page has full gallery with lightbox (keyboard nav, counter, thumbnails), existing demo apps backfilled via seed, tests on validation + RLS + ordering, SPEC.md updated.

**Phase 5 — Wave 8. Depends on: none (schema additive). Blocks: #31 (design system needs final gallery primitive shape) is parallel-able.**

---

## Context

Today apps have a single `icon_url`. Marketplace cards are bland; the app detail page has no visual content; vendors can't show what their product looks like before subscribing. This adds a 3–7 image gallery per app, mandatory before publish.

**Rules:**
- **3 minimum, 7 maximum** per app (CHECK constraint, enforced server-side too).
- **First image is the marketplace preview** — used in `/marketplace` cards and as hero on `/app/[id]`.
- **Same constraints as WL brand uploads** (#29): PNG/JPG/WebP only (no SVG — XSS), 1MB max, magic-bytes verified.
- **Drag-to-reorder** in the vendor form. Reorder updates the `screenshot_urls` array order; first index = preview.
- **Lightbox** on detail page: click any thumb → full-screen modal with ←→ keyboard nav, counter `n / total`, thumb strip at bottom, ESC to close, click-outside to close.
- **Pre-launch state**: app cannot be submitted for review with fewer than 3 screenshots (blocks the "Continue" button, server-validated).

---

## Build steps

### 1. Schema
```sql
alter table apps
  add column screenshot_urls text[] not null default '{}',
  add constraint apps_screenshot_count check (
    cardinality(screenshot_urls) = 0 or
    (cardinality(screenshot_urls) >= 3 and cardinality(screenshot_urls) <= 7)
  );

-- publish guard: live apps must have >=3 screenshots
alter table apps add constraint apps_published_has_screenshots check (
  status != 'live' or cardinality(screenshot_urls) >= 3
);
```

Storage bucket `app-screenshots`:
- Public read.
- Authenticated insert/delete restricted to `auth.uid() = app.vendor_id`.
- Path pattern: `{vendor_id}/{app_id}/{nanoid}.{ext}`.

### 2. Upload API route
`app/api/vendor/apps/[appId]/screenshots/route.ts`:
- POST: multipart upload, magic-bytes check (reuse `lib/utils/magic-bytes.ts`), 1MB cap, returns `{url, position}`.
- DELETE `?url=...`: removes from array + storage.
- PATCH: body `{urls: string[]}` — reorders, validates 3–7 if status=live.

### 3. Vendor form (new app + edit app)
[app/vendor/_components/AppForm.tsx](app/vendor/_components/AppForm.tsx) — add a `ScreenshotUploader` component:
- 7-slot grid (used + empty placeholders).
- Slot 1 marked `Preview` with indigo ring.
- Drag-and-drop reorder using HTML5 DnD (no lib).
- Each slot: delete button (×), filename + size below.
- Upload progress bar.
- Validation hint: "Min 3 to publish" while count < 3.

### 4. Marketplace card
[app/marketplace/page.tsx](app/marketplace/page.tsx) — replace solid color block with `<img src={app.screenshot_urls[0]}>` (`aspect-[16/10] object-cover`). Fallback to gradient if empty (legacy/demo).

### 5. App detail gallery + lightbox
[app/app/[id]/page.tsx](app/app/[id]/page.tsx):
- Hero: 1 large (first image) + grid of remaining thumbs (max 4 visible, "+N more" pill if >5).
- Lightbox component `components/ui/Lightbox.tsx`:
  - Fixed overlay, click backdrop closes.
  - Keyboard: ← → navigate, ESC close, Home/End jump.
  - Counter `1 / 5` top-right.
  - Thumbnail strip at bottom, active one ringed.
  - Lazy-load full-res images.
  - Trap focus while open (a11y).

### 6. Seed update
[scripts/seed-demo.mjs](scripts/seed-demo.mjs) — generate 4–6 placeholder screenshots per demo app (use the gradient generator already in mockups, render to PNG with `@napi-rs/canvas` or commit static PNGs to `public/seed-screenshots/`).

### 7. Tests
- `apps.test.ts`: array length 3–7 enforced, published requires ≥3, reorder preserves URLs.
- `screenshots-upload.test.ts`: magic-bytes rejects SVG and >1MB, only vendor can upload to their own app.
- E2E: vendor uploads 5 images, reorders, marketplace shows new preview, lightbox cycles all 5.

---

## Acceptance criteria

- [ ] Vendor cannot publish app without ≥3 screenshots (server + client).
- [ ] Drag-to-reorder updates array order and re-renders preview slot.
- [ ] SVG upload rejected with clear error.
- [ ] Marketplace card shows first screenshot, falls back to gradient if missing.
- [ ] Lightbox: ←→ navigation, ESC close, counter accurate, focus trapped.
- [ ] Demo seed runs cleanly with 4–6 images per app.
- [ ] RLS: vendor A cannot upload to vendor B's app.
- [ ] All existing tests pass.
