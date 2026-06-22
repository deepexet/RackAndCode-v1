CREATE TABLE projects (
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planned'
        CHECK (status IN ('planned', 'active', 'on_hold', 'completed', 'cancelled')),
    priority TEXT NOT NULL DEFAULT 'medium'
        CHECK (priority IN ('critical', 'high', 'medium', 'low')),
    start_date TEXT,
    target_date TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, id),
    UNIQUE (organization_id, code)
);

CREATE TABLE project_stages (
    organization_id TEXT NOT NULL,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    task_area TEXT,
    position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned'
        CHECK (status IN ('planned', 'active', 'completed', 'blocked')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, id),
    UNIQUE (organization_id, project_id, code),
    FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_projects_status
ON projects(organization_id, status, priority);

CREATE INDEX idx_project_stages_order
ON project_stages(organization_id, project_id, position);

INSERT INTO projects (
    organization_id, id, code, name, description, status, priority,
    start_date, target_date, version, created_at, updated_at
) VALUES (
    'local-dev', 'fieldos-platform', 'FIELDOS', 'FieldOS Platform',
    'Внутренняя разработка AI Operating System.', 'active', 'critical',
    date('now'), NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

INSERT INTO project_stages (
    organization_id, id, project_id, code, name, task_area, position,
    status, created_at, updated_at
) VALUES
    ('local-dev', 'fieldos-foundation', 'fieldos-platform', 'foundation', 'Foundation', 'foundation', 0, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('local-dev', 'fieldos-platform-core', 'fieldos-platform', 'platform', 'Platform Core', 'platform', 1, 'planned', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('local-dev', 'fieldos-field-operations', 'fieldos-platform', 'field', 'Field Operations', 'field', 2, 'planned', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('local-dev', 'fieldos-intelligence', 'fieldos-platform', 'intelligence', 'Intelligence', 'intelligence', 3, 'planned', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('local-dev', 'fieldos-ecosystem', 'fieldos-platform', 'ecosystem', 'Scale & Ecosystem', 'ecosystem', 4, 'planned', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
