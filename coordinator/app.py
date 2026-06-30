"""FastAPI surface for RackPilot Agent Coordinator."""

from __future__ import annotations

import os
import json
import shutil
import signal
import subprocess
import threading
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
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
    integrate_job_worktree,
    local_chat,
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
integration_lock = threading.RLock()
autonomous_stop = threading.Event()
autonomous_thread: threading.Thread | None = None
awake_process: subprocess.Popen[Any] | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global autonomous_thread
    store.recover_interrupted_jobs()
    scheduler.start()
    autonomous_stop.clear()
    autonomous_thread = threading.Thread(
        target=_autonomous_loop, daemon=True, name="coordinator-autonomous-shift"
    )
    autonomous_thread.start()
    try:
        yield
    finally:
        autonomous_stop.set()
        if autonomous_thread.is_alive():
            autonomous_thread.join(timeout=3)
        _ensure_awake(False)
        scheduler.stop()


app = FastAPI(
    title="RackPilot Agent Coordinator",
    version="1.3.0",
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
    sourceOrganizationId: str = Field(default="", max_length=200)
    sourceProjectId: str = Field(default="", max_length=200)
    sourceWorkItemId: str = Field(default="", max_length=200)


class ReviewFeedbackRequest(BaseModel):
    feedback: str = Field(min_length=3, max_length=10000)


class AutonomousShiftRequest(BaseModel):
    durationHours: int = Field(default=10, ge=1, le=24)
    retryMinutes: int = Field(default=60, ge=5, le=1440)
    autoApprove: bool = True


class CoordinatorChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    history: list[dict[str, str]] = Field(default_factory=list, max_length=30)
    machineContext: dict[str, Any] = Field(default_factory=dict)


def _validate_job_workspace(job: dict[str, Any]) -> Path:
    if job["assignedAgent"] == "local":
        if Path(job["worktreePath"]).resolve() != REPO_ROOT or job["branchName"] != "local/read-only":
            raise ValueError("local text jobs must use the coordinator read-only workspace")
        return REPO_ROOT
    return validate_worktree(REPO_ROOT, job["worktreePath"], job["branchName"])


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


def _concise_failure(lines: deque[str], *, rate_limited: bool = False) -> str:
    """Extract a user-facing terminal reason while full output remains in result/logs."""
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except (TypeError, json.JSONDecodeError):
            lowered = line.lower()
            if "usage limit" in lowered or "maximum number of turns" in lowered:
                return line[-1000:]
            continue
        if isinstance(entry.get("errors"), list) and entry["errors"]:
            return str(entry["errors"][-1])[:1000]
        if entry.get("type") == "error" and entry.get("message"):
            return str(entry["message"])[:1000]
        if entry.get("type") == "turn.failed":
            message = entry.get("error", {}).get("message")
            if message:
                return str(message)[:1000]
        if entry.get("type") == "result" and entry.get("is_error") and entry.get("result"):
            return str(entry["result"])[:1000]
    return "Agent usage limit reached" if rate_limited else "Agent exited before completing the task"


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
        "autonomousShift": store.get_autonomous_shift(),
    }


@app.get("/api/v1/agents")
async def agents() -> dict[str, Any]:
    return {"agents": probes_as_dict(probe_agent(agent) for agent in sorted(AGENTS))}


@app.get("/api/v1/worktrees")
async def worktrees() -> dict[str, Any]:
    return {"worktrees": discover_worktrees(REPO_ROOT)}


@app.get("/api/v1/jobs")
async def jobs(
    status_filter: str | None = Query(default=None, alias="status"),
    work_item_id: str | None = Query(default=None, alias="workItemId"),
    limit: int = 100,
):
    try:
        return {"jobs": store.list_jobs(status_filter, limit, source_work_item_id=work_item_id)}
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
        if job["assignedAgent"] == "local":
            _validate_job_workspace(job)
            return {
                "review": {
                    "dirty": False,
                    "changeCount": 0,
                    "changes": [],
                    "unstagedStat": "",
                    "stagedStat": "",
                    "recentCommits": [],
                    "mode": "text-only",
                }
            }
        validated = _validate_job_workspace(job)
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
        if body.assignedAgent == "local":
            worktree_path = str(REPO_ROOT)
            branch_name = "local/read-only"
        elif body.autoWorktree:
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
        workspace_job = {
            "assignedAgent": body.assignedAgent,
            "worktreePath": worktree_path,
            "branchName": branch_name,
        }
        _validate_job_workspace(workspace_job)
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
                managed_worktree=body.autoWorktree and body.assignedAgent != "local",
                base_ref=body.baseRef if body.autoWorktree and body.assignedAgent != "local" else "",
                scope_paths=tuple(body.scopePaths),
                source_organization_id=body.sourceOrganizationId,
                source_project_id=body.sourceProjectId,
                source_work_item_id=body.sourceWorkItemId,
                base_commit=(managed or {}).get("baseCommit", ""),
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
    rate_limited = _is_rate_limited_output(output_lines)
    error_text = _concise_failure(output_lines, rate_limited=rate_limited) if process.returncode else ""
    if rate_limited:
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


