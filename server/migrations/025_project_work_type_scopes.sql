CREATE TABLE project_work_type_scopes (
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    work_type_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, project_id, work_type_id),
    FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id, work_type_id) REFERENCES work_types(organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_project_work_type_scopes_active
ON project_work_type_scopes(organization_id, project_id, active);

INSERT INTO project_work_type_scopes (organization_id, project_id, work_type_id, active, created_at)
SELECT project.organization_id, project.id, work_type.id, 1, CURRENT_TIMESTAMP
FROM projects project
JOIN work_types work_type
  ON work_type.organization_id = project.organization_id
WHERE work_type.active = 1;
