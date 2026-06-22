CREATE TABLE buildings (
    organization_id TEXT NOT NULL,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planned'
        CHECK (status IN ('planned', 'active', 'on_hold', 'completed')),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, id),
    UNIQUE (organization_id, project_id, code),
    FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE project_work_items (
    organization_id TEXT NOT NULL,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    building_id TEXT,
    stage_id TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'backlog'
        CHECK (status IN ('ideas', 'backlog', 'ready', 'progress', 'blocked', 'review', 'testing', 'done')),
    priority TEXT NOT NULL DEFAULT 'medium'
        CHECK (priority IN ('critical', 'high', 'medium', 'low')),
    assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    start_date TEXT,
    due_date TEXT,
    estimated_minutes INTEGER CHECK (estimated_minutes IS NULL OR estimated_minutes >= 0),
    actual_minutes INTEGER NOT NULL DEFAULT 0 CHECK (actual_minutes >= 0),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, id),
    FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id, building_id)
        REFERENCES buildings(organization_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id, stage_id)
        REFERENCES project_stages(organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_buildings_project
ON buildings(organization_id, project_id, status);

CREATE INDEX idx_project_work_items_flow
ON project_work_items(organization_id, project_id, status, priority);

CREATE INDEX idx_project_work_items_building
ON project_work_items(organization_id, building_id);

CREATE INDEX idx_project_work_items_assignee
ON project_work_items(assignee_user_id, status);
