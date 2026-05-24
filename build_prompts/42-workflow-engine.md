# Task #42 — Workflow / automation engine — the recipe book

> **Before starting:** read [build_prompts/40-usage-metering-billing.md](build_prompts/40-usage-metering-billing.md), [build_prompts/41-ai-gateway-byok.md](build_prompts/41-ai-gateway-byok.md), `ENGINEERING.md` (transactions + idempotency).
> **Definition of Done:** agencies build trigger→steps workflows that run server-side; each run meters via #40; AI steps run through the gateway #41 (BYOK, zero platform compute cost beyond orchestration); the executor is idempotent and resumable. Vendors can publish workflow **templates** that resellers resell and affiliates refer. This is where the customer's daily work starts living in the platform — the start of real lock-in.

**Phase 6 — Wave 9. Depends on: #41 (AI steps), #40 (metering). Connector steps light up after #43.**

---

## Cost-to-owner principle
Orchestration (deciding which step runs next, passing data between steps) is **cheap serverless time** — covered by a small per-run `platform_fee_cents` meter (#40). The expensive part (AI) runs through the **BYOK gateway (#41)** on the customer's key. Connectors (#43) just move data. So the platform's cost stays a thin, always-covered margin even as workflows scale.

## Attractiveness
- **Agency/buyer:** automate real work ("new lead → AI drafts reply → send email → log to sheet") without code. Once built, leaving means rebuilding their operation elsewhere.
- **Vendor:** publish reusable workflow **templates** as products with a per-run price — recurring usage revenue, no hosting.
- **Reseller:** resell templates with a per-run markup (#40 split).
- **Affiliate:** recurring % of platform fee per run referred.

---

## Sections to build

### 1. Schema
- `workflows` — `id`, `owner_id` → profiles, `name`, `status` (`draft|active|paused`), `trigger_type` (`manual|schedule|webhook`), `trigger_config` (jsonb), `meter_id` → usage_meters (per-run billing), `created_at`, `updated_at`.
- `workflow_versions` — immutable snapshots: `id`, `workflow_id`, `version` (int), `graph` (jsonb — ordered steps/edges), `created_at`. Runs pin a version.
- `workflow_runs` — `id`, `workflow_id`, `version_id`, `status` (`queued|running|succeeded|failed|canceled`), `trigger_payload` (jsonb), `started_at`, `finished_at`, `error` (nullable), `usage_event_id` (nullable).
- `run_steps` — `id`, `run_id`, `step_key`, `type`, `status`, `input` (jsonb), `output` (jsonb), `attempt` (int), `started_at`, `finished_at`. Index `(run_id)`.

### 2. Triggers
- **manual:** "Run now" + the gateway-token API so external systems can trigger.
- **schedule:** cron expression → an Edge Function tick (`workflow-scheduler-cron`) enqueues due runs.
- **webhook:** inbound `POST /api/workflows/[id]/trigger/[secret]` — signature/secret-verified, enqueues a run with the body as payload.

### 3. Step types
`ai` (via #41 gateway), `http` (outbound request), `transform` (JS-safe template/JSONata-style mapping — NO arbitrary eval), `branch` (conditional), `delay`, `connector` (from #43). Each step type is a pure-ish handler `run(input, ctx) → output`.

### 4. Executor — **tick-driven & async, NOT a long-running synchronous loop** (critical, expensive to retrofit)
Serverless functions have a hard max duration; a workflow with a `delay` step ("wait 1 day") or many steps cannot run in one invocation. So model the run as a **durable state machine advanced one slice at a time**:
- `workflow_runs` carries `next_step_key` and `next_run_at` (timestamptz). A frequent **scheduler tick** (Edge Function `workflow-runner-cron`, ~every minute) claims runs where `status='running' AND next_run_at <= now()` (row-locked claim, like the webhook atomic claim), executes **one step (or a small bounded slice)**, persists the result to `run_steps`, sets the next `next_step_key`/`next_run_at`, and returns. A `delay` step just sets `next_run_at` in the future — zero compute while waiting.
- Each `run_steps` row is the **durable checkpoint** with a per-step idempotency key → a crashed/re-claimed run resumes from the last incomplete step with **no duplicate side effects**.
- Long external calls (AI/connector) run within one slice but with a timeout; on timeout the step is retried (bounded attempts) then failed.
- Metering: `recordUsage()` once per run (and per metered step) **inside the step transaction**. If credits are `blocked`, the run halts with a clear status — never a half-charge.

This keeps ENGINEERING's "no heavy queue" rule (it's a cron tick + a table, not Kafka) while being durable and timeout-proof. Do **not** implement a synchronous "run all steps now" executor even for the manual trigger — manual just sets `next_run_at = now()`.

### 5. Builder UI
Minimal first: a list/form builder (add step, pick type, configure, order) + a run-history table with per-step input/output drill-down (drawer). A visual graph editor is a later polish — do NOT build it now.

### 6. Templates (sellable)
A vendor publishes a `workflow_version` as a **template product** (`template_of` ref). Buyer "installs" → clones the version into their own workflow with their own keys/connectors. Template gets a `meter_id` (per-run price). Lists in the marketplace via #44.

---

## Data layer additions
```ts
// lib/services/workflows.ts (new)
createWorkflow / publishVersion / setStatus
enqueueRun(workflowId, payload, idempotencyKey): { runId }
executeRun(runId): void   // the durable executor; called by worker/cron
getRunHistory(workflowId): Run[]
installTemplate(buyerId, templateVersionId): { workflowId }
// step handlers: lib/workflows/steps/{ai,http,transform,branch,delay,connector}.ts
```

## Acceptance criteria
- [ ] A 3-step workflow (webhook → ai → http) runs end to end and meters exactly once per run.
- [ ] Crashing mid-run and re-executing resumes from the last incomplete step (no duplicate side effects, no double-charge).
- [ ] A `delay` step (e.g. wait 1h) survives across function invocations via `next_run_at` — no long-running invocation, zero compute while waiting.
- [ ] Step timeout retries with bounded attempts, then fails the step cleanly (run resumable).
- [ ] Manual trigger uses the same tick path (`next_run_at = now()`), no separate synchronous executor.
- [ ] Schedule trigger fires due runs; webhook trigger verifies its secret.
- [ ] `transform` step uses a safe evaluator — NO `eval`/`Function` on user input.
- [ ] No-credit halts the run cleanly; partial work is checkpointed.
- [ ] AI steps route through the #41 gateway on the owner's BYOK key (platform pays no compute).
- [ ] Template install clones a pinned version; original owner's keys/connectors are NOT copied.
- [ ] RLS: owner reads/runs only own workflows; run step I/O not readable cross-owner.
- [ ] Tests: executor resume, metering-once, transform safety, trigger auth.
