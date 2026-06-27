from __future__ import annotations

from fastapi import APIRouter, Query
from typing import Any

from app.middleware.auth import Auth

router = APIRouter()


@router.get("")
async def list_work_orders(ctx: Auth, status: str | None = None, assetId: str | None = None):
    return {"workOrders": ctx.store.list_work_orders(ctx.org, status=status, asset_id=assetId)}


@router.post("")
async def create_work_order(body: dict[str, Any], ctx: Auth):
    wo = ctx.store.create_work_order(ctx.org, body)
    return {"workOrder": wo}


@router.post("/{wo_id}/update")
async def update_work_order(wo_id: str, body: dict[str, Any], ctx: Auth):
    wo = ctx.store.update_work_order(ctx.org, wo_id, body)
    return {"workOrder": wo}
