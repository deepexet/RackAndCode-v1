-- Material reservations: link inventory stock to projects
CREATE TABLE IF NOT EXISTS material_reservations (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL,
    warehouse_id    TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    sku_id          TEXT NOT NULL REFERENCES inventory_skus(id) ON DELETE CASCADE,
    quantity        REAL NOT NULL CHECK (quantity > 0),
    consumed        REAL NOT NULL DEFAULT 0,  -- how much has actually been issued
    status          TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','consumed','released','cancelled')),
    note            TEXT NOT NULL DEFAULT '',
    reserved_by     TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reservations_project
    ON material_reservations(organization_id, project_id, status);
CREATE INDEX IF NOT EXISTS idx_reservations_sku
    ON material_reservations(organization_id, sku_id, status);
