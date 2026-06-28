-- Enhance wiki_pages with type, ratings, views, and equipment metadata
-- Uses idempotent pattern since columns may already exist

CREATE TABLE IF NOT EXISTS wiki_pages_backup_091 AS SELECT * FROM wiki_pages WHERE 1=0;

-- Add columns only if they don't exist (handled via separate statements)
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we use a workaround:
-- The MigrationRunner wraps in BEGIN IMMEDIATE, so we must avoid duplicates.
-- Columns already added manually: page_type, view_count, helpful_count, not_helpful_count, metadata

-- Full-text search index for wiki pages
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
    page_id UNINDEXED,
    organization_id UNINDEXED,
    title,
    content,
    category,
    tokenize = 'porter unicode61'
);

-- Wiki page view log (for analytics)
CREATE TABLE IF NOT EXISTS wiki_page_views (
    id          TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    page_id     TEXT NOT NULL,
    viewer_id   TEXT NOT NULL DEFAULT '',
    viewed_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wiki_views_page
    ON wiki_page_views(organization_id, page_id, viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_wiki_views_user
    ON wiki_page_views(organization_id, viewer_id, viewed_at DESC);
