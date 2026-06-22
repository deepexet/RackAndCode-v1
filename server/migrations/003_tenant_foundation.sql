CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('Technician', 'Supervisor', 'ProjectManager', 'Administrator')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'disabled')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS workspace_states (
    organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO organizations (id, name, slug, status, created_at)
VALUES ('local-dev', 'FieldOS Local Development', 'local-dev', 'active', CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO users (id, email, display_name, created_at)
VALUES ('local-admin', 'admin@local.fieldos', 'Local Administrator', CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO memberships (organization_id, user_id, role, status, created_at)
VALUES ('local-dev', 'local-admin', 'Administrator', 'active', CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO workspace_states (organization_id, revision, payload, updated_at)
SELECT 'local-dev', revision, payload, updated_at FROM workspace_state WHERE id = 1;

CREATE TABLE idempotency_records_v2 (
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, key)
);

INSERT INTO idempotency_records_v2
    (organization_id, key, request_hash, status, response_json, created_at)
SELECT 'local-dev', key, request_hash, status, response_json, created_at
FROM idempotency_records;

DROP TABLE idempotency_records;
ALTER TABLE idempotency_records_v2 RENAME TO idempotency_records;

CREATE INDEX idx_idempotency_created_at
ON idempotency_records(created_at);

CREATE INDEX idx_memberships_user
ON memberships(user_id, status);

