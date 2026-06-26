-- Reusable work item templates per organization
CREATE TABLE IF NOT EXISTS work_item_templates (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    title_template  TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    priority        TEXT NOT NULL DEFAULT 'medium',
    estimated_minutes INTEGER,
    work_type_code  TEXT NOT NULL DEFAULT '',
    checklist_items TEXT NOT NULL DEFAULT '[]',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wi_templates
    ON work_item_templates(organization_id, name);
