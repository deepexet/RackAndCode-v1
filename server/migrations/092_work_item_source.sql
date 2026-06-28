-- Track who created a work item: 'user' (human via UI) or 'agent' (AI/automation)
-- User-created tasks are displayed with higher priority in critical task views

ALTER TABLE project_work_items ADD COLUMN created_by TEXT NOT NULL DEFAULT '';
ALTER TABLE project_work_items ADD COLUMN source_type TEXT NOT NULL DEFAULT 'user';
-- source_type: 'user' | 'agent'

CREATE INDEX IF NOT EXISTS idx_wi_priority_source
    ON project_work_items(organization_id, priority, source_type, status);

CREATE INDEX IF NOT EXISTS idx_wi_critical
    ON project_work_items(organization_id, priority, status)
    WHERE priority = 'critical';
