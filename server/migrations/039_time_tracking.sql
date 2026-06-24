-- Time tracking: work sessions per team member per project
CREATE TABLE IF NOT EXISTS time_sessions (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    member_id       TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL,    -- no FK (composite PK on projects)
    work_type_id    TEXT,             -- optional work type reference
    started_at      TEXT NOT NULL,
    ended_at        TEXT,             -- NULL = session in progress
    duration_min    INTEGER,          -- computed on end; NULL while in progress
    notes           TEXT NOT NULL DEFAULT '',
    approved        INTEGER NOT NULL DEFAULT 0,
    approved_by     TEXT REFERENCES users(id),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_member  ON time_sessions(member_id, started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON time_sessions(organization_id, project_id, started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_open    ON time_sessions(member_id, ended_at);
