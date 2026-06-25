-- Add barcode field to inventory SKUs
ALTER TABLE inventory_skus ADD COLUMN barcode TEXT NOT NULL DEFAULT '';

-- Reorder requests: track supplier replenishment needs
CREATE TABLE IF NOT EXISTS inventory_reorder_requests (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    sku_id          TEXT NOT NULL REFERENCES inventory_skus(id) ON DELETE CASCADE,
    warehouse_id    TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    quantity        REAL NOT NULL CHECK (quantity > 0),
    unit_cost       REAL,
    supplier_ref    TEXT NOT NULL DEFAULT '',
    note            TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','ordered','received','cancelled')),
    requested_by    TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reorder_requests
    ON inventory_reorder_requests(organization_id, status, created_at DESC);
