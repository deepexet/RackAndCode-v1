-- Project comments (threaded) and activity feed
CREATE TABLE IF NOT EXISTS project_comments (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL,   -- no FK: projects has composite PK
    parent_id       TEXT REFERENCES project_comments(id) ON DELETE CASCADE,
    author_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
    author_name     TEXT NOT NULL DEFAULT '',
    body            TEXT NOT NULL,
    mentions        TEXT NOT NULL DEFAULT '[]',  -- JSON array of user_ids
    edited          INTEGER NOT NULL DEFAULT 0,
    deleted         INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_project ON project_comments(organization_id, project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_parent  ON project_comments(parent_id);

-- Activity feed: auto-populated on key mutations
CREATE TABLE IF NOT EXISTS project_activity (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL,   -- no FK: projects has composite PK
    actor_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_name      TEXT NOT NULL DEFAULT '',
    event_type      TEXT NOT NULL,   -- 'comment' | 'daily_update' | 'location_added' | 'issue_opened' | ...
    summary         TEXT NOT NULL DEFAULT '',
    payload         TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_project ON project_activity(organization_id, project_id, created_at);
