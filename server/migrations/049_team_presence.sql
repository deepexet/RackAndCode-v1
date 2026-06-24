-- Field presence: daily presence records (who was on-site at which project)
CREATE TABLE IF NOT EXISTS team_presence (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL,  -- no FK (composite PK on projects)
    member_id       TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
    presence_date   TEXT NOT NULL,  -- YYYY-MM-DD
    check_in        TEXT,           -- ISO time (optional)
    check_out       TEXT,           -- ISO time (optional)
    notes           TEXT,
    recorded_by     TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (organization_id, project_id, member_id, presence_date)
);

CREATE INDEX IF NOT EXISTS idx_team_presence_project
    ON team_presence (organization_id, project_id, presence_date DESC);
CREATE INDEX IF NOT EXISTS idx_team_presence_member
    ON team_presence (organization_id, member_id, presence_date DESC);
