-- Fix critical tenant-isolation bug in secrets_vault
-- ADR-005 | Work item: ed852213-333e-4fc7-b95f-aaa7b941e3bc
--
-- PROBLEM (migration 027):
--   secrets_vault has no organization_id column.
--   list_secrets() returns ALL secrets across ALL tenants.
--   This is a P0 tenant-isolation breach.
--
-- FIX:
--   1. Add organization_id column (nullable first, then set default, then NOT NULL via new table).
--   2. Drop the global unique index on name.
--   3. Create scoped unique index on (organization_id, name).
--
-- STRATEGY — SQLite lacks ALTER COLUMN / ADD CONSTRAINT, so we use the
-- standard SQLite table-rename + recreate pattern (atomic, safe):
--   a) Rename old table to _legacy.
--   b) Create new table with correct schema.
--   c) Copy rows, assigning existing rows to the default org.
--   d) Recreate indexes.
--   e) Drop legacy table.
--
-- DEFAULT ORG: existing secrets (if any) are assigned to 'local-dev',
-- matching the convention established in ADR-003 for pre-tenant data.
-- Operators with multi-org data must reassign manually after migration.

-- Step a: preserve existing data
ALTER TABLE secrets_vault RENAME TO secrets_vault_legacy_100;

-- Step b: correct schema
CREATE TABLE IF NOT EXISTS secrets_vault (
    id              TEXT    NOT NULL PRIMARY KEY,
    organization_id TEXT    NOT NULL,                   -- Tenant boundary — REQUIRED
    name            TEXT    NOT NULL,
    description     TEXT    NOT NULL DEFAULT '',
    category        TEXT    NOT NULL DEFAULT 'api_key',
    encrypted       TEXT    NOT NULL,                   -- HMAC-CTR ciphertext
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    created_by      TEXT    NOT NULL REFERENCES users(id),

    CHECK (category IN ('api_key', 'credential', 'config', 'certificate', 'note', 'other'))
);

-- Step c: migrate existing rows into the default org
INSERT INTO secrets_vault
    (id, organization_id, name, description, category, encrypted, created_at, updated_at, created_by)
SELECT
    id,
    'local-dev' AS organization_id,    -- legacy default; re-assign if multi-org
    name,
    description,
    category,
    encrypted,
    created_at,
    updated_at,
    created_by
FROM secrets_vault_legacy_100;

-- Step d: tenant-scoped indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_secrets_org_name
    ON secrets_vault(organization_id, name);

CREATE INDEX IF NOT EXISTS idx_secrets_org
    ON secrets_vault(organization_id, created_at);

-- Step e: drop legacy table (data is safely copied above)
DROP TABLE secrets_vault_legacy_100;
