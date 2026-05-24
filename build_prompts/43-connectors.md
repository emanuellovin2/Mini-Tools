# Task #43 — Connectors / integrations — the lock-in

> **Before starting:** read [build_prompts/41-ai-gateway-byok.md](build_prompts/41-ai-gateway-byok.md) (key vault pattern), [build_prompts/42-workflow-engine.md](build_prompts/42-workflow-engine.md) (step interface), `ENGINEERING.md` (security).
> **Definition of Done:** OAuth-based connectors (Gmail, Slack, Google Sheets, generic HTTP/webhook) usable as workflow steps; an encrypted credential vault with token refresh; a connector registry that exposes actions/triggers to the engine. This is the moat: once the agency's tools are wired in, leaving means re-plumbing their whole operation.

**Phase 6 — Wave 9. Depends on: #42 (consumed as step type) + #41 vault pattern. Parallel-able with #42 after the registry interface is agreed.**

---

## Cost-to-owner principle
A connector call just **moves data** between the customer's tools and a workflow — cheap serverless time, covered by a per-call meter (#40) when you choose to bill it (often bundled into the per-run price). The platform stores **the customer's own OAuth tokens** (encrypted) and acts on their behalf — it never pays for the third-party service. Zero external cost.

## Attractiveness
- **Agency/buyer:** workflows can finally touch real tools (send the email, write the row, post to Slack). This is what makes automation useful — and what makes leaving painful.
- **Vendor:** templates that use connectors are far more valuable (sell for more).
- **Reseller/affiliate:** richer products → higher usage → more markup/commission.

---

## Sections to build

### 1. Connector registry
A static, code-defined registry (`lib/connectors/registry.ts`): each connector declares `id`, `version` (int — **contract version, so a schema change to an action doesn't silently break existing workflows**; runs pin the version they were built against, like `workflow_versions`), `name`, `auth` (`oauth2|api_key|none`), `actions[]` (e.g. `gmail.send`, `sheets.appendRow`, `slack.postMessage`), `triggers[]` (e.g. `gmail.newEmail`), and a Zod/JSON schema for each action's input. Start with: **Gmail, Slack, Google Sheets, HTTP/Webhook** (HTTP needs no auth — ship it first as the universal escape hatch).

### 2. Credential vault (`connector_accounts`)
`id`, `owner_id` → profiles, `connector_id` (text), `label`, `ciphertext` (bytea), `dek_wrapped` (bytea), `key_version` (int), `scopes` (text[]), `expires_at` (nullable), `refresh_ciphertext` (nullable + own wrapped DEK), `created_at`. **Reuse the envelope-encryption module from #41 (`encryptSecret`/`decryptSecret`)** — same per-record DEK + versioned master key, so master-key rotation covers connector tokens too with no re-encryption. Tokens encrypted at rest; decrypt only server-side at execution. RLS: owner-only metadata; ciphertext/`dek_wrapped` service-role only.

### 3. OAuth flows
`GET /api/connectors/[id]/connect` → provider OAuth consent; callback `GET /api/connectors/[id]/callback` → exchange code, encrypt + store tokens. Auto-refresh expired tokens before a step runs (refresh token → new access token → re-encrypt). State param signed to prevent CSRF.

### 4. Action/trigger handlers
Each action: `execute(input, account, ctx) → output`. Each trigger (for #42 webhook/poll triggers): either a provider webhook subscription or a poll on the scheduler tick. Handlers are the bridge between the connector registry and the workflow `connector` step type.

### 5. Connector step wiring (into #42)
The `connector` step in the workflow engine resolves `(connector_id, action, account_id)`, loads + decrypts the account, runs the handler, meters via #40 if the meter is set. Surfaces connector errors as step failures (resumable).

### 6. Dashboard surface
"Connections" page: connected accounts (provider + label + status + reconnect), connect-new buttons, revoke. Per-role under account settings (ties to #39).

---

## Data layer additions
```ts
// lib/services/connectors.ts (new)
listConnectorDefs(): ConnectorDef[]            // from registry
connectAccount(ownerId, connectorId): { authUrl }
listConnectorAccounts(ownerId): Account[]      // metadata only
revokeAccount(ownerId, accountId): void
runConnectorAction(accountId, action, input, ctx): output   // used by #42
// lib/connectors/registry.ts — static defs
// lib/connectors/handlers/{gmail,slack,sheets,http}.ts
```

## Acceptance criteria
- [ ] HTTP/webhook connector works with no auth (universal escape hatch) — ship first.
- [ ] At least one OAuth connector (Gmail or Sheets) completes connect → token stored encrypted → action executes.
- [ ] Expired access token auto-refreshes before the step runs.
- [ ] OAuth `state` is signed; callback rejects forged/missing state.
- [ ] Tokens encrypted at rest; never returned to client, never logged.
- [ ] Connector step integrates with #42 executor; failures are resumable.
- [ ] Revoke removes stored tokens immediately.
- [ ] RLS: nobody reads another owner's `connector_accounts` ciphertext.
- [ ] Tests: token refresh, state verification, handler input validation (Zod), encryption round-trip.
