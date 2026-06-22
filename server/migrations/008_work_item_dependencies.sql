CREATE TABLE work_item_dependencies (
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    dependent_item_id TEXT NOT NULL,
    predecessor_item_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, dependent_item_id, predecessor_item_id),
    CHECK (dependent_item_id <> predecessor_item_id),
    FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id, dependent_item_id)
        REFERENCES project_work_items(organization_id, id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id, predecessor_item_id)
        REFERENCES project_work_items(organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_work_item_dependencies_predecessor
ON work_item_dependencies(organization_id, project_id, predecessor_item_id);
