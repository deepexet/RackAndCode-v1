from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.parse
import urllib.request

from fastapi import APIRouter, HTTPException, status
from typing import Any

from app.core.config import settings
from app.middleware.auth import Auth

router = APIRouter()


def _require_authenticated_admin(ctx: Auth) -> None:
    if not ctx.user_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Authenticated session required")
    if ctx.role != "Administrator":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Administrator role required")


def _coordinator_request(path: str, *, method: str = "GET", body: dict[str, Any] | None = None) -> Any:
    url = f"{settings.coordinator_url.rstrip('/')}/{path.lstrip('/')}"
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if method != "GET":
        if not settings.coordinator_token:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Coordinator control is not configured")
        headers["X-Coordinator-Token"] = settings.coordinator_token
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=settings.coordinator_timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8")).get("detail", "Coordinator request failed")
        except (ValueError, AttributeError):
            detail = "Coordinator request failed"
        raise HTTPException(exc.code, detail) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Coordinator is unavailable") from exc


async def _coordinator(path: str, *, method: str = "GET", body: dict[str, Any] | None = None) -> Any:
    return await asyncio.to_thread(_coordinator_request, path, method=method, body=body)


def _find_work_item(ctx: Auth, project_id: str, work_item_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    project = ctx.store.get_project(ctx.org, project_id)
    if not project:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    work_item = next((item for item in project.get("workItems", []) if item["id"] == work_item_id), None)
    if not work_item:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Work item not found")
    return project, work_item


def _recommend_work_item_agent(work_item: dict[str, Any]) -> dict[str, Any]:
    text = " ".join([
        str(work_item.get("title", "")),
        str(work_item.get("description", "")),
        " ".join(str(value) for value in work_item.get("labels", [])),
    ]).lower()
    architecture_terms = {
        "architecture", "architect", "adr", "schema", "data model", "threat model",
        "design secure", "diagram model", "архитект", "схем", "модель данных",
    }
    local_terms = {
        "classify", "summarize", "summary", "extract", "label", "triage",
        "классифиц", "суммар", "извлеч", "размет",
    }
    implementation_terms = {
        "implement", "fix", "route", "fastapi", "frontend", "backend", "migration",
        "test", "ui", "api", "bug", "реализ", "исправ", "перенест", "тест",
    }
    if any(term in text for term in architecture_terms):
        return {"agent": "claude", "reason": "Architecture or system-contract work is assigned to Claude Architecture Lead."}
    if any(term in text for term in local_terms) and not any(term in text for term in implementation_terms):
        return {"agent": "local", "reason": "This is a bounded text-analysis task suitable for the local model."}
    return {"agent": "codex", "reason": "Implementation, integration and verification are assigned to Codex."}


def _work_item_scope(work_item: dict[str, Any]) -> list[str]:
    text = " ".join([
        str(work_item.get("title", "")), str(work_item.get("description", "")),
        " ".join(str(value) for value in work_item.get("labels", [])),
    ]).lower()
    scopes: list[str] = []
    mappings = (
        (("coordinator", "agent"), ("coordinator", "backend/app/routes/admin.py", "frontend/src/modules/admin.js")),
        (("wiki", "knowledge", "vault"), ("backend/app/routes/wiki.py", "frontend/src/modules/wiki.js", "server/migrations")),
        (("diagram", "схем"), ("frontend/src/modules/diagrams.js", "backend/app/routes", "server/migrations")),
        (("inventory", "склад"), ("backend/app/routes/inventory.py", "frontend/src/modules/inventory.js", "server/app.py")),
        (("work order", "наряд"), ("backend/app/routes/work_orders.py", "frontend/src/modules/work_orders.js", "server/app.py")),
        (("project", "kanban", "work item"), ("backend/app/routes/projects.py", "frontend/src/modules/projects.js", "server/app.py")),
        (("frontend", "mobile", "ui", "style"), ("frontend",)),
        (("fastapi", "backend", "api", "route"), ("backend", "server/app.py")),
        (("test", "quality"), ("tests",)),
        (("doc", "adr", "architecture"), ("docs",)),
    )
    for terms, paths in mappings:
        if any(term in text for term in terms):
            scopes.extend(paths)
    return list(dict.fromkeys(scopes or ["docs", "tests"]))[:12]


def _agent_instructions(project: dict[str, Any], work_item: dict[str, Any], agent: str) -> str:
    role = {
        "claude": "Act as RackPilot Architecture Lead. Produce concrete contracts/ADR first and implement only within the declared scope when required.",
        "codex": "Act as RackPilot Engineering & Integration Lead. Implement, test, and leave the worktree ready for review.",
        "local": "Perform text-only analysis. Do not claim code or filesystem changes; return a concise structured result for Codex review.",
    }[agent]
    return f"""{role}

SOURCE OF TRUTH
Project: {project.get('name')} ({project.get('id')})
Kanban work item: {work_item.get('code') or work_item.get('id')} — {work_item.get('title')}
Priority: {work_item.get('priority')}

DESCRIPTION
{work_item.get('description') or 'No description provided.'}

DELIVERY CONTRACT
- Work only on this task and its declared repository scope.
- Preserve tenant isolation, RBAC, auditability, offline-first compatibility, and existing user changes.
- Use numbered immutable migrations for schema changes.
- Run focused tests and report exact results and remaining risks.
- Do not merge to the integration branch. Stop for Codex/owner review.
"""


def _advance_work_item(ctx: Auth, project_id: str, work_item: dict[str, Any], target: str) -> dict[str, Any]:
    paths = {
        "progress": {"ideas": ["ready", "progress"], "backlog": ["ready", "progress"], "ready": ["progress"], "blocked": ["progress"]},
        "review": {"ideas": ["ready", "progress", "review"], "backlog": ["ready", "progress", "review"], "ready": ["progress", "review"], "progress": ["review"], "blocked": ["progress", "review"]},
        "testing": {"ideas": ["ready", "progress", "review", "testing"], "backlog": ["ready", "progress", "review", "testing"], "ready": ["progress", "review", "testing"], "progress": ["review", "testing"], "review": ["testing"]},
        "blocked": {"progress": ["blocked"]},
    }
    current = work_item
    for next_status in paths.get(target, {}).get(current.get("status"), []):
        current = ctx.store.update_work_item(ctx.org, project_id, current["id"], {
            "expectedVersion": current["version"],
            "status": next_status,
        })
    return current


async def _create_work_item_job(
    ctx: Auth,
    project: dict[str, Any],
    work_item: dict[str, Any],
    *,
    assigned_agent: str,
    max_turns: int = 10,
    scope_paths: list[str] | None = None,
) -> dict[str, Any]:
    payload = {
        "title": f"{work_item.get('code') or 'KANBAN'}: {work_item['title']}",
        "instructions": _agent_instructions(project, work_item, assigned_agent),
        "assignedAgent": assigned_agent,
        "autoWorktree": assigned_agent != "local",
        "baseRef": settings.coordinator_base_ref,
        "scopePaths": scope_paths or _work_item_scope(work_item),
        "requiresReview": True,
        "maxTurns": max(1, min(max_turns, 20)),
        "createdBy": ctx.user_id,
        "sourceOrganizationId": ctx.org,
        "sourceProjectId": project["id"],
        "sourceWorkItemId": work_item["id"],
    }
    created = await _coordinator("/api/v1/jobs", method="POST", body=payload)
    job = created.get("job", {})
    try:
        updated = _advance_work_item(ctx, project["id"], work_item, "progress")
    except Exception:
        if job.get("id"):
            try:
                await _coordinator(f"/api/v1/jobs/{job['id']}/cancel", method="POST", body={})
            except HTTPException:
                pass
        raise
    ctx.store.audit(ctx.org, ctx.user_id, ctx.role, "coordinator.work_item.delegate", "work_item", work_item["id"])
    return {"job": job, "workItem": updated}


# ── Platform settings ─────────────────────────────────────────────────────

@router.get("/platform-settings")
async def get_platform_settings(ctx: Auth):
    return {"settings": ctx.store.get_platform_settings(ctx.org)}


@router.post("/platform-settings")
async def save_platform_settings(body: dict[str, Any], ctx: Auth):
    return {"settings": ctx.store.save_platform_settings(ctx.org, body)}


# ── Git sync ──────────────────────────────────────────────────────────────

@router.get("/git-sync")
async def get_git_sync(ctx: Auth):
    return {"settings": ctx.store.get_git_sync_settings(ctx.org)}


@router.post("/git-sync")
async def save_git_sync(body: dict[str, Any], ctx: Auth):
    return {"settings": ctx.store.save_git_sync_settings(ctx.org, body)}


# ── Compute nodes ─────────────────────────────────────────────────────────

@router.get("/compute-nodes")
async def list_compute_nodes(ctx: Auth):
    return {"nodes": ctx.store.list_compute_nodes(ctx.org)}


@router.post("/compute-nodes/{node_id}/enabled")
async def set_node_enabled(node_id: str, body: dict[str, Any], ctx: Auth):
    ctx.store.set_compute_node_enabled(ctx.org, node_id, body.get("enabled", False))
    return {"ok": True}


# ── Work types ────────────────────────────────────────────────────────────

@router.get("/work-types")
async def list_work_types(ctx: Auth):
    return {"workTypes": ctx.store.list_workflow_configuration(ctx.org)}


@router.post("/work-types")
async def save_work_type(body: dict[str, Any], ctx: Auth):
    wt = ctx.store.save_workflow_configuration(ctx.org, body)
    return {"workType": wt}


# ── Custom fields ─────────────────────────────────────────────────────────

@router.get("/custom-fields")
async def list_custom_fields(ctx: Auth):
    return {"customFields": ctx.store.list_custom_field_definitions(ctx.org)}


@router.post("/custom-fields")
async def save_custom_field(body: dict[str, Any], ctx: Auth):
    f = ctx.store.save_custom_field_definition(ctx.org, body)
    return {"customField": f}


# ── Secrets vault ─────────────────────────────────────────────────────────

@router.get("/secrets")
async def list_secrets(ctx: Auth):
    return {"secrets": ctx.store.list_secrets(ctx.org)}


@router.post("/secrets")
async def create_secret(body: dict[str, Any], ctx: Auth):
    s = ctx.store.create_secret(ctx.org, body)
    return {"secret": s}


@router.post("/secrets/{secret_id}")
async def update_secret(secret_id: str, body: dict[str, Any], ctx: Auth):
    s = ctx.store.update_secret(ctx.org, secret_id, body)
    return {"secret": s}


@router.post("/secrets/{secret_id}/delete")
async def delete_secret(secret_id: str, ctx: Auth):
    ctx.store.delete_secret(ctx.org, secret_id)
    return {"ok": True}


@router.get("/secrets/{secret_id}/value")
async def get_secret_value(secret_id: str, ctx: Auth):
    val = ctx.store.get_secret_value(ctx.org, secret_id)
    return {"value": val}


# ── Feature docs ──────────────────────────────────────────────────────────

@router.get("/feature-docs")
async def list_feature_docs(ctx: Auth):
    return {"featureDocs": ctx.store.list_feature_docs(ctx.org)}


@router.post("/feature-docs/save")
async def save_feature_guide(body: dict[str, Any], ctx: Auth):
    ctx.store.save_feature_guide(ctx.org, body["featureId"], body.get("guide", ""))
    return {"ok": True}


# ── AI Gateway ────────────────────────────────────────────────────────────

@router.get("/ai-gateway/providers")
async def list_ai_providers(ctx: Auth):
    return {"providers": ctx.store.list_ai_providers(ctx.org)}


@router.post("/ai-gateway/providers")
async def save_ai_provider(body: dict[str, Any], ctx: Auth):
    ctx.store.save_ai_provider(ctx.org, body)
    return {"ok": True}


@router.post("/ai-gateway/providers/{provider_id}/delete")
async def delete_ai_provider(provider_id: str, ctx: Auth):
    ctx.store.delete_ai_provider(ctx.org, provider_id)
    return {"ok": True}


@router.get("/ai-gateway/usage")
async def ai_gateway_usage(ctx: Auth, days: int = 30):
    return ctx.store.get_ai_usage(ctx.org, days=days)


# ── Email inboxes ─────────────────────────────────────────────────────────

@router.get("/email-inboxes")
async def list_email_inboxes(ctx: Auth):
    return {"inboxes": ctx.store.list_email_inboxes(ctx.org)}


@router.post("/email-inboxes")
async def create_email_inbox(body: dict[str, Any], ctx: Auth):
    inbox = ctx.store.create_email_inbox(ctx.org, body)
    return {"inbox": inbox}


@router.post("/email-inboxes/{inbox_id}/delete")
async def delete_email_inbox(inbox_id: str, ctx: Auth):
    ctx.store.delete_email_inbox(ctx.org, inbox_id)
    return {"ok": True}


@router.post("/email-inboxes/{inbox_id}/poll")
async def poll_inbox(inbox_id: str, body: dict[str, Any], ctx: Auth):
    result = ctx.store.poll_email_inbox(ctx.org, inbox_id, body.get("rawEmail", ""))
    return result


# ── Sessions ──────────────────────────────────────────────────────────────

@router.get("/sessions")
async def list_sessions(ctx: Auth):
    return {"sessions": ctx.store.list_active_sessions(ctx.org)}


@router.post("/sessions/revoke")
async def revoke_session(body: dict[str, Any], ctx: Auth):
    ctx.store.revoke_session(ctx.org, body["sessionId"])
    return {"ok": True}


# ── Monitors ──────────────────────────────────────────────────────────────

@router.get("/monitors")
async def list_monitors(ctx: Auth, assetId: str | None = None):
    return {"monitors": ctx.store.list_monitors(ctx.org, asset_id=assetId)}


@router.post("/monitors")
async def create_monitor(body: dict[str, Any], ctx: Auth):
    m = ctx.store.create_monitor(ctx.org, body)
    return {"monitor": m}


@router.post("/monitors/{monitor_id}/delete")
async def delete_monitor(monitor_id: str, ctx: Auth):
    ctx.store.delete_monitor(ctx.org, monitor_id)
    return {"ok": True}


# ── Connectors ────────────────────────────────────────────────────────────

@router.get("/connectors")
async def list_connectors(ctx: Auth):
    return {"connectors": ctx.store.list_connectors(ctx.org)}


@router.post("/connectors")
async def upsert_connector(body: dict[str, Any], ctx: Auth):
    c = ctx.store.upsert_connector(ctx.org, body["type"], body["name"], body.get("config", {}))
    return {"connector": c}


# ── Org settings ──────────────────────────────────────────────────────────

@router.get("/org-settings")
async def get_org_settings(ctx: Auth):
    return ctx.store.get_org_settings(ctx.org) or {}


@router.post("/org-settings")
async def save_org_settings(body: dict[str, Any], ctx: Auth):
    ctx.store.save_org_settings(ctx.org, body)
    return {"ok": True}


# ── Privacy ───────────────────────────────────────────────────────────────

@router.get("/privacy")
async def list_privacy(ctx: Auth):
    return {"settings": ctx.store.list_privacy_settings(ctx.org)}


@router.post("/privacy/{key}")
async def save_privacy(key: str, body: dict[str, Any], ctx: Auth):
    ctx.store.save_privacy_setting(ctx.org, key, body.get("value"))
    return {"ok": True}


# ── Team ──────────────────────────────────────────────────────────────────

@router.get("/team")  # also accessible via /api/v1/team
async def list_team(ctx: Auth):
    return {"members": ctx.store.list_team_members(ctx.org)}


# ── Retrieval eval ────────────────────────────────────────────────────────

@router.get("/retrieval-eval")
async def list_retrieval_eval(ctx: Auth):
    return {"cases": []}  # TODO: implement when RAG is ready


# ── Digest ────────────────────────────────────────────────────────────────

@router.get("/digest")
async def get_digest(ctx: Auth):
    return ctx.store.build_digest_html(ctx.org)


@router.post("/digest/send-email")
async def send_digest_email(body: dict[str, Any], ctx: Auth):
    return {"ok": True}  # TODO: wire SMTP


# ── Runbooks ──────────────────────────────────────────────────────────────

@router.get("/runbooks")
async def list_runbooks(ctx: Auth):
    from server.app import _RUNBOOKS
    return {"runbooks": _RUNBOOKS}


# ── SMTP ──────────────────────────────────────────────────────────────────

@router.get("/smtp-config")
async def get_smtp(ctx: Auth):
    return {"config": ctx.store.get_smtp_config(ctx.org)}


@router.post("/smtp-config")
async def save_smtp(body: dict[str, Any], ctx: Auth):
    ctx.store.save_smtp_config(ctx.org, body)
    return {"ok": True}


# ── Platform growth ───────────────────────────────────────────────────────

@router.get("/platform-growth")
async def platform_growth(ctx: Auth):
    from server.app import _build_platform_growth
    return _build_platform_growth()


# ── System stats (local machine) ──────────────────────────────────────────

def _get_battery_ioreg() -> dict:
    """Read battery voltage, current and cycle count via ioreg (macOS only)."""
    import re, subprocess
    try:
        out = subprocess.check_output(
            ["ioreg", "-rn", "AppleSmartBattery", "-l"],
            text=True, timeout=2,
        )
        def _find(key: str):
            m = re.search(rf'"{key}"\s*=\s*(-?\d+)', out)
            return int(m.group(1)) if m else None
        return {
            "voltageMv": _find("Voltage"),
            "currentMa": _find("InstantAmperage"),
            "cycleCount": _find("CycleCount"),
            "designCapacity": _find("DesignCapacity"),
            "maxCapacity": _find("MaxCapacity"),
        }
    except Exception:
        return {}


@router.get("/system-stats")
async def system_stats(ctx: Auth):
    import asyncio, time, platform
    import psutil

    cpu = psutil.cpu_percent(interval=0.25)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    bat = psutil.sensors_battery()
    boot_ts = psutil.boot_time()
    uptime_s = int(time.time() - boot_ts)

    battery: dict = {}
    if bat is not None:
        battery = {
            "percent": round(bat.percent, 1),
            "plugged": bat.power_plugged,
            "secsleft": bat.secsleft if bat.secsleft != psutil.POWER_TIME_UNLIMITED else -1,
        }
        battery.update(_get_battery_ioreg())

    return {
        "cpu": {"percent": round(cpu, 1), "count": psutil.cpu_count()},
        "memory": {
            "percent": round(mem.percent, 1),
            "usedBytes": mem.used,
            "totalBytes": mem.total,
        },
        "disk": {
            "percent": round(disk.percent, 1),
            "usedBytes": disk.used,
            "totalBytes": disk.total,
        },
        "battery": battery,
        "uptimeSeconds": uptime_s,
        "platform": platform.system(),
        "hostname": platform.node(),
    }


# ── Local Agent Coordinator ───────────────────────────────────────────────

@router.get("/coordinator")
async def coordinator_overview(ctx: Auth):
    _require_authenticated_admin(ctx)
    health, agents, worktrees, jobs, events, autonomous = await asyncio.gather(
        _coordinator("/health"),
        _coordinator("/api/v1/agents"),
        _coordinator("/api/v1/worktrees"),
        _coordinator("/api/v1/jobs?limit=50"),
        _coordinator("/api/v1/events?limit=100"),
        _coordinator("/api/v1/autonomous-shift"),
    )
    coordinator_jobs = jobs.get("jobs", [])
    for job in coordinator_jobs:
        if (job.get("status") == "completed" and job.get("sourceOrganizationId") == ctx.org
                and job.get("sourceProjectId") and job.get("sourceWorkItemId")):
            try:
                _, work_item = _find_work_item(ctx, job["sourceProjectId"], job["sourceWorkItemId"])
                if work_item.get("status") in {"progress", "review"}:
                    _advance_work_item(ctx, job["sourceProjectId"], work_item, "testing")
            except (HTTPException, LookupError, ValueError):
                pass
    return {
        "health": health,
        "agents": agents.get("agents", []),
        "worktrees": worktrees.get("worktrees", []),
        "jobs": coordinator_jobs,
        "events": events.get("events", []),
        "autonomous": autonomous,
    }


@router.post("/coordinator/autonomous-shift/start")
async def coordinator_start_autonomous_shift(body: dict[str, Any], ctx: Auth):
    _require_authenticated_admin(ctx)
    max_tasks = max(1, min(int(body.get("maxTasks", 8)), 24))
    duration_hours = max(1, min(int(body.get("durationHours", 10)), 24))
    retry_minutes = max(5, min(int(body.get("retryMinutes", 60)), 1440))
    shift = await _coordinator(
        "/api/v1/autonomous-shift/start", method="POST",
        body={"durationHours": duration_hours, "retryMinutes": retry_minutes, "autoApprove": True},
    )
    jobs = await _coordinator("/api/v1/jobs?limit=500")
    active_ids = {
        job.get("sourceWorkItemId") for job in jobs.get("jobs", [])
        if job.get("status") in {"queued", "running", "review", "waiting_approval", "integrating", "rate_limited"}
    }
    priority = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    candidates: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for project in ctx.store.list_projects(ctx.org):
        if project.get("status") not in {"active", "planned"}:
            continue
        for item in project.get("workItems", []):
            if (item.get("status") == "ready" and item.get("effectiveStatus") == "ready"
                    and item.get("id") not in active_ids and item.get("title") != "Test task"):
                candidates.append((project, item))
    candidates.sort(key=lambda pair: (
        priority.get(pair[1].get("priority"), 9), pair[1].get("dueDate") or "9999-12-31",
        pair[1].get("title", ""),
    ))
    delegated: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for project, item in candidates[:max_tasks]:
        recommendation = _recommend_work_item_agent(item)
        try:
            result = await _create_work_item_job(
                ctx, project, item, assigned_agent=recommendation["agent"]
            )
            delegated.append({
                "workItemId": item["id"], "title": item["title"],
                "agent": recommendation["agent"], "jobId": result["job"].get("id"),
            })
        except HTTPException as exc:
            errors.append({"workItemId": item["id"], "error": str(exc.detail)})
    ctx.store.audit(ctx.org, ctx.user_id, ctx.role, "coordinator.autonomous_shift.start", "agent_shift", None)
    return {**shift, "delegated": delegated, "errors": errors}


@router.post("/coordinator/autonomous-shift/stop")
async def coordinator_stop_autonomous_shift(ctx: Auth):
    _require_authenticated_admin(ctx)
    result = await _coordinator("/api/v1/autonomous-shift/stop", method="POST", body={})
    ctx.store.audit(ctx.org, ctx.user_id, ctx.role, "coordinator.autonomous_shift.stop", "agent_shift", None)
    return result


@router.post("/coordinator/jobs")
async def coordinator_create_job(body: dict[str, Any], ctx: Auth):
    _require_authenticated_admin(ctx)
    payload = dict(body)
    payload["createdBy"] = ctx.user_id
    return await _coordinator("/api/v1/jobs", method="POST", body=payload)


@router.get("/coordinator/work-items/{project_id}/{work_item_id}")
async def coordinator_work_item(project_id: str, work_item_id: str, ctx: Auth):
    _require_authenticated_admin(ctx)
    _, work_item = _find_work_item(ctx, project_id, work_item_id)
    recommendation = _recommend_work_item_agent(work_item)
    encoded = urllib.parse.quote(work_item_id, safe="")
    jobs, agents = await asyncio.gather(
        _coordinator(f"/api/v1/jobs?workItemId={encoded}&limit=20"),
        _coordinator("/api/v1/agents"),
    )
    latest_job = next(iter(jobs.get("jobs", [])), None)
    if latest_job and latest_job.get("status") == "completed" and work_item.get("status") in {"progress", "review"}:
        work_item = _advance_work_item(ctx, project_id, work_item, "testing")
    return {
        "recommendation": recommendation,
        "scopePaths": _work_item_scope(work_item),
        "jobs": jobs.get("jobs", []),
        "agents": agents.get("agents", []),
        "workItem": work_item,
    }


@router.post("/coordinator/work-items/{project_id}/{work_item_id}/delegate")
async def coordinator_delegate_work_item(project_id: str, work_item_id: str, body: dict[str, Any], ctx: Auth):
    _require_authenticated_admin(ctx)
    project, work_item = _find_work_item(ctx, project_id, work_item_id)
    if work_item.get("effectiveStatus") == "blocked" or work_item.get("blockedBy"):
        raise HTTPException(status.HTTP_409_CONFLICT, "Complete blocking dependencies before delegation")
    if work_item.get("status") == "done":
        raise HTTPException(status.HTTP_409_CONFLICT, "Completed work items cannot be delegated")

    encoded = urllib.parse.quote(work_item_id, safe="")
    existing = await _coordinator(f"/api/v1/jobs?workItemId={encoded}&limit=20")
    active = next((job for job in existing.get("jobs", []) if job.get("status") in {
        "queued", "running", "review", "waiting_approval", "integrating"
    }), None)
    if active:
        raise HTTPException(status.HTTP_409_CONFLICT, "This work item already has an active agent job")

    recommendation = _recommend_work_item_agent(work_item)
    assigned_agent = str(body.get("assignedAgent") or recommendation["agent"]).lower()
    if assigned_agent not in {"codex", "claude", "local"}:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown agent")
    scope_paths = body.get("scopePaths") or _work_item_scope(work_item)
    if not isinstance(scope_paths, list) or any(not isinstance(path, str) for path in scope_paths):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "scopePaths must be an array of paths")
    delegated = await _create_work_item_job(
        ctx, project, work_item,
        assigned_agent=assigned_agent,
        max_turns=int(body.get("maxTurns", 10)),
        scope_paths=scope_paths,
    )
    return {**delegated, "recommendation": recommendation}


