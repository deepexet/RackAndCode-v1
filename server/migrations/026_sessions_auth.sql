-- Password credentials (scrypt hashed, no plaintext ever)
CREATE TABLE IF NOT EXISTS password_credentials (
    user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL,
    must_change INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- Signed bearer sessions — token stored as SHA-256 hash, never plaintext
CREATE TABLE IF NOT EXISTS sessions (
    token_hash      TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
    organization_id TEXT NOT NULL REFERENCES organizations(id)  ON DELETE CASCADE,
    role            TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
