# Task #28 — Security hardening v2 (production-ready)

> **Before starting:** read `ENGINEERING.md`, `SPEC.md` §6 (anonymous token model), §7 (PII boundaries), §8 (RLS), §11 (Stripe Connect).
> **Definition of Done:** every P0 item shipped + tested, P1 items shipped or explicitly deferred with a tracking note, all new keys documented in `.env.local.example`, typecheck clean, full test suite green, Verify step passes (including the adversarial checks), Progress checklist ticked.

**Phase 4 — Wave 7. Depends on: nothing functionally, but should ship before #29 (white-label) because WL introduces multi-tenant host routing which expands the attack surface — better to have headers + rate limiting + audit log already in place.**

---

## Context

Task #11 covered the basics: RLS test suite, role-escalation guard, Zod input validation, in-memory rate limiter, magic-bytes upload check, webhook signature verification. Post-launch, 8 commits of audit fixes added: cancel URL hardening, env validation, refund/MRR drift, deferred transfers, affiliate clamp, email XSS escape, auth bypass fix, atomic webhook claim.

This task closes the remaining gaps that block a confident production launch with real money flowing. Scope is **defense-in-depth**, not feature work.

**What's NOT in scope** (deliberately deferred to a future #30):
- External penetration test (third-party engagement, not code)
- Bug bounty program setup
- SOC2 / compliance certification

---

## What changes — P0 (blockers for launch)

### 1. Security headers — `next.config.ts`

Today `next.config.ts` is empty besides turbopack root. Add the headers below. CSP is the only one that can break the UI, so deploy CSP in **report-only mode first** (1 week), review violations, then switch to enforcing.

```ts
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// CSP — start in report-only. Switch to Content-Security-Policy header after 1 week of clean reports.
// Sources allowed: self, Stripe (checkout + JS SDK), Supabase (REST + Realtime), Resend (none on client), Vercel analytics.
// inline styles: 'unsafe-inline' kept ONLY for Tailwind JIT in dev; production uses nonce-based.
// See: https://stripe.com/docs/security/guide#content-security-policy
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://js.stripe.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",                              // shadcn/Tailwind require inline; tighten with nonce in v3
  "img-src 'self' data: blob: https://*.supabase.co https://*.stripe.com",
  "font-src 'self' data:",
  "connect-src 'self' https://api.stripe.com https://*.supabase.co wss://*.supabase.co",
  "frame-src https://js.stripe.com https://hooks.stripe.com https://challenges.cloudflare.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://checkout.stripe.com",
  "frame-ancestors 'none'",                                         // anti-clickjacking
  "upgrade-insecure-requests",
  ...(isDev ? [] : [`report-uri ${process.env.NEXT_PUBLIC_APP_URL}/api/csp-report`]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy-Report-Only", value: csp },       // SWITCH to "Content-Security-Policy" after 1wk of clean reports
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(self \"https://js.stripe.com\")" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  turbopack: { root: __dirname },
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
    ];
  },
};

export default nextConfig;
```

Add a minimal CSP report endpoint at `app/api/csp-report/route.ts`:
```ts
export const runtime = "edge";
export async function POST(req: Request) {
  const body = await req.text();
  console.warn("[CSP-REPORT]", body.slice(0, 2000));  // forward to Sentry in step 7
  return new Response(null, { status: 204 });
}
```

**Stripe Checkout note:** `form-action 'self' https://checkout.stripe.com` allows POSTing to Stripe Checkout. If you use Stripe Elements (embedded) the `frame-src https://js.stripe.com` line covers it. Test both paths.

**Anti-trick:** confirm CSP doesn't break the affiliate `?aff=` cookie-set flow (which is server-side, so no CSP impact) and the JWKS endpoint (public GET, no CSP issue).

### 2. Distributed rate limiter — Upstash Redis (replaces in-memory)

Current [lib/utils/rate-limit.ts](lib/utils/rate-limit.ts) uses an in-memory `Map`. On Vercel serverless, **every cold-start gets a fresh map and every region has its own** — meaning a determined attacker bypasses the limit by hitting different lambdas. The file even has a TODO comment about it.