def _integrate_job(job_id: str) -> None:
    with integration_lock:
        try:
            job = store.get_job(job_id)
            store.append_job_log(job_id, "Integration gate: validating scope and quality", "system")
            result = integrate_job_worktree(REPO_ROOT, job)
            store.update_integration_result(job_id, **{
                "result_commit": result["resultCommit"],
                "integrated_commit": result["integratedCommit"],
                "quality_summary": result["qualitySummary"],
            })
            store.append_job_log(
                job_id,
                f"Integrated {result['resultCommit'][:12]} as {result['integratedCommit'][:12]} — {result['qualitySummary']}",
                "system",
            )
            store.transition_job(job_id, "completed", actor="integration-gate", error="")
        except Exception as exc:
            message = str(exc)[:4000]
            store.update_integration_result(job_id, integration_error=message)
            store.append_job_log(job_id, f"Integration stopped: {message}", "stderr")
            try:
                store.transition_job(job_id, "failed", actor="integration-gate", error=message)
            except ValueError:
                pass
        finally:
            scheduler.wake()


def _parse_utc(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _ensure_awake(enabled: bool) -> bool:
    """Use macOS caffeinate only while an autonomous shift is active."""
    global awake_process
    if enabled:
        if awake_process is not None and awake_process.poll() is None:
            return True
        executable = shutil.which("caffeinate")
        if not executable:
            return False
        awake_process = subprocess.Popen(
            [executable, "-dimsu"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return True
    if awake_process is not None and awake_process.poll() is None:
        awake_process.terminate()
        try:
            awake_process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            awake_process.kill()
    awake_process = None
    return False


def _autonomous_report(shift: dict[str, Any]) -> dict[str, Any]:
    started = _parse_utc(shift.get("startedAt"))
    jobs = store.list_jobs(limit=500)
    if started:
        jobs = [job for job in jobs if (_parse_utc(job.get("createdAt")) or started) >= started]
    counts: dict[str, int] = {}
    for job in jobs:
        counts[job["status"]] = counts.get(job["status"], 0) + 1
    return {
        "jobs": len(jobs),
        "counts": counts,
        "completed": [
            {"id": job["id"], "title": job["title"], "agent": job["assignedAgent"],
             "commit": job.get("integratedCommit", ""), "quality": job.get("qualitySummary", "")}
            for job in jobs if job["status"] == "completed"
        ],
        "attention": [
            {"id": job["id"], "title": job["title"], "status": job["status"], "error": job.get("error", "")}
            for job in jobs if job["status"] in {"failed", "rate_limited"}
        ],
    }


def _autonomous_tick() -> None:
    shift = store.get_autonomous_shift()
    if not shift["enabled"]:
        _ensure_awake(False)
        return
    _ensure_awake(True)
    now = datetime.now(timezone.utc)
    ends_at = _parse_utc(shift.get("endsAt"))
    if ends_at and now >= ends_at:
        store.save_autonomous_shift(
            enabled=False, started_at=shift.get("startedAt"), ends_at=shift.get("endsAt"),
            retry_minutes=shift["retryMinutes"], auto_approve=shift["autoApprove"],
        )
        store.append_event("autonomous_shift.completed", actor="autonomous-shift", payload=_autonomous_report(shift))
        _ensure_awake(False)
        return
    if shift["autoApprove"]:
        for job in store.list_jobs("review", limit=100):
            if job["assignedAgent"] == "local":
                store.transition_job(job["id"], "completed", actor="autonomous-shift", error="")
                continue
            store.transition_job(job["id"], "integrating", actor="autonomous-shift")
            threading.Thread(
                target=_integrate_job, args=(job["id"],), daemon=True,
                name=f"auto-integrate-{job['id'][:8]}",
            ).start()
    retry_after = timedelta(minutes=shift["retryMinutes"])
    for job in store.list_jobs("rate_limited", limit=100):
        updated_at = _parse_utc(job.get("updatedAt")) or now
        if now - updated_at < retry_after:
            continue
        store.append_job_log(
            job["id"], f"Autonomous shift: retrying after {shift['retryMinutes']} minute limit cooldown", "system"
        )
        store.transition_job(job["id"], "queued", actor="autonomous-shift")
    scheduler.wake()


def _autonomous_loop() -> None:
    while not autonomous_stop.is_set():
        try:
            _autonomous_tick()
        except Exception as exc:
            store.append_event(
                "autonomous_shift.error", actor="autonomous-shift", payload={"error": str(exc)[:1000]}
            )
        autonomous_stop.wait(15)


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


@app.get("/api/v1/autonomous-shift")
async def autonomous_shift_status() -> dict[str, Any]:
    shift = store.get_autonomous_shift()
    shift["keepAwake"] = bool(awake_process is not None and awake_process.poll() is None)
    return {"shift": shift, "report": _autonomous_report(shift)}


@app.post("/api/v1/chat")
async def coordinator_chat(
    body: CoordinatorChatRequest, x_coordinator_token: str | None = Header(default=None),
):
    require_control_token(x_coordinator_token)
    shift = store.get_autonomous_shift()
    jobs = store.list_jobs(limit=30)
    context = {
        "scheduler": scheduler.snapshot(),
        "shift": shift,
        "agents": probes_as_dict(probe_agent(agent) for agent in sorted(AGENTS)),
        "recentJobs": [
            {"id": job["id"], "title": job["title"], "agent": job["assignedAgent"],
             "status": job["status"], "error": job.get("error", "")[:300]}
            for job in jobs[:15]
        ],
        "report": _autonomous_report(shift),
        "conversation": [
            {"role": str(row.get("role", ""))[:20], "content": str(row.get("content", ""))[:2000]}
            for row in body.history[-20:]
        ],
        "machine": body.machineContext,
    }
    try:
        answer = await __import__("asyncio").to_thread(local_chat, body.message, context)
    except ValueError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    store.append_event("coordinator.chat", actor="owner", payload={"message": body.message[:500]})
    return {"answer": answer, "context": context}


@app.post("/api/v1/autonomous-shift/start")
async def start_autonomous_shift(
    body: AutonomousShiftRequest, x_coordinator_token: str | None = Header(default=None),
):
    require_control_token(x_coordinator_token)
    if not EXECUTION_ENABLED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Agent execution is disabled")
    now = datetime.now(timezone.utc)
    shift = store.save_autonomous_shift(
        enabled=True,
        started_at=now.isoformat(),
        ends_at=(now + timedelta(hours=body.durationHours)).isoformat(),
        retry_minutes=body.retryMinutes,
        auto_approve=body.autoApprove,
    )
    store.append_event("autonomous_shift.started", actor="owner", payload=shift)
    _ensure_awake(True)
    scheduler.wake()
    return {"shift": shift, "report": _autonomous_report(shift)}


@app.post("/api/v1/autonomous-shift/stop")
async def stop_autonomous_shift(x_coordinator_token: str | None = Header(default=None)):
    require_control_token(x_coordinator_token)
    current = store.get_autonomous_shift()
    shift = store.save_autonomous_shift(
        enabled=False, started_at=current.get("startedAt"), ends_at=datetime.now(timezone.utc).isoformat(),
        retry_minutes=current["retryMinutes"], auto_approve=current["autoApprove"],
    )
    report = _autonomous_report(shift)
    _ensure_awake(False)
    store.append_event("autonomous_shift.stopped", actor="owner", payload=report)
    return {"shift": shift, "report": report}


@app.post("/api/v1/jobs/{job_id}/start", status_code=status.HTTP_202_ACCEPTED)
async def start_job(job_id: str, x_coordinator_token: str | None = Header(default=None)):
    require_control_token(x_coordinator_token)
    if not EXECUTION_ENABLED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Agent execution is disabled")
    try:
        job = store.get_job(job_id)
        _validate_job_workspace(job)
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
        _validate_job_workspace(job)
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
    if job["status"] not in {"queued", "running", "review", "waiting_approval", "rate_limited"}:
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
        if job["assignedAgent"] == "local":
            return {"job": store.transition_job(job_id, "completed", actor="owner")}
        _validate_job_workspace(job)
        integrating = store.transition_job(job_id, "integrating", actor="owner")
        threading.Thread(
            target=_integrate_job, args=(job_id,), daemon=True, name=f"integrate-{job_id[:8]}"
        ).start()
        return {"job": integrating}
    except KeyError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found") from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc


@app.post("/api/v1/jobs/{job_id}/submit-review")
async def submit_job_review(job_id: str, x_coordinator_token: str | None = Header(default=None)):
    """Recover useful worktree output after turn-limit or CLI failure."""
    require_control_token(x_coordinator_token)
    try:
        job = store.get_job(job_id)
        if job["status"] not in {"failed", "rate_limited"}:
            raise ValueError("Only a failed job can submit preserved changes")
        _validate_job_workspace(job)
        review = inspect_worktree(job["worktreePath"])
        if not review["dirty"]:
            raise ValueError("Worktree contains no preserved changes")
        store.append_job_log(job_id, "Preserved changes submitted for integration review", "system")
        return {"job": store.transition_job(job_id, "review", actor="owner")}
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
        _validate_job_workspace(job)
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
        if job["status"] in {"queued", "running", "review", "waiting_approval", "integrating"}:
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
