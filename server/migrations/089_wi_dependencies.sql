-- Work item blocker relationships (separate from legacy 008 WI dependency table)
CREATE TABLE IF NOT EXISTS work_item_blockers (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    blocker_id      TEXT NOT NULL,
    blocked_id      TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wi_blocker_pair
    ON work_item_blockers(blocker_id, blocked_id);
CREATE INDEX IF NOT EXISTS idx_wi_blocker_blocked
    ON work_item_blockers(organization_id, blocked_id);
CREATE INDEX IF NOT EXISTS idx_wi_blocker_blocker
    ON work_item_blockers(organization_id, blocker_id);
