-- Project risk register
CREATE TABLE IF NOT EXISTS project_risks (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    probability     TEXT NOT NULL DEFAULT 'medium' CHECK (probability IN ('low','medium','high')),
    impact          TEXT NOT NULL DEFAULT 'medium' CHECK (impact IN ('low','medium','high')),
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','mitigated','closed','accepted')),
    mitigation      TEXT NOT NULL DEFAULT '',
    owner           TEXT NOT NULL DEFAULT '',
    due_date        TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_risks
    ON project_risks(organization_id, project_id, status);
