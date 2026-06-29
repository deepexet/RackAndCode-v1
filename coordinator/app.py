"""FastAPI surface for RackPilot Agent Coordinator."""

from __future__ import annotations

import os
import json
import signal
import subprocess
import threading
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query, status
from pydantic import BaseModel, Field

from .core import (
    AGENTS,
    CoordinatorStore,
    JobCreate,
    build_agent_command,
    create_managed_worktree,
    discover_worktrees,
    probe_agent,
    probes_as_dict,
    inspect_worktree,
    remove_managed_worktree,
    validate_worktree,
)
from .scheduler import CoordinatorScheduler


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.getenv("RACKPILOT_COORDINATOR_DB", ROOT / "data" / "coordinator.db"))
REPO_ROOT = Path(os.getenv("RACKPILOT_REPO_ROOT", ROOT)).resolve()
CONTROL_TOKEN = os.getenv("RACKPILOT_COORDINATOR_TOKEN", "")
EXECUTION_ENABLED = os.getenv("RACKPILOT_COORDINATOR_EXECUTION", "false").lower() == "true"
SCHEDULER_ENABLED = EXECUTION_ENABLED and os.getenv("RACKPILOT_COORDINATOR_SCHEDULER", "true").lower() == "true"
MAX_CONCURRENT = int(os.getenv("RACKPILOT_COORDINATOR_MAX_CONCURRENT", "2"))
MAX_PER_AGENT = int(os.getenv("RACKPILOT_COORDINATOR_MAX_PER_AGENT", "1"))
WORKTREE_ROOT = Path(
    os.getenv("RACKPILOT_WORKTREE_ROOT", REPO_ROOT.parent / f"{REPO_ROOT.name}-agent-worktrees")
).resolve()

store = CoordinatorStore(DB_PATH)
processes: dict[str, subprocess.Popen[str]] = {}
process_lock = threading.RLock()


@asynccontextmanager
async def lifespan(_: FastAPI):
    store.recover_interrupted_jobs()
    scheduler.start()
    try:
        yield
    finally:
        scheduler.stop()


app = FastAPI(
    title="RackPilot Agent Coordinator",
    version="1.0.0",
    docs_url="/docs",
    redoc_url=None,
    lifespan=lifespan,
)


class JobRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    instructions: str = Field(min_length=1, max_length=50000)
    assignedAgent: str
    worktreePath: str | None = None
    branchName: str | None = None
    autoWorktree: bool = False
    baseRef: str = "HEAD"
    scopePaths: list[str] = Field(default_factory=list, max_length=100)
    createdBy: str = "owner"
    requiresReview: bool = True
    maxTurns: int = Field(default=8, ge=1, le=20)


class ReviewFeedbackRequest(BaseModel):
    feedback: str = Field(min_length=3, max_length=10000)


def _is_rate_limited_output(lines: deque[str]) -> bool:
    """Recognize an actual limit rejection, not Claude's allowed usage warning."""
    for line in lines:
        try:
            entry = json.loads(line)
        except (TypeError, json.JSONDecodeError):
            lowered = line.lower()
            if (
                "usage limit" in lowered
                or ("rate limit" in lowered and any(word in lowered for word in ("exceeded", "blocked", "retry after")))
            ):
                return True
            continue
        if entry.get("type") == "rate_limit_event":
            limit_status = str(entry.get("rate_limit_info", {}).get("status", "")).lower()
            if limit_status and limit_status not in {"allowed", "allowed_warning"}:
                return True
            continue
        if entry.get("type") == "result" and entry.get("is_error"):
            result = str(entry.get("result", "")).lower()
            subtype = str(entry.get("subtype", "")).lower()
            if "rate limit" in result or "usage limit" in result or "rate_limit" in result or "rate_limit" in subtype:
                return True
        if entry.get("type") == "error" and "usage limit" in str(entry.get("message", "")).lower():
            return True
    return False


def _session_id_from_line(line: str) -> str | None:
    try:
        entry = json.loads(line)
    except (TypeError, json.JSONDecodeError):
        return None
    session_id = entry.get("session_id")
    return session_id if isinstance(session_id, str) and session_id else None


