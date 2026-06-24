-- Self-documenting platform: AI-generated guides per feature task
CREATE TABLE IF NOT EXISTS feature_guides (
    task_id      TEXT PRIMARY KEY,
    content      TEXT NOT NULL,
    generated_by TEXT NOT NULL DEFAULT 'claude',
    model        TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
