# Task #56 — Hierarchical instruction sets + prompt versioning

> **Before starting:** read `SPEC.md`, [build_prompts/50-agency-client-deployments.md](build_prompts/50-agency-client-deployments.md), [lib/services/deployments.ts](lib/services/deployments.ts) (`getEffectiveConfig` — the caching + merge pattern to copy exactly), [build_prompts/42-workflow-engine.md](build_prompts/42-workflow-engine.md) (`workflow_versions` immutable-snapshot pattern + the safe `{{path}}` template expansion — NO eval), [build_prompts/53-client-portal.md](build_prompts/53-client-portal.md) (`branding_version` Redis counter invalidation pattern), [build_prompts/41-ai-gateway-byok.md](build_prompts/41-ai-gateway-byok.md) (`gateway_products.system_prompt` — the field this generalizes).
> **Definition of Done:** instructions ("who the AI is") become **layered and versioned** instead of a single static `system_prompt`. An org sets a `global` instruction set; a `project` set refines it; a `client` set refines that; a `deployment` set refines that. At call time, the gateway/workflow resolves the **merged** instruction deterministically, from a Redis-cached read that never hits the DB on the hot path. Every change is an immutable, diffable version (Git-like for prompts).

**Phase 7 — Wave 10. Depends on: #50 (org/client/deployment scopes), #41 (gateway system_prompt to generalize), #42 (template expansion + version pattern). Parallel-able with #55. Consumed by #57 (each agent resolves its own instruction set).**

> **Why now:** the moment there's more than one deployment, "one system prompt per product" stops scaling — agencies need a house voice (global), per-engagement rules (project), per-client tone/constraints (client), and per-deployment overrides, without copy-pasting prompts. Build the resolver + cache correctly once; it sits on the hottest path (every single AI call resolves instructions).

> **What this is NOT:** a free-form prompt soup. Merge is **deterministic and structured** (blocks with explicit append/replace modes), not ambiguous string concatenation. And it is **not** a place for secrets or keys — those stay in the #41 vault.

---

## Scale frame
- Resolution runs on **every** gateway/workflow AI call. At target volume this is the single hottest read in the system. Therefore resolution is **cache-first**, mirroring `getEffectiveConfig`: Redis (5 min) + in-process LRU (30 s), keyed by `(orgId, projectId, clientOrgId, deploymentId, version_counter)`. The version counter makes invalidation O(1) — bump on publish, all stale keys fall out naturally. **The hot path must never touch Postgres after warm.**

---

## Sections to build

### 1. `instruction_sets` + immutable `instruction_versions`
**`instruction_sets`** — the editable head per scope.
```
id uuid pk
org_id uuid NOT NULL FK organizations(id) ON DELETE CASCADE
scope_level text NOT NULL              -- 'global' | 'project' | 'client' | 'deployment'
scope_ref_id uuid                      -- NULL for global; project_id / client_org_id / deployment_id otherwise
name text NOT NULL
active_version_id uuid                  -- FK instruction_versions(id); the currently-resolved version
status text NOT NULL DEFAULT 'draft'    -- draft | published
created_at timestamptz NOT NULL DEFAULT now()
UNIQUE (org_id, scope_level, scope_ref_id)   -- one set per scope target
```
**`instruction_versions`** — immutable snapshots (Git-like; same discipline as `workflow_versions`).
```
id uuid pk
instruction_set_id uuid NOT NULL FK instruction_sets(id) ON DELETE CASCADE
version int NOT NULL                    -- monotonic per set; CHECK > 0
blocks jsonb NOT NULL                   -- structured body (see §2)
variables jsonb NOT NULL DEFAULT '{}'   -- typed key→value defaults for {{var}} expansion
content_hash text NOT NULL              -- dedupe no-op publishes
created_by uuid NOT NULL
created_at timestamptz NOT NULL DEFAULT now()
UNIQUE (instruction_set_id, version)
```
- **Cap 50 versions per set** via trigger (same as `workflow_versions`). Publishing = insert new version + flip `active_version_id` + bump cache counter, in one transaction.

