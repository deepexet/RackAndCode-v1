"""FastAPI surface for RackPilot Agent Coordinator."""

from __future__ import annotations

import os
import subprocess
import threading
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query, status
from pydantic import BaseModel, Field

from .core import (
    AGENTS,
    CoordinatorStore,
    JobCreate,
    build_agent_command,
    discover_worktrees,
    probe_agent,
    probes_as_dict,
    validate_worktree,
)


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.getenv("RACKPILOT_COORDINATOR_DB", ROOT / "data" / "coordinator.db"))
REPO_ROOT = Path(os.getenv("RACKPILOT_REPO_ROOT", ROOT)).resolve()
CONTROL_TOKEN = os.getenv("RACKPILOT_COORDINATOR_TOKEN", "")
EXECUTION_ENABLED = os.getenv("RACKPILOT_COORDINATOR_EXECUTION", "false").lower() == "true"

store = CoordinatorStore(DB_PATH)
processes: dict[str, subprocess.Popen[str]] = {}
process_lock = threading.RLock()

app = FastAPI(
    title="RackPilot Agent Coordinator",
    version="0.1.0",
    docs_url="/docs",
    redoc_url=None,
)


class JobRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    instructions: str = Field(min_length=1, max_length=50000)
    assignedAgent: str
    worktreePath: str
    branchName: str
    createdBy: str = "owner"
    requiresReview: bool = True
    maxTurns: int = Field(default=8, ge=1, le=20)


def require_control_token(x_coordinator_token: str | None) -> None:
    if not CONTROL_TOKEN:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Coordinator control token is not configured")
    if x_coordinator_token != CONTROL_TOKEN:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid coordinator control token")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "rackpilot-agent-coordinator",
        "version": app.version,
        "executionEnabled": EXECUTION_ENABLED,
        "controlConfigured": bool(CONTROL_TOKEN),
    }


@app.get("/api/v1/agents")
async def agents() -> dict[str, Any]:
    return {"agents": probes_as_dict(probe_agent(agent) for agent in sorted(AGENTS))}


@app.get("/api/v1/worktrees")
async def worktrees() -> dict[str, Any]:
    return {"worktrees": discover_worktrees(REPO_ROOT)}


@app.get("/api/v1/jobs")
async def jobs(status_filter: str | None = Query(default=None, alias="status"), limit: int = 100):
    try:
        return {"jobs": store.list_jobs(status_filter, limit)}
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc


@app.get("/api/v1/jobs/{job_id}")
async def job(job_id: str):
    try:
        return {"job": store.get_job(job_id)}
    except KeyError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found") from exc


