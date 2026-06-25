-- Comments thread on work items and issues
CREATE TABLE IF NOT EXISTS work_item_comments (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    work_item_id    TEXT NOT NULL,
    project_id      TEXT NOT NULL,
    author_id       TEXT,
    author_name     TEXT NOT NULL DEFAULT '',
    body            TEXT NOT NULL,
    edited          INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wi_comments ON work_item_comments(organization_id, work_item_id, created_at);
