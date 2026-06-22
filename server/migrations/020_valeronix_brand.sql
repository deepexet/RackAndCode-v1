UPDATE projects
SET code = 'VALERONIX',
    name = 'Valeronix Platform',
    description = 'Internal development of the Valeronix operational intelligence platform.',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'fieldos-platform';
