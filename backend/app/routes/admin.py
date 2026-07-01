from __future__ import annotations

import asyncio
import json
import re
import urllib.error
import urllib.parse
import urllib.request

from fastapi import APIRouter, HTTPException, status
from typing import Any

from app.core.config import settings
from app.middleware.auth import Auth

router = APIRouter()
_proposal_queue_lock = asyncio.Lock()


def _require_authenticated_admin(ctx: Auth) -> None:
    if not ctx.user_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Authenticated session required")
    if ctx.role != "Administrator":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Administrator role required")


def _coordinator_request(
    path: str, *, method: str = "GET", body: dict[str, Any] | None = None,
    timeout_seconds: float | None = None,
) -> Any:
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
        with urllib.request.urlopen(
            request, timeout=timeout_seconds or settings.coordinator_timeout_seconds
        ) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8")).get("detail", "Coordinator request failed")
        except (ValueError, AttributeError):
            detail = "Coordinator request failed"
        raise HTTPException(exc.code, detail) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Coordinator is unavailable") from exc


async def _coordinator(
    path: str, *, method: str = "GET", body: dict[str, Any] | None = None,
    timeout_seconds: float | None = None,
) -> Any:
    return await asyncio.to_thread(
        _coordinator_request, path, method=method, body=body, timeout_seconds=timeout_seconds
    )


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
        "inspect", "check status", "verify status", "monitor", "analyse", "analyze",
        "классифиц", "суммар", "извлеч", "размет", "провер", "статус", "монитор", "проанализ",
    }
    mutation_terms = {
        "implement", "fix", "add", "create", "update", "remove", "migrate",
        "реализ", "исправ", "добав", "созда", "обнов", "удал", "перенест",
    }
    if any(term in text for term in architecture_terms):
        return {"agent": "claude", "reason": "Architecture or system-contract work is assigned to Claude Architecture Lead."}
    if any(term in text for term in local_terms) and not any(term in text for term in mutation_terms):
        return {"agent": "local", "reason": "This is a bounded text-analysis task suitable for the local model."}
    return {"agent": "codex", "reason": "Implementation, integration and verification are assigned to Codex."}


def _work_item_scope(work_item: dict[str, Any]) -> list[str]:
    text = " ".join([
        str(work_item.get("title", "")), str(work_item.get("description", "")),
        " ".join(str(value) for value in work_item.get("labels", [])),
    ]).lower()
    scopes: list[str] = []
    mappings = (
        (("coordinator", "agent", "координатор", "агент", "очеред"),
         ("coordinator", "backend/app/routes/admin.py", "frontend/src/modules/admin.js")),
        (("wiki", "knowledge", "vault"), ("backend/app/routes/wiki.py", "frontend/src/modules/wiki.js", "server/migrations")),
        (("diagram", "схем"), ("frontend/src/modules/diagrams.js", "backend/app/routes", "server/migrations")),
        (("inventory", "склад"), ("backend/app/routes/inventory.py", "frontend/src/modules/inventory.js", "server/app.py")),
        (("work order", "наряд"), ("backend/app/routes/work_orders.py", "frontend/src/modules/work_orders.js", "server/app.py")),
        (("project", "kanban", "work item"), ("backend/app/routes/projects.py", "frontend/src/modules/projects.js", "server/app.py")),
        (("frontend", "mobile", "ui", "style", "интерфейс", "стил"), ("frontend",)),
        (("monitor", "монитор", "статистик"),
         ("frontend/src/modules/api_metrics.js", "frontend/src/styles/main.css", "backend/app/routes/admin.py")),
        (("fastapi", "backend", "api", "route"), ("backend", "server/app.py")),
        (("test", "quality"), ("tests",)),
        (("doc", "adr", "architecture"), ("docs",)),
    )
    for terms, paths in mappings:
        if any(term in text for term in terms):
            scopes.extend(paths)
    if scopes:
        scopes.append("tests")
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
            "temperatureC": round(_find("Temperature") / 100, 1) if _find("Temperature") is not None else None,
            "virtualTemperatureC": round(_find("VirtualTemperature") / 100, 1) if _find("VirtualTemperature") is not None else None,
        }
    except Exception:
        return {}


