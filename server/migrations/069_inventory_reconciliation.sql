-- Inventory reconciliation sessions (physical count vs system count)
CREATE TABLE IF NOT EXISTS inventory_reconciliations (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    warehouse_id    TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','in_progress','completed','cancelled')),
    note            TEXT NOT NULL DEFAULT '',
    counted_by      TEXT NOT NULL DEFAULT '',
    started_at      TEXT NOT NULL,
    completed_at    TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_reconciliation_lines (
    id                  TEXT PRIMARY KEY,
    reconciliation_id   TEXT NOT NULL REFERENCES inventory_reconciliations(id) ON DELETE CASCADE,
    organization_id     TEXT NOT NULL,
    sku_id              TEXT NOT NULL REFERENCES inventory_skus(id),
    system_quantity     REAL NOT NULL DEFAULT 0,
    counted_quantity    REAL,
    variance            REAL GENERATED ALWAYS AS (
        CASE WHEN counted_quantity IS NOT NULL THEN counted_quantity - system_quantity ELSE NULL END
    ) STORED,
    note                TEXT NOT NULL DEFAULT '',
    updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recon_org ON inventory_reconciliations(organization_id, warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_recon_lines ON inventory_reconciliation_lines(reconciliation_id);
