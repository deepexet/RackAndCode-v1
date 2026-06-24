-- Work item shortcode (auto-assigned sequential per project, e.g. WI-001)
ALTER TABLE project_work_items ADD COLUMN code TEXT;

-- Backfill code as WI-<rownum> using rowid ordering
UPDATE project_work_items
SET code = printf('WI-%03d',
    (SELECT COUNT(*) FROM project_work_items wi2
     WHERE wi2.organization_id = project_work_items.organization_id
       AND wi2.project_id = project_work_items.project_id
       AND wi2.rowid <= project_work_items.rowid))
WHERE code IS NULL;
