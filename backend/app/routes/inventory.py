from __future__ import annotations

from fastapi import APIRouter, Query, UploadFile, File
from typing import Any

from app.middleware.auth import Auth, require_permission

router = APIRouter()


@router.get("/warehouses")
async def list_warehouses(ctx: Auth):
    return {"warehouses": ctx.store.list_warehouses(ctx.org)}


@router.post("/warehouses")
async def create_warehouse(body: dict[str, Any], ctx: Auth):
    w = ctx.store.create_warehouse(ctx.org, body)
    return {"warehouse": w}


@router.post("/warehouses/{warehouse_id}/delete")
async def delete_warehouse(warehouse_id: str, ctx: Auth):
    ctx.store.delete_warehouse(ctx.org, warehouse_id)
    return {"ok": True}


@router.get("/skus")
async def list_skus(ctx: Auth, category: str | None = None, limit: int = Query(5000, le=10000)):
    return {"skus": ctx.store.list_skus(ctx.org, category=category)}


@router.post("/skus")
async def create_sku(body: dict[str, Any], ctx: Auth):
    sku = ctx.store.create_sku(ctx.org, body, actor=ctx.user_id)
    return {"sku": sku}


@router.post("/skus/{sku_id}")
async def update_sku(sku_id: str, body: dict[str, Any], ctx: Auth):
    sku = ctx.store.update_sku(ctx.org, sku_id, body, actor=ctx.user_id)
    return {"sku": sku}


@router.post("/skus/{sku_id}/delete")
async def delete_sku(sku_id: str, ctx: Auth):
    ctx.store.delete_sku(ctx.org, sku_id)
    return {"ok": True}


@router.post("/skus/import-csv")
async def import_skus_csv(body: dict[str, Any], ctx: Auth):
    result = ctx.store.import_skus_csv(ctx.org, body.get("csv", ""))
    return result


@router.get("/stock")
async def get_stock(ctx: Auth, warehouseId: str | None = None, limit: int = 1000):
    return {"stock": ctx.store.get_stock_levels(ctx.org, warehouse_id=warehouseId)}


@router.get("/stock-settings")
async def get_stock_settings(ctx: Auth, warehouseId: str | None = None, skuId: str | None = None):
    return {"settings": []}  # TODO


@router.post("/receive")
async def receive_stock(body: dict[str, Any], ctx: Auth):
    result = ctx.store.receive_stock(ctx.org, body, actor=ctx.user_id)
    return result


@router.post("/transfer")
async def transfer_stock(body: dict[str, Any], ctx: Auth):
    result = ctx.store.transfer_stock(
        ctx.org,
        body["fromWarehouseId"], body["toWarehouseId"],
        body["skuId"], body["quantity"],
        actor=ctx.user_id,
    )
    return result


@router.get("/movements")
async def list_movements(ctx: Auth, skuId: str | None = None, warehouseId: str | None = None, limit: int = 200):
    return {"movements": ctx.store.list_movements(ctx.org, sku_id=skuId, warehouse_id=warehouseId, limit=limit)}


@router.post("/movements/batch")
async def batch_movements(body: dict[str, Any], ctx: Auth):
    return {"ok": True}  # TODO


@router.get("/suppliers")
async def list_suppliers(ctx: Auth):
    return {"suppliers": ctx.store.list_suppliers(ctx.org)}


@router.post("/suppliers")
async def create_supplier(body: dict[str, Any], ctx: Auth):
    s = ctx.store.create_supplier(ctx.org, body, actor=ctx.user_id)
    return {"supplier": s}


@router.post("/suppliers/{supplier_id}")
async def update_supplier(supplier_id: str, body: dict[str, Any], ctx: Auth):
    s = ctx.store.update_supplier(ctx.org, supplier_id, body, actor=ctx.user_id)
    return {"supplier": s}


@router.post("/suppliers/{supplier_id}/delete")
async def delete_supplier(supplier_id: str, ctx: Auth):
    ctx.store.delete_supplier(ctx.org, supplier_id)
    return {"ok": True}


@router.get("/orders")
async def list_orders(ctx: Auth):
    return {"orders": ctx.store.list_purchase_orders(ctx.org)}


@router.post("/orders")
async def create_order(body: dict[str, Any], ctx: Auth):
    o = ctx.store.create_purchase_order(ctx.org, body, actor=ctx.user_id)
    return {"order": o}


@router.post("/orders/{order_id}/{action}")
async def order_action(order_id: str, action: str, body: dict[str, Any], ctx: Auth):
    result = ctx.store.update_purchase_order(ctx.org, order_id, {"action": action, **body}, actor=ctx.user_id)
    return {"order": result}


@router.get("/lots")
async def list_lots(ctx: Auth, days: int = 90):
    return {"lots": ctx.store.list_expiring_lots(ctx.org, days)}


@router.post("/lots")
async def create_lot(body: dict[str, Any], ctx: Auth):
    lot = ctx.store.create_lot(ctx.org, body, actor=ctx.user_id)
    return {"lot": lot}


