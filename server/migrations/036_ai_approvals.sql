-- Human approval queue for AI-proposed mutations
CREATE TABLE IF NOT EXISTS ai_approvals (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    proposed_by     TEXT NOT NULL,              -- user_id or 'agent'
    action_type     TEXT NOT NULL,              -- 'task.update' | 'project.update' | 'daily_update.create' | ...
    action_payload  TEXT NOT NULL DEFAULT '{}', -- JSON: the proposed mutation
    evidence        TEXT NOT NULL DEFAULT '{}', -- JSON: supporting context shown to reviewer
    status          TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
    reviewed_by     TEXT REFERENCES users(id),
    reviewed_at     TEXT,
    reviewer_note   TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    expires_at      TEXT NOT NULL               -- auto-expire after 72h if not reviewed
);

CREATE INDEX IF NOT EXISTS idx_ai_approvals_org_status ON ai_approvals(organization_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_approvals_expires ON ai_approvals(status, expires_at);
