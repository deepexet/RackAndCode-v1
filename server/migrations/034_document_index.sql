-- Document versioning and full-text search index
ALTER TABLE objects ADD COLUMN parent_id TEXT REFERENCES objects(id) ON DELETE SET NULL;
-- NULL = first version; non-NULL = child version of parent
ALTER TABLE objects ADD COLUMN version_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE objects ADD COLUMN extracted_text TEXT;       -- plain text content (text/* files)
ALTER TABLE objects ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE objects ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'; -- JSON array of strings

CREATE INDEX IF NOT EXISTS idx_objects_parent ON objects(parent_id);
CREATE INDEX IF NOT EXISTS idx_objects_version ON objects(organization_id, parent_id, version_number);

-- FTS5 virtual table for document full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS objects_fts USING fts5(
    obj_id UNINDEXED,
    name,
    description,
    extracted_text,
    tags,
    tokenize="unicode61"
);
