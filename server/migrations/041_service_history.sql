-- Asset service history, configuration snapshots, and document-to-entity bindings

-- Service events: maintenance, inspection, repair, replacement, config change, notes
CREATE TABLE IF NOT EXISTS asset_service_events (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    asset_id        TEXT NOT NULL REFERENCES dt_assets(id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL DEFAULT 'note'
        CHECK (event_type IN ('inspection','repair','replacement','config_change','calibration','note')),
    performed_by    TEXT NOT NULL DEFAULT '',
    performed_at    TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    attributes      TEXT NOT NULL DEFAULT '{}',  -- cost, parts_used, warranty, etc.
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_svc_asset   ON asset_service_events(asset_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_svc_org     ON asset_service_events(organization_id, performed_at DESC);

-- Configuration snapshots: point-in-time JSON of asset config
CREATE TABLE IF NOT EXISTS asset_configurations (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    asset_id        TEXT NOT NULL REFERENCES dt_assets(id) ON DELETE CASCADE,
    config_snapshot TEXT NOT NULL DEFAULT '{}',
    notes           TEXT NOT NULL DEFAULT '',
    recorded_at     TEXT NOT NULL,
    recorded_by     TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_cfg_asset ON asset_configurations(asset_id, recorded_at DESC);

-- Document bindings: attach any stored object to a project entity
CREATE TABLE IF NOT EXISTS object_bindings (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    object_id       TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    target_type     TEXT NOT NULL DEFAULT 'project'
        CHECK (target_type IN ('project','building','location','asset','relationship')),
    target_id       TEXT NOT NULL,
    notes           TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    UNIQUE(object_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_bindings_object ON object_bindings(object_id);
CREATE INDEX IF NOT EXISTS idx_bindings_target ON object_bindings(organization_id, target_type, target_id);
