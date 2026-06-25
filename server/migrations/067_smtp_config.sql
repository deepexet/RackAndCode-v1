-- SMTP configuration for email digest
CREATE TABLE IF NOT EXISTS smtp_config (
    organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    host            TEXT NOT NULL DEFAULT '',
    port            INTEGER NOT NULL DEFAULT 587,
    use_tls         INTEGER NOT NULL DEFAULT 1,
    username        TEXT NOT NULL DEFAULT '',
    password_enc    TEXT NOT NULL DEFAULT '',
    from_address    TEXT NOT NULL DEFAULT '',
    to_addresses    TEXT NOT NULL DEFAULT '',
    updated_at      TEXT NOT NULL
);
