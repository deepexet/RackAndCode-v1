-- Knowledge ingestion: chunked FTS index for large documents

CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    object_id       TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    project_id      TEXT,             -- inherited from object; no FK (composite PK)
    chunk_index     INTEGER NOT NULL, -- 0-based position in document
    chunk_text      TEXT NOT NULL,
    token_count     INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_object  ON knowledge_chunks(object_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_chunks_project ON knowledge_chunks(organization_id, project_id);

-- FTS5 full-text index over chunks (separate from objects_fts for recall)
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    chunk_id UNINDEXED,
    object_id UNINDEXED,
    project_id UNINDEXED,
    chunk_text,
    tokenize="unicode61 remove_diacritics 2"
);