@router.get("/reservations")
async def list_reservations(ctx: Auth, projectId: str | None = None):
    return {"reservations": ctx.store.list_reservations(ctx.org, project_id=projectId)}


@router.post("/reservations")
async def create_reservation(body: dict[str, Any], ctx: Auth):
    r = ctx.store.create_reservation(
        ctx.org, body["projectId"], body["warehouseId"],
        body["skuId"], body["quantity"], body.get("note", ""),
    )
    return {"reservation": r}


@router.post("/reservations/{reservation_id}/release")
async def release_reservation(reservation_id: str, ctx: Auth):
    ctx.store.release_reservation(ctx.org, reservation_id, actor=ctx.user_id)
    return {"ok": True}


@router.get("/reorder-requests")
async def list_reorder_requests(ctx: Auth, status: str = "open"):
    return {"requests": ctx.store.list_reorder_requests(ctx.org, status)}


@router.get("/reorder-suggest")
async def reorder_suggest(ctx: Auth):
    return {"suggestions": ctx.store.auto_suggest_reorders(ctx.org)}


@router.post("/reorder-requests")
async def create_reorder_request(body: dict[str, Any], ctx: Auth):
    r = ctx.store.create_reorder_request(
        ctx.org, body["skuId"], body["warehouseId"],
        body.get("quantity", 1), body.get("note", ""), actor=ctx.user_id,
    )
    return {"request": r}


@router.post("/reorder-requests/{request_id}/fulfill")
async def fulfill_reorder(request_id: str, body: dict[str, Any], ctx: Auth):
    ctx.store.fulfill_reorder_request(ctx.org, request_id, actor=ctx.user_id)
    return {"ok": True}


@router.get("/cycle-counts")
async def list_cycle_counts(ctx: Auth):
    return {"reconciliations": ctx.store.list_reconciliations(ctx.org)}


@router.get("/cycle-counts/{recon_id}")
async def get_cycle_count(recon_id: str, ctx: Auth):
    return {"reconciliation": ctx.store.get_reconciliation(ctx.org, recon_id)}


@router.post("/cycle-counts")
async def create_cycle_count(body: dict[str, Any], ctx: Auth):
    r = ctx.store.create_reconciliation(
        ctx.org, body.get("warehouseId", ""),
        note=body.get("note", ""), counted_by=ctx.user_id or "",
    )
    return {"reconciliation": r}


@router.post("/cycle-counts/{recon_id}/lines")
async def update_recon_line(recon_id: str, body: dict[str, Any], ctx: Auth):
    ctx.store.update_reconciliation_line(
        ctx.org, recon_id, body["skuId"],
        body.get("countedQuantity"), body.get("note", ""),
    )
    return {"ok": True}


@router.post("/cycle-counts/{recon_id}/commit")
async def commit_cycle_count(recon_id: str, body: dict[str, Any], ctx: Auth):
    ctx.store.commit_reconciliation(ctx.org, recon_id, actor=ctx.user_id)
    return {"ok": True}


@router.get("/alerts")
async def inventory_alerts(ctx: Auth):
    require_permission(ctx, "projectRead")
    return {"alerts": ctx.store.list_inventory_alerts(ctx.org)}


@router.post("/auto-reorder")
async def auto_reorder(body: dict[str, Any], ctx: Auth):
    result = ctx.store.process_auto_reorder(ctx.org, actor=ctx.user_id)
    return result


@router.get("/valuation")
async def inventory_valuation(ctx: Auth):
    return ctx.store.get_inventory_valuation(ctx.org)


@router.get("/demand-forecast")
async def demand_forecast(ctx: Auth, days: int = 90, horizon: int = 30):
    return ctx.store.get_demand_forecast(ctx.org, days=days, horizon=horizon)


@router.get("/supplier-performance")
async def supplier_performance(ctx: Auth):
    return ctx.store.get_supplier_performance(ctx.org)


@router.get("/pending")
async def list_pending(ctx: Auth, status: str = "pending"):
    return {"pending": ctx.store.list_inventory_pending(ctx.org, status=status)}


@router.post("/pending/{pending_id}/approve")
async def approve_pending(pending_id: str, body: dict[str, Any], ctx: Auth):
    ctx.store.approve_inventory_pending(
        ctx.org, pending_id,
        warehouse_id=body.get("warehouseId", ""),
        reviewer=ctx.user_id,
    )
    return {"ok": True}


@router.post("/pending/{pending_id}/reject")
async def reject_pending(pending_id: str, body: dict[str, Any], ctx: Auth):
    ctx.store.reject_inventory_pending(ctx.org, pending_id, reviewer=ctx.user_id)
    return {"ok": True}


@router.post("/ai-parse")
async def ai_parse(body: dict[str, Any], ctx: Auth):
    result = ctx.store.create_inventory_pending_from_ai(
        ctx.org, body.get("text", ""),
        warehouse_id=body.get("warehouseId"),
        actor=ctx.user_id,
    )
    return result
