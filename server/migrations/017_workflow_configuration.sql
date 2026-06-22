ALTER TABLE work_types ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE work_types ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE work_type_actions ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1));
ALTER TABLE work_type_actions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

UPDATE work_types SET updated_at=created_at WHERE updated_at='';
