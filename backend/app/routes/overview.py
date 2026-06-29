"""Overview dashboard read models."""

from __future__ import annotations

from fastapi import APIRouter

from app.middleware.auth import Auth, require_permission


router = APIRouter()


@router.get("/overview/kpi")
async def overview_kpi(ctx: Auth):
    """Return tenant-scoped counts used by the overview dashboard."""
    require_permission(ctx, "projectRead")
    with ctx.store._connect() as connection:
        active_projects = connection.execute(
            """
            SELECT COUNT(*)
            FROM projects
            WHERE organization_id=? AND status NOT IN ('completed', 'archived')
            """,
            (ctx.org,),
        ).fetchone()[0]
        open_work_orders = connection.execute(
            """
            SELECT COUNT(*)
            FROM work_orders
            WHERE organization_id=? AND status IN ('open', 'in_progress')
            """,
            (ctx.org,),
        ).fetchone()[0]
        overdue_work_orders = connection.execute(
            """
            SELECT COUNT(*)
            FROM work_orders
            WHERE organization_id=?
              AND status IN ('open', 'in_progress')
              AND due_date IS NOT NULL
              AND due_date < date('now')
            """,
            (ctx.org,),
        ).fetchone()[0]
        stock_alert_view_exists = connection.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type='view' AND name='v_stock_alerts'
            """
        ).fetchone()
        stock_alerts = 0
        if stock_alert_view_exists:
            stock_alerts = connection.execute(
                "SELECT COUNT(*) FROM v_stock_alerts WHERE organization_id=?",
                (ctx.org,),
            ).fetchone()[0]

    return {
        "activeProjects": active_projects,
        "openWorkOrders": open_work_orders,
        "overdueCount": overdue_work_orders,
        "stockAlerts": stock_alerts,
        "techsOnline": 0,
    }


@router.get("/critical-tasks")
async def critical_tasks(ctx: Auth):
    """Return open critical work items for the current tenant."""
    require_permission(ctx, "projectRead")
    tasks = ctx.store.get_critical_tasks(ctx.org)
    return {"tasks": tasks, "count": len(tasks)}