def _get_thermal_state() -> str:
    import subprocess
    try:
        output = subprocess.check_output(["pmset", "-g", "therm"], text=True, timeout=2).lower()
        if "critical" in output or "danger" in output:
            return "critical"
        if "warning level" in output and "no thermal warning" not in output:
            return "warning"
        return "normal"
    except Exception:
        return "unknown"


def _collect_system_stats() -> dict[str, Any]:
    import time, platform
    import psutil

    cpu = psutil.cpu_percent(interval=0.25)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    bat = psutil.sensors_battery()
    uptime_s = int(time.time() - psutil.boot_time())
    battery: dict[str, Any] = {}
    if bat is not None:
        battery = {
            "percent": round(bat.percent, 1), "plugged": bat.power_plugged,
            "secsleft": bat.secsleft if bat.secsleft != psutil.POWER_TIME_UNLIMITED else -1,
        }
        battery.update(_get_battery_ioreg())
    temperature = battery.get("virtualTemperatureC") or battery.get("temperatureC")
    return {
        "cpu": {"percent": round(cpu, 1), "count": psutil.cpu_count()},
        "memory": {"percent": round(mem.percent, 1), "usedBytes": mem.used, "totalBytes": mem.total},
        "disk": {"percent": round(disk.percent, 1), "usedBytes": disk.used, "totalBytes": disk.total},
        "battery": battery,
        "temperature": {
            "celsius": temperature, "sensor": "virtual/battery" if temperature is not None else "unavailable",
            "thermalState": _get_thermal_state(),
        },
        "uptimeSeconds": uptime_s, "platform": platform.system(), "hostname": platform.node(),
    }


@router.get("/system-stats")
async def system_stats(ctx: Auth):
    snapshot = await asyncio.to_thread(_collect_system_stats)
    temp = snapshot.get("temperature", {})
    ctx.store.record_system_metric_sample(ctx.org, {
        "cpuPercent": snapshot["cpu"]["percent"], "memoryPercent": snapshot["memory"]["percent"],
        "temperatureC": temp.get("celsius"), "thermalState": temp.get("thermalState", "unknown"),
    })
    return snapshot


@router.get("/system-stats/history")
async def system_stats_history(ctx: Auth, hours: int = 6):
    _require_authenticated_admin(ctx)
    return {"hours": max(1, min(hours, 24)), "samples": ctx.store.list_system_metric_samples(ctx.org, hours)}


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


def _chat_agent_result(job: dict[str, Any]) -> str:
    if job.get("status") != "completed":
        return f"{job.get('assignedAgent', 'Agent')} could not complete the request: {job.get('error') or job.get('status')}"
    for line in reversed(str(job.get("resultSummary", "")).splitlines()):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        item = entry.get("item", {})
        if item.get("type") == "agent_message" and item.get("text"):
            return str(item["text"])
        if entry.get("type") == "result" and entry.get("result"):
            return str(entry["result"])
    return f"{job.get('assignedAgent', 'Agent')} completed the request without a textual response."


async def _sync_chat_agent_results(ctx: Any) -> None:
    jobs = (await _coordinator("/api/v1/jobs?limit=500")).get("jobs", [])
    prefix = f"chat:{ctx.org}:{ctx.user_id}:"
    for job in reversed(jobs):
        if not str(job.get("createdBy", "")).startswith(prefix):
            continue
        if job.get("status") not in {"completed", "failed", "cancelled"}:
            continue
        if ctx.store.has_coordinator_chat_agent_result(ctx.org, ctx.user_id, job["id"]):
            continue
        ctx.store.append_coordinator_chat_message(
            ctx.org, ctx.user_id, "assistant",
            f"{job.get('assignedAgent', 'Agent').capitalize()} response:\n{_chat_agent_result(job)}",
            agent_job_id=job["id"],
        )


