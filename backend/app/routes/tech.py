from __future__ import annotations

from fastapi import APIRouter
from typing import Any

from app.middleware.auth import Auth

router = APIRouter()


@router.get("/projects")
async def tech_projects(ctx: Auth):
    return {"projects": ctx.store.list_projects(ctx.org)}


@router.get("/projects/{project_id}/tasks")
async def tech_project_tasks(project_id: str, ctx: Auth):
    project = ctx.store.get_project(ctx.org, project_id)
    if not project:
        return {"tasks": []}
    return {"tasks": project.get("workItems", [])}


@router.post("/projects/{project_id}/tasks/{task_id}/progress")
async def tech_task_progress(project_id: str, task_id: str, body: dict[str, Any], ctx: Auth):
    wi = ctx.store.update_work_item(
        ctx.org, task_id,
        {"status": body.get("status", "progress")},
        actor=ctx.user_id,
    )
    return {"workItem": wi}


@router.post("/field-note")
async def field_note(body: dict[str, Any], ctx: Auth):
    result = ctx.store.parse_field_note(
        ctx.org, body.get("text", ""),
        warehouse_id=body.get("warehouseId"),
        actor=ctx.user_id,
    )
    return result
