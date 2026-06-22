CREATE TABLE project_change_log (
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('project', 'building', 'work_item')),
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    old_value TEXT NOT NULL,
    new_value TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, id),
    FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_project_change_log_timeline
ON project_change_log(organization_id, project_id, created_at DESC);
