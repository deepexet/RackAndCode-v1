-- Link asynchronous Codex/Claude results back to the shared Coordinator conversation.
ALTER TABLE coordinator_chat_messages ADD COLUMN agent_job_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_chat_agent_result
    ON coordinator_chat_messages(organization_id, user_id, agent_job_id)
    WHERE agent_job_id IS NOT NULL;
