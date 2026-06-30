-- Bounded local host telemetry for short monitoring charts.
CREATE TABLE IF NOT EXISTS system_metric_samples (
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    sampled_at      TEXT NOT NULL,
    cpu_percent     REAL NOT NULL,
    memory_percent  REAL NOT NULL,
    temperature_c   REAL,
    thermal_state   TEXT NOT NULL DEFAULT 'unknown',
    PRIMARY KEY (organization_id, sampled_at)
);

CREATE INDEX IF NOT EXISTS idx_system_metrics_org_time
    ON system_metric_samples(organization_id, sampled_at);
