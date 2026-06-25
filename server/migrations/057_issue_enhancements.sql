-- Expand issue status FSM and add resolution tracking
ALTER TABLE project_issues ADD COLUMN resolution_note TEXT;
ALTER TABLE project_issues ADD COLUMN resolved_at TEXT;
ALTER TABLE project_issues ADD COLUMN resolved_by TEXT;
ALTER TABLE project_issues ADD COLUMN assigned_to TEXT;

-- Add 'closed' and 'wont_fix' statuses via new column (SQLite can't modify CHECK)
ALTER TABLE project_issues ADD COLUMN status_v2 TEXT DEFAULT NULL;
-- status_v2 values: 'open'|'in_progress'|'resolved'|'closed'|'wont_fix'
-- NULL means use legacy status column; after migration use status_v2 when set

CREATE INDEX IF NOT EXISTS idx_issues_assigned ON project_issues(organization_id, assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_issues_resolved ON project_issues(organization_id, project_id, resolved_at)
    WHERE resolved_at IS NOT NULL;