Add Upstash REST client (zero infrastructure, free tier covers 10k req/day):

```bash
npm i @upstash/redis
```

`.env.local` additions:
```
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

Add to `lib/validation/env.ts` Zod schema (required in production, optional in dev — fall back to in-memory):

```ts
UPSTASH_REDIS_REST_URL: process.env.NODE_ENV === "production"
  ? z.string().url()
  : z.string().url().optional(),
UPSTASH_REDIS_REST_TOKEN: process.env.NODE_ENV === "production"
  ? z.string().min(1)
  : z.string().min(1).optional(),
```

Rewrite `lib/utils/rate-limit.ts`:

```ts
import { Redis } from "@upstash/redis";

const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;

// Fallback in-memory for local dev only
const localBuckets = new Map<string, { count: number; windowStart: number }>();

export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<{ allowed: boolean; remaining: number }> {
  if (redis) {
    // Atomic INCR with TTL — single round trip via Lua-less pattern
    const windowKey = `rl:${key}:${Math.floor(Date.now() / windowMs)}`;
    const count = await redis.incr(windowKey);
    if (count === 1) await redis.expire(windowKey, Math.ceil(windowMs / 1000));
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
    };
  }

  // Local-dev fallback (unchanged from current implementation)
  const now = Date.now();
  const bucket = localBuckets.get(key);
  if (!bucket || now - bucket.windowStart > windowMs) {
    localBuckets.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: limit - 1 };
  }
  if (bucket.count >= limit) return { allowed: false, remaining: 0 };
  bucket.count++;
  return { allowed: true, remaining: limit - bucket.count };
}
```

All existing call sites become `await checkRateLimit(...)` (it's now async). Audit every caller — grep `checkRateLimit(` and add `await`.

**New rate limits to add (review existing first):**
- `/api/affiliate/links` POST — 10/min per user (prevent code-spamming)
- `/api/reseller/checkout` POST — 20/min per IP (prevent checkout flood)
- `/api/webhooks/*` — NO rate limit (Stripe needs unfettered delivery; idempotency handles dupes)
- Login attempt — 5/15min per email + 20/15min per IP (Supabase default may be enough; verify)

### 3. Stripe webhook replay protection (timestamp window)

[lib/stripe/webhook-handlers.ts](lib/stripe/webhook-handlers.ts) verifies signature but the Stripe SDK only validates the signature itself, **not** the recency of the timestamp. An attacker who captured a webhook payload (via a misconfigured proxy log) could replay it within the signing key's lifetime.

Stripe's `constructEvent` does support a tolerance parameter — confirm it's set:

```ts
import { headers } from "next/headers";

const STRIPE_TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes — Stripe's recommended default

export async function POST(req: Request) {
  const body = await req.text();
  const sig = (await headers()).get("stripe-signature");
  if (!sig) return new Response("missing signature", { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!,
      STRIPE_TIMESTAMP_TOLERANCE_SECONDS  // <-- the protection
    );
  } catch (err) {
    // Includes timestamp-out-of-tolerance errors — Stripe SDK throws "Timestamp outside the tolerance zone"
    return new Response("invalid signature", { status: 400 });
  }
  // ... existing handler dispatch
}
```

Verify the current implementation passes the tolerance. If not, add it. Log timestamp-rejection errors with `logWebhookEvent` so a replay attempt is observable.

### 4. Audit log — extend to ALL sensitive admin actions

Today `audit_log` tracks: app approve/reject ([app/admin/actions.ts](app/admin/actions.ts)), churn alert dispatch ([lib/services/admin.ts:363+](lib/services/admin.ts)). Add entries for every state-changing admin action:

| Action | actor_role | action | entity_type | metadata |
|---|---|---|---|---|
| Set vendor cut override | admin | vendor_cut_override_set | profile | `{old_bps, new_bps, reason}` (already in #27) |
| Clear vendor cut override | admin | vendor_cut_override_cleared | profile | `{old_bps, reason}` |
| Sync vendor Stripe | admin | vendor_stripe_synced | profile | `{result}` |
| Manual refund | admin | refund_issued | subscription | `{amount_cents, reason, stripe_refund_id}` |
| Reject app | admin | app_rejected | app | `{reason}` |
| Pause reseller (manual) | admin | reseller_paused | profile | `{reason}` |
| Override affiliate commission | admin | affiliate_commission_override | profile | `{old_bps, new_bps, reason}` (future) |

Pattern: every admin server action MUST write to `audit_log` in the same transaction (RPC) as the mutation. Half-success (mutation done, log missing) is a compliance failure.

Add a helper in `lib/services/admin.ts`:
```ts
export async function writeAuditLog(args: {
  actorId: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("audit_log").insert({
    actor_id: args.actorId,
    actor_role: args.actorRole,
    action: args.action,
    entity_type: args.entityType,
    entity_id: args.entityId,
    metadata: args.metadata ?? {},
  });
  if (error) throw new Error(`writeAuditLog: ${error.message}`);
}
```

Audit `app/admin/actions.ts` and `app/admin/reconciliation/page.tsx` actions — add `writeAuditLog` calls wherever a mutation happens.

**RLS lockdown on `audit_log`:**
```sql
-- Confirm via migration: audit_log is INSERT-only, SELECT only for admin.
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_admin_read ON public.audit_log;
CREATE POLICY audit_log_admin_read ON public.audit_log
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));

DROP POLICY IF EXISTS audit_log_no_update ON public.audit_log;
-- explicitly no UPDATE/DELETE policy = denied for all non-service-role.
```

### 5. CI dependency scanning

Add `.github/workflows/security.yml` (or extend existing CI):
```yaml
name: Security
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "0 5 * * 1"          # weekly Monday 5am UTC

jobs:
  npm-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: npm ci
      - run: npm audit --omit=dev --audit-level=high
        # fail PRs with HIGH or CRITICAL vulnerabilities in production deps

  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  codeql:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with: { languages: typescript }
      - uses: github/codeql-action/analyze@v3
```

Also add a Dependabot config `.github/dependabot.yml`:
```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule: { interval: weekly }
    open-pull-requests-limit: 10
    groups:
      patches: { update-types: [patch] }
      minor:   { update-types: [minor] }
```

---

## What changes — P1 (week 1 post-launch)

### 6. MFA on admin accounts (Supabase TOTP)

Supabase Auth supports TOTP enrollment out of the box. Enforce it for the admin role.

**Schema:** add helper view + guard.

```sql
-- Confirm admin has MFA enrolled before letting them act
CREATE OR REPLACE FUNCTION public.admin_has_mfa(p_user_id uuid)
RETURNS bool LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.mfa_factors
    WHERE user_id = p_user_id AND status = 'verified'
  );
$$;
```

**Middleware enforcement** in `proxy.ts`: if `pathname.startsWith("/admin")` and the user is admin but has no verified MFA factor, redirect to `/auth/mfa-setup`.

**UI**: `app/auth/mfa-setup/page.tsx` shows QR code (from `supabase.auth.mfa.enroll`) + 6-digit input + back-up codes (generate 10, hash with bcrypt, store in new `admin_backup_codes` table).

**Don't block vendors/buyers** — MFA is optional for them in this phase. Stripe Connect already requires it for payouts on its side.

### 7. CAPTCHA on signup (Cloudflare Turnstile)

Turnstile is free, invisible most of the time, no Google. Add site key + secret to `.env.local`:
```
NEXT_PUBLIC_TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=
```

Add to signup page (`app/auth/signup/page.tsx` or wherever signup form lives):
```tsx
<Turnstile sitekey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY!} onVerify={setToken} />
```

Server action verifies token server-side:
```ts
const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
  method: "POST",
  body: new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY!, response: token }),
});
const json = await res.json();
if (!json.success) throw new Error("captcha failed");
```

Also gate `/api/affiliate/links` POST behind a captcha challenge after 3 link creations from same IP within 5 minutes (progressive challenge, not on first action).

### 8. Sentry integration (error tracking + CSP reports)

```bash
npm i @sentry/nextjs
npx @sentry/wizard@latest -i nextjs
```

`.env.local`:
```
NEXT_PUBLIC_SENTRY_DSN=
SENTRY_AUTH_TOKEN=    # for sourcemap upload at build
SENTRY_ORG=
SENTRY_PROJECT=
```

Scrub PII in `sentry.server.config.ts`:
```ts
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  beforeSend(event) {
    // Strip emails, names, Stripe customer IDs from breadcrumbs and request data
    if (event.request?.cookies) delete event.request.cookies;
    if (event.user) { delete event.user.email; delete event.user.username; }
    return event;
  },
});
```

Wire CSP report endpoint to forward to Sentry:
```ts
// app/api/csp-report/route.ts
import * as Sentry from "@sentry/nextjs";
export async function POST(req: Request) {
  const body = await req.text();
  Sentry.captureMessage("CSP violation", { level: "warning", extra: { report: body.slice(0, 2000) } });
  return new Response(null, { status: 204 });
}
```

---

## Verify

### P0 verification (all required)

```bash
npm run typecheck
npm test
npm run dev
```

```bash
# Security headers — every page must serve them
curl -sI http://localhost:3000/ | grep -E "Strict-Transport|X-Frame|X-Content|Referrer|Permissions|Content-Security"
curl -sI http://localhost:3000/buyer | grep "Content-Security-Policy"
curl -sI http://localhost:3000/api/webhooks | grep "X-Frame-Options"

# Rate limit — distributed (only if Upstash creds set)
# Hit /api/affiliate/links 11 times in 1 minute, expect 11th to 429
for i in {1..11}; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/affiliate/links \
    -H "Cookie: <auth-cookie>" -H "Content-Type: application/json" -d '{"app_id":"..."}'
done

# Webhook replay window — should reject a stale signature
# (use Stripe CLI: stripe trigger invoice.paid --override-timestamp <6min-ago>; expect 400)

# Audit log completeness
# Run admin actions (approve app, set cut override, manual refund) — confirm audit_log row written for each

# CI deps scan locally
npm audit --omit=dev --audit-level=high
```

### P1 verification

- Admin logs in → forced to /auth/mfa-setup → enrolls TOTP → can access /admin
- Signup page → Turnstile widget renders → submit without solving → server rejects
- Trigger a deliberate error (`throw new Error("test")` in a server action) → Sentry receives it with PII stripped

### Adversarial checks (must all fail to escalate)

1. As vendor: try to read another vendor's `audit_log` rows → blocked
2. As vendor: try to UPDATE `audit_log` to alter a past entry → blocked (no policy)
3. As vendor: try to set own `vendor_cut_bps_override` via Supabase REST → blocked by trigger from #27
4. As anonymous: send Stripe webhook with valid signature but timestamp -10 min → 400
5. As anonymous: hit `/admin` → redirected to login
6. As anonymous: hit `/api/affiliate/links` 50× → 429 after limit
7. View page source on any logged-in page → confirm `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `RESEND_API_KEY`, `JWT_PRIVATE_KEY`, `TURNSTILE_SECRET_KEY`, `UPSTASH_REDIS_REST_TOKEN` are NOT present

---

## Caution

- **CSP report-only first.** Switching directly to enforcing CSP on a real app guarantees broken pages (some font, inline style, third-party script you forgot). Run report-only for 1 week, fix every report, then flip the header name.
- **Audit log RLS must DENY updates from authenticated users.** A tampered audit log is worthless. If an existing migration accidentally allowed UPDATE/DELETE on `audit_log`, find and revoke it in this prompt's migration.
- **Don't rate-limit webhooks.** Stripe retries with backoff up to 3 days. Rate-limiting their endpoint = dropping legitimate payment events = lost revenue + reconciliation drift. Idempotency is the right defense; rate limiting is wrong here.
- **MFA enforcement is one-way.** Once you flip it on for admin, an admin who loses their TOTP device is locked out. Implement backup codes BEFORE turning on enforcement. Document the recovery procedure (service-role SQL: `DELETE FROM auth.mfa_factors WHERE user_id = ...`).
- **Sentry PII scrubbing must be tested.** Trigger an error in a server action that receives buyer email as input → confirm the event in Sentry dashboard does NOT contain the email. PII leak via error tracking is a common compliance failure.
- **Turnstile's `secret-key` must NEVER ship to the client.** It goes in `TURNSTILE_SECRET_KEY` (server-only), only `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is public. Verify via the "no secret in client bundle" adversarial check.
- **Upstash free tier limit is 10k req/day.** A rate-limited endpoint hit 10k times burns the quota. Use Upstash for rate limiting only on user-facing actions (signup, link creation, checkout) — NOT inside per-request middleware on every page load. If middleware needs counting, use a higher tier or in-memory.
- **`form-action 'self' https://checkout.stripe.com` is necessary** for redirect-to-Stripe-Checkout. Without it, the Stripe Checkout form POST is blocked by CSP. Test the full subscribe flow after enabling CSP.
- **`gitleaks` will scan history.** If a real secret was ever committed (even if rotated since), this will fail PRs. Either accept the noise, add `.gitleaksignore` for known-rotated leaks, or scrub history with `git-filter-repo` (destructive — coordinate with all collaborators).
- **Don't add `unsafe-eval` or `unsafe-inline` to script-src** to silence CSP errors. If a library needs eval, replace the library. Stripe's JS does NOT require eval (only `unsafe-inline` for some inline initialization, which we already allow above for shadcn — narrow this with nonces in a future pass).

---

## SPEC.md updates

Add new §13 "Security posture":
> - **Transport:** HSTS preload; CSP enforced (report-only during 1-week soak); X-Frame-Options DENY (no embedding); strict referrer policy.
> - **Rate limiting:** distributed via Upstash Redis (in-memory fallback for dev only). Applied to auth, `/api/verify`, affiliate link creation, reseller checkout. NOT applied to Stripe webhook endpoint.
> - **Webhooks:** Stripe signature + 5-minute timestamp tolerance + atomic idempotency claim ([lib/stripe/webhook-handlers.ts](lib/stripe/webhook-handlers.ts)).
> - **Audit log:** every admin state mutation writes an immutable `audit_log` row (RLS: admin SELECT only, no UPDATE/DELETE for anyone but service-role). See `writeAuditLog` helper.
> - **MFA:** required for `role='admin'`, enforced in `proxy.ts`. Vendors/buyers/affiliates/resellers optional (Stripe Connect handles payout MFA on their side).
> - **CAPTCHA:** Cloudflare Turnstile on signup; progressive challenge on `/api/affiliate/links` after 3 creates/5min from same IP.
> - **Error tracking:** Sentry with PII scrubbing (email, name, IP) in `beforeSend`. CSP violation reports forwarded to Sentry.
> - **CI:** `npm audit` (high+), gitleaks, CodeQL (TypeScript), Dependabot weekly grouped PRs.

## CLAUDE.md updates

Under "Folder structure":
- `next.config.ts` — security headers (CSP, HSTS, X-Frame-Options, etc.)
- `lib/services/admin.ts` — add `writeAuditLog` to helper list
- `sentry.{server,client,edge}.config.ts` — Sentry init with PII scrubbing

Under "Environment variables" — append:
```
UPSTASH_REDIS_REST_URL=               # required from #28 in production
UPSTASH_REDIS_REST_TOKEN=             # required from #28 in production
NEXT_PUBLIC_TURNSTILE_SITE_KEY=       # required from #28
TURNSTILE_SECRET_KEY=                 # required from #28 — server-only
NEXT_PUBLIC_SENTRY_DSN=               # required from #28
SENTRY_AUTH_TOKEN=                    # required from #28 — sourcemap upload
SENTRY_ORG=
SENTRY_PROJECT=
```

Under "Guardrails" — append:
> - All admin state mutations write to `audit_log` in the same transaction as the mutation. Use the `writeAuditLog` helper. `audit_log` is immutable (no UPDATE/DELETE policy) and admin-read-only.
> - Webhook endpoints are exempt from rate limiting (Stripe retry logic depends on it). Idempotency is the dedupe mechanism, not rate limiting.
> - Admin role requires verified TOTP MFA before accessing `/admin` — enforced in `proxy.ts`.
> - CSP rolls out report-only first. Never add `unsafe-eval`; tighten `unsafe-inline` with nonces in future iteration.
