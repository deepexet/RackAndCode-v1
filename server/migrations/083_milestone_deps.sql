-- Milestone-to-milestone finish-to-start dependencies
CREATE TABLE IF NOT EXISTS milestone_dependencies (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL,
    predecessor_id  TEXT NOT NULL REFERENCES project_milestones(id) ON DELETE CASCADE,
    successor_id    TEXT NOT NULL REFERENCES project_milestones(id) ON DELETE CASCADE,
    created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_milestone_dep_pair
    ON milestone_dependencies(predecessor_id, successor_id);
CREATE INDEX IF NOT EXISTS idx_milestone_dep_succ
    ON milestone_dependencies(organization_id, successor_id);
