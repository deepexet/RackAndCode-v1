-- Maintenance / repair work orders linked to assets or inventory SKUs
CREATE TABLE IF NOT EXISTS work_orders (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
    priority        TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
    asset_id        TEXT REFERENCES tracked_assets(id) ON DELETE SET NULL,
    sku_id          TEXT REFERENCES inventory_skus(id) ON DELETE SET NULL,
    warehouse_id    TEXT REFERENCES warehouses(id) ON DELETE SET NULL,
    assigned_to     TEXT NOT NULL DEFAULT '',
    due_date        TEXT,
    completed_at    TEXT,
    notes           TEXT NOT NULL DEFAULT '',
    created_by      TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_orders_org
    ON work_orders(organization_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_work_orders_asset
    ON work_orders(organization_id, asset_id);
