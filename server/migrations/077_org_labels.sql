-- Organization-level label definitions
CREATE TABLE IF NOT EXISTS org_labels (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    color           TEXT NOT NULL DEFAULT '#4f8ef7',
    created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_labels_name
    ON org_labels(organization_id, name);
