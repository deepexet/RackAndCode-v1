-- AI Gateway: provider config, request log, token budgets
CREATE TABLE IF NOT EXISTS ai_providers (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    provider     TEXT NOT NULL,          -- 'anthropic' | 'openai' | 'ollama' | 'custom'
    base_url     TEXT,                   -- NULL = use provider default
    secret_id    TEXT REFERENCES secrets_vault(id) ON DELETE SET NULL,
    model        TEXT NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    priority     INTEGER NOT NULL DEFAULT 0,
    config       TEXT NOT NULL DEFAULT '{}',  -- JSON: max_tokens, temperature, etc.
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_requests (
    id              TEXT PRIMARY KEY,
    provider_id     TEXT REFERENCES ai_providers(id) ON DELETE SET NULL,
    organization_id TEXT NOT NULL,
    user_id         TEXT,
    purpose         TEXT NOT NULL,       -- 'feature_guide' | 'field_notes' | 'custom' | ...
    model           TEXT NOT NULL,
    prompt_tokens   INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens    INTEGER NOT NULL DEFAULT 0,
    latency_ms      INTEGER,
    status          TEXT NOT NULL DEFAULT 'ok',  -- 'ok' | 'error' | 'blocked'
    error           TEXT,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_requests_org  ON ai_requests(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_requests_date ON ai_requests(created_at);

-- Rolling token budget per org/purpose (resets monthly)
CREATE TABLE IF NOT EXISTS ai_budgets (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    purpose         TEXT NOT NULL DEFAULT '*',  -- '*' = all purposes
    monthly_limit   INTEGER NOT NULL DEFAULT 100000,
    alert_at        INTEGER NOT NULL DEFAULT 80,  -- percent
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE(organization_id, purpose)
);
