ALTER TABLE project_locations ADD COLUMN parent_location_id TEXT;
ALTER TABLE project_locations ADD COLUMN custom_fields TEXT NOT NULL DEFAULT '{}';

CREATE INDEX idx_project_locations_parent
ON project_locations(organization_id, project_id, parent_location_id);

CREATE TRIGGER validate_project_location_parent_insert
BEFORE INSERT ON project_locations
WHEN NEW.parent_location_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM project_locations parent
        WHERE parent.organization_id = NEW.organization_id
          AND parent.project_id = NEW.project_id
          AND parent.id = NEW.parent_location_id
    ) THEN RAISE(ABORT, 'parent location must belong to the same project') END;
END;

CREATE TRIGGER validate_project_location_parent_update
BEFORE UPDATE OF parent_location_id ON project_locations
WHEN NEW.parent_location_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NEW.parent_location_id = NEW.id THEN RAISE(ABORT, 'location cannot be its own parent') END;
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM project_locations parent
        WHERE parent.organization_id = NEW.organization_id
          AND parent.project_id = NEW.project_id
          AND parent.id = NEW.parent_location_id
    ) THEN RAISE(ABORT, 'parent location must belong to the same project') END;
    SELECT CASE WHEN EXISTS (
        WITH RECURSIVE descendants(id) AS (
            SELECT id FROM project_locations
            WHERE organization_id = NEW.organization_id AND parent_location_id = NEW.id
            UNION ALL
            SELECT child.id FROM project_locations child JOIN descendants ON child.parent_location_id = descendants.id
            WHERE child.organization_id = NEW.organization_id
        )
        SELECT 1 FROM descendants WHERE id = NEW.parent_location_id
    ) THEN RAISE(ABORT, 'location hierarchy cycle') END;
END;
