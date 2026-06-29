-- Checklist items for work orders
CREATE TABLE IF NOT EXISTS work_order_tasks (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    work_order_id   TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    completed       INTEGER NOT NULL DEFAULT 0,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wo_tasks_wo ON work_order_tasks(work_order_id, sort_order);

-- Activity / comments on work orders
CREATE TABLE IF NOT EXISTS work_order_comments (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    work_order_id   TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
    author          TEXT NOT NULL DEFAULT '',
    body            TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wo_comments_wo ON work_order_comments(work_order_id, created_at);
