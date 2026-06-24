-- Runtime optional connectors: Jobber, MS365, Google Workspace, etc.
CREATE TABLE IF NOT EXISTS connectors (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    connector_type  TEXT NOT NULL,   -- 'jobber'|'ms365'|'google_workspace'|'webhook'|'custom'
    name            TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    config          TEXT NOT NULL DEFAULT '{}',   -- encrypted-at-rest config JSON (no raw secrets)
    status          TEXT NOT NULL DEFAULT 'unconfigured',  -- 'unconfigured'|'active'|'error'|'paused'
    last_sync_at    TEXT,
    last_error      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- Webhook outbox: events queued for delivery to external systems
CREATE TABLE IF NOT EXISTS webhook_events (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    connector_id    TEXT REFERENCES connectors(id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,   -- 'project.updated'|'work_item.done'|etc.
    payload         TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'pending',   -- 'pending'|'delivered'|'failed'
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    delivered_at    TEXT,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connectors_org  ON connectors(organization_id, connector_type);
CREATE INDEX IF NOT EXISTS idx_webhook_events  ON webhook_events(organization_id, status, next_attempt_at);
