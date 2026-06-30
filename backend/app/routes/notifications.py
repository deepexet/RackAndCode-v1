from __future__ import annotations

from fastapi import APIRouter
from typing import Any

from app.middleware.auth import Auth, require_permission

router = APIRouter()


@router.get("")
async def list_notifications(ctx: Auth, unread: bool = False, limit: int = 30):
    require_permission(ctx, "projectRead")
    limit = max(1, min(limit, 100))
    notifications = ctx.store.list_notifications(ctx.org, user_id=ctx.user_id, unread_only=unread, limit=limit)
    unread_count = ctx.store.count_unread_notifications(ctx.org, user_id=ctx.user_id)
    return {"notifications": notifications, "unreadCount": unread_count}


@router.post("/mark-all-read")
async def mark_all_read(ctx: Auth):
    require_permission(ctx, "projectRead")
    count = ctx.store.mark_notifications_read(ctx.org, notif_ids=None, user_id=ctx.user_id)
    return {"marked": count}


@router.post("/read")
async def mark_read(body: dict[str, Any], ctx: Auth):
    require_permission(ctx, "projectRead")
    ids = body.get("ids")
    count = ctx.store.mark_notifications_read(ctx.org, notif_ids=ids, user_id=ctx.user_id)
    return {"marked": count}


@router.post("/generate-alerts")
async def generate_alerts(ctx: Auth):
    require_permission(ctx, "projectManage")
    result = ctx.store.generate_system_alerts(ctx.org)
    return result
