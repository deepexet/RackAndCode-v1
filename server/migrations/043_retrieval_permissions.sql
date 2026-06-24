-- Permission-aware retrieval: object access policy + audit log

-- Access policy per stored object
ALTER TABLE objects ADD COLUMN access_policy TEXT NOT NULL DEFAULT 'org'
    CHECK (access_policy IN ('org','project','restricted'));
-- 'org'        → any authenticated user in the org can retrieve
-- 'project'    → only users assigned to that project can retrieve
-- 'restricted' → explicitly blocked from retrieval (secrets, PII, legal hold)

CREATE INDEX IF NOT EXISTS idx_objects_policy ON objects(organization_id, access_policy);

-- Retrieval audit: every knowledge search that reaches the permission gate
CREATE TABLE IF NOT EXISTS retrieval_log (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         TEXT,
    user_role       TEXT NOT NULL DEFAULT '',
    query           TEXT NOT NULL,
    allowed_projects TEXT NOT NULL DEFAULT '[]',  -- JSON array, null = org-wide
    result_count    INTEGER NOT NULL DEFAULT 0,
    filtered_count  INTEGER NOT NULL DEFAULT 0,   -- items removed by permission gate
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retrieval_log_org  ON retrieval_log(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_retrieval_log_user ON retrieval_log(user_id, created_at DESC);
