UPDATE project_work_items
SET work_type_id = 'other'
WHERE work_type_id IS NULL;

INSERT INTO project_change_log
    (organization_id, id, project_id, entity_type, entity_id, action,
     old_value, new_value, source, created_at)
SELECT project.organization_id, 'backfill-project-' || project.id, project.id,
       'project', project.id, 'created', '{}',
       json_object('code', project.code, 'name', project.name), 'migration', project.created_at
FROM projects project
WHERE NOT EXISTS (
    SELECT 1 FROM project_change_log event
    WHERE event.organization_id = project.organization_id
      AND event.entity_type = 'project' AND event.entity_id = project.id
      AND event.action = 'created'
);

INSERT INTO project_change_log
    (organization_id, id, project_id, entity_type, entity_id, action,
     old_value, new_value, source, created_at)
SELECT building.organization_id, 'backfill-building-' || building.id, building.project_id,
       'building', building.id, 'created', '{}',
       json_object('code', building.code, 'name', building.name), 'migration', building.created_at
FROM buildings building
WHERE NOT EXISTS (
    SELECT 1 FROM project_change_log event
    WHERE event.organization_id = building.organization_id
      AND event.entity_type = 'building' AND event.entity_id = building.id
      AND event.action = 'created'
);

INSERT INTO project_change_log
    (organization_id, id, project_id, entity_type, entity_id, action,
     old_value, new_value, source, created_at)
SELECT item.organization_id, 'backfill-work-item-' || item.id, item.project_id,
       'work_item', item.id, 'created', '{}',
       json_object('title', item.title, 'workTypeId', item.work_type_id, 'status', item.status),
       'migration', item.created_at
FROM project_work_items item
WHERE NOT EXISTS (
    SELECT 1 FROM project_change_log event
    WHERE event.organization_id = item.organization_id
      AND event.entity_type = 'work_item' AND event.entity_id = item.id
      AND event.action = 'created'
);
