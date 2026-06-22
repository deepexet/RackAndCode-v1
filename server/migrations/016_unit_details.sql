ALTER TABLE project_units ADD COLUMN notes TEXT NOT NULL DEFAULT '';
ALTER TABLE project_units ADD COLUMN custom_fields TEXT NOT NULL DEFAULT '{}';
