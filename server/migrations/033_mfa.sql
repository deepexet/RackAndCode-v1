-- TOTP MFA credentials and backup recovery codes
CREATE TABLE IF NOT EXISTS mfa_credentials (
    user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    totp_secret  TEXT NOT NULL,           -- base32-encoded, stored encrypted via secrets vault key
    enabled      INTEGER NOT NULL DEFAULT 0,
    enrolled_at  TEXT,
    updated_at   TEXT NOT NULL
);

-- One-time backup codes (hashed, used once then deleted)
CREATE TABLE IF NOT EXISTS mfa_backup_codes (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,             -- SHA-256 of plain code
    used       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mfa_backup_user ON mfa_backup_codes(user_id, used);

-- Ephemeral MFA challenge tokens (issued after password check, expire in 5 min)
CREATE TABLE IF NOT EXISTS mfa_challenges (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id      TEXT NOT NULL,
    role        TEXT NOT NULL,
    expires_at  TEXT NOT NULL
);
