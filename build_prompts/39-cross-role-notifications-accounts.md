# Task #39 — Cross-role: notifications, account settings, onboarding, CSV export, vendor webhooks

> **Before starting:** read [lib/email/resend.ts](lib/email/resend.ts), [lib/services/admin.ts](lib/services/admin.ts) (audit log), [build_prompts/31-design-system-v2.md](build_prompts/31-design-system-v2.md).
> **Definition of Done:** every role has notification bell + preferences, account settings (email/password/2FA/sessions/data export/delete), first-run onboarding checklist with progress, CSV export on every relevant table, vendors can subscribe their own webhook URL to platform events for their apps. Tests + SPEC.md §10 updated.

**Phase 5 — Wave 8. Depends on: #31. Parallel with #32–#38.**

---

## 1. Notifications system

### Schema
```sql
create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  type text not null,             -- 'renewal_failed', 'payout_sent', 'app_approved', 'churn_alert', 'dispute_opened', 'floor_change', ...
  title text not null,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz default now()
);
create index on notifications (user_id, created_at desc);
create index on notifications (user_id) where read_at is null;
```

### Producers
Insert from webhook handlers, cron jobs, admin actions. Examples:
- Buyer: invoice.payment_failed → "Your SplitPay subscription failed to charge".
- Vendor: charge.dispute.created, app.approved/rejected, churn_alert_threshold_hit, large_refund, weekly payout summary.
- Affiliate: payout sent, badge earned, tier upgraded, large clawback.
- Reseller: vendor changed floor, WL trial ending in 3d, large refund.
- Admin: reconciliation drift, webhook failures spike, vendor concentration alarm.

