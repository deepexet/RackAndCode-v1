INSERT OR IGNORE INTO work_types (organization_id, id, code, name, color, position, active, created_at) VALUES
    ('local-dev', 'nsp-inspection', 'nsp_inspection', 'NSP Inspection', '#4dd5c7', 8, 1, CURRENT_TIMESTAMP),
    ('local-dev', 'conduit', 'conduit', 'Conduit', '#f29b62', 9, 1, CURRENT_TIMESTAMP),
    ('local-dev', 'wifi', 'wifi', 'WiFi', '#61d58d', 10, 1, CURRENT_TIMESTAMP),
    ('local-dev', 'audiovisual', 'audiovisual', 'Audio Visual', '#da7bf5', 11, 1, CURRENT_TIMESTAMP);

CREATE TABLE project_change_log_v2 (
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('project', 'building', 'work_item', 'location', 'daily_update', 'issue')),
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    old_value TEXT NOT NULL,
    new_value TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, id),
    FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

INSERT INTO project_change_log_v2 SELECT * FROM project_change_log;
DROP TABLE project_change_log;
ALTER TABLE project_change_log_v2 RENAME TO project_change_log;
CREATE INDEX idx_project_change_log_timeline ON project_change_log(organization_id, project_id, created_at DESC);

CREATE TABLE work_type_actions (
    organization_id TEXT NOT NULL,
    id TEXT NOT NULL,
    work_type_id TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (organization_id, id),
    UNIQUE (organization_id, work_type_id, code),
    FOREIGN KEY (organization_id, work_type_id)
        REFERENCES work_types(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE project_locations (
    organization_id TEXT NOT NULL,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    building_id TEXT,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'floor' CHECK (kind IN ('floor', 'suite', 'room', 'area')),
    suite_total INTEGER CHECK (suite_total IS NULL OR suite_total >= 0),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, id),
    UNIQUE (organization_id, project_id, code),
    FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id, building_id) REFERENCES buildings(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE daily_progress_entries (
    organization_id TEXT NOT NULL,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    work_type_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    work_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('not_started', 'ongoing', 'complete', 'blocked')),
    percent_complete INTEGER NOT NULL CHECK (percent_complete BETWEEN 0 AND 100),
    quantity_completed INTEGER CHECK (quantity_completed IS NULL OR quantity_completed >= 0),
    comments TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, id),
    FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id, location_id) REFERENCES project_locations(organization_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id, work_type_id) REFERENCES work_types(organization_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id, action_id) REFERENCES work_type_actions(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE project_issues (
    organization_id TEXT NOT NULL,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    progress_entry_id TEXT,
    location_id TEXT,
    work_type_id TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, id),
    FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id, progress_entry_id) REFERENCES daily_progress_entries(organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_daily_progress_project_date ON daily_progress_entries(organization_id, project_id, work_date DESC);
CREATE INDEX idx_daily_progress_scope ON daily_progress_entries(organization_id, project_id, location_id, work_type_id, action_id);
CREATE INDEX idx_project_issues_open ON project_issues(organization_id, project_id, status, severity);

INSERT INTO work_type_actions (organization_id, id, work_type_id, code, name, position) VALUES
('local-dev','data-prewire','data','prewire','Prewire',0),('local-dev','data-terminated-tested','data','terminated_tested','Terminated & Tested',1),('local-dev','data-trimout','data','trimout','Trimout',2),
('local-dev','fiber-prewire','fiber','prewire','Prewire',0),('local-dev','fiber-terminated-tested','fiber','terminated_tested','Terminated & Tested',1),('local-dev','fiber-as-built','fiber','as_built_sent','As Built Sent',2),
('local-dev','termination-terminate','termination','terminate','Terminate',0),('local-dev','termination-test','termination','test','Test',1),
('local-dev','cctv-prewire','cctv','prewire','Prewire',0),('local-dev','cctv-installed','cctv','installed','Installed',1),('local-dev','cctv-verified','cctv','view_verified','View Verified',2),
('local-dev','access-prewire','access-control','prewire','Prewire',0),('local-dev','access-installed','access-control','installed','Installed',1),('local-dev','access-operational','access-control','operational','Operational',2),
('local-dev','conduit-installed','conduit','installed','Installed',0),('local-dev','conduit-closed','conduit','junctions_closed','Junctions Closed',1),
('local-dev','wifi-prewire','wifi','prewire','Prewire',0),('local-dev','wifi-installed','wifi','installed','Installed',1),('local-dev','wifi-operational','wifi','operational','Operational',2),
('local-dev','av-prewire','audiovisual','prewire','Prewire',0),('local-dev','av-installed','audiovisual','installed','Installed',1),('local-dev','av-operational','audiovisual','operational','Operational',2),
('local-dev','nsp-prewire','nsp-inspection','prewire','Prewire',0),('local-dev','nsp-tested','nsp-inspection','terminated_tested','Terminated & Tested',1),('local-dev','nsp-as-built','nsp-inspection','as_built_sent','As Built Sent',2),
('local-dev','network-prewire','network','prewire','Prewire',0),('local-dev','network-installed','network','installed','Installed',1),('local-dev','network-operational','network','operational','Operational',2),
('local-dev','commissioning-test','commissioning','test','Test',0),('local-dev','commissioning-verify','commissioning','verify','Verify',1),('local-dev','other-update','other','update','Update',0);
