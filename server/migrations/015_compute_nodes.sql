CREATE TABLE compute_nodes (
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    hostname TEXT NOT NULL,
    platform TEXT NOT NULL,
    architecture TEXT NOT NULL,
    total_memory_bytes INTEGER NOT NULL CHECK(total_memory_bytes >= 0),
    agent_opt_in INTEGER NOT NULL DEFAULT 0 CHECK(agent_opt_in IN (0,1)),
    compute_enabled INTEGER NOT NULL DEFAULT 0 CHECK(compute_enabled IN (0,1)),
    agent_version TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (organization_id,id)
);

CREATE TABLE compute_node_metrics (
    organization_id TEXT NOT NULL,
    id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    cpu_percent REAL NOT NULL CHECK(cpu_percent BETWEEN 0 AND 100),
    memory_used_bytes INTEGER NOT NULL CHECK(memory_used_bytes >= 0),
    memory_total_bytes INTEGER NOT NULL CHECK(memory_total_bytes >= 0),
    battery_percent REAL CHECK(battery_percent BETWEEN 0 AND 100),
    power_source TEXT NOT NULL,
    charging INTEGER CHECK(charging IS NULL OR charging IN (0,1)),
    thermal_state TEXT NOT NULL,
    load_average REAL NOT NULL CHECK(load_average >= 0),
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (organization_id,id),
    FOREIGN KEY (organization_id,node_id) REFERENCES compute_nodes(organization_id,id) ON DELETE CASCADE
);

CREATE INDEX idx_compute_node_metrics_recent
ON compute_node_metrics(organization_id,node_id,recorded_at DESC);
