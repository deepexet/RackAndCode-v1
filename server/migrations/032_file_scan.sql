-- File security scanning: scan_result and preview safety flag on objects
ALTER TABLE objects ADD COLUMN scan_result TEXT NOT NULL DEFAULT 'pending';
-- 'clean' | 'quarantine' | 'blocked' | 'pending'
ALTER TABLE objects ADD COLUMN safe_preview INTEGER NOT NULL DEFAULT 0;
-- 1 if file is safe to render inline (image/pdf), 0 = download-only

CREATE INDEX IF NOT EXISTS idx_objects_scan ON objects(organization_id, scan_result);
