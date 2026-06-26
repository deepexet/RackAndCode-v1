-- Purchase orders sent to suppliers
CREATE TABLE IF NOT EXISTS supplier_orders (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    supplier_id     TEXT NOT NULL REFERENCES inventory_suppliers(id),
    warehouse_id    TEXT NOT NULL REFERENCES warehouses(id),
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','sent','confirmed','received','cancelled')),
    reference       TEXT NOT NULL DEFAULT '',
    note            TEXT NOT NULL DEFAULT '',
    ordered_by      TEXT NOT NULL DEFAULT '',
    ordered_at      TEXT,
    expected_at     TEXT,
    received_at     TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_order_lines (
    id              TEXT PRIMARY KEY,
    order_id        TEXT NOT NULL REFERENCES supplier_orders(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    sku_id          TEXT NOT NULL REFERENCES inventory_skus(id),
    quantity        REAL NOT NULL,
    unit_price      REAL,
    received_qty    REAL NOT NULL DEFAULT 0,
    note            TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_supplier_orders
    ON supplier_orders(organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_order_lines
    ON supplier_order_lines(order_id);