### 2. Structured, deterministic merge (the no-redo decision)
`blocks` is an ordered array, not a blob:
```ts
type Block = { key: string; mode: 'append' | 'replace'; text: string };
```
- Resolution composes scopes in precedence **global → project → client → deployment** (least → most specific).
- For each `key`: `replace` overrides any same-key block from a less-specific scope; `append` concatenates after it. Unknown keys from a more-specific scope are appended at the end in scope order.
- Output: a single composed system prompt string + a merged `variables` map (more-specific scope wins per key).
- **Determinism is the contract:** same inputs → byte-identical output. A property test asserts this (so the cache is safe and diffs are meaningful).
- `lib/instructions/resolve.ts` — pure function `resolveInstructions(scopes: ScopedVersion[]): { systemPrompt: string; variables: Record<string,string> }`. No IO. Heavily unit-tested.

### 3. Resolution service (cache-first, mirrors `getEffectiveConfig`)
`lib/services/instructions.ts`:
```ts
getEffectiveInstructions({ orgId, projectId?, clientOrgId?, deploymentId? }): Promise<{ systemPrompt, variables, resolvedFrom: string[] }>
```
- Loads the active version for each applicable scope (only the sets that exist), passes to the pure resolver, caches the result. `resolvedFrom` lists which scopes contributed (for the UI "this instruction came from: global + client").
- Redis key includes `instruction_version:{orgId}` counter; **`bumpInstructionVersion(orgId)`** on any publish (copy `bumpBrandingVersion` from #53).
- Variable expansion uses the workflow engine's **safe `{{path}}` template expander — NO eval** (existing guardrail). Expansion happens after merge, before handing to the model.

### 4. Versioning UX primitives
- `lib/instructions/diff.ts` — pure `diffVersions(a: Version, b: Version): BlockDiff[]` (added/removed/changed blocks) for a Git-style diff view.
- Publish / rollback (set `active_version_id` to an older version — a new pointer, not a delete; history is immutable).

### 5. Wire into the call paths
- **Gateway (#41):** replace the static `gateway_products.system_prompt` usage with `getEffectiveInstructions(...)`. Keep `system_prompt` as the seed for an auto-created `global` instruction set on migration (no behavior change for existing products — backfill once).
- **Workflow `ai` step + #57 `agent` step:** resolve instructions by the run's `(orgId, deploymentId, clientOrgId)` instead of inline prompt text.

### 6. RLS, quotas
- RLS: org-owned via `is_org_member`. `client`-scope sets visible to the operating agency + the client org per #50 trust boundaries. `deployment`-scope follows deployment RLS. No cross-tenant reads.
- Quota (#48): `instruction_sets` per org (default 200). `enforceQuota()` on create.

### 7. Surface
- `app/settings/instructions/` — list sets by scope, block editor (key + mode + text), variables editor, version history with diff view, publish/rollback. Dense, design-system v2. Show the **live resolved preview** for a chosen `(project, client, deployment)` context so users see exactly what the model will get.

---

## Acceptance criteria
- [ ] `instruction_sets` + `instruction_versions` created; one set per `(org, scope_level, scope_ref)`; versions immutable + capped at 50.
- [ ] `resolveInstructions` is **pure + deterministic** — property test: same inputs → byte-identical output across 1000 randomized scope combinations.
- [ ] Merge precedence global→project→client→deployment correct; `replace` overrides, `append` concatenates (unit tests per mode).
- [ ] `getEffectiveInstructions` is **cache-first** (Redis + LRU), keyed by a per-org version counter; publish bumps the counter; hot path proven to not hit Postgres after warm (test asserts query count = 0 on cache hit).
- [ ] Variable expansion uses the **safe template expander (NO eval)**; an injection-style variable value cannot execute.
- [ ] Existing `gateway_products.system_prompt` backfilled into an auto-created `global` set; existing products behave identically (regression test).
- [ ] Gateway + workflow `ai` step resolve via `getEffectiveInstructions` instead of inline prompt.
- [ ] `diffVersions` powers a version-history diff view; rollback re-points `active_version_id` without deleting history.
- [ ] RLS: client/deployment-scope visibility respects #50 boundaries (RLS test, 8+ cases).
- [ ] Quota `instruction_sets` enforced; default-deny.
- [ ] CLAUDE.md gains an "Instruction sets (as of #56)" section; SPEC.md documents the merge precedence + block semantics.
