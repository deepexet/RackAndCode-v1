ALTER TABLE project_change_log ADD COLUMN previous_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE project_change_log ADD COLUMN event_hash TEXT NOT NULL DEFAULT '';

CREATE TRIGGER seal_project_change_log_after_insert
AFTER INSERT ON project_change_log
WHEN NEW.event_hash = ''
BEGIN
    UPDATE project_change_log
    SET previous_hash = COALESCE((
            SELECT event_hash FROM project_change_log
            WHERE organization_id = NEW.organization_id
              AND project_id = NEW.project_id
              AND rowid <> NEW.rowid
              AND event_hash <> ''
            ORDER BY rowid DESC LIMIT 1
        ), ''),
        event_hash = fieldos_audit_hash(
            NEW.organization_id, NEW.id, NEW.project_id, NEW.entity_type,
            NEW.entity_id, NEW.action, NEW.old_value, NEW.new_value,
            NEW.source, NEW.created_at,
            COALESCE((
                SELECT event_hash FROM project_change_log
                WHERE organization_id = NEW.organization_id
                  AND project_id = NEW.project_id
                  AND rowid <> NEW.rowid
                  AND event_hash <> ''
                ORDER BY rowid DESC LIMIT 1
            ), '')
        )
    WHERE organization_id = NEW.organization_id AND id = NEW.id;
END;

CREATE TRIGGER prevent_project_change_log_update
BEFORE UPDATE ON project_change_log
WHEN OLD.event_hash <> ''
BEGIN
    SELECT RAISE(ABORT, 'project audit log is append-only');
END;

CREATE TRIGGER prevent_project_change_log_delete
BEFORE DELETE ON project_change_log
BEGIN
    SELECT RAISE(ABORT, 'project audit log is append-only');
END;