def _latest_logged_session_id(job_id: str) -> str | None:
    logs = store.list_job_logs(job_id, limit=1000)
    for log in reversed(logs):
        session_id = _session_id_from_line(log["message"])
        if session_id:
            return session_id
    return None


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
        "scheduler": scheduler.snapshot(),
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


@app.get("/api/v1/jobs/{job_id}/logs")
async def job_logs(job_id: str, after: int = 0, limit: int = 250, attempt: int | None = None):
    try:
        job = store.get_job(job_id)
        selected_attempt = job["attempt"] if attempt is None else attempt
        return {
            "attempt": selected_attempt,
            "logs": store.list_job_logs(job_id, after_id=after, limit=limit, attempt=selected_attempt),
        }
    except KeyError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found") from exc


@app.get("/api/v1/jobs/{job_id}/review")
async def job_review(job_id: str):
    try:
        job = store.get_job(job_id)
        validated = validate_worktree(REPO_ROOT, job["worktreePath"], job["branchName"])
        return {"review": inspect_worktree(str(validated))}
    except KeyError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found") from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc


@app.post("/api/v1/jobs", status_code=status.HTTP_201_CREATED)
async def create_job(body: JobRequest, x_coordinator_token: str | None = Header(default=None)):
    require_control_token(x_coordinator_token)
    managed: dict[str, str] | None = None
    try:
        if body.autoWorktree:
            managed = create_managed_worktree(
                REPO_ROOT,
                WORKTREE_ROOT,
                agent=body.assignedAgent,
                title=body.title,
                base_ref=body.baseRef,
            )
            worktree_path = managed["worktreePath"]
            branch_name = managed["branchName"]
        else:
            if not body.worktreePath or not body.branchName:
                raise ValueError("worktreePath and branchName are required when autoWorktree is false")
            worktree_path = body.worktreePath
            branch_name = body.branchName
        validate_worktree(REPO_ROOT, worktree_path, branch_name)
        created = store.create_job(
            JobCreate(
                title=body.title,
                instructions=body.instructions,
                assigned_agent=body.assignedAgent,
                worktree_path=worktree_path,
                branch_name=branch_name,
                created_by=body.createdBy,
                requires_review=body.requiresReview,
                max_turns=body.maxTurns,
                managed_worktree=body.autoWorktree,
                base_ref=body.baseRef if body.autoWorktree else "",
                scope_paths=tuple(body.scopePaths),
            )
        )
    except ValueError as exc:
        if managed:
            try:
                remove_managed_worktree(REPO_ROOT, managed["worktreePath"])
            except ValueError:
                pass
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    scheduler.wake()
    return {"job": created}