@app.post("/api/v1/jobs", status_code=status.HTTP_201_CREATED)
async def create_job(body: JobRequest, x_coordinator_token: str | None = Header(default=None)):
    require_control_token(x_coordinator_token)
    try:
        validate_worktree(REPO_ROOT, body.worktreePath, body.branchName)
        created = store.create_job(
            JobCreate(
                title=body.title,
                instructions=body.instructions,
                assigned_agent=body.assignedAgent,
                worktree_path=body.worktreePath,
                branch_name=body.branchName,
                created_by=body.createdBy,
                requires_review=body.requiresReview,
                max_turns=body.maxTurns,
            )
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return {"job": created}


def _run_job(job_id: str) -> None:
    job = store.get_job(job_id)
    probe = probe_agent(job["assignedAgent"])
    if not probe.available or not probe.executable:
        store.transition_job(job_id, "failed", error=probe.error or "Agent unavailable")
        return
    command = build_agent_command(job, probe.executable)
    try:
        process = subprocess.Popen(
            command,
            cwd=job["worktreePath"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            shell=False,
        )
        with process_lock:
            processes[job_id] = process
        stdout, stderr = process.communicate()
    except OSError as exc:
        store.transition_job(job_id, "failed", error=str(exc))
        return
    finally:
        with process_lock:
            processes.pop(job_id, None)
    latest = store.get_job(job_id)
    if latest["status"] == "cancelled":
        return
    combined = (stdout or "")[-65536:]
    error_text = (stderr or "")[-8192:]
    lowered = f"{combined}\n{error_text}".lower()
    if "rate limit" in lowered or "rate_limit" in lowered:
        store.transition_job(job_id, "rate_limited", exit_code=process.returncode, result_summary=combined, error=error_text)
    elif process.returncode != 0:
        store.transition_job(job_id, "failed", exit_code=process.returncode, result_summary=combined, error=error_text)
    elif job["requiresReview"]:
        store.transition_job(job_id, "review", exit_code=0, result_summary=combined)
    else:
        store.transition_job(job_id, "completed", exit_code=0, result_summary=combined)


@app.post("/api/v1/jobs/{job_id}/start", status_code=status.HTTP_202_ACCEPTED)
async def start_job(job_id: str, x_coordinator_token: str | None = Header(default=None)):
    require_control_token(x_coordinator_token)
    if not EXECUTION_ENABLED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Agent execution is disabled")
    try:
        job = store.get_job(job_id)
        validate_worktree(REPO_ROOT, job["worktreePath"], job["branchName"])
        if job["status"] != "queued":
            raise ValueError("Only queued jobs can start")
        store.transition_job(job_id, "running")
    except KeyError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found") from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    threading.Thread(target=_run_job, args=(job_id,), daemon=True, name=f"agent-{job_id[:8]}").start()
    return {"job": store.get_job(job_id)}


@app.post("/api/v1/jobs/{job_id}/retry", status_code=status.HTTP_202_ACCEPTED)
async def retry_job(job_id: str, x_coordinator_token: str | None = Header(default=None)):
    require_control_token(x_coordinator_token)
    if not EXECUTION_ENABLED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Agent execution is disabled")
    try:
        job = store.get_job(job_id)
        validate_worktree(REPO_ROOT, job["worktreePath"], job["branchName"])
        if job["status"] not in {"failed", "cancelled", "rate_limited"}:
            raise ValueError("Only a failed, cancelled or rate-limited job can be retried")
        store.transition_job(job_id, "queued", actor="owner")
        store.transition_job(job_id, "running", actor="owner")
    except KeyError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found") from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    threading.Thread(target=_run_job, args=(job_id,), daemon=True, name=f"agent-{job_id[:8]}").start()
    return {"job": store.get_job(job_id)}


@app.post("/api/v1/jobs/{job_id}/cancel")
async def cancel_job(job_id: str, x_coordinator_token: str | None = Header(default=None)):
    require_control_token(x_coordinator_token)
    try:
        job = store.get_job(job_id)
    except KeyError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found") from exc
    if job["status"] not in {"queued", "running", "review", "waiting_approval"}:
        raise HTTPException(status.HTTP_409_CONFLICT, "Job cannot be cancelled")
    with process_lock:
        process = processes.get(job_id)
        if process and process.poll() is None:
            process.terminate()
    return {"job": store.transition_job(job_id, "cancelled", actor="owner")}


@app.post("/api/v1/jobs/{job_id}/approve")
async def approve_job(job_id: str, x_coordinator_token: str | None = Header(default=None)):
    require_control_token(x_coordinator_token)
    try:
        job = store.get_job(job_id)
        if job["status"] not in {"review", "waiting_approval"}:
            raise ValueError("Only a reviewed job can be approved")
        return {"job": store.transition_job(job_id, "completed", actor="owner")}
    except KeyError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found") from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc


@app.post("/api/v1/jobs/{job_id}/reject")
async def reject_job(job_id: str, x_coordinator_token: str | None = Header(default=None)):
    require_control_token(x_coordinator_token)
    try:
        job = store.get_job(job_id)
        if job["status"] not in {"review", "waiting_approval"}:
            raise ValueError("Only a reviewed job can be rejected")
        return {
            "job": store.transition_job(
                job_id,
                "failed",
                actor="owner",
                error="Rejected during owner approval",
            )
        }
    except KeyError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found") from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc


@app.get("/api/v1/events")
async def events(job_id: str | None = Query(default=None, alias="jobId"), limit: int = 200):
    return {"events": store.list_events(job_id, limit)}
