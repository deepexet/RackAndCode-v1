-- Tracked physical assets (equipment installed at locations)
-- Note: no FK to projects — projects has composite PK (organization_id, id)
CREATE TABLE IF NOT EXISTS tracked_assets (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    asset_tag       TEXT NOT NULL DEFAULT '',
    category        TEXT NOT NULL DEFAULT '',
    manufacturer    TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '',
    serial_number   TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','retired','lost')),
    location_id     TEXT,
    project_id      TEXT,
    sku_id          TEXT,
    installed_at    TEXT,
    warranty_until  TEXT,
    notes           TEXT NOT NULL DEFAULT '',
    created_by      TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tracked_assets_org
    ON tracked_assets(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_tracked_assets_tag
    ON tracked_assets(organization_id, asset_tag);
