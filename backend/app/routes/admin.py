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
    health, agents, worktrees, jobs, events = await asyncio.gather(
        _coordinator("/health"),
        _coordinator("/api/v1/agents"),
        _coordinator("/api/v1/worktrees"),
        _coordinator("/api/v1/jobs?limit=50"),
        _coordinator("/api/v1/events?limit=100"),
    )
    return {
        "health": health,
        "agents": agents.get("agents", []),
        "worktrees": worktrees.get("worktrees", []),
        "jobs": jobs.get("jobs", []),
        "events": events.get("events", []),
    }


@router.post("/coordinator/jobs")
async def coordinator_create_job(body: dict[str, Any], ctx: Auth):
    _require_authenticated_admin(ctx)
    payload = dict(body)
    payload["createdBy"] = ctx.user_id
    return await _coordinator("/api/v1/jobs", method="POST", body=payload)


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


@router.post("/coordinator/jobs/{job_id}/{action}")
async def coordinator_job_action(job_id: str, action: str, ctx: Auth):
    _require_authenticated_admin(ctx)
    if action not in {"start", "retry", "cancel", "approve", "reject"}:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown coordinator action")
    result = await _coordinator(f"/api/v1/jobs/{job_id}/{action}", method="POST", body={})
    ctx.store.audit(
        ctx.org,
        ctx.user_id,
        ctx.role,
        f"coordinator.job.{action}",
        "agent_job",
        job_id,
    )
    return result
