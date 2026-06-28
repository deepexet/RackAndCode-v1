-- Wiki pages: org-wide and per-project knowledge base
CREATE TABLE IF NOT EXISTS wiki_pages (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      TEXT,               -- NULL = org-wide wiki
    title           TEXT NOT NULL,
    content         TEXT NOT NULL DEFAULT '',
    category        TEXT NOT NULL DEFAULT '',
    tags            TEXT NOT NULL DEFAULT '[]',  -- JSON array
    created_by      TEXT NOT NULL DEFAULT '',
    updated_by      TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wiki_org
    ON wiki_pages(organization_id, project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_wiki_category
    ON wiki_pages(organization_id, category);
