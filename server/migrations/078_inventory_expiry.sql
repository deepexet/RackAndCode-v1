-- Track expiry dates for inventory lots
CREATE TABLE IF NOT EXISTS inventory_lots (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    warehouse_id    TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    sku_id          TEXT NOT NULL REFERENCES inventory_skus(id) ON DELETE CASCADE,
    lot_number      TEXT NOT NULL DEFAULT '',
    quantity        REAL NOT NULL DEFAULT 0,
    received_at     TEXT NOT NULL,
    expires_at      TEXT,
    note            TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_lots_expiry
    ON inventory_lots(organization_id, expires_at, warehouse_id);
CREATE INDEX IF NOT EXISTS idx_inventory_lots_sku
    ON inventory_lots(organization_id, sku_id, warehouse_id);
