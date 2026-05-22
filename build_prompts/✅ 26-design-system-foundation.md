# Task #26 — Design system foundation + reference page

**Wave 3 — depends on: nothing functional. Must ship BEFORE Wave 4-5 UI work (#18, #23, #24, #25) so they adopt primitives natively.**

## Context
The current UI is functional but inconsistent — each page invents its own buttons, cards, forms. Before the upcoming UI-heavy features (affiliate calculator, pause modal, analytics charts, leaderboard), establish a small, opinionated design system. **This task is purely additive — no existing page is touched except `/buyer` as a reference.** Zero risk of breaking other dashboards.

## Principles
- **Additive, not destructive.** New primitives live alongside the old UI. Existing pages keep working unchanged until each is migrated incrementally.
- **No business logic moves.** Server Actions, lib/, api/, migrations untouched. Only `app/**/*.tsx` JSX and styling.
- **No `name` attribute changes on forms.** Server Actions read formData by name — preserve every `name="..."` on existing inputs.
- **No route changes.** `/admin`, `/vendor`, `/buyer`, `/affiliate`, `/reseller` stay as-is.
- **No "use client" / Server Component flips on existing pages.** Only the new reference page (`/buyer`) gets reorganized.

## What changes

### 1. Design tokens
Update `app/globals.css` and `tailwind.config.ts`:
- CSS variables for colors (background, foreground, primary, muted, border, destructive, success, warning) — light + dark mode ready (dark mode optional for MVP).
- Spacing scale: rely on Tailwind defaults but document the few used (1, 2, 3, 4, 6, 8, 12, 16, 24).
- Typography: 1 sans (default Inter via next/font), font sizes via Tailwind (xs–3xl), line-heights baked in.
- Radius scale: `--radius` = 0.5rem base, used in `rounded-md`, `rounded-lg`.
- Shadows: 2-3 levels (sm, md, lg) softer than Tailwind defaults.

Example `tailwind.config.ts` extension:
```ts
extend: {
  colors: {
    background: "hsl(var(--background))",
    foreground: "hsl(var(--foreground))",
    primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
    muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
    border: "hsl(var(--border))",
    destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
  },
  borderRadius: { lg: "var(--radius)", md: "calc(var(--radius) - 2px)", sm: "calc(var(--radius) - 4px)" },
}
```

### 2. Primitive components (`components/ui/` — new folder)
Build 10 shadcn-style primitives. **Do not install shadcn-cli — write them directly to keep dependencies minimal:**
- `Button.tsx` — variants: default, secondary, destructive, ghost, link. Sizes: sm, md, lg, icon.
- `Card.tsx` — Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter.
- `Input.tsx` — styled `<input>`.
- `Select.tsx` — native `<select>` styled to match (no Radix dependency for MVP).
- `Label.tsx`
- `Badge.tsx` — variants: default, secondary, success, warning, destructive.
- `Modal.tsx` — `<dialog>` element based, accessible. Used for confirm dialogs (cancel, pause).
- `Toast.tsx` — minimal toast for success/error after Server Action. Pick one of: existing `sonner`, or a simple custom hook + portal.
- `Table.tsx` — Table, TableHead, TableBody, TableRow, TableCell. Styled, no virtualization.
- `Skeleton.tsx` — pulse loading placeholder.

Each primitive: under 80 lines, no external deps beyond `clsx` (or `tailwind-merge` if needed). Export from `components/ui/index.ts` for clean imports.

### 3. Layout shell (`components/layout/` — new folder)
- `DashboardShell.tsx` — sidebar + topbar layout used by all dashboards. Props: `nav: NavItem[]`, `user: { email, role }`, `children`.
- `Sidebar.tsx` — collapsible sidebar, active route highlighting.
- `Topbar.tsx` — user menu (sign out), notifications icon (placeholder for now).
- `PageHeader.tsx` — title + description + action area, used at the top of each page.

Important: **DashboardShell is opt-in.** Existing pages keep their current layout until migrated. The new reference page uses it; other dashboards continue with whatever they had.

### 4. Reference page — migrate `/buyer`
Why `/buyer`: simplest dashboard (one list + cancel button), zero economic risk if I get it slightly wrong, every user sees it.

Steps:
1. Wrap `app/buyer/page.tsx` content in `<DashboardShell nav={buyerNav} user={...}>`.
2. Replace ad-hoc HTML with `Card` + `Table` + `Button` + `Badge` for subscription rows.
3. Replace `app/buyer/_components/CancelButton.tsx` body with new `Button` + `Modal` (confirm dialog). **Do NOT change its function signature or the Server Action it calls.**
4. Use `Toast` after action completes (success/error).

After this task, `/buyer` looks fresh. All other dashboards look as they did. Both work.

### 5. Documentation
Create `components/ui/README.md` — 1 paragraph per primitive with usage example. Future tasks (#18, #23, #24, #25) reference this when building new UI.

## Verify

### Manual
1. `/buyer` shows the new layout, cards, buttons. Subscription cancel still works (Server Action invoked correctly).
2. `/admin`, `/vendor`, `/affiliate`, `/reseller` look exactly as before — no visual regression on those.
3. Login still works (no auth changes).
4. No console errors on hydration.

### Automated
- `npm run typecheck` clean.
- `npm test` — all existing tests pass. The cancel-subscription test for `/buyer` must still pass (Server Action signature unchanged).

## Caution

🚫 **DO NOT touch these:**
- `app/buyer/actions.ts` — Server Action signatures must be byte-identical
- Form input `name` attributes — Server Actions parse formData by these
- `proxy.ts`, `lib/auth/roles.ts` — auth flow
- Any `lib/`, `app/api/`, `supabase/` files
- Existing tests

✅ **Free to change:**
- JSX in `app/buyer/page.tsx`
- `app/buyer/_components/*.tsx` internals (export names + props unchanged)
- `globals.css`, `tailwind.config.ts`
- Add new files under `components/ui/` and `components/layout/`

### Why this task is safe
- New primitives are pure presentation — they compose existing data.
- Reference migration touches ONE page; if anything breaks, the blast radius is `/buyer` only.
- Other dashboards adopt the design system at their own pace (per task #18, #23, #24, #25), so we never have "everything broken at once".

## Out of scope (intentionally)
- Migrating `/admin`, `/vendor`, `/affiliate`, `/reseller` — happens incrementally during their respective feature tasks.
- Dark mode toggle — tokens are dark-ready but no toggle UI in MVP.
- Mobile responsive deep-dive — Tailwind defaults are enough for desktop-first launch; mobile polish post-launch.
- Animations / micro-interactions beyond Tailwind transitions.
- Custom illustrations / marketing pages.
