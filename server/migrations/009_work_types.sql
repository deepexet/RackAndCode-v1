CREATE TABLE work_types (
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    position INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, id),
    UNIQUE (organization_id, code)
);

ALTER TABLE project_work_items ADD COLUMN work_type_id TEXT;

CREATE INDEX idx_project_work_items_type
ON project_work_items(organization_id, project_id, work_type_id, status);

INSERT INTO work_types (organization_id, id, code, name, color, position, active, created_at) VALUES
    ('local-dev', 'data', 'data', 'Data', '#62a8ff', 0, 1, CURRENT_TIMESTAMP),
    ('local-dev', 'termination', 'termination', 'Termination', '#ffb45c', 1, 1, CURRENT_TIMESTAMP),
    ('local-dev', 'fiber', 'fiber', 'Fiber', '#d987ff', 2, 1, CURRENT_TIMESTAMP),
    ('local-dev', 'access-control', 'access_control', 'Access Control', '#31d4a2', 3, 1, CURRENT_TIMESTAMP),
    ('local-dev', 'cctv', 'cctv', 'CCTV', '#ff7185', 4, 1, CURRENT_TIMESTAMP),
    ('local-dev', 'network', 'network', 'Network', '#7c8cff', 5, 1, CURRENT_TIMESTAMP),
    ('local-dev', 'commissioning', 'commissioning', 'Commissioning', '#42d697', 6, 1, CURRENT_TIMESTAMP),
    ('local-dev', 'other', 'other', 'Other', '#8893a6', 7, 1, CURRENT_TIMESTAMP);
