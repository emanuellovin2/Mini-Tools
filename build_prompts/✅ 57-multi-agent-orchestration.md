# Task #57 — Multi-agent orchestration (the `agent` step)

> **Before starting:** read `SPEC.md`, [build_prompts/42-workflow-engine.md](build_prompts/42-workflow-engine.md) (the durable executor — **one step per invocation, no long-running functions**; `claim_workflow_run` SKIP LOCKED; `run_steps` checkpoints), [lib/services/workflows.ts](lib/services/workflows.ts) (`executeRun`), [lib/workflows/steps/](lib/workflows/steps/) (existing step types to extend, never replace), [build_prompts/41-ai-gateway-byok.md](build_prompts/41-ai-gateway-byok.md) (reserve-then-settle, spend caps, idempotency — **all LLM calls go through here**), [build_prompts/55-knowledge-rag-foundation.md](build_prompts/55-knowledge-rag-foundation.md) (retrieve = a tool), [build_prompts/56-instruction-sets.md](build_prompts/56-instruction-sets.md) (each agent resolves its instructions), [build_prompts/43-connectors.md](build_prompts/43-connectors.md) (connectors = tools).
> **Definition of Done:** a new workflow step type `agent` that runs a role-driven agent (its own instructions + knowledge + tools) with a bounded think→act→observe loop, **fully durable** (each iteration is a checkpointed executor slice — never a long-running function), with a **hard cost ceiling** per run. Chains like Researcher → Writer → Critic are three `agent` steps wired by handoff. We extend the workflow engine; we reinvent nothing.

**Phase 7 — Wave 10. Depends on: #42 (executor + run state machine), #41 (gateway — the only LLM path), #55 (knowledge retrieve as a tool), #56 (per-agent instruction resolution), #43 (connectors as tools). Last of the engine tasks before the visual builder (#58).**

> **Why now:** single-prompt agents plateau fast; the value (and the differentiation vs. a bare Custom GPT) is *composed* agents with roles, memory, tools, and budgets. The existing workflow engine already gives durability, claiming, retries, and versioning — the agent is one more step type on top, which is exactly why it's safe to build now and dangerous to build as a bespoke runtime.

> **What this is NOT:** an unbounded autonomous loop running in one function. That is the #1 way agent systems melt at scale (cost runaways, 10-minute function timeouts, lost work on crash). Every iteration here is a **claimed, checkpointed, budgeted** slice — crash-safe and cost-capped by construction.

---

## Scale frame (the load-bearing design choices)
- **One agent iteration = one executor invocation.** A "step" (e.g. the Researcher) may take several iterations (LLM call → tool call → observe → repeat). Each iteration: claim the run (`claim_workflow_run`, SKIP LOCKED) → load scratchpad from `run_steps.state` → one LLM call (via gateway) → at most one tool exec → write scratchpad back → yield. No function runs longer than one slice. At 10k concurrent agent runs this is just 10k cheap claimed jobs, not 10k long-lived processes.
- **Hard cost ceiling per run.** Before every LLM call, reserve credits via #41's `reserve_credits()`; track cumulative spend on the run; exceed `budget_cents` → fail the step gracefully (no partial charge — release reservation). Without this, a looping agent is an unbounded bill. This is non-negotiable.
- **Bounded scratchpad.** Agent message history lives in `run_steps.state`; cap it (token budget) and summarize-or-truncate oldest turns when it grows. Prevents row bloat and runaway context cost.

---

## Sections to build

