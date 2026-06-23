CREATE TABLE platform_settings (
    organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    default_language TEXT NOT NULL DEFAULT 'en' CHECK(default_language IN ('en','ru')),
    timezone TEXT NOT NULL DEFAULT 'America/Halifax',
    role_mode TEXT NOT NULL DEFAULT 'planned' CHECK(role_mode IN ('planned','enforced')),
    telemetry_mode TEXT NOT NULL DEFAULT 'standard' CHECK(telemetry_mode IN ('minimal','standard','diagnostic')),
    log_retention_days INTEGER NOT NULL DEFAULT 365 CHECK(log_retention_days BETWEEN 30 AND 3650),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
