-- Document → entity links: attach objects to projects/floors/assets/locations/doors
ALTER TABLE objects ADD COLUMN linked_entity_type TEXT;   -- 'asset'|'location'|'project'|'door'|'room'|null
ALTER TABLE objects ADD COLUMN linked_entity_id   TEXT;   -- FK-less ID ref to target entity

CREATE INDEX IF NOT EXISTS idx_objects_entity ON objects(organization_id, linked_entity_type, linked_entity_id)
    WHERE linked_entity_id IS NOT NULL;
