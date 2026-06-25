-- IMAP inbox configurations for inventory email parsing
CREATE TABLE IF NOT EXISTS email_inbox_configs (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    host            TEXT NOT NULL,
    port            INTEGER NOT NULL DEFAULT 993,
    use_ssl         INTEGER NOT NULL DEFAULT 1,
    username        TEXT NOT NULL,
    password_secret_id TEXT,              -- reference to secrets vault
    folder          TEXT NOT NULL DEFAULT 'INBOX',
    filter_subject  TEXT NOT NULL DEFAULT '',   -- subject keyword filter (empty = all)
    filter_sender   TEXT NOT NULL DEFAULT '',   -- sender domain/address filter
    target_warehouse_id TEXT,             -- default warehouse for parsed items
    enabled         INTEGER NOT NULL DEFAULT 1,
    poll_interval   INTEGER NOT NULL DEFAULT 15, -- minutes
    last_polled_at  TEXT,
    last_uid        INTEGER NOT NULL DEFAULT 0,  -- highest UID processed
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- Processed email log (prevents reprocessing)
CREATE TABLE IF NOT EXISTS email_processed (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    inbox_id        TEXT NOT NULL REFERENCES email_inbox_configs(id) ON DELETE CASCADE,
    message_id      TEXT NOT NULL,       -- RFC 2822 Message-ID header
    subject         TEXT NOT NULL DEFAULT '',
    sender          TEXT NOT NULL DEFAULT '',
    pending_id      TEXT,                -- inventory_pending.id if parsing was triggered
    status          TEXT NOT NULL DEFAULT 'processed',
    created_at      TEXT NOT NULL,
    UNIQUE (inbox_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_email_processed_inbox ON email_processed(inbox_id, created_at DESC);
