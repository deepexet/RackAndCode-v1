-- Connect human approval requests to the coordinator job that proposed them.
ALTER TABLE ai_approvals ADD COLUMN coordinator_job_id TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_approvals_coordinator_job
    ON ai_approvals(coordinator_job_id)
    WHERE coordinator_job_id IS NOT NULL;
