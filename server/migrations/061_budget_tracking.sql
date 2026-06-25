-- Project budget envelope and expense line items
ALTER TABLE projects ADD COLUMN budget_amount REAL;
ALTER TABLE projects ADD COLUMN budget_currency TEXT NOT NULL DEFAULT 'USD';

CREATE TABLE IF NOT EXISTS project_expenses (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL,
    category        TEXT NOT NULL DEFAULT 'other',
    description     TEXT NOT NULL DEFAULT '',
    amount          REAL NOT NULL,
    currency        TEXT NOT NULL DEFAULT 'USD',
    expense_date    TEXT NOT NULL,
    recorded_by     TEXT,
    receipt_ref     TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_expenses_project ON project_expenses(organization_id, project_id, expense_date);
