-- Editable manual notes per project per day, merged into auto-generated daily log
CREATE TABLE IF NOT EXISTS daily_log_notes (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL,          -- no FK (composite PK on projects)
    work_date       TEXT NOT NULL,          -- YYYY-MM-DD
    note            TEXT NOT NULL DEFAULT '',
    author_id       TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (organization_id, project_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_log_notes_project
    ON daily_log_notes (organization_id, project_id, work_date DESC);