async def _recover_failed_agent_jobs(
    ctx: Any, limit: int = 2, agent_filter: str | None = None,
    allow_busy_queue: bool = False,
) -> list[dict[str, Any]]:
    jobs = (await _coordinator("/api/v1/jobs?limit=500")).get("jobs", [])
    active_states = {"queued", "running", "review", "waiting_approval", "integrating"}
    busy_agents = {job.get("assignedAgent") for job in jobs if job.get("status") in active_states}
    active_items = {job.get("sourceWorkItemId") for job in jobs if job.get("status") in active_states}
    latest_by_item: dict[str, dict[str, Any]] = {}
    for job in jobs:  # newest first
        item_id = str(job.get("sourceWorkItemId") or "")
        if item_id and item_id not in latest_by_item:
            latest_by_item[item_id] = job
    recovered: list[dict[str, Any]] = []
    for job in latest_by_item.values():
        agent = job.get("assignedAgent")
        if agent_filter and agent != agent_filter:
            continue
        if (job.get("status") != "failed"
                or (agent in busy_agents and not allow_busy_queue)
                or job.get("sourceWorkItemId") in active_items):
            continue
        error = str(job.get("integrationError") or job.get("error") or "").lower()
        try:
            if "outside declared scope" in error or job.get("integrationError"):
                result = await _coordinator(f"/api/v1/jobs/{job['id']}/repair", method="POST", body={})
                mode = "repair"
            elif "maximum number of turns" in error or "max_turns" in error:
                if int(job.get("maxTurns") or 0) < 20:
                    result = await _coordinator(f"/api/v1/jobs/{job['id']}/retry", method="POST", body={})
                    mode = "continue"
                else:
                    review = await _coordinator(f"/api/v1/jobs/{job['id']}/review")
                    if not review.get("review", {}).get("dirty"):
                        continue
                    result = await _coordinator(f"/api/v1/jobs/{job['id']}/submit-review", method="POST", body={})
                    mode = "review-preserved-work"
            else:
                result = await _coordinator(f"/api/v1/jobs/{job['id']}/repair", method="POST", body={})
                mode = "repair"
        except HTTPException:
            continue
        recovered.append({"job": result.get("job", {}), "mode": mode, "title": job.get("title")})
        busy_agents.add(agent)
        if len(recovered) >= max(1, min(limit, 4)):
            break
    return recovered


def _natural_delegation(message: str, history: list[dict[str, Any]]) -> tuple[str, str] | None:
    lowered = message.lower()
    action_terms = (
        "делегиру", "передай", "поставь", "запусти", "начни", "начина", "пусть", "выполни",
        "delegate", "queue", "start", "execute", "assign",
    )
    if not any(term in lowered for term in action_terms):
        return None
    agent = "codex" if "codex" in lowered else "claude" if "claude" in lowered else ""
    if not agent:
        for row in reversed(history[-8:]):
            if row.get("role") != "user":
                continue
            prior = str(row.get("content", "")).lower()
            if "codex" in prior:
                agent = "codex"
                break
            if "claude" in prior:
                agent = "claude"
                break
    return (agent, message) if agent else None


