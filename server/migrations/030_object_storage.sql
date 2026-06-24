-- Local object storage: files attached to projects (stored in data/objects/)
CREATE TABLE IF NOT EXISTS objects (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      TEXT,                -- NULL = org-level
    name            TEXT NOT NULL,
    mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes      INTEGER NOT NULL DEFAULT 0,
    storage_path    TEXT NOT NULL,       -- relative to data/objects/
    created_by      TEXT NOT NULL REFERENCES users(id),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_objects_project ON objects(organization_id, project_id);
CREATE INDEX IF NOT EXISTS idx_objects_name    ON objects(organization_id, name);
