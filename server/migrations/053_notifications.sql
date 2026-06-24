-- In-app notification center
CREATE TABLE IF NOT EXISTS notifications (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         TEXT,                   -- NULL = org-wide broadcast
    type            TEXT NOT NULL,          -- 'work_item_unblocked'|'issue_opened'|'comment'|'ai_approval'|'system'
    title           TEXT NOT NULL,
    body            TEXT,
    entity_type     TEXT,                   -- 'project'|'work_item'|'issue'|etc.
    entity_id       TEXT,
    project_id      TEXT,
    read            INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(organization_id, user_id, read, created_at DESC);