@router.post("/coordinator/projects/{project_id}/dispatch")
async def coordinator_dispatch_project(project_id: str, body: dict[str, Any], ctx: Auth):
    _require_authenticated_admin(ctx)
    project = ctx.store.get_project(ctx.org, project_id)
    if not project:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    requested_limit = max(1, min(int(body.get("limit", 2)), 4))
    health, all_jobs = await asyncio.gather(
        _coordinator("/health"),
        _coordinator("/api/v1/jobs?limit=500"),
    )
    scheduler_state = health.get("scheduler", {})
    capacity = max(0, int(scheduler_state.get("maxConcurrent", 2)) - int(scheduler_state.get("running", 0)))
    capacity = min(capacity, requested_limit)
    if capacity == 0:
        return {"delegated": [], "skipped": "Coordinator has no free execution slots"}
    active_jobs = [job for job in all_jobs.get("jobs", []) if job.get("status") in {
        "queued", "running", "review", "waiting_approval"
    }]
    active_work_items = {job.get("sourceWorkItemId") for job in active_jobs}
    busy_agents = {job.get("assignedAgent") for job in active_jobs if job.get("status") == "running"}
    priority_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    candidates = sorted(
        [item for item in project.get("workItems", [])
         if item.get("status") == "ready" and item.get("effectiveStatus") == "ready"
         and item.get("id") not in active_work_items and item.get("title") != "Test task"],
        key=lambda item: (priority_order.get(item.get("priority"), 9), item.get("dueDate") or "9999-12-31", item.get("title", "")),
    )
    delegated: list[dict[str, Any]] = []
    selected_agents = set(busy_agents)
    for work_item in candidates:
        recommendation = _recommend_work_item_agent(work_item)
        agent = recommendation["agent"]
        if agent in selected_agents:
            continue
        result = await _create_work_item_job(ctx, project, work_item, assigned_agent=agent)
        delegated.append({
            "workItemId": work_item["id"], "title": work_item["title"],
            "agent": agent, "reason": recommendation["reason"], "job": result["job"],
        })
        selected_agents.add(agent)
        if len(delegated) >= capacity:
            break
    return {"delegated": delegated, "capacity": capacity}


