-- Structured wiki attributes are kept in an extension table so this migration is
-- safe for installations that received the early wiki columns out-of-band.
-- ensure-column wiki_pages page_type TEXT NOT NULL DEFAULT 'general'
-- ensure-column wiki_pages view_count INTEGER NOT NULL DEFAULT 0
-- ensure-column wiki_pages helpful_count INTEGER NOT NULL DEFAULT 0
-- ensure-column wiki_pages not_helpful_count INTEGER NOT NULL DEFAULT 0
-- ensure-column wiki_pages metadata TEXT NOT NULL DEFAULT '{}'
CREATE TABLE IF NOT EXISTS wiki_page_details (
    organization_id TEXT NOT NULL,
    page_id          TEXT NOT NULL,
    is_pinned        INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
    structured_data  TEXT NOT NULL DEFAULT '{}',
    diagram_page_id  TEXT,
    PRIMARY KEY (organization_id, page_id),
    FOREIGN KEY (page_id) REFERENCES wiki_pages(id) ON DELETE CASCADE,
    FOREIGN KEY (diagram_page_id) REFERENCES wiki_pages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_wiki_details_pinned
    ON wiki_page_details(organization_id, is_pinned, page_id);

CREATE INDEX IF NOT EXISTS idx_wiki_details_diagram
    ON wiki_page_details(organization_id, diagram_page_id);
