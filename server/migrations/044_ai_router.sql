-- AI router configuration: provider settings stored per-org, key read from env
CREATE TABLE IF NOT EXISTS ai_router_config (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL DEFAULT 'anthropic'
                    CHECK (provider IN ('anthropic','openai','local')),
    model           TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
    env_key_var     TEXT NOT NULL DEFAULT 'ANTHROPIC_API_KEY',
    max_tokens      INTEGER NOT NULL DEFAULT 1024,
    temperature     REAL NOT NULL DEFAULT 0.3,
    enabled         INTEGER NOT NULL DEFAULT 1,
    updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_router_org ON ai_router_config(organization_id);

-- Per-request AI invocation log (for cost tracking and audit)
CREATE TABLE IF NOT EXISTS ai_invocation_log (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         TEXT,
    intent          TEXT NOT NULL DEFAULT 'invoke',
    provider        TEXT NOT NULL,
    model           TEXT NOT NULL,
    prompt_tokens   INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms      INTEGER NOT NULL DEFAULT 0,
    error           TEXT,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_log_org  ON ai_invocation_log(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_log_user ON ai_invocation_log(user_id, created_at DESC);
