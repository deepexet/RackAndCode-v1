from __future__ import annotations

from fastapi import APIRouter, HTTPException
from typing import Any

from app.middleware.auth import Auth

router = APIRouter()


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
