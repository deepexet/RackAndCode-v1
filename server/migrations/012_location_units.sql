CREATE TABLE project_change_log_v3 (
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('project','building','work_item','location','daily_update','issue','unit','unit_progress')),
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    old_value TEXT NOT NULL,
    new_value TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (organization_id,id),
    FOREIGN KEY (organization_id,project_id) REFERENCES projects(organization_id,id) ON DELETE CASCADE
);
INSERT INTO project_change_log_v3 SELECT * FROM project_change_log;
DROP TABLE project_change_log;
ALTER TABLE project_change_log_v3 RENAME TO project_change_log;
CREATE INDEX idx_project_change_log_timeline ON project_change_log(organization_id,project_id,created_at DESC);

CREATE TABLE project_units (
    organization_id TEXT NOT NULL,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (organization_id,id),
    UNIQUE (organization_id,location_id,code),
    FOREIGN KEY (organization_id,project_id) REFERENCES projects(organization_id,id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id,location_id) REFERENCES project_locations(organization_id,id) ON DELETE CASCADE
);

CREATE TABLE unit_progress (
    organization_id TEXT NOT NULL,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    work_type_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('not_started','ongoing','complete','blocked')),
    completed_on TEXT,
    comments TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (organization_id,id),
    UNIQUE (organization_id,unit_id,work_type_id,action_id),
    FOREIGN KEY (organization_id,project_id) REFERENCES projects(organization_id,id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id,location_id) REFERENCES project_locations(organization_id,id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id,unit_id) REFERENCES project_units(organization_id,id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id,work_type_id) REFERENCES work_types(organization_id,id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id,action_id) REFERENCES work_type_actions(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE audio_zone_details (
    organization_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    zone_type TEXT NOT NULL DEFAULT 'common_area',
    speaker_count INTEGER CHECK(speaker_count IS NULL OR speaker_count >= 0),
    display_count INTEGER CHECK(display_count IS NULL OR display_count >= 0),
    source_description TEXT NOT NULL DEFAULT '',
    equipment_notes TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (organization_id,location_id),
    FOREIGN KEY (organization_id,project_id) REFERENCES projects(organization_id,id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id,location_id) REFERENCES project_locations(organization_id,id) ON DELETE CASCADE
);

CREATE INDEX idx_project_units_location ON project_units(organization_id,project_id,location_id,position);
CREATE INDEX idx_unit_progress_scope ON unit_progress(organization_id,project_id,location_id,work_type_id,action_id,status);

WITH RECURSIVE numbers(value) AS (
    SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 500
)
INSERT INTO project_units
    (organization_id,id,project_id,location_id,code,name,position,active,version,created_at,updated_at)
SELECT location.organization_id, location.id || '-unit-' || numbers.value, location.project_id, location.id,
       location.code || '-U' || printf('%02d',numbers.value), 'Unit ' || numbers.value,
       numbers.value - 1, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM project_locations location JOIN numbers ON numbers.value <= location.suite_total
WHERE location.kind = 'floor' AND location.suite_total > 0;
