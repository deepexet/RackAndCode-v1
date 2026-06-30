-- Persistent, tenant- and user-scoped Coordinator Chat history.
CREATE TABLE IF NOT EXISTS coordinator_chat_messages (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content         TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 12000),
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_coordinator_chat_user_time
    ON coordinator_chat_messages(organization_id, user_id, created_at, id);
