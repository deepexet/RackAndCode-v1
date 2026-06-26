-- Inventory cycle count sessions and their line items
CREATE TABLE IF NOT EXISTS cycle_counts (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    warehouse_id    TEXT NOT NULL REFERENCES warehouses(id),
    name            TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    counted_by      TEXT NOT NULL DEFAULT '',
    started_at      TEXT NOT NULL,
    closed_at       TEXT,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cycle_counts ON cycle_counts(organization_id, warehouse_id, status);

CREATE TABLE IF NOT EXISTS cycle_count_lines (
    id              TEXT PRIMARY KEY,
    count_id        TEXT NOT NULL REFERENCES cycle_counts(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    sku_id          TEXT NOT NULL REFERENCES inventory_skus(id),
    book_qty        REAL NOT NULL DEFAULT 0,
    counted_qty     REAL,
    note            TEXT NOT NULL DEFAULT '',
    counted_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_cycle_count_lines ON cycle_count_lines(count_id, sku_id);
