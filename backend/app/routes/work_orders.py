from __future__ import annotations

from fastapi import APIRouter, HTTPException
from typing import Any

from app.middleware.auth import Auth, require_permission

router = APIRouter()


@router.get("")
async def list_work_orders(ctx: Auth, status: str | None = None, assetId: str | None = None):
    require_permission(ctx, "projectRead")
    return {"workOrders": ctx.store.list_work_orders(ctx.org, status=status, asset_id=assetId)}


@router.post("")
async def create_work_order(body: dict[str, Any], ctx: Auth):
    require_permission(ctx, "projectManage")
    wo = ctx.store.create_work_order(ctx.org, body)
    return {"workOrder": wo}


@router.get("/{wo_id}")
async def get_work_order(wo_id: str, ctx: Auth):
    require_permission(ctx, "projectRead")
    wo = ctx.store.get_work_order(ctx.org, wo_id)
    if not wo:
        raise HTTPException(404, "Work order not found")
    return {"workOrder": wo}


@router.post("/{wo_id}/update")
async def update_work_order(wo_id: str, body: dict[str, Any], ctx: Auth):
    require_permission(ctx, "projectManage")
    wo = ctx.store.update_work_order(ctx.org, wo_id, body)
    return {"workOrder": wo}


@router.post("/{wo_id}/tasks")
async def create_task(wo_id: str, body: dict[str, Any], ctx: Auth):
    require_permission(ctx, "projectManage")
    try:
        task = ctx.store.create_wo_task(ctx.org, wo_id, body)
    except (LookupError, ValueError) as exc:
        raise HTTPException(404 if isinstance(exc, LookupError) else 400, str(exc)) from exc
    return {"task": task}


@router.post("/{wo_id}/tasks/{task_id}")
async def update_task(wo_id: str, task_id: str, body: dict[str, Any], ctx: Auth):
    require_permission(ctx, "projectManage")
    try:
        task = ctx.store.update_wo_task(ctx.org, wo_id, task_id, body)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"task": task}


@router.post("/{wo_id}/tasks/{task_id}/delete")
async def delete_task(wo_id: str, task_id: str, ctx: Auth):
    require_permission(ctx, "projectManage")
    try:
        ctx.store.delete_wo_task(ctx.org, wo_id, task_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"ok": True}


@router.post("/{wo_id}/comments")
async def add_comment(wo_id: str, body: dict[str, Any], ctx: Auth):
    require_permission(ctx, "projectManage")
    try:
        comment = ctx.store.add_wo_comment(
            ctx.org,
            wo_id,
            {**body, "author": ctx.user_id or body.get("author", "")},
        )
    except (LookupError, ValueError) as exc:
        raise HTTPException(404 if isinstance(exc, LookupError) else 400, str(exc)) from exc
    return {"comment": comment}
