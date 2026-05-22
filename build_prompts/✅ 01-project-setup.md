# Prompt #1 — Project setup, auth, roles, and foundations

> **Before starting:** read `SPEC.md` and `ENGINEERING.md` in full.
> **Definition of Done:** strict TS, Zod at boundaries, tests on money/access paths, RLS + RLS tests for new tables, Verify step passes, Progress checklist ticked.

---

Initialize a Next.js app (App Router, TypeScript, `strict: true`) in this directory and connect it to Supabase. Establish the foundations the rest of the build depends on:

- **Local Supabase first:** run `supabase init` and `supabase start` in the repo. ALL migrations run against the local stack first (`supabase db push` or migration files), promoted to the hosted project only after they pass locally. Document the local↔hosted workflow in `README.md` and add `supabase/` to git.
- **RS256 key pair:** generate it once (`openssl genrsa -out private.pem 2048 && openssl rsa -in private.pem -pubout -out public.pem`), paste PEM contents into `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` (escape newlines as `\n`), pick a short `JWT_KEY_ID`. **Never commit `private.pem`** — add `*.pem` to `.gitignore`.
- **Folder structure:** `lib/services/*` (data access), `lib/stripe/*`, `lib/auth/*` (token logic), `lib/validation/*` (Zod schemas). No raw Supabase queries in components.
- **Env validation:** a Zod schema that parses `process.env` at boot and fails fast with a clear message if any required var (see `CLAUDE.md`) is missing. `RESEND_API_KEY` is optional in the schema (Resend only lands at #12) — log a warn-only message at boot if it's absent. Server-only vars (anything without the `NEXT_PUBLIC_` prefix) must never be importable from client code.
- **Test harness:** Vitest configured and runnable now, with one trivial passing test, plus a documented way to run against the **local** Supabase (`supabase start`) with a seeded test DB. Tests are required from here on, not later.
- **Auth & roles:** Supabase Auth (email/password) and a `profiles` table with `role` (admin, vendor, buyer; reseller defined but unused) and `display_name` (nullable). The role is set **server-side** at sign-up via a Postgres trigger on `auth.users` insert (or a server action) — never from a client-controlled field. Build sign-up and login pages with a vendor/buyer selector, and **role-aware middleware** that protects routes and redirects each role to its own (empty) dashboard shell.
- Generate Supabase types (`supabase gen types typescript --local`) and wire `npm` scripts for typecheck, test, type generation, and `supabase start/stop`.

## Verify

`supabase start` brings up the local stack; typecheck + the test run pass against it; you can register as a vendor and as a buyer, log in, and land on a role-specific empty dashboard; an unauthenticated user is redirected to login; booting with a missing required env var fails fast with a clear error; booting WITHOUT `RESEND_API_KEY` only warns (doesn't crash); a client bundle does **not** contain the service role key OR `JWT_PRIVATE_KEY`.
