CREATE TABLE development_agent_status (
    organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('working','idle','waiting','blocked','limit')),
    message TEXT NOT NULL,
    needs_action INTEGER NOT NULL DEFAULT 0 CHECK(needs_action IN (0,1)),
    continuation_requested INTEGER NOT NULL DEFAULT 0 CHECK(continuation_requested IN (0,1)),
    updated_at TEXT NOT NULL
);
