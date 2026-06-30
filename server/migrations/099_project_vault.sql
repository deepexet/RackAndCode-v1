-- Project Information Vault
-- ADR-005 | Work item: ed852213-333e-4fc7-b95f-aaa7b941e3bc
--
-- Stores project-scoped secrets (credentials, api keys, configs, certs, notes).
-- Values are encrypted with a per-entry key derived as:
--   entry_key = HMAC-SHA256(
--       HMAC-SHA256(HMAC-SHA256(master_key, "org-vault:{org_id}"), "project:{project_id}"),
--       "entry:{entry_id}"
--   )
-- Stored format: hex(nonce):hex(ciphertext):hex(mac)  (HMAC-CTR, encrypt-then-MAC)
--
-- SECURITY INVARIANTS:
--   1. organization_id is ALWAYS the first filter in every query.
--   2. encrypted_value is NEVER logged or returned in list endpoints.
--   3. AI agent sessions (is_agent_session=True) cannot call /reveal.
--   4. Every /reveal call creates an audit_log entry before returning the value.

-- ---------------------------------------------------------------------------
-- Main vault table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_vault (
    id              TEXT    NOT NULL PRIMARY KEY,        -- UUIDv4
    organization_id TEXT    NOT NULL,                   -- Tenant boundary (FK organisations.id)
    project_id      TEXT    NOT NULL,                   -- Project scope (FK projects.id)
    name            TEXT    NOT NULL,                   -- Human label (plaintext, shown in list)
    category        TEXT    NOT NULL DEFAULT 'credential',
                                                        -- credential | api_key | config
                                                        -- certificate | note
    encrypted_value TEXT    NOT NULL,                   -- HMAC-CTR ciphertext (never logged)
    description     TEXT    NOT NULL DEFAULT '',        -- Non-sensitive description (plaintext)
    created_by      TEXT    NOT NULL,                   -- users.id of creator
    created_at      TEXT    NOT NULL,                   -- ISO-8601 UTC
    updated_at      TEXT    NOT NULL,                   -- ISO-8601 UTC
    deleted_at      TEXT             DEFAULT NULL,      -- Soft delete; NULL = active
    version         INTEGER NOT NULL DEFAULT 1,         -- Monotonically increasing

    -- Category must be one of the defined values
    CHECK (category IN ('credential', 'api_key', 'config', 'certificate', 'note'))
);

-- Tenant-leading composite index (org first, mandatory)
CREATE INDEX IF NOT EXISTS idx_pv_org_project
    ON project_vault(organization_id, project_id, deleted_at);

-- Unique name per (org, project) for active entries only
-- SQLite partial indexes: WHERE deleted_at IS NULL
CREATE UNIQUE INDEX IF NOT EXISTS idx_pv_org_project_name_active
    ON project_vault(organization_id, project_id, name)
    WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Immutable version history
-- Append-only: entries are inserted on every update; never updated or deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_vault_history (
    id              TEXT    NOT NULL PRIMARY KEY,        -- UUIDv4
    vault_id        TEXT    NOT NULL REFERENCES project_vault(id),
    organization_id TEXT    NOT NULL,                   -- Denormalised for query isolation
    version         INTEGER NOT NULL,
    encrypted_value TEXT    NOT NULL,                   -- Snapshot of encrypted value at this version
    changed_by      TEXT    NOT NULL,                   -- users.id
    changed_at      TEXT    NOT NULL,                   -- ISO-8601 UTC
    change_reason   TEXT    NOT NULL DEFAULT ''         -- Optional human note (e.g. "rotated")
);

CREATE INDEX IF NOT EXISTS idx_pvh_vault_version
    ON project_vault_history(organization_id, vault_id, version);

-- ---------------------------------------------------------------------------
-- Append-only guard: prevent UPDATE/DELETE on history rows
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_pvh_no_update
    BEFORE UPDATE ON project_vault_history
BEGIN
    SELECT RAISE(ABORT, 'project_vault_history is immutable: updates are forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_pvh_no_delete
    BEFORE DELETE ON project_vault_history
BEGIN
    SELECT RAISE(ABORT, 'project_vault_history is immutable: deletes are forbidden');
END;

-- ---------------------------------------------------------------------------
-- Auto-snapshot trigger: insert history row whenever vault entry is updated
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_pv_snapshot_on_update
    AFTER UPDATE OF encrypted_value ON project_vault
    WHEN NEW.encrypted_value != OLD.encrypted_value
BEGIN
    INSERT INTO project_vault_history
        (id, vault_id, organization_id, version, encrypted_value, changed_by, changed_at)
    VALUES (
        lower(hex(randomblob(16))),   -- pseudo-UUID (replace with app-generated UUID in code)
        NEW.id,
        NEW.organization_id,
        NEW.version,
        OLD.encrypted_value,          -- snapshot of the PREVIOUS value before overwrite
        NEW.created_by,               -- updated_by should be passed via app; using created_by as fallback
        NEW.updated_at
    );
END;
