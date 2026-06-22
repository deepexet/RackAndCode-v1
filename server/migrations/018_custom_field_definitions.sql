CREATE TABLE custom_field_definitions (
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('location','unit')),
    code TEXT NOT NULL,
    label TEXT NOT NULL,
    data_type TEXT NOT NULL CHECK(data_type IN ('text','number','boolean','date','select')),
    options_json TEXT NOT NULL DEFAULT '[]',
    required INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0,1)),
    position INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (organization_id,id),
    UNIQUE (organization_id,scope,code)
);

CREATE INDEX idx_custom_field_scope
ON custom_field_definitions(organization_id,scope,active,position);
