-- Digital Twin: parent-child location hierarchy, asset registry, typed relationships

-- Extend project_locations with physical metadata (parent_location_id already in migration 014)
ALTER TABLE project_locations ADD COLUMN floor_number INTEGER;
ALTER TABLE project_locations ADD COLUMN area_sqm     REAL;
ALTER TABLE project_locations ADD COLUMN attributes   TEXT NOT NULL DEFAULT '{}';

-- Asset / equipment registry (one row per physical device or installation point)
CREATE TABLE IF NOT EXISTS dt_assets (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL,          -- no FK: composite PK on projects
    location_id     TEXT,                   -- no FK: composite PK on project_locations
    parent_asset_id TEXT REFERENCES dt_assets(id) ON DELETE SET NULL,  -- e.g. switch → port
    asset_type      TEXT NOT NULL DEFAULT 'device',  -- device|port|panel|cable|circuit|sensor|other
    name            TEXT NOT NULL,
    make            TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '',
    serial_number   TEXT NOT NULL DEFAULT '',
    install_date    TEXT,
    status          TEXT NOT NULL DEFAULT 'planned'
        CHECK (status IN ('planned','installed','active','faulty','decommissioned')),
    attributes      TEXT NOT NULL DEFAULT '{}',  -- JSON: port_count, ip_address, rack_unit, etc.
    notes           TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assets_location  ON dt_assets(organization_id, location_id, status);
CREATE INDEX IF NOT EXISTS idx_assets_project   ON dt_assets(organization_id, project_id, asset_type);
CREATE INDEX IF NOT EXISTS idx_assets_parent    ON dt_assets(parent_asset_id);

-- Typed directed relationships between assets (graph edges)
CREATE TABLE IF NOT EXISTS dt_relationships (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    from_asset_id   TEXT NOT NULL REFERENCES dt_assets(id) ON DELETE CASCADE,
    to_asset_id     TEXT NOT NULL REFERENCES dt_assets(id) ON DELETE CASCADE,
    relation_type   TEXT NOT NULL DEFAULT 'connects_to',
    -- connects_to | powers | feeds | backs_up | contains | links_to | depends_on
    label           TEXT NOT NULL DEFAULT '',   -- e.g. "Cat6 run #14"
    attributes      TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL,
    UNIQUE(from_asset_id, to_asset_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_dt_rel_from ON dt_relationships(from_asset_id);
CREATE INDEX IF NOT EXISTS idx_dt_rel_to   ON dt_relationships(to_asset_id);
CREATE INDEX IF NOT EXISTS idx_dt_rel_org  ON dt_relationships(organization_id, relation_type);
