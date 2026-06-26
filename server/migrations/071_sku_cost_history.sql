-- Track unit cost changes for SKUs
CREATE TABLE IF NOT EXISTS sku_cost_history (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    sku_id          TEXT NOT NULL REFERENCES inventory_skus(id) ON DELETE CASCADE,
    old_cost        REAL,
    new_cost        REAL NOT NULL,
    changed_by      TEXT NOT NULL DEFAULT '',
    note            TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sku_cost_history
    ON sku_cost_history(organization_id, sku_id, created_at DESC);
