# Task #31 — Design system v2 (Stripe-density tokens + primitives + responsive)

> **Before starting:** read [build_prompts/26-design-system-foundation.md](build_prompts/26-design-system-foundation.md), [components/ui/](components/ui/), [components/layout/](components/layout/), `mockups/index.html` (visual reference). Read `ENGINEERING.md`.
> **Definition of Done:** new tokens (typography 13px base, dense spacing, indigo accent, gradient utility, full color scale incl. soft variants) override #26 defaults, 10 new primitives shipped + tested, all 5 dashboards swapped to the new shell, dark mode opt-in via `prefers-color-scheme`, mobile responsive (≥375px), accessibility audited (keyboard, focus rings, ARIA), no visual regressions in marketplace/storefront, SPEC.md design section updated, screenshots in `mockups/` archived as `/reference/`.

**Phase 5 — Wave 8. Depends on: none (refactor of existing tokens). Blocks: #32–#37 (all dashboards consume these primitives).**

---

## Context

[#26](build_prompts/26-design-system-foundation.md) shipped a basic shadcn-style primitive set with comfortable defaults. The mockup work in `mockups/index.html` validated a denser, Stripe-inspired direction: 13px base type, tabular numerals, 232px sidebar, sparklines inline with KPIs, drawer-from-right replacing detail pages, command palette, gradient accents on hero moments only.

This task **replaces** the visual tokens and **adds** the missing primitives. Existing primitive names stay; their styles change. No new dependencies beyond `cmdk` (command palette).

---

## Token changes

```ts
// design/tokens.ts (or expand existing)
typography: { base: 13, dense: 12, micro: 11, kpi: 24 } // Inter / system
color: {
  bg: '#fafbfc', soft: '#f4f5f7', surface: '#ffffff',
  border: '#e6e8eb', borderSoft: '#eef0f3',
  ink: '#0a0e27', muted: '#697386', muted2: '#8792a2',
  accent: '#635bff', accentSoft: '#f0eeff', accentInk: '#3a32c7',
  ok: '#00a86b', okSoft: '#e6f7ef',
  warn: '#ff8a00', warnSoft: '#fff3e0',
  bad: '#df1b41', badSoft: '#ffeef0',
  gradientHero: 'linear-gradient(135deg,#635bff,#9747ff,#ec4899)',
}
radius: { sm:4, md:6, lg:10, xl:14 }
spacing: 4-based scale, tight defaults
shadow: { card: '0 1px 1px rgba(10,14,39,.02)', drawer: '-12px 0 32px rgba(10,14,39,.08)', overlay: '0 24px 64px rgba(10,14,39,.25)' }
```

Dark mode: every color has a `dark:` variant. Opt-in via `prefers-color-scheme` + manual toggle in account settings (persisted to `profiles.theme_pref`).

---

## Primitives to add / rewrite

1. **`Sidebar`** — fixed 232px, search slot at top, sections, role switcher footer with user avatar.
2. **`Topbar`** — h-14 sticky, breadcrumbs left, env chip (Test mode), notification bell, primary action right.
3. **`Drawer`** — slide-from-right 520px, overlay, focus trap, ESC close, header/body/footer slots. Replaces detail-page nav.
4. **`Sparkline`** — pure SVG, no lib. Props `points: number[]`, `width`, `height`, `color`, `fill`.
5. **`KpiCard`** — label + value + delta chip + sub + sparkline slot. Single component used everywhere.
6. **`DenseTable`** — `--cols` CSS var grid, row hover, click-to-drawer slot, head row, empty state slot. NOT a `<table>` (use grid).
7. **`Lightbox`** — image viewer with keyboard nav (shared with #30).
8. **`CommandPalette`** — `cmdk`-based, ⌘K trigger, groups (Navigate / Actions / Search), fuzzy match.
9. **`Skeleton`** — line + rect + avatar variants. Use everywhere data is loading instead of spinners.
10. **`EmptyState`** — icon + title + body + primary CTA. Required prop `cta` to force good empty states.
11. **`Toast`** — bottom-right, auto-dismiss, optional undo button (5s window). Replaces silent success.
12. **`Tooltip`** — for help (?) hints. Markdown supported in body.
13. **`OnboardingChecklist`** — collapsible card with checkable steps + per-step CTA + percent progress. Reused by vendor/affiliate/reseller first-run flows.
14. **`NotificationBell`** — popover feed, unread count, mark-all-read, link to settings.
15. **`PageHeader`** — title + subtitle + tab bar + right-side actions. Drop `DashboardShell`'s ad-hoc header.

All primitives ship with:
- TypeScript types exported.
- Storybook-style demo page at `/dev/components` (gated to NODE_ENV=development).
- Vitest + RTL test for behavior (open/close, keyboard, focus trap).

---

## Mobile responsive

- Sidebar collapses to drawer on `<768px` with hamburger in topbar.
- Tables: at `<640px`, switch to stacked cards (each row = a card).
- KPI grids: 4-up → 2-up on tablet → 1-up on mobile.
- Drawer becomes full-screen on `<640px`.
- Test viewports: 375 (iPhone SE), 768 (iPad), 1280 (desktop), 1440 (work).

---

## A11y

- All interactive primitives keyboard-operable.
- Focus rings (3px indigo at 18% opacity) on every focusable element.
- ARIA: `role="dialog"` on drawer/lightbox/cmdk, `aria-live="polite"` for toasts, `aria-current="page"` for active nav.
- Color contrast ≥4.5:1 for text on every background combination (auto-check with `@axe-core/playwright`).

---

## Acceptance criteria

- [ ] All 15 primitives shipped, typed, tested, demo page renders all variants.
- [ ] Dark mode toggleable, persisted, no contrast regressions.
- [ ] Mobile 375px usable for all 5 dashboards (no horizontal scroll except tables-to-cards transition).
- [ ] Lighthouse a11y ≥95 on `/buyer`, `/vendor`, `/admin`.
- [ ] No regressions in `/marketplace`, `/app/[id]`, `/r/<slug>/<offer>` rendering.
- [ ] Bundle size delta < +12kb gzipped (cmdk is ~5kb).