### 1. The `agent` step type (extend, don't replace)
`lib/workflows/steps/agent.ts` — registered alongside `ai|http|transform|branch|delay|connector`. Step config (lives in `workflow_versions.graph`, so it's already versioned/immutable — no new versioning table):
```ts
type AgentStepConfig = {
  role: string;                       // 'researcher' | 'writer' | 'critic' | freeform — labels the agent
  instruction_set_id?: string;        // resolved via #56 getEffectiveInstructions; else inline system_prompt
  system_prompt?: string;
  knowledge_base_ids?: string[];      // #55 retrieve = long-term memory tool
  tools: ToolRef[];                   // connector ids (#43), http, knowledge.retrieve, sub-workflow call
  model: string;
  max_iterations: number;             // per-agent loop cap; hard ceiling AGENT_MAX_ITERATIONS_CAP
  budget_cents: number;               // per-step cost cap, counts toward run budget
  output_schema?: JsonSchema;         // typed handoff (see §3)
  handoff: string;                    // next_step_key
};
```

### 2. The durable iteration loop
In `executeRun` (`lib/services/workflows.ts`), the `agent` branch runs **exactly one iteration per invocation**:
1. Load `run_steps.state` for this step = `{ messages, iteration, spent_cents }` (empty on first entry).
2. Budget check: `run.spent_cents + estimate > run.budget_cents` → fail step, release any reservation, set run state.
3. Resolve instructions (#56) for `(orgId, deploymentId, clientOrgId)`; if `knowledge_base_ids`, retrieve (#55) and inject.
4. **One** LLM call via the gateway (#41) — reserve → call → settle; idempotency key `{run_id}:{step_key}:{iteration}` (reuses #42's `run_steps.idempotency_key` discipline → no double-charge on retry).
5. If the model requests a tool: execute **one** tool (reusing existing step executors — connector/http/transform; `knowledge.retrieve`; or a sub-workflow trigger), append observation to `messages`, increment `iteration`, persist state, **yield** (next slice continues the loop).
6. If the model returns a final answer OR `iteration >= max_iterations`: validate against `output_schema`, write the handoff payload to run context, advance `next_step_key = handoff`. Done.
- Crash between any two iterations: the run is re-claimed and resumes from persisted `run_steps.state` with no duplicate side effects (the idempotency key guards the in-flight LLM call).

### 3. Typed handoff (Researcher → Writer → Critic)
- Each agent's `output_schema` (Zod-validated) defines what it hands the next step. The Researcher emits `{ findings: [...] }`; the Writer reads it from run context as typed input; the Critic reads the Writer's output. No ambiguous string passing.
- `lib/workflows/agent/handoff.ts` — `validateHandoff(output, schema)` + `readUpstream(runContext, stepKey)`. Invalid handoff = step failure (surfaced, not silently coerced).

### 4. Guards (cost + loop safety)
`lib/workflows/agent/{budget,loop}.ts`:
- **Budget:** cumulative `run.spent_cents` enforced before each call; per-step `budget_cents` enforced too. Hard platform ceiling `AGENT_MAX_RUN_BUDGET_CENTS` caps any single run regardless of config.
- **Loop / no-progress:** abort if `iteration >= max_iterations`, or if the same tool call with identical args repeats N times (no-progress detection), or if total run steps exceed the workflow cap (#42). Aborts are clean failures with a reason, never silent spins.
- All caps are also enforced server-side at publish-time validation (an agent step without a `budget_cents` and `max_iterations` fails graph validation — see #58).

### 5. Tools = existing capabilities (no new runtime)
- `connector` tools → `runConnectorStep` (#43), creds from the encrypted vault, auto-refreshed.
- `http` tool → existing http step executor.
- `knowledge.retrieve` tool → #55 `retrieve` scoped to the deployment's entitled bases.
- `sub-workflow` tool → trigger another workflow run (bounded depth cap to prevent recursion bombs).
- Tool catalog assembled per-agent from `tools[]`; the model only sees tools it's granted (least privilege).

### 6. Templates, RLS, observability
- Multi-agent workflows are **sellable templates** via the existing `installTemplate` (strips `provider_key_id` + connector creds — buyer supplies own; already implemented in #42). No new path.
- RLS: reuses workflow/run RLS (org-owned; agency reads operated runs; client reads own). Agents inherit the run's trust boundary — an agent can only retrieve/connect within its deployment's entitlements.
- Each iteration writes a `run_steps` checkpoint → the run timeline UI shows the agent's think/act/observe trace (debuggability at scale). Outcome metrics (#51) can be emitted from agent steps (e.g. `task.completed`).

### 7. Env
- `AGENT_MAX_ITERATIONS_CAP` (hard per-agent ceiling, default 12).
- `AGENT_MAX_RUN_BUDGET_CENTS` (hard per-run cost ceiling, default e.g. 500).
- `AGENT_MAX_SUBWORKFLOW_DEPTH` (default 3).

---

## Acceptance criteria
- [ ] `agent` step type registered; config Zod-validated; lives in `workflow_versions.graph` (no new versioning table).
- [ ] **One iteration per executor invocation** — proven by a test that runs a 3-iteration agent across 3 claimed slices, asserting no long-running call and correct resume.
- [ ] **Crash-safety:** killing the worker mid-iteration and re-claiming resumes from `run_steps.state` with no duplicate LLM charge (idempotency-key test).
- [ ] **Cost ceiling:** an agent configured to loop is stopped at `budget_cents`/`max_iterations`; reservation released; no charge beyond the cap (budget test).
- [ ] All LLM calls go through the **gateway** (reserve→settle, spend caps, BYOK) — a test asserts no direct provider call from the agent step.
- [ ] **Typed handoff:** Researcher→Writer→Critic fixture chain passes typed payloads; an invalid handoff fails the step (schema test).
- [ ] **No-progress / loop guard** aborts a repeating agent cleanly with a reason.
- [ ] Tools are least-privilege (agent only sees granted tools); `knowledge.retrieve` scoped to entitled bases (cross-tenant tool-call test returns nothing).
- [ ] Sub-workflow recursion bounded by `AGENT_MAX_SUBWORKFLOW_DEPTH`.
- [ ] Scratchpad size-bounded; an over-long conversation is summarized/truncated, not unbounded (row-size test).
- [ ] Multi-agent workflow installs as a template with keys/creds stripped (reuse #42 path).
- [ ] CLAUDE.md "Workflow engine" section gains the `agent` step type; SPEC.md documents the iteration/budget/handoff model.
