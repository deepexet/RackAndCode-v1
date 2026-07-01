-- Actionable task proposals rendered inside the shared Coordinator conversation.
CREATE TABLE IF NOT EXISTS coordinator_chat_proposals (
    id                TEXT PRIMARY KEY,
    organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id        TEXT NOT NULL REFERENCES coordinator_chat_messages(id) ON DELETE CASCADE,
    title             TEXT NOT NULL,
    instructions      TEXT NOT NULL,
    assigned_agent    TEXT NOT NULL CHECK(assigned_agent IN ('codex','claude','local')),
    scope_paths_json  TEXT NOT NULL DEFAULT '[]',
    status            TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','queued')),
    coordinator_job_id TEXT,
    created_at        TEXT NOT NULL,
    queued_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_proposals_user_message
    ON coordinator_chat_proposals(organization_id,user_id,message_id,created_at);
