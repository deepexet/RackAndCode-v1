-- Work item checklist items (sub-tasks with checkbox state)
CREATE TABLE IF NOT EXISTS work_item_checklist (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    work_item_id    TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    checked         INTEGER NOT NULL DEFAULT 0,
    position        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wi_checklist
    ON work_item_checklist(organization_id, work_item_id, position);
