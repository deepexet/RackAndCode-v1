-- Scheduled recurring reports: weekly/monthly PDF or CSV summaries
CREATE TABLE IF NOT EXISTS scheduled_reports (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    report_type     TEXT NOT NULL DEFAULT 'project_summary',  -- 'project_summary'|'issues'|'team_presence'|'velocity'
    project_id      TEXT,              -- NULL = all projects
    cadence         TEXT NOT NULL DEFAULT 'weekly',           -- 'daily'|'weekly'|'monthly'
    day_of_week     INTEGER,           -- 0=Mon..6=Sun for weekly
    day_of_month    INTEGER,           -- 1-28 for monthly
    format          TEXT NOT NULL DEFAULT 'csv',              -- 'csv'|'json'
    last_run_at     TEXT,
    next_run_at     TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_reports_next ON scheduled_reports(organization_id, enabled, next_run_at);
