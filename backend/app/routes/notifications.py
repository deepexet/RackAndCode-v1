from __future__ import annotations

from fastapi import APIRouter, Query
from typing import Any

from app.middleware.auth import Auth

router = APIRouter()


@router.get("")
async def list_notifications(ctx: Auth, unread: bool = False):
    notifications, unread_count = ctx.store.list_notifications(
        ctx.org, user_id=ctx.user_id, unread_only=unread
    )
    return {"notifications": notifications, "unreadCount": unread_count}


@router.post("/read")
async def mark_read(body: dict[str, Any], ctx: Auth):
    ids = body.get("ids")
    ctx.store.mark_notifications_read(ctx.org, user_id=ctx.user_id, notif_ids=ids)
    return {"ok": True}


@router.post("/generate-alerts")
async def generate_alerts(ctx: Auth):
    count = ctx.store.generate_inventory_alerts(ctx.org)
    return {"generated": count}
