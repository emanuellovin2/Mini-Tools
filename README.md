# [PLATFORM]

A two-sided SaaS marketplace. See `SPEC.md` for full product and engineering spec.

## Prerequisites

- Node.js 20+
- [Docker Desktop](https://docs.docker.com/desktop) — required for local Supabase
- [Supabase CLI](https://supabase.com/docs/guides/cli/getting-started)
- [Stripe CLI](https://stripe.com/docs/stripe-cli) — required from #6

## Local development setup

```bash
# 1. Install deps
npm install

# 2. Start Docker Desktop, then start local Supabase
supabase start
# Copy the printed anon key + service_role key into .env.local

# 3. Configure environment
cp .env.local.example .env.local
# Fill in all values (see .env.local.example for instructions)

# 4. Apply migrations
supabase db push

# 5. Generate TypeScript types from the local schema
npm run types

# 6. Run dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Local ↔ hosted Supabase workflow

- All schema changes go through migration files in `supabase/migrations/` — never edit the dashboard directly.
- Develop against the local stack (`supabase start`), verify, then push to the hosted project via the Supabase dashboard or `supabase db push --linked`.
- After a schema change, re-run `npm run types` to regenerate `types/supabase.ts`.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Next.js dev server |
| `npm run typecheck` | Strict TypeScript check (`tsc --noEmit`) |
| `npm test` | Run Vitest test suite |
| `npm run test:watch` | Vitest in watch mode |
| `npm run types` | Regenerate Supabase types from local stack |
| `supabase start` | Start local Supabase (requires Docker) |
| `supabase stop` | Stop local Supabase |
| `supabase db push` | Apply migrations to local stack |

## RS256 key pair (JWT)

Generate once:

```bash
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem
```

Paste PEM contents into `.env.local` (escape newlines as `\n`). **Never commit `private.pem`** — it's in `.gitignore`.
