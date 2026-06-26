-- Add tags (comma-separated labels) to projects
ALTER TABLE projects ADD COLUMN tags TEXT NOT NULL DEFAULT '';
