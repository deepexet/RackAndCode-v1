from __future__ import annotations

from fastapi import APIRouter
from typing import Any

from app.middleware.auth import Auth

router = APIRouter()


@router.get("/status")
async def ai_status(ctx: Auth):
    return ctx.store.get_ai_router_config(ctx.org)


@router.get("/config")
async def ai_config(ctx: Auth):
    return ctx.store.get_ai_router_config(ctx.org)


@router.post("/invoke")
async def ai_invoke(body: dict[str, Any], ctx: Auth):
    router_instance = ctx.store.get_ai_router(ctx.org)
    result = router_instance.invoke(
        body.get("prompt", ""),
        model=body.get("model"),
        system=body.get("system"),
    )
    ctx.store.log_ai_invocation(ctx.org, body, result, actor=ctx.user_id)
    return result


@router.post("/classify")
async def ai_classify(body: dict[str, Any], ctx: Auth):
    from server.ai_router import classify
    result = classify(body.get("text", ""), body.get("schema", {}))
    return result


@router.post("/parse-note")
async def parse_note(body: dict[str, Any], ctx: Auth):
    result = ctx.store.parse_field_note(
        ctx.org, body.get("text", ""),
        warehouse_id=body.get("warehouseId"),
        actor=ctx.user_id,
    )
    return result


@router.get("/log")
async def ai_log(ctx: Auth, limit: int = 50):
    return {"invocations": ctx.store.list_ai_invocations(ctx.org, limit=limit)}
