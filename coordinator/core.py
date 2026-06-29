"""Persistence and process contracts for the local agent coordinator.

This module deliberately uses only the Python standard library so queue and
safety behavior can be tested without starting FastAPI or either agent CLI.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
import threading
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


AGENTS = {"codex", "claude"}
JOB_STATUSES = {
    "queued",
    "running",
    "review",
    "waiting_approval",
    "completed",
    "failed",
    "cancelled",
    "rate_limited",
}
TERMINAL_STATUSES = {"completed", "failed", "cancelled", "rate_limited"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class JobCreate:
    title: str
    instructions: str
    assigned_agent: str
    worktree_path: str
    branch_name: str
    created_by: str = "owner"
    requires_review: bool = True
    max_turns: int = 8

    def validate(self) -> None:
        if not self.title.strip():
            raise ValueError("title is required")
        if not self.instructions.strip():
            raise ValueError("instructions are required")
        if self.assigned_agent not in AGENTS:
            raise ValueError("assigned_agent must be codex or claude")
        if not 1 <= self.max_turns <= 20:
            raise ValueError("max_turns must be between 1 and 20")
        if not self.worktree_path.strip():
            raise ValueError("worktree_path is required")
        if not self.branch_name.strip():
            raise ValueError("branch_name is required")
        if self.branch_name in {"main", "master"}:
            raise ValueError("agent jobs cannot run directly on the integration branch")


@dataclass(frozen=True)
class AgentProbe:
    agent: str
    available: bool
    executable: str | None
    version: str | None
    error: str | None = None


def probe_agent(agent: str, timeout_seconds: float = 5) -> AgentProbe:
    if agent not in AGENTS:
        raise ValueError(f"unsupported agent: {agent}")
    executable = shutil.which(agent)
    if not executable:
        return AgentProbe(agent, False, None, None, "executable not found")
    try:
        result = subprocess.run(
            [executable, "--version"],
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return AgentProbe(agent, False, executable, None, str(exc))
    version = (result.stdout or result.stderr).strip().splitlines()
    return AgentProbe(
        agent=agent,
        available=result.returncode == 0,
        executable=executable,
        version=version[0] if version else None,
        error=None if result.returncode == 0 else f"version command exited {result.returncode}",
    )


def discover_worktrees(repo_root: Path) -> list[dict[str, Any]]:
    """Return Git-owned worktrees without relying on user-controlled shell text."""
    result = subprocess.run(
        ["git", "-C", str(repo_root), "worktree", "list", "--porcelain"],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    worktrees: list[dict[str, Any]] = []
    current: dict[str, Any] = {}
    for raw_line in result.stdout.splitlines() + [""]:
        line = raw_line.strip()
        if not line:
            if current:
                worktrees.append(current)
                current = {}
            continue
        key, _, value = line.partition(" ")
        if key in {"bare", "detached", "prunable", "locked"} and not value:
            current[key] = True
        else:
            current[key] = value
    return worktrees


def validate_worktree(repo_root: Path, worktree_path: str, branch_name: str) -> Path:
    candidate = Path(worktree_path).expanduser().resolve()
    known = discover_worktrees(repo_root)
    match = next((item for item in known if Path(item.get("worktree", "")).resolve() == candidate), None)
    if not match:
        raise ValueError("worktree_path is not registered in this Git repository")
    branch_ref = str(match.get("branch", ""))
    actual_branch = branch_ref.removeprefix("refs/heads/")
    if actual_branch and actual_branch != branch_name:
        raise ValueError(f"branch mismatch: worktree uses {actual_branch}")
    if actual_branch in {"main", "master"}:
        raise ValueError("integration branch cannot be used as an agent worktree")
    return candidate


def inspect_worktree(worktree_path: str) -> dict[str, Any]:
    """Return bounded Git metadata for review without exposing file contents."""
    root = Path(worktree_path).expanduser().resolve()

    def git(*args: str) -> str:
        result = subprocess.run(
            ["git", "-C", str(root), *args],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if result.returncode != 0:
            raise ValueError((result.stderr or "Git inspection failed").strip())
        return result.stdout.strip()

    status_output = git("status", "--short", "--untracked-files=all")
    changes = []
    for line in status_output.splitlines()[:500]:
        if len(line) < 3:
            continue
        changes.append({"status": line[:2], "path": line[3:]})
    unstaged = git("diff", "--stat", "--compact-summary")
    staged = git("diff", "--cached", "--stat", "--compact-summary")
    commits = []
    try:
        history = git("log", "-5", "--pretty=format:%h%x09%s")
    except ValueError:
        history = ""  # A newly created worktree may not have a first commit yet.
    for line in history.splitlines():
        commit, _, subject = line.partition("\t")
        commits.append({"commit": commit, "subject": subject})
    return {
        "dirty": bool(changes),
        "changeCount": len(changes),
        "changes": changes,
        "unstagedStat": unstaged,
        "stagedStat": staged,
        "recentCommits": commits,
    }


def build_agent_command(job: dict[str, Any], executable: str) -> list[str]:
    """Build an argv list. Commands are never passed through a shell."""
    instructions = str(job["instructions"])
    worktree = str(job["worktreePath"])
    max_turns = int(job["maxTurns"])
    if job["assignedAgent"] == "codex":
        return [
            executable,
            "exec",
            "--json",
            "--sandbox",
            "workspace-write",
            "--cd",
            worktree,
            instructions,
        ]
    if job["assignedAgent"] == "claude":
        session_id = str(job.get("agentSessionId") or "").strip()
        prompt = instructions
        command = [
            executable,
            "-p",
            prompt,
            "--output-format",
            "stream-json",
            "--verbose",
            "--max-turns",
            str(max_turns),
            "--permission-mode",
            "acceptEdits",
        ]
        if session_id:
            command.extend(["--resume", session_id])
            feedback = str(job.get("reviewFeedback") or "").strip()
            command[2] = (
                f"Codex review feedback:\n{feedback}\n\nApply the requested corrections, verify the result, and stop for review."
                if feedback
                else "Continue the assigned task from the existing session. Do not repeat completed analysis. "
                     "Finish the remaining implementation, verification, and handoff, then stop for Codex review."
            )
        return command
    raise ValueError("unsupported assigned agent")


class CoordinatorStore:
    """Thread-safe SQLite queue with append-only event history."""

    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS coordinator_jobs (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    instructions TEXT NOT NULL,
                    assigned_agent TEXT NOT NULL,
                    status TEXT NOT NULL,
                    worktree_path TEXT NOT NULL,
                    branch_name TEXT NOT NULL,
                    created_by TEXT NOT NULL,
                    requires_review INTEGER NOT NULL,
                    max_turns INTEGER NOT NULL,
                    attempt INTEGER NOT NULL DEFAULT 0,
                    agent_session_id TEXT NOT NULL DEFAULT '',
                    review_feedback TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    started_at TEXT,
                    completed_at TEXT,
                    exit_code INTEGER,
                    result_summary TEXT NOT NULL DEFAULT '',
                    error TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS idx_coordinator_jobs_status
                    ON coordinator_jobs(status, created_at);
                CREATE TABLE IF NOT EXISTS coordinator_events (
                    id TEXT PRIMARY KEY,
                    job_id TEXT,
                    event_type TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(job_id) REFERENCES coordinator_jobs(id)
                );
                CREATE INDEX IF NOT EXISTS idx_coordinator_events_job
                    ON coordinator_events(job_id, created_at);
                CREATE TABLE IF NOT EXISTS coordinator_job_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL,
                    stream TEXT NOT NULL,
                    attempt INTEGER NOT NULL DEFAULT 0,
                    message TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(job_id) REFERENCES coordinator_jobs(id)
                );
                CREATE INDEX IF NOT EXISTS idx_coordinator_job_logs_job
                    ON coordinator_job_logs(job_id, id);
                """
            )
            job_columns = {row["name"] for row in connection.execute("PRAGMA table_info(coordinator_jobs)")}
            if "attempt" not in job_columns:
                connection.execute("ALTER TABLE coordinator_jobs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0")
            if "agent_session_id" not in job_columns:
                connection.execute("ALTER TABLE coordinator_jobs ADD COLUMN agent_session_id TEXT NOT NULL DEFAULT ''")
            if "review_feedback" not in job_columns:
                connection.execute("ALTER TABLE coordinator_jobs ADD COLUMN review_feedback TEXT NOT NULL DEFAULT ''")
            log_columns = {row["name"] for row in connection.execute("PRAGMA table_info(coordinator_job_logs)")}
            if "attempt" not in log_columns:
                connection.execute("ALTER TABLE coordinator_job_logs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0")

    @staticmethod
    def _job(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "title": row["title"],
            "instructions": row["instructions"],
            "assignedAgent": row["assigned_agent"],
            "status": row["status"],
            "worktreePath": row["worktree_path"],
            "branchName": row["branch_name"],
            "createdBy": row["created_by"],
            "requiresReview": bool(row["requires_review"]),
            "maxTurns": row["max_turns"],
            "attempt": row["attempt"],
            "agentSessionId": row["agent_session_id"],
            "reviewFeedback": row["review_feedback"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "startedAt": row["started_at"],
            "completedAt": row["completed_at"],
            "exitCode": row["exit_code"],
            "resultSummary": row["result_summary"],
            "error": row["error"],
        }

    def append_event(
        self,
        event_type: str,
        *,
        job_id: str | None = None,
        actor: str = "coordinator",
        payload: dict[str, Any] | None = None,
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, Any]:
        event = {
            "id": str(uuid.uuid4()),
            "jobId": job_id,
            "eventType": event_type,
            "actor": actor,
            "payload": payload or {},
            "createdAt": utc_now(),
        }

        def insert(conn: sqlite3.Connection) -> None:
            conn.execute(
                "INSERT INTO coordinator_events(id,job_id,event_type,actor,payload_json,created_at) VALUES(?,?,?,?,?,?)",
                (
                    event["id"],
                    event["jobId"],
                    event["eventType"],
                    event["actor"],
                    json.dumps(event["payload"], sort_keys=True),
                    event["createdAt"],
                ),
            )

        if connection is not None:
            insert(connection)
        else:
            with self._lock, self._connect() as conn:
                insert(conn)
        return event

    def create_job(self, payload: JobCreate) -> dict[str, Any]:
        payload.validate()
        job_id = str(uuid.uuid4())
        now = utc_now()
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO coordinator_jobs(
                    id,title,instructions,assigned_agent,status,worktree_path,
                    branch_name,created_by,requires_review,max_turns,created_at,updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    job_id,
                    payload.title.strip(),
                    payload.instructions.strip(),
                    payload.assigned_agent,
                    "queued",
                    payload.worktree_path,
                    payload.branch_name,
                    payload.created_by,
                    int(payload.requires_review),
                    payload.max_turns,
                    now,
                    now,
                ),
            )
            self.append_event(
                "job.created",
                job_id=job_id,
                actor=payload.created_by,
                payload={"assignedAgent": payload.assigned_agent, "branchName": payload.branch_name},
                connection=connection,
            )
        return self.get_job(job_id)

    def get_job(self, job_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM coordinator_jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise KeyError(job_id)
        return self._job(row)

    def update_execution_context(
        self,
        job_id: str,
        *,
        agent_session_id: str | None = None,
        max_turns: int | None = None,
        review_feedback: str | None = None,
    ) -> dict[str, Any]:
        current = self.get_job(job_id)
        next_session = current["agentSessionId"] if agent_session_id is None else agent_session_id.strip()[:200]
        next_turns = current["maxTurns"] if max_turns is None else max_turns
        next_feedback = current["reviewFeedback"] if review_feedback is None else review_feedback.strip()[:10000]
        if not 1 <= next_turns <= 20:
            raise ValueError("max_turns must be between 1 and 20")
        with self._lock, self._connect() as connection:
            connection.execute(
                "UPDATE coordinator_jobs SET agent_session_id=?,max_turns=?,review_feedback=?,updated_at=? WHERE id=?",
                (next_session, next_turns, next_feedback, utc_now(), job_id),
            )
        return self.get_job(job_id)

    def append_job_log(
        self,
        job_id: str,
        message: str,
        stream: str = "stdout",
        attempt: int | None = None,
    ) -> dict[str, Any]:
        if stream not in {"stdout", "stderr", "system"}:
            raise ValueError("unknown log stream")
        entry = {
            "jobId": job_id,
            "stream": stream,
            "attempt": self.get_job(job_id)["attempt"] if attempt is None else max(0, attempt),
            "message": message[:8192],
            "createdAt": utc_now(),
        }
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                "INSERT INTO coordinator_job_logs(job_id,stream,attempt,message,created_at) VALUES(?,?,?,?,?)",
                (entry["jobId"], entry["stream"], entry["attempt"], entry["message"], entry["createdAt"]),
            )
            entry["id"] = cursor.lastrowid
            connection.execute(
                """
                DELETE FROM coordinator_job_logs
                WHERE job_id=? AND id NOT IN (
                    SELECT id FROM coordinator_job_logs WHERE job_id=? ORDER BY id DESC LIMIT 2000
                )
                """,
                (job_id, job_id),
            )
        return entry

    def list_job_logs(
        self,
        job_id: str,
        after_id: int = 0,
        limit: int = 250,
        attempt: int | None = None,
    ) -> list[dict[str, Any]]:
        self.get_job(job_id)
        limit = max(1, min(limit, 1000))
        with self._connect() as connection:
            if attempt is None:
                rows = connection.execute(
                    """
                    SELECT id,job_id,stream,attempt,message,created_at
                    FROM coordinator_job_logs
                    WHERE job_id=? AND id>?
                    ORDER BY id ASC LIMIT ?
                    """,
                    (job_id, max(0, after_id), limit),
                ).fetchall()
            else:
                rows = connection.execute(
                    """
                    SELECT id,job_id,stream,attempt,message,created_at
                    FROM coordinator_job_logs
                    WHERE job_id=? AND attempt=? AND id>?
                    ORDER BY id ASC LIMIT ?
                    """,
                    (job_id, max(0, attempt), max(0, after_id), limit),
                ).fetchall()
        return [
            {
                "id": row["id"],
                "jobId": row["job_id"],
                "stream": row["stream"],
                "attempt": row["attempt"],
                "message": row["message"],
                "createdAt": row["created_at"],
            }
            for row in rows
        ]

    def list_jobs(self, status: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 500))
        with self._connect() as connection:
            if status:
                if status not in JOB_STATUSES:
                    raise ValueError("unknown status")
                rows = connection.execute(
                    "SELECT * FROM coordinator_jobs WHERE status=? ORDER BY created_at DESC LIMIT ?",
                    (status, limit),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM coordinator_jobs ORDER BY created_at DESC LIMIT ?", (limit,)
                ).fetchall()
        return [self._job(row) for row in rows]

    def transition_job(
        self,
        job_id: str,
        status: str,
        *,
        actor: str = "coordinator",
        exit_code: int | None = None,
        result_summary: str | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        if status not in JOB_STATUSES:
            raise ValueError("unknown status")
        current = self.get_job(job_id)
        allowed = {
            "queued": {"running", "cancelled"},
            "running": {"review", "waiting_approval", "completed", "failed", "cancelled", "rate_limited"},
            "review": {"waiting_approval", "completed", "failed", "cancelled"},
            "waiting_approval": {"completed", "failed", "cancelled", "queued"},
            "failed": {"queued"},
            "cancelled": {"queued"},
            "rate_limited": {"queued"},
        }
        if status not in allowed.get(current["status"], set()):
            raise ValueError(f"invalid transition {current['status']} -> {status}")
        now = utc_now()
        started_at = None if status == "queued" else (
            now if status == "running" and not current["startedAt"] else current["startedAt"]
        )
        completed_at = now if status in TERMINAL_STATUSES else None
        reset_run = status in {"queued", "running"}
        next_attempt = current["attempt"] + 1 if status == "running" else current["attempt"]
        next_exit_code = None if reset_run else (current["exitCode"] if exit_code is None else exit_code)
        next_result = "" if reset_run else (current["resultSummary"] if result_summary is None else result_summary)
        next_error = "" if reset_run else (current["error"] if error is None else error)
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                UPDATE coordinator_jobs
                SET status=?,updated_at=?,started_at=?,completed_at=?,exit_code=?,result_summary=?,error=?,attempt=?
                WHERE id=?
                """,
                (
                    status,
                    now,
                    started_at,
                    completed_at,
                    next_exit_code,
                    next_result[:65536],
                    next_error[:8192],
                    next_attempt,
                    job_id,
                ),
            )
            self.append_event(
                "job.status_changed",
                job_id=job_id,
                actor=actor,
                payload={
                    "from": current["status"],
                    "to": status,
                    "exitCode": next_exit_code,
                    "attempt": next_attempt,
                },
                connection=connection,
            )
        return self.get_job(job_id)

    def list_events(self, job_id: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 1000))
        with self._connect() as connection:
            if job_id:
                rows = connection.execute(
                    "SELECT * FROM coordinator_events WHERE job_id=? ORDER BY created_at DESC LIMIT ?",
                    (job_id, limit),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM coordinator_events ORDER BY created_at DESC LIMIT ?", (limit,)
                ).fetchall()
        return [
            {
                "id": row["id"],
                "jobId": row["job_id"],
                "eventType": row["event_type"],
                "actor": row["actor"],
                "payload": json.loads(row["payload_json"]),
                "createdAt": row["created_at"],
            }
            for row in rows
        ]


def probes_as_dict(probes: Iterable[AgentProbe]) -> list[dict[str, Any]]:
    return [asdict(probe) for probe in probes]
