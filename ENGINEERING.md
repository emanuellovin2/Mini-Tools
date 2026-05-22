# [PLATFORM] — Engineering Principles

The goal: a correct, maintainable foundation with clean boundaries — not premature scaling infrastructure. The chosen stack scales to thousands of users on its own. Build it right, not big.

## Money & payments (most critical)
- Store all money as **integer cents** (`9900`), never floats. Store percentages as **basis points** (`2000` = 20%), never floats.
- Architecture is **Separate Charges & Transfers** (SPEC §11), not destination charges: buyer is charged on the platform account; vendor (and Phase-2 reseller) shares move via per-recipient **transfers** on `invoice.paid`. This is required so one charge can fund multiple recipients and so reversals are precise.
- Attach **idempotency keys** to every Stripe write (subscriptions, transfers, invoices); a retry must never double-charge or double-transfer.
- **Webhook handlers must be idempotent.** Stripe redelivers and does **not** guarantee ordering. Record every `event.id` in `webhook_events`, process once, and write handlers so an out-of-order or duplicate event is safe (e.g. `subscription.updated` may arrive before `created`).
- **Verify the Stripe webhook signature** on every webhook **before** acting. In Next.js App Router this requires the **raw body** (`await req.text()` — never `req.json()` first), with `export const runtime = 'nodejs'` and body parsing disabled.
- The **database is the source of truth for entitlements/access**, reconciled from Stripe events — never grant access off an unconfirmed client redirect. Map Stripe status → access via the SPEC §8 state machine, in **one** shared function.
- **Refunds/disputes reverse money:** reverse the matching transfer(s) on `charge.refunded` / `charge.dispute.*`; handle negative balances. Compute trailing revenue **net of** refunds/chargebacks. Refunds count toward the **calendar month they OCCUR** (cash-basis, SPEC §3) — never re-tier a closed `vendor_billing` period.
- The flat tier fee ($49/$99) is a **separate monthly Stripe invoice to the vendor**, idempotent per `vendor_billing` period — never an `application_fee`.
- All money moves via Stripe Connect transfers; the platform never holds or moves funds manually.

## Security
- **RLS is the real enforcement layer.** Assume the app layer can be bypassed; every table has policies that hold on their own. **Write RLS tests** (cross-vendor read denied, role escalation denied, buyer-can't-read-others).
- **Privilege-escalation guard:** the `profiles` UPDATE policy must enforce that `role` cannot change (`WITH CHECK` new role = old role). Roles and Stripe/Connect columns are written only via the service role.
- **Anti-poaching data boundary:** vendors must have **no path** to `subscriptions.buyer_id` or any buyer PII. Expose vendor stats only through the `vendor_subscription_stats` view/RPC (anon id + status + revenue). Audit every new vendor-facing query against this rule.
- **Validate every API input with Zod** at the boundary. Never trust the client.
- The **service role key is server-only**. Never ship it to the browser; never use it to skip RLS casually.
- **Validate env vars at boot** with a Zod schema (fail fast if a key is missing/malformed). Secrets live in env vars only; never commit them.
- **Rate-limit** auth endpoints and the public `/api/verify`.
- **Safe file upload** (vendor logos): allow only `png/jpg/webp` (reject SVG — inline SVG is an XSS vector), cap size, set Storage bucket RLS, serve from a dedicated bucket. **Validate magic bytes server-side**, not just `Content-Type` (the header is client-controlled and trivially spoofed).
- **CSRF:** Next.js Server Actions ship with built-in CSRF tokens — use them for form-based mutations. API routes that mutate state must either require a Supabase session cookie (same-site, `httpOnly`) or check `Origin`/`Referer` against `NEXT_PUBLIC_APP_URL`. Webhook endpoints are exempt — signature verification IS the auth.
- Never expose buyer email or card data to vendors (anonymous token model, SPEC §6).
- **JWT:** RS256 with a `kid` header and a public **JWKS** endpoint so keys can rotate without breaking vendors. Tokens carry `iss`/`aud`/`jti`/`exp` (≤5 min); verify all of them plus a small `clockTolerance`.

## Architecture & maintainability
- **Strict TypeScript** (`strict: true`). No `any` without a written reason.
- **Generate types from the Supabase schema** and treat them as the single source of truth — no hand-duplicated DB types.
- **Centralize data access** in a service/repository layer (`lib/services/*`). Raw Supabase queries do not belong inside React components. Stripe access lives in `lib/stripe/*`, token logic in `lib/auth/*`.
- **DB transactions for multi-table writes.** Any path that writes to ≥2 tables (subscribe flow, webhook handlers, refund handling, monthly cron) MUST run inside a single transaction — Supabase RPC (Postgres function) or an explicit `BEGIN/COMMIT`. Half-written state (e.g. `subscriptions` row inserted but `audit_log` row not, or transfer created but webhook_events not marked processed) is the #1 source of silent billing bugs.
- Keep business logic (tier calculation, split math, status→access mapping, token minting) in **pure, testable functions**, separate from HTTP/UI.
- Prefer **server components / server actions** for data; reach for client components only when interactivity needs it.
- Paginate list endpoints (e.g. marketplace) from the start; never ship an unbounded query.
- One way to do each thing. Consistent naming. No dead code, no half-finished abstractions.

## Correctness & safety net
- **All schema changes go through migrations**, never manual edits in the dashboard.
- **Test harness exists from #1** (Vitest + a test DB/seed). Don't defer it — by #5 you need it.
- **Tests on critical paths** before they are considered done: token verify (sig/exp/aud), payment split math, vendor tier calculation + boundaries, webhook idempotency + out-of-order, refund/dispute reversal, status→access mapping, RLS policies.
- **Audit log** for money and access events (who, what, when) — essential for debugging and disputes.
- **Reconciliation:** a job compares Stripe state to the DB and flags drift (orphan subscriptions, missing transfers).
- Use **Stripe test mode** + the **Stripe CLI** (`stripe listen`, `stripe trigger`) for local webhook testing until the full flow is verified end to end.

## Scalability (mostly free — do not pre-build)
- Keep APIs **stateless** (JWT, no server session affinity) so horizontal scaling is automatic.
- Do **NOT** add caching layers, message queues, microservices, or multi-region now. Add them only when real metrics demand it.

## Definition of done for any prompt
Code compiles with strict TS, inputs are validated with Zod, money/access paths have tests, RLS covers and tests new tables, the prompt's Verify step passes, and the Progress checklist in `CLAUDE.md` is updated.
