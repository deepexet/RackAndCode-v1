-- Risk register for projects
CREATE TABLE IF NOT EXISTS project_risks (
    id              TEXT NOT NULL,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    probability     TEXT NOT NULL DEFAULT 'medium'
        CHECK (probability IN ('low','medium','high')),
    impact          TEXT NOT NULL DEFAULT 'medium'
        CHECK (impact IN ('low','medium','high','critical')),
    status          TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','mitigated','accepted','closed')),
    mitigation      TEXT NOT NULL DEFAULT '',
    owner           TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_risks_proj
    ON project_risks(organization_id, project_id, status);
