-- Encrypted secrets vault (HMAC-CTR, master key in data/.master_key)
CREATE TABLE IF NOT EXISTS secrets_vault (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    category      TEXT NOT NULL DEFAULT 'api_key',
    encrypted     TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    created_by    TEXT NOT NULL REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_secrets_name ON secrets_vault(name);
