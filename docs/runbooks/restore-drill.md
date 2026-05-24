# Restore Drill — Supabase PITR Quarterly Verification

> **Schedule:** Run once per quarter (Jan / Apr / Jul / Oct — first week).
> Without a completed drill, "we have backups" is a belief, not a fact.

## Purpose

Verify that the latest Supabase PITR snapshot can be restored to a sandbox project and that:
- All migrations apply cleanly
- RLS policies hold (cross-org reads blocked)
- One buyer can authenticate and read their own subscriptions
- No secrets leak in logs or environment

## Prerequisites

- Access to the Supabase dashboard (owner or DBA role)
- A dedicated **sandbox project** (`[platform]-restore-drill`) — keep it paused when not in use
- Local Supabase CLI installed (`supabase --version`)
- `.env.restore` file with sandbox credentials (never commit; store in 1Password)

## Steps

### 1. Identify the restore point

1. In the Supabase dashboard → Production project → **Database** → **Backups**.
2. Note the latest PITR snapshot timestamp (should be < 24h old).
3. Select "Restore to a point in time" and choose a timestamp from the previous day (e.g. yesterday 02:00 UTC — after the reconciliation cron).

### 2. Restore to sandbox project

1. Choose **destination project = `[platform]-restore-drill`**.
2. Confirm the restore. ETA: 10–30 minutes depending on DB size.
3. Once complete, the sandbox project has a full copy of production data at the chosen point-in-time.

### 3. Validate migrations apply cleanly

```bash
# Point CLI at sandbox
export SUPABASE_DB_URL="$(grep SUPABASE_DB_URL .env.restore | cut -d= -f2-)"

# Dry-run migrations (no destructive changes — sandbox only)
supabase db push --db-url "$SUPABASE_DB_URL" --dry-run
```

Expected: all migrations show as "already applied" or apply without errors.

### 4. Smoke-check RLS

Connect to the sandbox Postgres (via Supabase SQL editor or `psql`):

```sql
-- Switch to a buyer's session (pick any from profiles where role='buyer')
SET LOCAL role = authenticated;
SET LOCAL request.jwt.claims = '{"sub": "<buyer-uuid>"}';

-- Should return ONLY this buyer's subscriptions
SELECT id, app_id, status FROM subscriptions LIMIT 10;

-- Should return ZERO rows (buyer cannot see other buyers' subscriptions)
SELECT count(*) FROM subscriptions
WHERE buyer_id <> '<buyer-uuid>';

-- Should return ZERO rows (buyer cannot see audit_log)
SELECT count(*) FROM audit_log;
```

Expected: first query returns rows, last two return 0.

### 5. Smoke-check authentication

1. In sandbox project Settings → **Auth** → enable email/password (if disabled for sandbox).
2. Use a test account from the seeded data (or create one).
3. Log in via `http://localhost:3000` pointed at sandbox credentials.
4. Navigate to `/buyer` — verify subscriptions load.

### 6. Document results

Fill in the drill log below and commit it to this file:

| Date | Restore point | Snapshot age | Migrations OK | RLS OK | Auth OK | Notes | Drilled by |
|------|--------------|-------------|---------------|--------|---------|-------|------------|
| YYYY-MM-DD | YYYY-MM-DD HH:MM UTC | Xh | ✅ / ❌ | ✅ / ❌ | ✅ / ❌ | | |

### 7. Tear down sandbox

1. Delete all data in the sandbox project (or pause it).
2. Rotate the sandbox service role key if it was used during the drill.
3. Ensure no sandbox credentials are committed to git.

## Failure handling

If any step fails:
1. **Migrations fail:** open a P1 incident — production is at risk if migrations can't be replayed.
2. **RLS fails:** audit all recent RLS policy changes; check `is_org_member` / `my_org_ids` are `STABLE SECURITY DEFINER`.
3. **Auth fails:** check GoTrue config and `NEXT_PUBLIC_SUPABASE_URL` in sandbox env.

File a GitHub issue with label `restore-drill-failure` for any failure. Do not mark the drill complete until all steps pass.

## Drill log

| Date | Restore point | Snapshot age | Migrations OK | RLS OK | Auth OK | Notes | Drilled by |
|------|--------------|-------------|---------------|--------|---------|-------|------------|
| _(first drill TBD)_ | | | | | | | |
