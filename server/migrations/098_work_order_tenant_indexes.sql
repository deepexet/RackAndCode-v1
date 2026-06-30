-- Keep applied migration 095 immutable; add tenant-leading indexes separately.
CREATE INDEX IF NOT EXISTS idx_wo_tasks_org_wo
    ON work_order_tasks(organization_id, work_order_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_wo_comments_org_wo
    ON work_order_comments(organization_id, work_order_id, created_at);
