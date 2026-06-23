UPDATE organizations
SET name = 'RackPilot Local Development'
WHERE id = 'local-dev'
  AND name = 'FieldOS Local Development';

UPDATE users
SET email = 'admin@local.rackpilot'
WHERE id = 'local-admin'
  AND email = 'admin@local.fieldos';
