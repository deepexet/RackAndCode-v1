-- 096: Transport module — vehicles, assignments, service records

CREATE TABLE IF NOT EXISTS vehicles (
  organization_id TEXT NOT NULL,
  id              TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  plate           TEXT NOT NULL,
  make            TEXT NOT NULL,
  model           TEXT NOT NULL,
  year            INTEGER,
  color           TEXT,
  vin             TEXT,
  fuel_type       TEXT DEFAULT 'gasoline', -- gasoline|diesel|electric|hybrid|lpg
  status          TEXT DEFAULT 'active',   -- active|repair|inactive
  mileage         INTEGER DEFAULT 0,
  warehouse_id    TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_vehicles_org ON vehicles(organization_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_status ON vehicles(organization_id, status);

CREATE TABLE IF NOT EXISTS vehicle_assignments (
  organization_id TEXT NOT NULL,
  id              TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  vehicle_id      TEXT NOT NULL,
  assignee_name   TEXT NOT NULL,
  assignee_user_id TEXT,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_vassign_vehicle ON vehicle_assignments(organization_id, vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vassign_active  ON vehicle_assignments(organization_id, vehicle_id, ended_at);

CREATE TABLE IF NOT EXISTS vehicle_service_records (
  organization_id  TEXT NOT NULL,
  id               TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  vehicle_id       TEXT NOT NULL,
  service_type     TEXT DEFAULT 'maintenance', -- maintenance|repair|inspection|fuel|wash|other
  title            TEXT NOT NULL,
  description      TEXT,
  mileage          INTEGER,
  cost             REAL,
  performed_by     TEXT,
  service_date     TEXT,
  status           TEXT DEFAULT 'done', -- planned|done
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_vservice_vehicle ON vehicle_service_records(organization_id, vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vservice_date    ON vehicle_service_records(organization_id, service_date);
