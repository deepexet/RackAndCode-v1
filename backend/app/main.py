"""
RackPilot — FastAPI application entry point.

Serves:
  - /api/v1/*  — REST API (FastAPI)
  - /          — Frontend (static files from frontend/dist, or proxy to Vite in dev)
"""
from __future__ import annotations

import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.core.config import settings
from app.core.database import run_migrations
from app.routes import api_router

log = logging.getLogger("rackpilot")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    log.info("RackPilot starting — running migrations…")
    run_migrations()
    log.info(f"Database ready: {settings.db_path}")
    yield
    # Shutdown
    log.info("RackPilot shutting down")


app = FastAPI(
    title="RackPilot API",
    description="Field Operations Platform by Valeronix",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

# ── CORS ──────────────────────────────────────────────────────────────────
# In LAN mode we allow all origins on the local network.
# Production: restrict to your actual domain.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if settings.lan_mode else [f"http://{settings.host}:{settings.port}"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── API routes ────────────────────────────────────────────────────────────
app.include_router(api_router)


# ── Additional standalone routes ──────────────────────────────────────────
# These mirror legacy top-level endpoints not under /api/v1 prefix.

from app.middleware.auth import get_store, StoreOnly
from fastapi import Depends
from typing import Any


@app.get("/api/v1/team")
async def team_top_level(store: StoreOnly):
    from app.core.config import settings
    return {"members": store.list_team_members(settings.default_org)}


@app.get("/api/v1/team/skills")
async def team_skills(store: StoreOnly):
    return {"skills": store.list_team_skills(settings.default_org)}


@app.get("/api/v1/labels")
async def list_labels(store: StoreOnly):
    return {"labels": store.list_labels(settings.default_org)}


@app.post("/api/v1/labels")
async def create_label(body: dict[str, Any], store: StoreOnly):
    l = store.create_label(settings.default_org, body)
    return {"label": l}


@app.get("/api/v1/webhooks")
async def list_webhooks(store: StoreOnly):
    return {"webhooks": store.list_webhooks(settings.default_org)}


@app.post("/api/v1/webhooks")
async def create_webhook(body: dict[str, Any], store: StoreOnly):
    w = store.create_webhook(settings.default_org, body)
    return {"webhook": w}


@app.post("/api/v1/webhooks/{webhook_id}/delete")
async def delete_webhook(webhook_id: str, store: StoreOnly):
    store.delete_webhook(settings.default_org, webhook_id)
    return {"ok": True}


@app.get("/api/v1/wi-templates")
async def list_wi_templates(store: StoreOnly):
    return {"templates": store.list_work_item_templates(settings.default_org)}


@app.post("/api/v1/wi-templates")
async def create_wi_template(body: dict[str, Any], store: StoreOnly):
    t = store.create_work_item_template(settings.default_org, body)
    return {"template": t}


@app.get("/api/v1/digest/schedules")
async def list_digest_schedules(store: StoreOnly):
    return {"schedules": store.list_digest_schedules(settings.default_org)}


@app.post("/api/v1/digest/schedules")
async def create_digest_schedule(body: dict[str, Any], store: StoreOnly):
    s = store.save_digest_schedule(settings.default_org, body)
    return {"schedule": s}


@app.post("/api/v1/digest/schedules/{schedule_id}/delete")
async def delete_digest_schedule(schedule_id: str, store: StoreOnly):
    store.delete_digest_schedule(settings.default_org, schedule_id)
    return {"ok": True}


@app.get("/api/v1/time/log")
async def list_time_log(store: StoreOnly):
    return {"entries": store.list_time_log(settings.default_org)}


@app.post("/api/v1/time/log")
async def log_time(body: dict[str, Any], store: StoreOnly):
    entry = store.log_time(settings.default_org, body)
    return {"entry": entry}


@app.get("/api/v1/knowledge/log")
async def knowledge_log(store: StoreOnly, limit: int = 50):
    return {"entries": store.list_retrieval_log(settings.default_org, limit=limit)}


@app.post("/api/v1/knowledge/rebuild")
async def knowledge_rebuild(store: StoreOnly):
    count = store.rebuild_knowledge_index(settings.default_org)
    return {"indexed": count}


@app.get("/api/v1/notifications")
async def notifications_top(store: StoreOnly, unread: bool = False):
    notifications, unread_count = store.list_notifications(settings.default_org, unread_only=unread)
    return {"notifications": notifications, "unreadCount": unread_count}


@app.post("/api/v1/notifications/read")
async def mark_read_top(body: dict[str, Any], store: StoreOnly):
    store.mark_notifications_read(settings.default_org, notif_ids=body.get("ids"))
    return {"ok": True}


@app.post("/api/v1/notifications/generate-alerts")
async def generate_alerts_top(store: StoreOnly):
    count = store.generate_inventory_alerts(settings.default_org)
    return {"generated": count}


@app.get("/api/v1/work-items/{wi_id}/dependencies")
async def wi_dependencies(wi_id: str, store: StoreOnly):
    return store.get_wi_dependencies(settings.default_org, wi_id)


@app.post("/api/v1/work-items/{wi_id}/dependencies/add")
async def wi_add_dep(wi_id: str, body: dict[str, Any], store: StoreOnly):
    store.add_wi_dependency(settings.default_org, wi_id, body["blockerId"])
    return {"ok": True}


@app.post("/api/v1/work-items/{wi_id}/dependencies/remove")
async def wi_remove_dep(wi_id: str, body: dict[str, Any], store: StoreOnly):
    store.remove_wi_dependency(settings.default_org, wi_id, body["blockerId"])
    return {"ok": True}


# ── Workspace (legacy bulk state sync) ───────────────────────────────────

@app.get("/api/v1/workspace")
async def get_workspace(request: Request, store: StoreOnly):
    from app.core.config import settings as s
    etag = store.etag(s.default_org)
    if request.headers.get("If-None-Match") == etag:
        from fastapi.responses import Response
        return Response(status_code=304)
    data = store.get(s.default_org)
    return JSONResponse({"workspace": data}, headers={"ETag": etag})


@app.post("/api/v1/workspace")
async def save_workspace(body: dict[str, Any], store: StoreOnly):
    from app.core.config import settings as s
    result = store.save(s.default_org, body.get("workspace", {}), body.get("version"), actor=None)
    return result


# ── Frontend (SPA) ────────────────────────────────────────────────────────

_static_dir = settings.static_dir

if _static_dir.exists():
    # Production: serve built frontend
    app.mount("/assets", StaticFiles(directory=_static_dir / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        index = _static_dir / "index.html"
        if index.exists():
            return FileResponse(index)
        return JSONResponse({"error": "Frontend not built. Run: cd frontend && npm run build"}, status_code=404)

else:
    # Dev: redirect to Vite dev server info
    @app.get("/", include_in_schema=False)
    async def dev_root():
        return JSONResponse({
            "message": "RackPilot API running. Frontend dev server: http://localhost:5173",
            "api_docs": "/api/docs",
        })


# ── Error handlers ────────────────────────────────────────────────────────

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    log.exception(f"Unhandled error: {request.method} {request.url}")
    return JSONResponse(
        status_code=500,
        content={"error": {"message": "Internal server error", "type": type(exc).__name__}},
    )