@router.get("/coordinator/jobs/{job_id}")
async def coordinator_job_details(job_id: str, ctx: Auth, after: int = 0):
    _require_authenticated_admin(ctx)
    encoded_job_id = urllib.parse.quote(job_id, safe="")
    job, logs, events, review = await asyncio.gather(
        _coordinator(f"/api/v1/jobs/{encoded_job_id}"),
        _coordinator(f"/api/v1/jobs/{encoded_job_id}/logs?after={max(0, after)}&limit=500"),
        _coordinator(f"/api/v1/events?jobId={encoded_job_id}&limit=100"),
        _coordinator(f"/api/v1/jobs/{encoded_job_id}/review"),
    )
    return {
        "job": job.get("job"),
        "logs": logs.get("logs", []),
        "events": events.get("events", []),
        "review": review.get("review", {}),
    }


@router.post("/coordinator/jobs/{job_id}/request-changes")
async def coordinator_request_job_changes(job_id: str, body: dict[str, Any], ctx: Auth):
    _require_authenticated_admin(ctx)
    result = await _coordinator(
        f"/api/v1/jobs/{job_id}/request-changes",
        method="POST",
        body={"feedback": str(body.get("feedback", ""))},
    )
    job = result.get("job", {})
    if job.get("sourceOrganizationId") == ctx.org and job.get("sourceProjectId") and job.get("sourceWorkItemId"):
        try:
            _, work_item = _find_work_item(ctx, job["sourceProjectId"], job["sourceWorkItemId"])
            _advance_work_item(ctx, job["sourceProjectId"], work_item, "progress")
        except (HTTPException, LookupError, ValueError):
            pass
    ctx.store.audit(
        ctx.org,
        ctx.user_id,
        ctx.role,
        "coordinator.job.request_changes",
        "agent_job",
        job_id,
    )
    return result


@router.post("/coordinator/jobs/{job_id}/{action}")
async def coordinator_job_action(job_id: str, action: str, ctx: Auth):
    _require_authenticated_admin(ctx)
    if action not in {"start", "retry", "cancel", "approve", "reject", "submit-review", "remove-worktree"}:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown coordinator action")
    result = await _coordinator(f"/api/v1/jobs/{job_id}/{action}", method="POST", body={})
    job = result.get("job", {})
    if job.get("sourceOrganizationId") == ctx.org and job.get("sourceProjectId") and job.get("sourceWorkItemId"):
        try:
            _, work_item = _find_work_item(ctx, job["sourceProjectId"], job["sourceWorkItemId"])
            target = {
                "start": "progress", "retry": "progress", "approve": "review",
                "submit-review": "review",
                "reject": "blocked", "cancel": "blocked",
            }.get(action)
            if target:
                _advance_work_item(ctx, job["sourceProjectId"], work_item, target)
        except (HTTPException, LookupError, ValueError):
            pass
    ctx.store.audit(
        ctx.org,
        ctx.user_id,
        ctx.role,
        f"coordinator.job.{action}",
        "agent_job",
        job_id,
    )
    return result
