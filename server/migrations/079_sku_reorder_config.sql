-- Preferred supplier and reorder quantity per SKU for auto-reorder
CREATE TABLE IF NOT EXISTS inventory_sku_reorder (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    sku_id          TEXT NOT NULL REFERENCES inventory_skus(id) ON DELETE CASCADE,
    supplier_id     TEXT REFERENCES inventory_suppliers(id) ON DELETE SET NULL,
    reorder_quantity REAL NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sku_reorder_sku
    ON inventory_sku_reorder(organization_id, sku_id);
