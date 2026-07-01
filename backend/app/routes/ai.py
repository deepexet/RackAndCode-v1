from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, status
from typing import Any

from app.middleware.auth import Auth, require_permission

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


@router.get("/approvals")
async def list_approvals(ctx: Auth, status_filter: str | None = Query(default=None, alias="status")):
    """List tenant-scoped AI actions waiting for a human decision."""
    require_permission(ctx, "projectManage")
    return {"approvals": ctx.store.list_ai_approvals(ctx.org, status=status_filter)}


@router.post("/approvals", status_code=status.HTTP_201_CREATED)
async def propose_approval(body: dict[str, Any], ctx: Auth):
    require_permission(ctx, "projectManage")
    action_type = str(body.get("actionType") or "").strip()
    if not action_type:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "actionType is required")
    approval = ctx.store.propose_ai_action(
        ctx.org,
        proposed_by=ctx.user_id or "agent",
        action_type=action_type,
        action_payload=body.get("actionPayload") or {},
        evidence=body.get("evidence") or {},
    )
    coordinator_job_id = str(body.get("coordinatorJobId") or "").strip()
    if coordinator_job_id:
        ctx.store.set_approval_coordinator_job(ctx.org, approval["id"], coordinator_job_id)
        approval = next(item for item in ctx.store.list_ai_approvals(ctx.org) if item["id"] == approval["id"])
    return {"approval": approval}


@router.post("/approvals/{approval_id}/review")
async def review_approval(approval_id: str, body: dict[str, Any], ctx: Auth):
    require_permission(ctx, "adminPanel")
    decision = str(body.get("decision") or "").strip()
    if decision not in {"approved", "rejected"}:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "decision must be approved or rejected")
    try:
        approval = ctx.store.review_ai_approval(
            ctx.org, approval_id=approval_id, reviewer_id=ctx.user_id,
            decision=decision, note=str(body.get("note") or "").strip(),
        )
    except LookupError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return {"approval": approval}
