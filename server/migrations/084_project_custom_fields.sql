-- Extend custom field scope to include project and work_item entities
-- SQLite does not support modifying CHECK constraints, so we recreate the table
CREATE TABLE IF NOT EXISTS custom_field_definitions_v2 (
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id              TEXT NOT NULL,
    scope           TEXT NOT NULL CHECK(scope IN ('location','unit','project','work_item')),
    code            TEXT NOT NULL,
    label           TEXT NOT NULL,
    data_type       TEXT NOT NULL CHECK(data_type IN ('text','number','boolean','date','select')),
    options_json    TEXT NOT NULL DEFAULT '[]',
    required        INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0,1)),
    position        INTEGER NOT NULL,
    active          INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    version         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (organization_id, id),
    UNIQUE (organization_id, scope, code)
);
INSERT OR IGNORE INTO custom_field_definitions_v2
    SELECT * FROM custom_field_definitions;
CREATE INDEX IF NOT EXISTS idx_custom_field_scope_v2
    ON custom_field_definitions_v2(organization_id, scope, active, position);

-- Values store for project custom fields
CREATE TABLE IF NOT EXISTS project_custom_field_values (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    field_id        TEXT NOT NULL,
    value_text      TEXT,
    value_number    REAL,
    value_bool      INTEGER,
    value_date      TEXT,
    updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proj_cfv
    ON project_custom_field_values(organization_id, project_id, field_id);
