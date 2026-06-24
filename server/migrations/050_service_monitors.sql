-- Service monitors: ping/TCP checks for network assets
CREATE TABLE IF NOT EXISTS service_monitors (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    asset_id        TEXT REFERENCES dt_assets(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    check_type      TEXT NOT NULL DEFAULT 'ping',  -- 'ping'|'tcp'|'http'
    target          TEXT NOT NULL,                  -- IP or hostname
    port            INTEGER,                        -- for tcp/http
    path            TEXT,                           -- for http
    interval_seconds INTEGER NOT NULL DEFAULT 60,
    enabled         INTEGER NOT NULL DEFAULT 1,
    last_check_at   TEXT,
    last_status     TEXT,   -- 'up'|'down'|'unknown'
    last_latency_ms REAL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_events (
    id              TEXT PRIMARY KEY,
    monitor_id      TEXT NOT NULL REFERENCES service_monitors(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    status          TEXT NOT NULL,   -- 'up'|'down'
    latency_ms      REAL,
    error_message   TEXT,
    checked_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_service_monitors_org ON service_monitors(organization_id);
CREATE INDEX IF NOT EXISTS idx_monitor_events_monitor ON monitor_events(monitor_id, checked_at DESC);
