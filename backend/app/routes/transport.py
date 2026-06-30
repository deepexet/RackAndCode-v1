from __future__ import annotations

from fastapi import APIRouter, HTTPException
from typing import Any

from app.middleware.auth import Auth

router = APIRouter()


@router.get("/vehicles")
async def list_vehicles(ctx: Auth, status: str | None = None):
    return {"vehicles": ctx.store.list_vehicles(ctx.org, status)}


@router.post("/vehicles")
async def create_vehicle(body: dict[str, Any], ctx: Auth):
    v = ctx.store.create_vehicle(ctx.org, body)
    return {"vehicle": v}


@router.get("/vehicles/{vid}")
async def get_vehicle(vid: str, ctx: Auth):
    v = ctx.store.get_vehicle(ctx.org, vid)
    if not v:
        raise HTTPException(404, "Vehicle not found")
    return {"vehicle": v}


@router.post("/vehicles/{vid}/update")
async def update_vehicle(vid: str, body: dict[str, Any], ctx: Auth):
    v = ctx.store.update_vehicle(ctx.org, vid, body)
    return {"vehicle": v}


@router.get("/vehicles/{vid}/assignments")
async def list_assignments(vid: str, ctx: Auth):
    return {"assignments": ctx.store.list_vehicle_assignments(ctx.org, vid)}


@router.post("/vehicles/{vid}/assign")
async def assign_vehicle(vid: str, body: dict[str, Any], ctx: Auth):
    a = ctx.store.assign_vehicle(ctx.org, vid, body)
    return {"assignment": a}


@router.post("/vehicles/{vid}/unassign")
async def unassign_vehicle(vid: str, body: dict[str, Any], ctx: Auth):
    from datetime import datetime, timezone
    end_at = body.get("endedAt") or datetime.now(timezone.utc).isoformat()
    ctx.store.unassign_vehicle(ctx.org, vid, end_at)
    return {"ok": True}


@router.get("/vehicles/{vid}/service")
async def list_service(vid: str, ctx: Auth):
    return {"records": ctx.store.list_vehicle_service(ctx.org, vid)}


@router.post("/vehicles/{vid}/service")
async def create_service(vid: str, body: dict[str, Any], ctx: Auth):
    rec = ctx.store.create_vehicle_service(ctx.org, vid, body)
    return {"record": rec}


@router.get("/vehicles/{vid}/inventory")
async def get_vehicle_inventory(vid: str, ctx: Auth):
    return {"stock": ctx.store.get_vehicle_inventory(ctx.org, vid)}
