UPDATE projects
SET code = 'RACKPILOT',
    name = 'RackPilot by Valeronix',
    description = 'Internal development of RackPilot by Valeronix: project, inventory and field operations platform.',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'fieldos-platform';
