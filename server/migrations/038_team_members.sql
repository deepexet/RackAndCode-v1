-- Team member profiles, skills, and project assignments
CREATE TABLE IF NOT EXISTS team_members (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    email           TEXT NOT NULL DEFAULT '',
    role            TEXT NOT NULL DEFAULT 'Technician',   -- platform role
    trade           TEXT NOT NULL DEFAULT '',             -- e.g. 'Low Voltage', 'Electrical'
    skills          TEXT NOT NULL DEFAULT '[]',           -- JSON array of skill strings
    phone           TEXT NOT NULL DEFAULT '',
    availability    TEXT NOT NULL DEFAULT 'available',    -- 'available'|'busy'|'off'
    notes           TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_team_org ON team_members(organization_id, availability);

-- Project assignments: which team members are on which projects
CREATE TABLE IF NOT EXISTS project_assignments (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL,
    member_id       TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
    role_on_project TEXT NOT NULL DEFAULT '',   -- e.g. 'Lead Tech', 'Foreman'
    assigned_at     TEXT NOT NULL,
    UNIQUE(organization_id, project_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_assignments_project ON project_assignments(organization_id, project_id);
CREATE INDEX IF NOT EXISTS idx_assignments_member  ON project_assignments(member_id);
