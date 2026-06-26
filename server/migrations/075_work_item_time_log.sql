-- Detailed time log entries for work items
CREATE TABLE IF NOT EXISTS work_item_time_log (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    work_item_id    TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL,
    minutes         INTEGER NOT NULL CHECK (minutes > 0),
    worker_name     TEXT NOT NULL DEFAULT '',
    note            TEXT NOT NULL DEFAULT '',
    spent_at        TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wi_time_log
    ON work_item_time_log(organization_id, work_item_id, spent_at DESC);
CREATE INDEX IF NOT EXISTS idx_time_log_project
    ON work_item_time_log(organization_id, project_id, spent_at DESC);
