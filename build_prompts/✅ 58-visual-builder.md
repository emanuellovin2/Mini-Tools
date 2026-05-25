# Task #58 — Visual workflow builder + adaptive shell

> **Before starting:** read `SPEC.md`, [build_prompts/42-workflow-engine.md](build_prompts/42-workflow-engine.md) (`workflow_steps` draft + `workflow_versions.graph` snapshot — the builder drives these, it does not invent storage), [build_prompts/57-multi-agent-orchestration.md](build_prompts/57-multi-agent-orchestration.md) (`agent` node), [build_prompts/26-design-system-foundation.md](build_prompts/26-design-system-foundation.md) + [build_prompts/31 design system v2] (primitives + tokens to reuse), [lib/services/workflows.ts](lib/services/workflows.ts), [build_prompts/41-ai-gateway-byok.md](build_prompts/41-ai-gateway-byok.md) (the chat side of the shell).
> **Definition of Done:** a non-technical operator can build a workflow/agent graph on a **visual canvas** (nodes = steps, edges = handoff/next), save it as a draft, and publish it — all through the **existing** workflow APIs. The server **validates the graph authoritatively** (never trusts the client). One adaptive shell toggles between **chat** (gateway) and **canvas** (builder). IDE/Excel-like surfaces are explicitly out of scope — they're integrations (connectors), not reimplementations.

**Phase 7 — Wave 10, last. Depends on: #42 (graph storage + publish), #57 (agent node), #55/#56 (nodes reference bases + instruction sets), design system v2. Mostly frontend — the only load-bearing backend is the graph validator.**

> **Why now:** the engine, knowledge, instructions, and agents now exist but are only reachable via API/JSON. The builder is what makes the platform usable by agency operators who don't write code — the "80% of value for 20% of effort" surface, since the runtime is already built. Doing it last means the canvas renders a stable node/edge model instead of a moving target.

> **What this is NOT:** Notion/Figma/Excel-native apps (years of work — out of scope), and **not** real-time multiplayer editing (CRDT is a declared future seam, not v1). v1 is single-editor with an optimistic version lock. Keeping scope tight here is the whole point of this task.

---

## Scale / safety frame
- **The graph validator is the only thing that must be bulletproof.** The canvas is client state; the server must re-validate every save/publish against a shared Zod schema. Anything else is a security hole (a hand-crafted graph could reference another org's connector, a nonexistent knowledge base, or an agent with no budget cap → #57's cost guard bypassed).
- Large graphs must stay responsive: virtualize node rendering; don't re-layout the whole canvas on every keystroke. But this is a UI concern — the backend contract is just "validate + persist the graph JSON," which already scales (it's the same write path #42 ships).

---

## Sections to build

### 1. Shared graph schema + authoritative validator (the backend piece)
`lib/workflows/graph-schema.ts` — a single Zod schema for the graph (`{ nodes: Node[], edges: Edge[] }`), **imported by both client and server** (one source of truth). `validateGraph(graph, ctx)` runs server-side on every save/publish and asserts:
- Every node is a known step type with a valid config (delegates to each step's existing config schema, incl. `agent` requiring `budget_cents` + `max_iterations` per #57).
- No orphan nodes; exactly one entry; edges reference existing nodes; `next_step_key`/`handoff` resolve.
- Cycles only where intended (a `branch` may loop back; a plain chain may not) — cycle detection with an allow-flag.
- **Ownership/entitlement checks (security-critical):** every referenced `connector_account_id`, `knowledge_base_id`, `instruction_set_id`, `provider_key_id` is owned by (or public to) the caller's org. A graph referencing another tenant's resource is **rejected**, not silently dropped.
- Step count within `max_workflow_steps` quota (#48).
- Wire validation into the existing draft-save and publish endpoints; **publish is impossible if `validateGraph` fails** (the snapshot to `workflow_versions` only happens on a valid graph).

### 2. The canvas (frontend, design-system v2)
`app/builder/[workflowId]/` :
- Node palette: `ai`, `agent`, `http`, `transform`, `branch`, `delay`, `connector` — drag onto canvas.
- Per-node config drawer (reuse the `Drawer` primitive): edits the node's config with inline validation (the shared schema gives instant client-side feedback; server is still authoritative on save).
- Edge drawing for handoff/next; branch nodes render multiple labeled outputs.
- Agent nodes surface `knowledge_base_ids` (#55), `instruction_set_id` (#56), tools, budget — pickers populated only with org-owned/public resources.
- Save = draft (writes `workflow_steps` via existing service). Publish = snapshot (existing). **Optimistic version lock:** save sends the base version; a concurrent edit → 409 with a "reload" prompt (no lost-write, no CRDT).
- Validation panel: shows server validation errors inline on the offending node.

### 3. Adaptive shell (chat ↔ canvas, nothing more)
`components/layout/` — a shell that switches modes:
- **Chat** mode: a conversational surface over the gateway (#41) for a selected deployment — resolves instructions (#56), retrieves knowledge (#55). This is the "sometimes chat" face.
- **Canvas** mode: the builder above. This is the "sometimes no-code builder" face.
- Mode is a view toggle over the same context (org/deployment), not separate apps. **IDE / spreadsheet modes are explicitly deferred** — documented as "use a connector," not built.

### 4. Guardrails, quota, RLS
- Builder only edits workflows the user's org owns (existing workflow RLS); agency-vs-client editing rights follow #50 boundaries.
- `BUILDER_ENABLED` env flag gates the route. Off = no change.
- No new tables. No new write path. The builder is a client over #42's API + the new validator.

---

## Acceptance criteria
- [ ] `lib/workflows/graph-schema.ts` is the **single shared** Zod schema (client + server import it); no duplicate schema.
- [ ] `validateGraph` runs **server-side** on every save and publish; publish blocked on invalid graph (test).
- [ ] **Entitlement check:** a graph referencing another org's connector/knowledge base/instruction set/key is **rejected** server-side (security test, multiple resource types).
- [ ] `agent` nodes without `budget_cents`/`max_iterations` fail validation (cost-guard cannot be bypassed via builder).
- [ ] Cycle detection: an unintended cycle is rejected; an intended branch-loop is allowed (test both).
- [ ] Step count enforced against `max_workflow_steps` quota.
- [ ] Canvas: drag nodes, configure via drawer, draw edges, save draft, publish — exercised end-to-end against a real dev server (preview verification: build a 3-node Researcher→Writer→Critic graph and publish it).
- [ ] **Optimistic version lock:** concurrent edit returns 409, no lost write (test).
- [ ] Adaptive shell toggles chat↔canvas over the same context; chat path uses gateway + resolves #56 instructions + #55 retrieval.
- [ ] Large-graph rendering virtualized; no full re-layout per keystroke (perf sanity check).
- [ ] `BUILDER_ENABLED` gates the route; off = no behavior change.
- [ ] CLAUDE.md notes the builder + shared graph validator; SPEC.md documents that the graph validator is authoritative and IDE/spreadsheet modes are deferred.
