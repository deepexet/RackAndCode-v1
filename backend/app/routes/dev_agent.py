from __future__ import annotations

from fastapi import APIRouter
from typing import Any

from app.middleware.auth import Auth

router = APIRouter()


@router.get("/status")
async def agent_status(ctx: Auth):
    return {"agent": ctx.store.get_development_agent_status(ctx.org)}


@router.post("/status")
async def set_agent_status(body: dict[str, Any], ctx: Auth):
    ctx.store.set_development_agent_status(ctx.org, body)
    return {"ok": True}


@router.post("/request-continuation")
async def request_continuation(ctx: Auth):
    ctx.store.request_development_continuation(ctx.org, requested_by=ctx.user_id)
    return {"ok": True}
