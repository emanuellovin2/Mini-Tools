# Task #45 — Partner-client data lifecycle & DPA (the legal foundation for §13)

> **Before starting:** read `SPEC.md` §6, §7, **§13** (`acquired_by`), [build_prompts/40-usage-metering-billing.md](build_prompts/40-usage-metering-billing.md), [build_prompts/41-ai-gateway-byok.md](build_prompts/41-ai-gateway-byok.md), [build_prompts/43-connectors.md](build_prompts/43-connectors.md), [build_prompts/39-cross-role-notifications-accounts.md](build_prompts/39-cross-role-notifications-accounts.md).
> **Definition of Done:** because §13 makes the platform store **end-client personal data on behalf of partners** (agencies/resellers/vendors who brought their own clients), the platform is now a **data processor**. This task builds the cross-kitchen data lifecycle: a partner can export and erase a single client's data spanning every store that touches it, retention policies exist, and a DPA/processor stance is documented. Designing erasure in from the start is far cheaper than retrofitting deletion across ledgers, logs, and connector data later.

**Phase 6 — Wave 9. Depends on: #40, #41, #43 (the stores that hold client data). Ship alongside / right after the kitchens — NOT deferred to Wave 8 polish.**

---

## Why this is foundational, not polish
Once `acquired_by='partner'`, identifiable client data lands in: `usage_events` (per-client metering), gateway metadata logs, workflow run I/O (`run_steps` may contain client content), connector data (emails, rows synced), and any `partner_owner_id`-scoped identity store. A GDPR/CCPA erasure or export request must fan out across **all** of these. If each kitchen is built without an erasure hook, adding one later means reverse-engineering every data path — expensive and error-prone. Build the hook into each store now; this task is the coordinator.

## Boundary reminder (SPEC §13)
Only the **`partner_owner_id`** party owns/sees a given client. A data request can be raised by (a) that partner (acting for their client) or (b) the platform admin (compliance). Every other counterparty still sees only `anon_user_id` — erasure must not leak identity to them. Card/payment data stays with Stripe (never in our stores).

---

## Sections to build

### 1. Client identity registry (`partner_clients`)
A single canonical row per `(partner_owner_id, client)` so identity lives in ONE place and everything else references it by id (makes erasure a focused operation):
`id`, `partner_owner_id` → profiles, `external_ref` (text — the partner's own id for their client, optional), `email` (text, nullable), `display_name` (nullable), `created_at`, `deleted_at` (nullable — soft-delete tombstone). All other tables (`usage_events`, workflow runs, etc.) reference `partner_client_id`, never duplicate PII. RLS: only `partner_owner_id` + admin read; never exposed to other counterparties.

### 2. Per-store erasure hooks
Each kitchen registers an eraser in a registry (`lib/privacy/erasers.ts`): given a `partner_client_id`, it deletes or irreversibly anonymizes that client's rows in its store:
- **#40** usage_events: keep aggregate money rows (financial record) but null/Hash the client linkage → metering totals survive, identity does not.
- **#41** gateway logs: delete client-linked metadata; bodies aren't stored by default anyway.
- **#42** workflow run I/O: purge `run_steps.input/output` for that client's runs (may contain content).
- **#43** connector data: delete synced records / cached payloads tied to the client.
Each eraser is idempotent and logs to `audit_log`.

### 3. Export (data portability)
`requestClientExport(partnerOwnerId, partnerClientId)` → background job assembles a ZIP/JSON of everything held for that client across stores (respecting the boundary), delivered via signed link. Mirrors #39's user data-export plumbing but scoped to a partner's client, not the logged-in user.

### 4. Erasure flow
`requestClientErasure(partnerOwnerId, partnerClientId)` → soft-delete tombstone (`deleted_at`) immediately (stops all processing for that client: blocks new usage, pauses workflows referencing them), then a grace window, then hard erasure fans out across all registered erasers in one coordinated job. Audited end-to-end. Stripe-side: detach/anonymize the Stripe Customer if it exists for that client.

### 5. Retention policy
Config-driven max retention for high-PII stores (workflow run I/O, gateway debug logs): a cron purges content older than the window even without a request. Financial/aggregate rows are exempt (kept for accounting/tax).

### 6. DPA / processor stance (docs, not just code)
- A `/legal/dpa` page + a `/legal/subprocessors` list (Stripe, the AI providers used in `managed` mode, Supabase, Resend) — partners need this to resell compliantly.
- SPEC §13 gains a "Data processing & erasure" subsection pointing here.
- Partner account settings (ties to #39): a "Client data requests" panel to raise export/erasure for their clients + see status.

---

## Data layer additions
```ts
// lib/services/privacy.ts (new)
upsertPartnerClient(partnerOwnerId, args): { id }
requestClientExport(partnerOwnerId, partnerClientId): { jobId }
requestClientErasure(partnerOwnerId, partnerClientId): { jobId, graceEndsAt }
runErasure(partnerClientId): void   // fans out across lib/privacy/erasers.ts
// lib/privacy/erasers.ts — registry: each store registers (partnerClientId) => void
```

## Acceptance criteria
- [ ] Client PII lives only in `partner_clients`; other stores reference `partner_client_id`.
- [ ] Erasure fans out across #40/#41/#42/#43 stores; identity gone, aggregate money rows preserved.
- [ ] Erasure is idempotent and fully audited; soft-delete halts processing immediately, hard-delete after grace.
- [ ] Export assembles all client data across stores, scoped to the requesting partner, no cross-counterparty leak.
- [ ] Retention cron purges high-PII content past the window; financial rows exempt.
- [ ] `/legal/dpa` + `/legal/subprocessors` published; partner settings panel raises requests.
- [ ] RLS: only `partner_owner_id` + admin can read/raise requests for a client; no other counterparty sees identity (SPEC §13).
- [ ] Tests: eraser fan-out completeness, idempotency, boundary (counterparty sees only anon after erasure too).
