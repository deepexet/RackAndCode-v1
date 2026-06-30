from __future__ import annotations

from fastapi import APIRouter, HTTPException
from typing import Any

from app.middleware.auth import Auth, require_permission

router = APIRouter()


@router.get("/vehicles")
async def list_vehicles(ctx: Auth, status: str | None = None):
    require_permission(ctx, "projectRead")
    return {"vehicles": ctx.store.list_vehicles(ctx.org, status)}


@router.post("/vehicles")
async def create_vehicle(body: dict[str, Any], ctx: Auth):
    require_permission(ctx, "projectManage")
    try:
        v = ctx.store.create_vehicle(ctx.org, body)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"vehicle": v}


@router.get("/vehicles/{vid}")
async def get_vehicle(vid: str, ctx: Auth):
    require_permission(ctx, "projectRead")
    v = ctx.store.get_vehicle(ctx.org, vid)
    if not v:
        raise HTTPException(404, "Vehicle not found")
    return {"vehicle": v}


@router.post("/vehicles/{vid}/update")
async def update_vehicle(vid: str, body: dict[str, Any], ctx: Auth):
    require_permission(ctx, "projectManage")
    v = ctx.store.update_vehicle(ctx.org, vid, body)
    if not v:
        raise HTTPException(404, "Vehicle not found")
    return {"vehicle": v}


@router.get("/vehicles/{vid}/assignments")
async def list_assignments(vid: str, ctx: Auth):
    require_permission(ctx, "projectRead")
    if not ctx.store.get_vehicle(ctx.org, vid):
        raise HTTPException(404, "Vehicle not found")
    return {"assignments": ctx.store.list_vehicle_assignments(ctx.org, vid)}


@router.post("/vehicles/{vid}/assign")
async def assign_vehicle(vid: str, body: dict[str, Any], ctx: Auth):
    require_permission(ctx, "projectManage")
    try:
        a = ctx.store.assign_vehicle(ctx.org, vid, body)
    except (LookupError, ValueError) as exc:
        raise HTTPException(404 if isinstance(exc, LookupError) else 400, str(exc)) from exc
    return {"assignment": a}


@router.post("/vehicles/{vid}/unassign")
async def unassign_vehicle(vid: str, body: dict[str, Any], ctx: Auth):
    require_permission(ctx, "projectManage")
    from datetime import datetime, timezone
    end_at = body.get("endedAt") or datetime.now(timezone.utc).isoformat()
    try:
        ctx.store.unassign_vehicle(ctx.org, vid, end_at)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"ok": True}


@router.get("/vehicles/{vid}/service")
async def list_service(vid: str, ctx: Auth):
    require_permission(ctx, "projectRead")
    if not ctx.store.get_vehicle(ctx.org, vid):
        raise HTTPException(404, "Vehicle not found")
    return {"records": ctx.store.list_vehicle_service(ctx.org, vid)}


@router.post("/vehicles/{vid}/service")
async def create_service(vid: str, body: dict[str, Any], ctx: Auth):
    require_permission(ctx, "projectManage")
    try:
        rec = ctx.store.create_vehicle_service(ctx.org, vid, body)
    except (LookupError, ValueError) as exc:
        raise HTTPException(404 if isinstance(exc, LookupError) else 400, str(exc)) from exc
    return {"record": rec}


@router.get("/vehicles/{vid}/inventory")
async def get_vehicle_inventory(vid: str, ctx: Auth):
    require_permission(ctx, "projectRead")
    if not ctx.store.get_vehicle(ctx.org, vid):
        raise HTTPException(404, "Vehicle not found")
    return {"stock": ctx.store.get_vehicle_inventory(ctx.org, vid)}
