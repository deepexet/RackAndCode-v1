-- Knowledge retrieval evaluation: test cases and eval run results
CREATE TABLE IF NOT EXISTS retrieval_test_cases (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
    query           TEXT NOT NULL,
    expected_doc_names TEXT NOT NULL DEFAULT '[]',  -- JSON array of expected document names
    notes           TEXT NOT NULL DEFAULT '',
    created_by      TEXT REFERENCES users(id),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_cases_org ON retrieval_test_cases(organization_id);

CREATE TABLE IF NOT EXISTS retrieval_eval_runs (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
    case_count      INTEGER NOT NULL DEFAULT 0,
    precision_at_3  REAL,   -- P@3: fraction of top-3 results that matched expected
    recall_at_5     REAL,   -- R@5: fraction of expected docs found in top-5
    hit_rate        REAL,   -- fraction of cases with at least 1 hit in top-5
    details         TEXT NOT NULL DEFAULT '[]',  -- JSON: per-case results
    ran_by          TEXT REFERENCES users(id),
    ran_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_org ON retrieval_eval_runs(organization_id, ran_at);
