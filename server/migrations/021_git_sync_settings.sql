CREATE TABLE git_sync_settings (
    organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    remote_url TEXT NOT NULL DEFAULT '',
    branch_name TEXT NOT NULL DEFAULT 'main',
    commit_strategy TEXT NOT NULL DEFAULT 'per_task'
        CHECK(commit_strategy IN ('manual','per_task','per_release')),
    auto_commit INTEGER NOT NULL DEFAULT 1 CHECK(auto_commit IN (0,1)),
    auto_push INTEGER NOT NULL DEFAULT 0 CHECK(auto_push IN (0,1)),
    include_docs INTEGER NOT NULL DEFAULT 1 CHECK(include_docs IN (0,1)),
    last_commit_hash TEXT,
    last_sync_status TEXT NOT NULL DEFAULT 'not_configured'
        CHECK(last_sync_status IN ('not_configured','configured','synced','error')),
    last_sync_message TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
