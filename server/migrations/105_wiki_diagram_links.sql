-- Tenant-scoped relations between Wiki pages and diagram pages.
-- diagram_id intentionally has no FK: links and snapshots survive diagram deletion.
CREATE TABLE IF NOT EXISTS wiki_diagram_links (
    id                        TEXT PRIMARY KEY,
    organization_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    wiki_page_id              TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
    diagram_id                TEXT NOT NULL,
    diagram_title_snapshot    TEXT NOT NULL DEFAULT '',
    diagram_metadata_snapshot TEXT NOT NULL DEFAULT '{}',
    state                     TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deleted')),
    created_by                TEXT NOT NULL DEFAULT '',
    created_at                TEXT NOT NULL,
    updated_at                TEXT NOT NULL,
    UNIQUE (organization_id, wiki_page_id, diagram_id)
);

CREATE INDEX IF NOT EXISTS idx_wiki_diagram_links_page
    ON wiki_diagram_links(organization_id, wiki_page_id, created_at);

CREATE INDEX IF NOT EXISTS idx_wiki_diagram_links_diagram
    ON wiki_diagram_links(organization_id, diagram_id, state);

-- Keep tenant isolation enforceable below the application layer. A diagram
-- foreign key is deliberately avoided so deleted references remain intact.
CREATE TRIGGER IF NOT EXISTS trg_wiki_diagram_links_validate_insert
BEFORE INSERT ON wiki_diagram_links
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM wiki_pages
        WHERE id=NEW.wiki_page_id AND organization_id=NEW.organization_id
    ) THEN RAISE(ABORT, 'wiki diagram link page tenant mismatch') END;
    SELECT CASE WHEN NEW.wiki_page_id=NEW.diagram_id OR NOT EXISTS (
        SELECT 1 FROM wiki_pages
        WHERE id=NEW.diagram_id AND organization_id=NEW.organization_id AND page_type='schema'
    ) THEN RAISE(ABORT, 'wiki diagram link diagram tenant/type mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_wiki_diagram_links_validate_restore
BEFORE UPDATE OF state ON wiki_diagram_links
WHEN NEW.state='active'
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM wiki_pages
        WHERE id=NEW.diagram_id AND organization_id=NEW.organization_id AND page_type='schema'
    ) THEN RAISE(ABORT, 'wiki diagram link restore tenant/type mismatch') END;
END;

CREATE TABLE IF NOT EXISTS wiki_diagram_link_history (
    id                        TEXT PRIMARY KEY,
    organization_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    link_id                   TEXT NOT NULL,
    wiki_page_id              TEXT NOT NULL,
    diagram_id                TEXT NOT NULL,
    action                    TEXT NOT NULL CHECK (action IN ('linked', 'unlinked', 'diagram_deleted', 'restored')),
    diagram_title_snapshot    TEXT NOT NULL DEFAULT '',
    diagram_metadata_snapshot TEXT NOT NULL DEFAULT '{}',
    actor_id                  TEXT NOT NULL DEFAULT '',
    created_at                TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wiki_diagram_history_page
    ON wiki_diagram_link_history(organization_id, wiki_page_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wiki_diagram_history_diagram
    ON wiki_diagram_link_history(organization_id, diagram_id, created_at DESC);
