-- Integration SDK: outgoing webhooks with HMAC signing + delivery retry queue

CREATE TABLE IF NOT EXISTS webhook_configs (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    url             TEXT NOT NULL,
    secret_hash     TEXT NOT NULL,   -- HMAC key stored as SHA-256(secret); raw key never persisted
    events          TEXT NOT NULL DEFAULT '["*"]',  -- JSON array of event types, ["*"] = all
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_by      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhook_configs(organization_id, enabled);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    webhook_id      TEXT NOT NULL REFERENCES webhook_configs(id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,
    payload         TEXT NOT NULL,   -- JSON event body
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_status     INTEGER,         -- HTTP status of last attempt
    last_error      TEXT,
    next_retry_at   TEXT,            -- NULL = delivered or exhausted
    delivered_at    TEXT,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deliveries_retry ON webhook_deliveries(next_retry_at)
    WHERE next_retry_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);