def _extract_task_proposals(answer: str, user_message: str) -> list[dict[str, Any]]:
    lowered = answer.lower()
    if not any(term in lowered for term in ("next action", "следующ", "задач", "действ", "рекоменду")):
        return []
    numbered: list[str] = []
    bullets: list[str] = []
    for raw_line in answer.splitlines():
        line = raw_line.strip()
        match = re.match(r"^(?:#{1,4}\s*)?(\d+[.)]\s*|[-*]\s+)(.+)$", line)
        if not match:
            continue
        title = re.sub(r"[*_`#]", "", match.group(2)).strip().rstrip(":")
        title = re.sub(r"^(?:цель|действие|action|goal)\s*:\s*", "", title, flags=re.I)
        target = numbered if match.group(1)[0].isdigit() else bullets
        if 5 <= len(title) <= 180 and title.lower() not in {value.lower() for value in target}:
            target.append(title)
    # Numbered items are top-level tasks in the coordinator's response. Bullets
    # are usually goal/action details and must not become duplicate agent jobs.
    titles = (numbered or bullets)[:8]
    proposals: list[dict[str, Any]] = []
    for title in titles:
        recommendation = _recommend_work_item_agent({
            "title": title, "description": f"{user_message}\n{title}", "labels": [],
        })
        is_local = recommendation["agent"] == "local"
        proposals.append({
            "title": title,
            "instructions": (
                f"{'Inspect and report on' if is_local else 'Implement'} the approved Coordinator Chat proposal: {title}\n\n"
                f"OWNER CONTEXT:\n{user_message}\n\nRun focused verification and stop for review."
            ),
            "assignedAgent": recommendation["agent"],
            "scopePaths": _work_item_scope({"title": title, "description": user_message, "labels": []}),
        })
    return proposals


async def _queue_chat_proposal(ctx: Any, proposal: dict[str, Any]) -> dict[str, Any]:
    if proposal.get("status") != "proposed":
        raise HTTPException(status.HTTP_409_CONFLICT, "Proposal is already queued")
    agent = proposal["assignedAgent"]
    created = await _coordinator("/api/v1/jobs", method="POST", body={
        "title": f"Chat proposal: {proposal['title'][:120]}",
        "instructions": proposal["instructions"], "assignedAgent": agent,
        "autoWorktree": agent != "local", "baseRef": settings.coordinator_base_ref,
        "scopePaths": proposal.get("scopePaths", []), "requiresReview": agent != "local",
        "maxTurns": 1 if agent == "local" else 14,
        "createdBy": f"chat-proposal:{ctx.org}:{ctx.user_id}:{proposal['id']}",
    })
    job = created.get("job", {})
    updated = ctx.store.queue_coordinator_chat_proposal(ctx.org, ctx.user_id, proposal["id"], job["id"])
    return {"proposal": updated, "job": job}


@router.get("/coordinator/chat")
async def coordinator_chat_history(ctx: Auth, limit: int = 100):
    _require_authenticated_admin(ctx)
    await _sync_chat_agent_results(ctx)
    return {
        "messages": ctx.store.list_coordinator_chat_messages(ctx.org, ctx.user_id, limit),
        "proposals": ctx.store.list_coordinator_chat_proposals(ctx.org, ctx.user_id),
    }


@router.post("/coordinator/chat/proposals/{proposal_id}/queue")
async def queue_coordinator_chat_proposal(proposal_id: str, ctx: Auth):
    _require_authenticated_admin(ctx)
    async with _proposal_queue_lock:
        proposal = next((row for row in ctx.store.list_coordinator_chat_proposals(ctx.org, ctx.user_id)
                         if row["id"] == proposal_id), None)
        if not proposal:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Proposal not found")
        result = await _queue_chat_proposal(ctx, proposal)
    ctx.store.audit(ctx.org, ctx.user_id, ctx.role, "coordinator.chat.proposal.queue", "chat_proposal", proposal_id)
    return result


@router.post("/coordinator/chat/proposals/queue-all")
async def queue_all_coordinator_chat_proposals(body: dict[str, Any], ctx: Auth):
    _require_authenticated_admin(ctx)
    message_id = str(body.get("messageId", ""))
    queued: list[dict[str, Any]] = []
    async with _proposal_queue_lock:
        proposals = [row for row in ctx.store.list_coordinator_chat_proposals(ctx.org, ctx.user_id)
                     if row["messageId"] == message_id and row["status"] == "proposed"]
        for proposal in proposals[:10]:
            try:
                queued.append(await _queue_chat_proposal(ctx, proposal))
            except HTTPException:
                continue
    ctx.store.audit(ctx.org, ctx.user_id, ctx.role, "coordinator.chat.proposal.queue_all", "chat_message", message_id)
    return {"queued": queued}