def _run_job(job_id: str) -> None:
    job = store.get_job(job_id)
    probe = probe_agent(job["assignedAgent"])
    if not probe.available or not probe.executable:
        store.transition_job(job_id, "failed", error=probe.error or "Agent unavailable")
        return
    command = build_agent_command(job, probe.executable)
    store.append_job_log(job_id, f"Starting {job['assignedAgent']} in {job['branchName']}", "system")
    output_lines: deque[str] = deque(maxlen=1000)
    active_session_id = job["agentSessionId"]
    try:
        process = subprocess.Popen(
            command,
            cwd=job["worktreePath"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            shell=False,
            start_new_session=True,
        )
        with process_lock:
            processes[job_id] = process
        if process.stdout is not None:
            for raw_line in process.stdout:
                line = raw_line.rstrip("\r\n")
                if not line:
                    continue
                output_lines.append(line)
                store.append_job_log(job_id, line)
                session_id = _session_id_from_line(line)
                if session_id and session_id != active_session_id:
                    store.update_execution_context(job_id, agent_session_id=session_id)
                    active_session_id = session_id
            process.stdout.close()
        process.wait()
    except OSError as exc:
        store.append_job_log(job_id, str(exc), "stderr")
        store.transition_job(job_id, "failed", error=str(exc))
        return
    finally:
        with process_lock:
            processes.pop(job_id, None)
    latest = store.get_job(job_id)
    if latest["status"] == "cancelled":
        store.append_job_log(job_id, "Job cancelled", "system")
        return
    combined = "\n".join(output_lines)[-65536:]
    error_text = combined[-8192:] if process.returncode else ""
    if _is_rate_limited_output(output_lines):
        store.transition_job(job_id, "rate_limited", exit_code=process.returncode, result_summary=combined, error=error_text)
    elif process.returncode != 0:
        store.transition_job(job_id, "failed", exit_code=process.returncode, result_summary=combined, error=error_text)
    elif job["requiresReview"]:
        store.transition_job(job_id, "review", exit_code=0, result_summary=combined)
    else:
        store.transition_job(job_id, "completed", exit_code=0, result_summary=combined)
    final = store.get_job(job_id)
    store.append_job_log(job_id, f"Job finished with status {final['status']}", "system")
    scheduler.wake()


def _launch_job(job_id: str) -> None:
    threading.Thread(target=_run_job, args=(job_id,), daemon=True, name=f"agent-{job_id[:8]}").start()


scheduler = CoordinatorScheduler(
    store,
    _launch_job,
    enabled=SCHEDULER_ENABLED,
    max_concurrent=MAX_CONCURRENT,
    max_per_agent=MAX_PER_AGENT,
)


@app.get("/api/v1/scheduler")
async def scheduler_status() -> dict[str, Any]:
    return {"scheduler": scheduler.snapshot()}


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
        claimed = scheduler.claim(job_id, actor="owner")
    except KeyError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found") from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return {"job": claimed}


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
        session_id = job["agentSessionId"] or _latest_logged_session_id(job_id)
        hit_turn_limit = "max_turns" in job["error"].lower() or "maximum number of turns" in job["error"].lower()
        next_max_turns = min(20, job["maxTurns"] + 4) if hit_turn_limit else job["maxTurns"]
        job = store.update_execution_context(
            job_id,
            agent_session_id=session_id,
            max_turns=next_max_turns,
        )
        store.transition_job(job_id, "queued", actor="owner")
        queued = store.get_job(job_id)
    except KeyError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found") from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    scheduler.wake()
    return {"job": queued}


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
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
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


@app.post("/api/v1/jobs/{job_id}/request-changes", status_code=status.HTTP_202_ACCEPTED)
async def request_job_changes(
    job_id: str,
    body: ReviewFeedbackRequest,
    x_coordinator_token: str | None = Header(default=None),
):
    require_control_token(x_coordinator_token)
    if not EXECUTION_ENABLED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Agent execution is disabled")
    try:
        job = store.get_job(job_id)
        validate_worktree(REPO_ROOT, job["worktreePath"], job["branchName"])
        if job["status"] not in {"review", "waiting_approval"}:
            raise ValueError("Only a reviewed job can receive change requests")
        store.update_execution_context(job_id, review_feedback=body.feedback)
        store.append_job_log(job_id, f"Codex requested changes: {body.feedback}", "system")
        if job["status"] == "review":
            store.transition_job(job_id, "waiting_approval", actor="owner")
        store.transition_job(job_id, "queued", actor="owner")
        queued = store.get_job(job_id)
    except KeyError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found") from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    scheduler.wake()
    return {"job": queued}


@app.post("/api/v1/jobs/{job_id}/remove-worktree")
async def remove_job_worktree(job_id: str, x_coordinator_token: str | None = Header(default=None)):
    require_control_token(x_coordinator_token)
    try:
        job = store.get_job(job_id)
        if not job["managedWorktree"]:
            raise ValueError("Job does not own a managed worktree")
        if job["status"] in {"queued", "running", "review", "waiting_approval"}:
            raise ValueError("Active or unreviewed job worktrees cannot be removed")
        remove_managed_worktree(REPO_ROOT, job["worktreePath"])
        store.append_event("worktree.removed", job_id=job_id, actor="owner", payload={"path": job["worktreePath"]})
        return {"ok": True}
    except KeyError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found") from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc


@app.get("/api/v1/events")
async def events(job_id: str | None = Query(default=None, alias="jobId"), limit: int = 200):
    return {"events": store.list_events(job_id, limit)}
