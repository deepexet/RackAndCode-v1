-- Project milestones: named checkpoints with target dates
CREATE TABLE IF NOT EXISTS project_milestones (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    target_date     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'at_risk', 'achieved', 'missed')),
    achieved_at     TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_milestones_project ON project_milestones(organization_id, project_id, target_date);

-- Org-level settings: timezone, locale, date format, currency
CREATE TABLE IF NOT EXISTS org_settings (
    organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    timezone        TEXT NOT NULL DEFAULT 'UTC',
    locale          TEXT NOT NULL DEFAULT 'en',
    date_format     TEXT NOT NULL DEFAULT 'YYYY-MM-DD',
    currency        TEXT NOT NULL DEFAULT 'USD',
    work_week_start INTEGER NOT NULL DEFAULT 1,  -- 0=Sun, 1=Mon
    updated_at      TEXT NOT NULL
);