### UI
- **Bell** in topbar (already in #31 primitives) — unread count chip, click opens popover with feed (last 20).
- **Mark all read** button + per-item.
- **Settings link** at popover bottom.

### Preferences page (`/settings/notifications`)
- Per type: in-app toggle, email toggle.
- Frequency for digest types (immediate / daily / weekly).
- Quiet hours.
- Default: all in-app on, critical email on.

### Email integration
Existing Resend helpers (`sendChurnAlert`, etc.) → also insert in `notifications`. Add `sendDigest` for daily/weekly batched.

---

## 2. Account settings (`/settings/account`)

All roles see:
- **Profile**: avatar, display name, bio.
- **Email**: change with verification.
- **Password**: change with current.
- **2FA**: TOTP enroll/disable (Supabase Auth MFA).
- **Active sessions**: list with device/IP/last seen, revoke individually or all.
- **Data export** (GDPR): "Request all my data" → background job → email with ZIP of all rows with user_id. *(This covers the logged-in user's OWN data. Data of a partner's end-clients — stored under `acquired_by='partner'`, SPEC §13 — is handled by the dedicated cross-kitchen lifecycle in #45; reuse its plumbing, don't duplicate.)*
- **Delete account**: confirmation flow, soft-delete with 30-day grace, then hard-delete cron. *(A partner deleting their account must trigger #45 erasure for all their clients too.)*
- **Theme**: light / dark / system.

Role-specific:
- Vendor: Stripe Connect manage link, tax info.
- Reseller: billing portal link.
- Affiliate: Stripe Connect manage link, payout schedule.
- Buyer: payment methods (cross-link to #35).
- Admin: nothing extra here (admin tools are separate in #36).

---

## 3. Onboarding checklist

First login per role → collapsible card top of dashboard with steps:

**Vendor:**
1. Connect Stripe (Connect Express).
2. Create your first app (with 3+ screenshots).
3. Set price + min_price floor.
4. Choose reseller-openness.
5. Submit for review.

**Affiliate:**
1. Connect Stripe (for payouts).
2. Set public profile (display name + slug).
3. Browse apps + generate first link.
4. Share your link (with built-in share kit).

**Reseller:**
1. Subscribe to platform plan ($9.99/mo, 30d trial).
2. Connect Stripe (for payouts).
3. Set mini-brand (logo + color).
4. Browse apps + create first offer.
5. Share storefront URL.

**Buyer:** no checklist (low-friction).

**Admin:** no checklist (internal).

Each step has CTA → routes to the right page. Persists progress in `profiles.onboarding_state jsonb`. Hides when all complete; reappears via "?" menu.

---

## 4. CSV export

Reusable `<ExportButton scope="vendor.subscriptions" />` triggers an async job → email with download link (or stream directly if <10k rows).

Endpoints:
- Vendor: subs, payouts, refunds, channel mix.
- Reseller: sales, payouts, offers.
- Affiliate: links, sales, payouts.
- Buyer: invoices, subs.
- Admin: any list table, audit log.

Service: `lib/services/export.ts` with a registry of scopes, RLS-respecting queries.

---

## 5. Vendor webhook subscribers (NEW)

Vendors want to be notified at their own backend when subs change (e.g., to provision/deprovision their app).

### Schema
```sql
create table vendor_webhooks (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references profiles(id),
  app_id uuid references apps(id),     -- null = all apps
  url text not null,
  signing_secret text not null,         -- generated, shown once
  events text[] not null,               -- ['subscription.created', 'subscription.canceled', 'subscription.paused', ...]
  enabled boolean default true,
  created_at timestamptz default now()
);
```

### Dispatcher
On every platform event for that vendor's apps, queue a POST to subscribed URLs:
- HMAC-SHA256 signature in `X-Platform-Signature` header (same pattern as Stripe).
- **Event-type versioning from day 1:** every event type is prefixed `v1.` (e.g. `v1.subscription.created`, `v1.subscription.canceled`, `v1.subscription.paused`). Payload schema for `v1.*` is frozen — fixes/breaking changes ship as `v2.*` and partners opt in per endpoint via the `events[]` array. Without this convention, any payload bug fix becomes a breaking change for every integrated partner.
- Retries: 5 attempts with exponential backoff.
- Tracks delivery in `vendor_webhook_deliveries` table.
- Anonymizes payload (uses `anon_user_id`, not `buyer_id`).

### Vendor UI (`/vendor/settings/webhooks`)
- List endpoints with status (active/failing).
- Add new: URL + events selector + per-app or all.
- Test event button.
- Delivery log per endpoint with payload + response.
- Rotate signing secret.

### Security
- URL must be HTTPS.
- Signing secret only shown on create + rotate.
- Failed deliveries auto-disable endpoint after 50 consecutive failures (with email alert).
- Rate-limited.

---

## 6. Partner platform API (NEW — inbound; embedding = stickiness)
Outbound webhooks tell a partner when something changed; an **inbound API** lets them build ON the platform (pull their stats, manage products/offers/links programmatically, top up credits, trigger workflows). Once a partner integrates their own systems against your API, leaving means re-engineering — durable switching cost.
- **`api_keys`** — `id`, `org_id` → organizations (#47), `name`, `hashed_key` (store only the hash; show full key once), `prefix` (text — for display, e.g. `pk_test_ab…` / `pk_live_ab…`), **`mode` (`test|live` — NOT NULL, from day 1)**, `scopes` (text[] — `read:analytics`, `manage:products`, `manage:offers`, `manage:links`, `billing:credits`, `run:workflows`), `last_used_at`, `revoked_at` (nullable), `created_at`. RLS: org members (admin+) manage; key auth resolves the org + scopes server-side. **Why test/live now:** retrofitting the split later means re-issuing every partner's key — adopt Stripe's convention from day 1. Test-mode keys route to Stripe test-mode + a no-op for irreversible side effects (emails, payouts).
- **Idempotency** — **`idempotency_keys`** table from day 1: `(key, org_id, request_hash, response_status, response_body, created_at)`, UNIQUE `(org_id, key)`. Every mutating `/api/v1/*` endpoint accepts an `Idempotency-Key` header; identical key + identical body within 24h replays the stored response, identical key + different body returns 409. Without this, a network blip on `POST /api/v1/checkout` = double subscription. Standard Stripe pattern; **schema gap closes here**.
- **Surface** a stable, **explicitly versioned** REST API (`/api/v1/...`) backed by the **existing service layer** (do NOT write parallel logic — the services from #32–#46 are the single source). Scope every endpoint to the key's org + scopes, rate-limited per key. Version is in the URL path; never break v1 — additive only.
- **Settings UI** under `/settings/api`: tabs for Test/Live keys, create/revoke keys, scope selection, usage, docs link.
- **Design note:** this is the reason the service layer must stay UI-agnostic (ENGINEERING.md) — the same functions back the dashboards, the webhooks, and this API.

---

## Acceptance criteria

- [ ] Notification bell shows unread count, opens feed, mark-as-read works.
- [ ] Preferences page persists, email sends respect toggles.
- [ ] Account settings: 2FA enroll → next login requires TOTP.
- [ ] Active sessions list accurate, revoke works.
- [ ] Data export emails ZIP within 1 hour.
- [ ] Account delete with 30d grace + recoverable, then hard-delete.
- [ ] Onboarding checklist persists, all CTAs route correctly, hides when complete.
- [ ] CSV exports complete for all 4 roles' tables; ≤10k rows direct, >10k async.
- [ ] Vendor webhook dispatcher signs payloads, retries on failure, anonymizes buyer data.
- [ ] Webhook test event delivers immediately.
- [ ] Failed webhook auto-disables after 50 failures with email alert.
- [ ] RLS: notifications RLS — user reads own; vendor_webhooks RLS — vendor reads own.
- [ ] Platform API keys: hashed at rest, shown once, scoped + rate-limited per org; revoke is immediate; endpoints reuse the service layer (no parallel logic).
- [ ] API keys split test/live from day 1; test-mode keys cannot trigger irreversible side effects (no real emails, no payouts).
- [ ] `Idempotency-Key` header on every mutating `/api/v1/*`: same key+body → cached replay; same key+different body → 409.
- [ ] Outbound webhook event types are `v1.*`-prefixed from day 1; payload schema for v1 frozen.
- [ ] Mobile responsive for settings pages.
