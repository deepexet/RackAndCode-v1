-- Materials planned or consumed by a work order.
CREATE TABLE IF NOT EXISTS work_order_materials (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    work_order_id   TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
    sku_id          TEXT NOT NULL REFERENCES inventory_skus(id) ON DELETE RESTRICT,
    quantity        REAL NOT NULL CHECK (quantity > 0),
    note            TEXT NOT NULL DEFAULT '',
    added_by        TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (organization_id, work_order_id, sku_id)
);

CREATE INDEX IF NOT EXISTS idx_wo_materials_org_wo
    ON work_order_materials(organization_id, work_order_id, created_at);
