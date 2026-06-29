"""Tenant-scoped operational and security log read models."""

from __future__ import annotations

from fastapi import APIRouter

from app.middleware.auth import Auth, require_permission


router = APIRouter()


@router.get("/logs")
async def list_logs(
    ctx: Auth,
    source: str = "all",
    projectId: str | None = None,
    entityType: str = "all",
    q: str = "",
    limit: int = 100,
):
    """Return the unified project/workspace activity stream."""
    require_permission(ctx, "logsRead")
    return ctx.store.list_logs(
        ctx.org,
        {
            "source": source,
            "projectId": projectId,
            "entityType": entityType,
            "q": q,
            "limit": limit,
        },
    )


@router.get("/audit/integrity")
async def audit_integrity(ctx: Auth, projectId: str | None = None):
    """Verify the append-only project audit hash chain without exposing events."""
    require_permission(ctx, "logsRead")
    return ctx.store.verify_audit_integrity(ctx.org, projectId)


@router.get("/admin/audit-log")
async def list_security_audit(ctx: Auth, limit: int = 100):
    """Return recent security audit events for administrators."""
    require_permission(ctx, "adminPanel")
    bounded_limit = max(1, min(limit, 500))
    return {"entries": ctx.store.list_audit_log(ctx.org, bounded_limit)}
