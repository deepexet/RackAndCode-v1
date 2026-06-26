-- Skills and certifications per team member
CREATE TABLE IF NOT EXISTS team_member_skills (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL,
    skill_name      TEXT NOT NULL,
    level           TEXT NOT NULL DEFAULT 'basic' CHECK (level IN ('basic','intermediate','advanced','expert')),
    certified       INTEGER NOT NULL DEFAULT 0,
    cert_expiry     TEXT,
    notes           TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_skills_user_skill
    ON team_member_skills(organization_id, user_id, skill_name);
CREATE INDEX IF NOT EXISTS idx_team_skills_skill
    ON team_member_skills(organization_id, skill_name);
