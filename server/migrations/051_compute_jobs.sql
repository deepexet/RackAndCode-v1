-- Distributed compute jobs: tasks dispatched to compute-enabled nodes
CREATE TABLE IF NOT EXISTS compute_jobs (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    job_type        TEXT NOT NULL,       -- 'ai_inference'|'report_gen'|'index_rebuild'|'custom'
    payload         TEXT NOT NULL DEFAULT '{}',  -- JSON
    status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'dispatched'|'running'|'done'|'failed'
    node_id         TEXT,                -- assigned compute node
    priority        INTEGER NOT NULL DEFAULT 5,   -- 1 (urgent) .. 10 (low)
    created_by      TEXT,
    dispatched_at   TEXT,
    started_at      TEXT,
    completed_at    TEXT,
    result          TEXT,               -- JSON result or error
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compute_jobs_status ON compute_jobs(organization_id, status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_compute_jobs_node   ON compute_jobs(node_id, status);
