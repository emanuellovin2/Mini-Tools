-- #57 — Multi-agent orchestration: agent step type
--
-- Adds sub-workflow depth tracking to workflow_runs so the agent step can
-- enforce AGENT_MAX_SUBWORKFLOW_DEPTH without chasing ancestor rows.
--
-- Migration safety: nullable column → zero rewrites, no lock escalation.

ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS subworkflow_depth smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS parent_run_id uuid REFERENCES workflow_runs(id) ON DELETE SET NULL;

COMMENT ON COLUMN workflow_runs.subworkflow_depth IS
  'Depth from root run (0 = top-level). Bounded by AGENT_MAX_SUBWORKFLOW_DEPTH env var.';
COMMENT ON COLUMN workflow_runs.parent_run_id IS
  'Set when this run was triggered as a sub-workflow by an agent step.';

-- Index: look up child runs of a parent
CREATE INDEX IF NOT EXISTS workflow_runs_parent_run_id_idx
  ON workflow_runs (parent_run_id)
  WHERE parent_run_id IS NOT NULL;
