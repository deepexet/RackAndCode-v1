from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Any

from app.middleware.auth import Auth

router = APIRouter()


# ── Project CRUD ─────────────────────────────────────────────────────────

@router.get("")
async def list_projects(ctx: Auth):
    return {"projects": ctx.store.list_projects(ctx.org)}


@router.post("")
async def create_project(body: dict[str, Any], ctx: Auth):
    project = ctx.store.create_project(ctx.org, body, actor=ctx.user_id)
    return {"project": project}


@router.get("/sla-report")
async def sla_report(ctx: Auth):
    return ctx.store.project_sla_report(ctx.org)


@router.get("/import")
async def import_project(ctx: Auth):
    raise HTTPException(405, "Use POST /projects/import")


@router.post("/import")
async def import_project_post(body: dict[str, Any], ctx: Auth):
    project = ctx.store.create_project(ctx.org, body, actor=ctx.user_id)
    return {"project": project}


@router.get("/{project_id}")
async def get_project(project_id: str, ctx: Auth):
    project = ctx.store.get_project(ctx.org, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return {"project": project}


@router.post("/{project_id}")
async def update_project(project_id: str, body: dict[str, Any], ctx: Auth):
    updated = ctx.store.update_project_meta(ctx.org, project_id, body, actor=ctx.user_id)
    return {"project": updated}


# ── Work Items ────────────────────────────────────────────────────────────

@router.get("/{project_id}/work-items")
async def list_work_items(project_id: str, ctx: Auth):
    project = ctx.store.get_project(ctx.org, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return {"workItems": project.get("workItems", [])}


@router.post("/{project_id}/work-items")
async def create_work_item(project_id: str, body: dict[str, Any], ctx: Auth):
    wi = ctx.store.create_work_item(ctx.org, project_id, body, actor=ctx.user_id)
    return {"workItem": wi}


@router.post("/{project_id}/work-items/{wi_id}")
async def update_work_item(project_id: str, wi_id: str, body: dict[str, Any], ctx: Auth):
    wi = ctx.store.update_work_item(ctx.org, wi_id, body, actor=ctx.user_id)
    return {"workItem": wi}


# ── Milestones ───────────────────────────────────────────────────────────

@router.get("/{project_id}/milestones")
async def list_milestones(project_id: str, ctx: Auth):
    return {"milestones": ctx.store.list_milestones(ctx.org, project_id)}


@router.post("/{project_id}/milestones")
async def create_milestone(project_id: str, body: dict[str, Any], ctx: Auth):
    m = ctx.store.create_milestone(ctx.org, project_id, body, actor=ctx.user_id)
    return {"milestone": m}


@router.post("/{project_id}/milestones/{milestone_id}")
async def update_milestone(project_id: str, milestone_id: str, body: dict[str, Any], ctx: Auth):
    m = ctx.store.update_milestone(ctx.org, milestone_id, body, actor=ctx.user_id)
    return {"milestone": m}


# ── Budget ───────────────────────────────────────────────────────────────

@router.get("/{project_id}/budget")
async def get_budget(project_id: str, ctx: Auth):
    return ctx.store.get_project(ctx.org, project_id) or {}


@router.post("/{project_id}/budget")
async def update_budget(project_id: str, body: dict[str, Any], ctx: Auth):
    return ctx.store.update_project_meta(ctx.org, project_id, body, actor=ctx.user_id)


@router.get("/{project_id}/budget/forecast")
async def budget_forecast(project_id: str, ctx: Auth):
    return ctx.store.get_budget_forecast(ctx.org, project_id)


@router.post("/{project_id}/budget/expense")
async def add_expense(project_id: str, body: dict[str, Any], ctx: Auth):
    return ctx.store.update_project_meta(ctx.org, project_id, {"expense": body}, actor=ctx.user_id)


# ── Risks ────────────────────────────────────────────────────────────────

@router.get("/{project_id}/risks")
async def list_risks(project_id: str, ctx: Auth):
    return {"risks": ctx.store.list_project_risks(ctx.org, project_id)}


@router.post("/{project_id}/risks")
async def create_risk(project_id: str, body: dict[str, Any], ctx: Auth):
    r = ctx.store.create_project_risk(ctx.org, project_id, body, actor=ctx.user_id)
    return {"risk": r}


@router.post("/{project_id}/risks/{risk_id}")
async def update_risk(project_id: str, risk_id: str, body: dict[str, Any], ctx: Auth):
    r = ctx.store.update_project_risk(ctx.org, risk_id, body, actor=ctx.user_id)
    return {"risk": r}


@router.post("/{project_id}/risks/{risk_id}/delete")
async def delete_risk(project_id: str, risk_id: str, ctx: Auth):
    ctx.store.delete_project_risk(ctx.org, risk_id)
    return {"ok": True}


# ── Activity ─────────────────────────────────────────────────────────────

@router.get("/{project_id}/activity")
async def project_activity(project_id: str, limit: int = Query(50, le=200), ctx: Auth = None):
    return {"events": ctx.store.list_project_activity(ctx.org, project_id, limit=limit)}


# ── Standup ──────────────────────────────────────────────────────────────

@router.get("/{project_id}/standup")
async def standup(project_id: str, ctx: Auth):
    return ctx.store.build_standup_data(ctx.org, project_id)


# ── Comments ─────────────────────────────────────────────────────────────

@router.get("/{project_id}/comments")
async def list_comments(project_id: str, ctx: Auth):
    return {"comments": ctx.store.list_comments(ctx.org, project_id)}


@router.post("/{project_id}/comments")
async def add_comment(project_id: str, body: dict[str, Any], ctx: Auth):
    c = ctx.store.add_comment(ctx.org, project_id, body, actor=ctx.user_id)
    return {"comment": c}


# ── Digital Twin ──────────────────────────────────────────────────────────

@router.get("/{project_id}/twin")
async def digital_twin(project_id: str, ctx: Auth):
    return ctx.store.get_digital_twin(ctx.org, project_id)


# ── Locations ────────────────────────────────────────────────────────────

@router.get("/{project_id}/locations")
async def list_locations(project_id: str, ctx: Auth):
    p = ctx.store.get_project(ctx.org, project_id)
    return {"locations": (p or {}).get("locations", [])}


@router.post("/{project_id}/locations")
async def create_location(project_id: str, body: dict[str, Any], ctx: Auth):
    loc = ctx.store.create_location(ctx.org, project_id, body, actor=ctx.user_id)
    return {"location": loc}