@router.post("/coordinator/chat")
async def coordinator_chat(body: dict[str, Any], ctx: Auth):
    """Chat with local Coordinator Assistant; mutations require explicit slash commands."""
    _require_authenticated_admin(ctx)
    message = str(body.get("message", "")).strip()
    if not message or len(message) > 4000:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Message must contain 1-4000 characters")
    prior_history = ctx.store.list_coordinator_chat_messages(ctx.org, ctx.user_id, 20)
    user_message = ctx.store.append_coordinator_chat_message(ctx.org, ctx.user_id, "user", message)
    command = message.split()
    natural_delegation = _natural_delegation(message, prior_history) if not message.startswith("/") else None
    answer: str | None = None
    action: dict[str, Any] | None = None
    if natural_delegation:
        agent, request_text = natural_delegation
        lowered = request_text.lower()
        if "scope" in lowered or "наруш" in lowered or "вне области" in lowered:
            recovered = await _recover_failed_agent_jobs(
                ctx, limit=4, agent_filter=agent, allow_busy_queue=True
            )
            action = {"recovered": recovered, "agent": agent}
            answer = (f"Started real recovery for {len(recovered)} failed {agent.capitalize()} job(s): "
                      + "; ".join(row["title"] for row in recovered)) if recovered else (
                f"No failed {agent.capitalize()} job is currently safe to recover. No task was queued."
            )
        else:
            scope_paths = _work_item_scope({"title": request_text, "description": request_text, "labels": []})
            created = await _coordinator("/api/v1/jobs", method="POST", body={
                "title": f"Owner request for {agent}: {request_text[:100]}",
                "instructions": (
                    f"Act as RackPilot {'Engineering & Integration Lead' if agent == 'codex' else 'Architecture Lead'}. "
                    "Execute the owner's request in the isolated worktree. Make only necessary scoped changes, "
                    "run focused tests, document exact results, and stop for integration review.\n\n"
                    f"OWNER REQUEST:\n{request_text}"
                ),
                "assignedAgent": agent, "autoWorktree": True, "baseRef": settings.coordinator_base_ref,
                "scopePaths": scope_paths, "requiresReview": True, "maxTurns": 14,
                "createdBy": f"chat:{ctx.org}:{ctx.user_id}:{user_message['id']}",
            })
            job = created.get("job", {})
            action = {"job": job, "agent": agent}
            answer = (f"Task was actually queued for {agent.capitalize()}. Job ID: {job.get('id')}. "
                      f"Current status: {job.get('status')}. It will wait safely if the agent is busy.")
    elif command and command[0].lower() == "/retry" and len(command) == 2:
        action = await _coordinator(f"/api/v1/jobs/{urllib.parse.quote(command[1], safe='')}/retry", method="POST", body={})
        answer = f"Job {command[1]} was queued for retry."
    elif command and command[0].lower() == "/priority" and len(command) == 3:
        item_id, priority = command[1], command[2].lower()
        if priority not in {"critical", "high", "medium", "low"}:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Priority must be critical, high, medium or low")
        found = None
        for project in ctx.store.list_projects(ctx.org):
            item = next((row for row in project.get("workItems", []) if row["id"] == item_id), None)
            if item:
                found = ctx.store.update_work_item(ctx.org, project["id"], item_id, {
                    "expectedVersion": item["version"], "priority": priority,
                })
                break
        if not found:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Work item not found")
        action = {"workItem": found}
        answer = f"Priority for {found['title']} changed to {priority}."
    elif command and command[0].lower() == "/stop":
        action = await _coordinator("/api/v1/autonomous-shift/stop", method="POST", body={})
        answer = "Autonomous shift stopped. Running work will finish safely."
    elif command and command[0].lower() == "/start":
        hours = int(command[1]) if len(command) == 2 and command[1].isdigit() else 10
        action = await coordinator_start_autonomous_shift(
            {"durationHours": max(1, min(hours, 24)), "maxTasks": 8, "retryMinutes": 60}, ctx
        )
        answer = f"Autonomous shift started for {max(1, min(hours, 24))} hours."
    elif command and command[0].lower() == "/recover":
        recovered = await _recover_failed_agent_jobs(ctx, limit=2)
        action = {"recovered": recovered}
        answer = (f"Recovery started for {len(recovered)} failed job(s)."
                  if recovered else "No safely recoverable failed jobs are currently available.")
    elif command and command[0].lower() in {"/codex", "/claude"}:
        agent = command[0].lower().removeprefix("/")
        request_text = message[len(command[0]):].strip()
        if not request_text:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Use /{agent} followed by a question or task")
        created = await _coordinator("/api/v1/jobs", method="POST", body={
            "title": f"Chat request for {agent}: {request_text[:100]}",
            "instructions": (
                "Answer the owner's request as an advisory task. You may inspect the repository when useful, "
                "but do not edit files, create commits, or perform external actions. Return a concise, concrete "
                f"answer for the shared Coordinator Chat.\n\nOWNER REQUEST:\n{request_text}"
            ),
            "assignedAgent": agent, "autoWorktree": True, "baseRef": settings.coordinator_base_ref,
            "scopePaths": ["docs"], "requiresReview": False, "maxTurns": 8,
            "createdBy": f"chat:{ctx.org}:{ctx.user_id}:{user_message['id']}",
        })
        job = created.get("job", {})
        action = {"job": job}
        answer = f"Request sent to {agent.capitalize()} as job {job.get('id')}. The response will appear in this chat automatically."
    else:
        history = ctx.store.list_coordinator_chat_messages(ctx.org, ctx.user_id, 20)
        local_message = message[len("/local"):].strip() if command and command[0].lower() == "/local" else message
        if not local_message:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Use /local followed by a question or simple task")
        machine = await asyncio.to_thread(_collect_system_stats)
        result = await _coordinator(
            "/api/v1/chat", method="POST",
            body={"message": local_message, "history": history, "machineContext": machine},
            timeout_seconds=150,
        )
        answer = result.get("answer", "Coordinator Assistant did not return an answer.")
        action = {"context": result.get("context", {})}
        false_action_claims = (
            "добавлены в очередь", "задача добавлена", "задачи добавлены", "делегировано", "запущено выполнение",
            "queued the task", "tasks were queued", "delegated successfully",
        )
        if any(claim in answer.lower() for claim in false_action_claims):
            answer = (
                "Никаких действий не было выполнено: локальная модель подготовила только рекомендацию. "
                "Для реального запуска напишите «делегируй Codex/Claude и начни» либо используйте кнопку действия.\n\n"
                + answer
            )
    ctx.store.audit(ctx.org, ctx.user_id, ctx.role, "coordinator.chat", "agent_coordinator", "current")
    assistant_message = ctx.store.append_coordinator_chat_message(ctx.org, ctx.user_id, "assistant", answer)
    proposals = []
    if not action or set(action) == {"context"}:
        extracted = _extract_task_proposals(answer, message)
        if extracted:
            proposals = ctx.store.create_coordinator_chat_proposals(
                ctx.org, ctx.user_id, assistant_message["id"], extracted
            )
    suggested_actions = []
    if not message.startswith("/"):
        context = (action or {}).get("context", {})
        shift_enabled = bool(context.get("shift", {}).get("enabled"))
        failed_count = int(context.get("report", {}).get("counts", {}).get("failed", 0))
        if not shift_enabled:
            suggested_actions.append({"label": "Start 10h shift", "command": "/start 10"})
        if failed_count:
            suggested_actions.append({"label": f"Recover failed jobs ({failed_count})", "command": "/recover"})
        suggested_actions.append({"label": "Refresh status", "command": "/status"})
    return {
        "answer": answer, "action": action, "suggestedActions": suggested_actions,
        "messageId": assistant_message["id"], "proposals": proposals,
    }


