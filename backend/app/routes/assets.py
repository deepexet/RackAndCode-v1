from __future__ import annotations

from fastapi import APIRouter, Query
from typing import Any

from app.middleware.auth import Auth

router = APIRouter()


@router.get("")
async def list_assets(ctx: Auth, projectId: str | None = None, locationId: str | None = None, assetType: str | None = None):
    return {"assets": ctx.store.list_assets(ctx.org, project_id=projectId, location_id=locationId, asset_type=assetType)}


@router.post("")
async def create_asset(body: dict[str, Any], ctx: Auth):
    asset = ctx.store.create_asset(ctx.org, body.get("projectId", ""), body, actor=ctx.user_id)
    return {"asset": asset}


@router.get("/{asset_id}")
async def get_asset(asset_id: str, ctx: Auth):
    return {"asset": ctx.store.get_asset(ctx.org, asset_id)}


@router.post("/{asset_id}")
async def update_asset(asset_id: str, body: dict[str, Any], ctx: Auth):
    asset = ctx.store.update_asset(ctx.org, asset_id, body, actor=ctx.user_id)
    return {"asset": asset}


@router.post("/{asset_id}/delete")
async def delete_asset(asset_id: str, ctx: Auth):
    ctx.store.delete_asset(ctx.org, asset_id)
    return {"ok": True}


@router.get("/{asset_id}/relationships")
async def list_relationships(asset_id: str, ctx: Auth):
    return {"relationships": ctx.store.list_relationships(ctx.org, asset_id=asset_id)}


@router.post("/{asset_id}/service-events")
async def add_service_event(asset_id: str, body: dict[str, Any], ctx: Auth):
    ev = ctx.store.add_service_event(ctx.org, asset_id, body)
    return {"event": ev}


@router.get("/{asset_id}/service-events")
async def list_service_events(asset_id: str, ctx: Auth, limit: int = 50):
    return {"events": ctx.store.list_service_events(ctx.org, asset_id, limit=limit)}


@router.get("/{asset_id}/config-snapshots")
async def list_config_snapshots(asset_id: str, ctx: Auth):
    return {"snapshots": ctx.store.list_config_snapshots(ctx.org, asset_id)}
