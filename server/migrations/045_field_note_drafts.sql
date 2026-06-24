-- AI field note parsing: store raw text, structured proposed changes, approval trail
CREATE TABLE IF NOT EXISTS field_note_drafts (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL,             -- no FK (composite PK on projects)
    author_id       TEXT NOT NULL,
    raw_text        TEXT NOT NULL,
    proposed_changes TEXT NOT NULL DEFAULT '[]',  -- JSON array of change objects
    unrecognized    TEXT NOT NULL DEFAULT '[]',   -- JSON array of unmatched spans
    provider        TEXT NOT NULL DEFAULT 'local',
    model           TEXT NOT NULL DEFAULT 'local',
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','applied')),
    applied_at      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_drafts_project ON field_note_drafts(organization_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_note_drafts_author  ON field_note_drafts(author_id, created_at DESC);
