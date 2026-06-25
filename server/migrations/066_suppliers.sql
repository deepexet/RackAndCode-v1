-- Supplier directory for reorder requests
CREATE TABLE IF NOT EXISTS suppliers (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    contact_name    TEXT NOT NULL DEFAULT '',
    email           TEXT NOT NULL DEFAULT '',
    phone           TEXT NOT NULL DEFAULT '',
    address         TEXT NOT NULL DEFAULT '',
    note            TEXT NOT NULL DEFAULT '',
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_suppliers_org
    ON suppliers(organization_id, active);

-- Link reorder requests to suppliers
ALTER TABLE inventory_reorder_requests ADD COLUMN supplier_id TEXT REFERENCES suppliers(id);