async def autonomous_maintenance_cycle(ctx: Any) -> dict[str, Any]:
    """Keep useful agent capacity occupied without bypassing dependencies or scope locks."""
    autonomous, jobs_payload = await asyncio.gather(
        _coordinator("/api/v1/autonomous-shift"), _coordinator("/api/v1/jobs?limit=500")
    )
    if not autonomous.get("shift", {}).get("enabled"):
        return {"active": False, "created": []}
    recovered = await _recover_failed_agent_jobs(ctx, limit=2)
    if recovered:
        jobs = (await _coordinator("/api/v1/jobs?limit=500")).get("jobs", [])
    else:
        jobs = jobs_payload.get("jobs", [])
    active_states = {"queued", "running", "review", "waiting_approval", "integrating"}
    active = [job for job in jobs if job.get("status") in active_states]
    busy_agents = {job.get("assignedAgent") for job in active}
    active_items = {job.get("sourceWorkItemId") for job in active if job.get("sourceWorkItemId")}
    created: list[dict[str, Any]] = []

    # Claude takes over a Codex worktree when Codex cannot proceed because of a subscription limit.
    if "claude" not in busy_agents:
        limited = next((job for job in jobs if job.get("assignedAgent") == "codex"
                        and job.get("status") == "rate_limited"
                        and job.get("sourceWorkItemId") not in active_items), None)
        if limited:
            payload = {
                "title": f"Claude assist: {limited['title']}",
                "instructions": (
                    "Codex reached its subscription limit. Continue the same scoped task from the existing "
                    "worktree. Inspect preserved work, finish only the assigned task, run focused tests, and stop "
                    "for integration review. Do not expand scope.\n\n" + limited.get("instructions", "")
                ),
                "assignedAgent": "claude", "autoWorktree": False,
                "worktreePath": limited["worktreePath"], "branchName": limited["branchName"],
                "scopePaths": limited.get("scopePaths", []), "requiresReview": True, "maxTurns": 14,
                "createdBy": "autonomous-utilization", "sourceOrganizationId": limited.get("sourceOrganizationId", ""),
                "sourceProjectId": limited.get("sourceProjectId", ""), "sourceWorkItemId": limited.get("sourceWorkItemId", ""),
            }
            try:
                result = await _coordinator("/api/v1/jobs", method="POST", body=payload)
                await _coordinator(f"/api/v1/jobs/{limited['id']}/cancel", method="POST", body={})
                created.append(result.get("job", {}))
                busy_agents.add("claude")
                active_items.add(limited.get("sourceWorkItemId"))
            except HTTPException:
                pass

    priority = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    candidates: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for project in ctx.store.list_projects(ctx.org):
        if project.get("status") not in {"active", "planned"}:
            continue
        for item in project.get("workItems", []):
            if (item.get("status") == "ready" and item.get("effectiveStatus") == "ready"
                    and item.get("id") not in active_items and item.get("title") != "Test task"):
                candidates.append((project, item))
    candidates.sort(key=lambda pair: (priority.get(pair[1].get("priority"), 9), pair[1].get("dueDate") or "9999-12-31"))
    for project, item in candidates:
        recommendation = _recommend_work_item_agent(item)
        agent = recommendation["agent"]
        if agent in busy_agents:
            if agent == "codex" and "claude" not in busy_agents:
                agent = "claude"
            else:
                continue
        try:
            result = await _create_work_item_job(ctx, project, item, assigned_agent=agent)
        except (HTTPException, ValueError, LookupError):
            continue
        created.append(result.get("job", {}))
        busy_agents.add(agent)
        active_items.add(item["id"])
        if {"codex", "claude", "local"}.issubset(busy_agents):
            break

    return {"active": True, "created": created, "recovered": recovered}


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
