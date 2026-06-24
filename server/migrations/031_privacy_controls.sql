-- Privacy controls: per-org data collection policies, retention, redaction
CREATE TABLE IF NOT EXISTS privacy_settings (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    purpose         TEXT NOT NULL,     -- 'ai_requests' | 'audit_log' | 'field_telemetry' | 'object_storage'
    enabled         INTEGER NOT NULL DEFAULT 1,
    retention_days  INTEGER NOT NULL DEFAULT 90,   -- 0 = keep forever
    redact_fields   TEXT NOT NULL DEFAULT '[]',    -- JSON array of field names to mask in logs
    notes           TEXT NOT NULL DEFAULT '',
    updated_at      TEXT NOT NULL,
    UNIQUE(organization_id, purpose)
);

-- Audit log: every security-relevant mutation (session, secrets, settings, privacy changes)
CREATE TABLE IF NOT EXISTS audit_log (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    actor_id        TEXT,              -- NULL if unauthenticated
    actor_role      TEXT,
    action          TEXT NOT NULL,     -- 'login' | 'logout' | 'secret.create' | 'privacy.update' | ...
    target_type     TEXT,              -- 'secret' | 'session' | 'privacy_setting' | ...
    target_id       TEXT,
    outcome         TEXT NOT NULL DEFAULT 'ok',   -- 'ok' | 'denied' | 'error'
    ip              TEXT,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_org  ON audit_log(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, created_at);
