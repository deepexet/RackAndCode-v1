-- Warehouses and inventory management
CREATE TABLE IF NOT EXISTS warehouses (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    location        TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (organization_id, name)
);

-- Stock keeping units — catalog of items
CREATE TABLE IF NOT EXISTS inventory_skus (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    sku_code        TEXT NOT NULL,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    category        TEXT NOT NULL DEFAULT 'general',
    unit            TEXT NOT NULL DEFAULT 'pcs',   -- pcs, m, kg, box, roll, etc.
    unit_cost       REAL,
    currency        TEXT NOT NULL DEFAULT 'USD',
    tags            TEXT NOT NULL DEFAULT '[]',    -- JSON array
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (organization_id, sku_code)
);

-- Per-warehouse stock levels
CREATE TABLE IF NOT EXISTS inventory_stock (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    warehouse_id    TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    sku_id          TEXT NOT NULL REFERENCES inventory_skus(id) ON DELETE CASCADE,
    quantity        REAL NOT NULL DEFAULT 0,
    reserved        REAL NOT NULL DEFAULT 0,       -- allocated to projects
    min_quantity    REAL,                           -- reorder threshold
    location_bin    TEXT NOT NULL DEFAULT '',       -- shelf/bin reference
    updated_at      TEXT NOT NULL,
    UNIQUE (warehouse_id, sku_id)
);

-- Movement ledger — every stock change is logged
CREATE TABLE IF NOT EXISTS inventory_movements (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    warehouse_id    TEXT NOT NULL,
    sku_id          TEXT NOT NULL,
    movement_type   TEXT NOT NULL
        CHECK (movement_type IN ('receive','issue','transfer','adjustment','return','loss')),
    quantity        REAL NOT NULL,                 -- positive = in, negative = out
    reference       TEXT NOT NULL DEFAULT '',      -- PO number, project code, etc.
    note            TEXT NOT NULL DEFAULT '',
    source          TEXT NOT NULL DEFAULT 'manual', -- manual/email/ai/import
    source_ref      TEXT,                          -- email message-id, AI session id
    recorded_by     TEXT,
    approved_by     TEXT,
    project_id      TEXT,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_movements_sku ON inventory_movements(organization_id, sku_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_movements_warehouse ON inventory_movements(organization_id, warehouse_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_warehouse ON inventory_stock(organization_id, warehouse_id);

-- Pending AI/email suggestions awaiting human approval
CREATE TABLE IF NOT EXISTS inventory_pending (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source          TEXT NOT NULL DEFAULT 'ai',    -- ai/email/import
    source_ref      TEXT,
    suggested_movements TEXT NOT NULL DEFAULT '[]', -- JSON array of movement proposals
    raw_input       TEXT,                          -- original text/email body/image desc
    ai_confidence   REAL,                          -- 0-1
    status          TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','partial')),
    reviewed_by     TEXT,
    reviewed_at     TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_pending ON inventory_pending(organization_id, status, created_at DESC);
