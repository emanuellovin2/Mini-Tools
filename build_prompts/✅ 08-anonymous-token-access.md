# Prompt #8 — Anonymous token access (anti-poaching core)

> **Before starting:** read `SPEC.md` §6 carefully.
> **Definition of Done:** strict TS, Zod at boundaries, tests on money/access paths, RLS + RLS tests for new tables, Verify step passes, Progress checklist ticked.

---

The `anon_user_id` is already minted at subscribe time in #6 (stable per `(buyer_id, app_id)` across resubscriptions). This prompt builds the launch + verify flow on top of it:

- **Launch endpoint** (`/api/launch/[app_id]` or server action): look up the buyer's current subscription to the app; mint an RS256 JWT with header `kid` and claims `iss = NEXT_PUBLIC_APP_URL`, `aud = app_id`, `sub = anon_user_id` (from the subscription row), `active` (from the SAME state-machine function as #6), `jti` (random nonce), `iat`, `exp ≤ 5 min`; redirect to the app's `auth_url` with `?token=...`. Keys come from env; expose the public **JWKS** endpoint at `/.well-known/jwks.json` returning the `JWT_PUBLIC_KEY` keyed by `JWT_KEY_ID` — built so a future rotation can serve two keys side-by-side without code change.
- **`/api/verify`:** validate signature (via JWKS), `exp`, `iss`, `aud` (with `clockTolerance` ~30s), then re-read **live** `subscriptions.status` from the DB and compute `active` via the shared state-machine function. Return `{ user_id, active }` — **no PII, no other fields**. Rate-limit it (e.g. 60 req/min per IP).
- **Anti-poaching invariant:** neither the token nor `/api/verify` ever leaks `buyer_id`, email, or any field joinable to a buyer's identity. Add a Zod schema for the response and assert the keys in a test.
- **SDK concept** `@platform/auth`: a `verifyToken` helper (verifies via JWKS + checks `aud`), a one-page quickstart, and a sandbox test token. Flip the vendor's "Integration status" to connected after the first successful `/api/verify` call from that app's `auth_url` origin (track a `first_verified_at` on `apps`).

## Verify

- Launching produces a valid short-lived token that `/api/verify` accepts
- An **expired** token, a **wrong-`aud`** token (minted for app A, presented as app B), a **tampered-signature** token, and a token with a `kid` not in JWKS are all rejected
- Canceling a sub makes `/api/verify` return `active:false` even within the token's 5-min window (live DB check)
- A buyer who cancels and resubscribes lands the SAME `sub` claim on both new and old tokens (anon_user_id stability)
- No buyer email/PII appears in the token or response (Zod-asserted)
- Rate limit triggers at the configured threshold
- Rotating to a new `kid` while keeping the old one in JWKS keeps in-flight tokens working

Tests cover: sig/exp/aud/live-status and the no-PII invariant.
