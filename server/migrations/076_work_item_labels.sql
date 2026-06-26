-- Color labels for work items (many-to-many via JSON column for simplicity)
ALTER TABLE project_work_items ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
