-- Scheduled digest delivery settings per organization
CREATE TABLE IF NOT EXISTS digest_schedules (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL DEFAULT 'Daily Digest',
    cron_expr       TEXT NOT NULL DEFAULT '0 8 * * *',
    recipients      TEXT NOT NULL DEFAULT '[]',
    include_sections TEXT NOT NULL DEFAULT '["projects","inventory","sla","kpi"]',
    active          INTEGER NOT NULL DEFAULT 1,
    last_sent       TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_sched_org
    ON digest_schedules(organization_id, name);
