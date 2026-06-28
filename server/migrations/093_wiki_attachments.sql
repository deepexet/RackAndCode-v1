-- Local file storage for wiki attachments (PDFs, manuals downloaded from external URLs)

CREATE TABLE IF NOT EXISTS wiki_attachments (
    id               TEXT PRIMARY KEY,
    organization_id  TEXT NOT NULL,
    page_id          TEXT,              -- wiki page this is attached to (nullable)
    original_url     TEXT NOT NULL,
    filename         TEXT NOT NULL,
    file_path        TEXT NOT NULL,     -- path relative to data/attachments/
    file_size        INTEGER DEFAULT 0,
    mime_type        TEXT DEFAULT 'application/octet-stream',
    created_by       TEXT DEFAULT '',
    created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wiki_attach_page
    ON wiki_attachments(organization_id, page_id);
