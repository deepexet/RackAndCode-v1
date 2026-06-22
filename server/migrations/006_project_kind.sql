ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'customer'
    CHECK (kind IN ('internal', 'customer'));

UPDATE projects
SET kind = 'internal', updated_at = CURRENT_TIMESTAMP, version = version + 1
WHERE organization_id = 'local-dev' AND id = 'fieldos-platform';

CREATE INDEX idx_projects_kind
ON projects(organization_id, kind, status);
