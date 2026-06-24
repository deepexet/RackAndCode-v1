-- Project template library: reusable project scaffolds with pre-defined stages, work types, and work items
CREATE TABLE IF NOT EXISTS project_templates (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    category        TEXT NOT NULL DEFAULT 'general',   -- 'general'|'residential'|'commercial'|'data_centre'
    scaffold        TEXT NOT NULL DEFAULT '{}',        -- JSON: {stages:[],workItems:[],defaultWorkTypes:[]}
    is_public       INTEGER NOT NULL DEFAULT 0,        -- shared across all orgs in future
    created_by      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (organization_id, name)
);

CREATE INDEX IF NOT EXISTS idx_templates_org ON project_templates(organization_id, category);
