"""Persistence and process contracts for the local agent coordinator.

This module deliberately uses only the Python standard library so queue and
safety behavior can be tested without starting FastAPI or either agent CLI.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import tempfile
import urllib.error
import urllib.request
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


AGENTS = {"codex", "claude", "local"}
LOCAL_MODEL = os.getenv("RACKPILOT_LOCAL_MODEL", "qwen3:1.7b")
LOCAL_AI_URL = os.getenv("RACKPILOT_LOCAL_AI_URL", "http://127.0.0.1:11434").rstrip("/")


def local_chat(message: str, context: dict[str, Any]) -> str:
    """Answer coordinator questions locally; context is bounded and contains no secrets."""
    request_body = {
        "model": LOCAL_MODEL,
        "stream": False,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are RackPilot Coordinator Assistant, the owner's local first-line assistant. "
                    "Answer in the user's language. Distinguish agent queue load from physical Mac load. "
                    "For CPU, memory, disk, battery or temperature questions, quote exact values only from "
                    "context.machine and identify unavailable sensors honestly. Claude is Architecture Lead; "
                    "Codex is Engineering and Integration Lead; Local AI handles simple private text work. "
                    "Use conversation context to resolve follow-ups. Be concise, never invent metrics or claim "
                    "an action was performed unless context confirms it, and never request or expose secrets."
                ),
            },
            {"role": "user", "content": f"/no_think\nCOORDINATOR CONTEXT:\n{json.dumps(context, ensure_ascii=False)[:12000]}\n\nUSER:\n{message[:4000]}"},
        ],
        "options": {"temperature": 0.2, "num_ctx": 4096, "num_predict": 700},
        "keep_alive": "10m",
    }
    request = urllib.request.Request(
        f"{LOCAL_AI_URL}/api/chat",
        data=json.dumps(request_body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            result = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError) as exc:
        raise ValueError(f"Local coordinator assistant unavailable: {exc}") from exc
    content = str(result.get("message", {}).get("content", "")).strip()
    if not content:
        raise ValueError("Local coordinator assistant returned an empty response")
    return content
JOB_STATUSES = {
    "queued",
    "running",
    "review",
    "waiting_approval",
    "completed",
    "failed",
    "cancelled",
    "rate_limited",
    "integrating",
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
    managed_worktree: bool = False
    base_ref: str = ""
    scope_paths: tuple[str, ...] = ()
    source_organization_id: str = ""
    source_project_id: str = ""
    source_work_item_id: str = ""
    base_commit: str = ""

    def validate(self) -> None:
        if not self.title.strip():
            raise ValueError("title is required")
        if not self.instructions.strip():
            raise ValueError("instructions are required")
        if self.assigned_agent not in AGENTS:
            raise ValueError("assigned_agent must be codex, claude or local")
        if not 1 <= self.max_turns <= 20:
            raise ValueError("max_turns must be between 1 and 20")
        if not self.worktree_path.strip():
            raise ValueError("worktree_path is required")
        if not self.branch_name.strip():
            raise ValueError("branch_name is required")
        if self.branch_name in {"main", "master"}:
            raise ValueError("agent jobs cannot run directly on the integration branch")
        for path in self.scope_paths:
            normalized = path.strip().strip("/")
            if not normalized or normalized.startswith(".") or ".." in Path(normalized).parts:
                raise ValueError("scope paths must be safe repository-relative paths")
        source_values = (
            self.source_organization_id.strip(),
            self.source_project_id.strip(),
            self.source_work_item_id.strip(),
        )
        if any(source_values) and not all(source_values):
            raise ValueError("all source Kanban identifiers are required together")


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
    if agent == "local":
        return _probe_local_agent(timeout_seconds)
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


def _probe_local_agent(timeout_seconds: float) -> AgentProbe:
    """Probe the local Ollama API and require the configured on-device model."""
    try:
        with urllib.request.urlopen(f"{LOCAL_AI_URL}/api/version", timeout=timeout_seconds) as response:
            version = json.loads(response.read().decode("utf-8")).get("version", "unknown")
        with urllib.request.urlopen(f"{LOCAL_AI_URL}/api/tags", timeout=timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError) as exc:
        return AgentProbe("local", False, None, None, f"Ollama unavailable: {exc}")
    models = {str(item.get("name", "")) for item in payload.get("models", [])}
    if LOCAL_MODEL not in models:
        return AgentProbe(
            "local",
            False,
            sys.executable,
            f"Ollama {version} · {LOCAL_MODEL}",
            f"local model is not installed: {LOCAL_MODEL}",
        )
    return AgentProbe("local", True, sys.executable, f"Ollama {version} · {LOCAL_MODEL}")


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


def create_managed_worktree(
    repo_root: Path,
    worktree_root: Path,
    *,
    agent: str,
    title: str,
    base_ref: str = "HEAD",
) -> dict[str, str]:
    if agent not in AGENTS:
        raise ValueError("agent must be codex, claude or local")
    if not base_ref or base_ref.startswith("-") or not re.fullmatch(r"[A-Za-z0-9._/@{}^~:+-]+", base_ref):
        raise ValueError("base ref contains unsupported characters")
    safe_title = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:36] or "task"
    suffix = uuid.uuid4().hex[:8]
    branch = f"{agent}/rp-{safe_title}-{suffix}"
    worktree_root = Path(worktree_root).expanduser().resolve()
    worktree_root.mkdir(parents=True, exist_ok=True)
    path = worktree_root / f"{agent}-{safe_title}-{suffix}"
    verify = subprocess.run(
        ["git", "-C", str(repo_root), "rev-parse", "--verify", f"{base_ref}^{{commit}}"],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    if verify.returncode != 0:
        raise ValueError(f"unknown base ref: {base_ref}")
    result = subprocess.run(
        ["git", "-C", str(repo_root), "worktree", "add", "-b", branch, str(path), base_ref],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise ValueError((result.stderr or "could not create managed worktree").strip())
    return {
        "worktreePath": str(path), "branchName": branch, "baseRef": base_ref,
        "baseCommit": verify.stdout.strip(),
    }


def remove_managed_worktree(repo_root: Path, worktree_path: str) -> None:
    candidate = Path(worktree_path).expanduser().resolve()
    repo_root = Path(repo_root).resolve()
    registered = {Path(item.get("worktree", "")).resolve() for item in discover_worktrees(repo_root)}
    if candidate == repo_root or candidate not in registered:
        raise ValueError("path is not a removable managed worktree")
    status = subprocess.run(
        ["git", "-C", str(candidate), "status", "--porcelain"],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    if status.returncode != 0:
        raise ValueError("managed worktree is unavailable")
    if status.stdout.strip():
        raise ValueError("managed worktree has uncommitted changes")
    result = subprocess.run(
        ["git", "-C", str(repo_root), "worktree", "remove", str(candidate)],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise ValueError((result.stderr or "could not remove managed worktree").strip())


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


def _git(root: Path, *args: str, timeout: int = 30, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True,
        timeout=timeout, check=False, env=env,
    )


def _changed_paths(worktree: Path) -> list[str]:
    tracked = _git(worktree, "diff", "--name-only", "HEAD")
    untracked = _git(worktree, "ls-files", "--others", "--exclude-standard")
    if tracked.returncode != 0 or untracked.returncode != 0:
        raise ValueError("Unable to inspect agent changes")
    return sorted(set(filter(None, tracked.stdout.splitlines() + untracked.stdout.splitlines())))


def _path_in_scope(path: str, scopes: list[str]) -> bool:
    normalized = path.strip("/")
    return any(normalized == scope.strip("/") or normalized.startswith(f"{scope.strip('/')}/") for scope in scopes)


def validate_job_scope(job: dict[str, Any]) -> list[str]:
    worktree = Path(job["worktreePath"]).resolve()
    paths = _changed_paths(worktree)
    scopes = [str(path).strip("/") for path in job.get("scopePaths", []) if str(path).strip("/")]
    if not scopes:
        raise ValueError("Integration requires an explicit repository scope")
    outside = [path for path in paths if not _path_in_scope(path, scopes)]
    if outside:
        raise ValueError(f"Agent changed files outside declared scope: {', '.join(outside[:10])}")
    return paths


def run_job_quality_checks(repo_root: Path, job: dict[str, Any], changed_paths: list[str]) -> str:
    """Run deterministic bounded checks selected only from changed file types."""
    worktree = Path(job["worktreePath"]).resolve()
    checks: list[tuple[str, list[str]]] = []
    python_files = [path for path in changed_paths if path.endswith(".py")]
    js_files = [path for path in changed_paths if path.endswith((".js", ".mjs"))]
    migration_files = [path for path in changed_paths if path.startswith("server/migrations/") and path.endswith(".sql")]
    for path in migration_files:
        exists_at_base = _git(repo_root, "cat-file", "-e", f"{job.get('baseCommit') or 'HEAD'}:{path}")
        if exists_at_base.returncode == 0:
            raise ValueError(f"Applied migration is immutable and cannot be edited: {path}")
    if python_files:
        checks.append(("python syntax", [sys.executable, "-m", "py_compile", *python_files]))
    for path in js_files:
        checks.append((f"javascript syntax: {path}", ["node", "--check", path]))
    if migration_files:
        migration_script = (
            "import tempfile; from pathlib import Path; from server.migrations import MigrationRunner; "
            "d=tempfile.TemporaryDirectory(); "
            "r=MigrationRunner(Path(d.name)/'quality.db', Path('server/migrations')).apply(); "
            "print(r.current_version)"
        )
        checks.append(("migration replay", [sys.executable, "-c", migration_script]))
    summaries: list[str] = []
    env = {**os.environ, "PYTHONPATH": str(worktree)}
    for label, command in checks:
        result = subprocess.run(
            command, cwd=worktree, capture_output=True, text=True,
            timeout=120, check=False, env=env,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "check failed").strip()[-2000:]
            raise ValueError(f"{label} failed: {detail}")
        summaries.append(f"{label}: passed")
    return "; ".join(summaries) if summaries else "documentation/content scope: no syntax check required"


def integrate_job_worktree(repo_root: Path, job: dict[str, Any]) -> dict[str, str]:
    """Commit scoped agent changes and cherry-pick them into a clean integration worktree."""
    repo_root = Path(repo_root).resolve()
    worktree = validate_worktree(repo_root, job["worktreePath"], job["branchName"])
    changed_paths = validate_job_scope(job)
    root_status = _git(repo_root, "status", "--porcelain")
    if root_status.returncode != 0 or root_status.stdout.strip():
        raise ValueError("Integration worktree must be clean before approval")
    quality = run_job_quality_checks(repo_root, job, changed_paths)
    if changed_paths:
        add = _git(worktree, "add", "--all", "--", *changed_paths, timeout=60)
        if add.returncode != 0:
            raise ValueError((add.stderr or "Unable to stage agent changes").strip())
        commit = _git(
            worktree, "-c", "user.name=RackPilot Agent Coordinator",
            "-c", "user.email=coordinator@rackpilot.local", "commit",
            "-m", f"agent({job['assignedAgent']}): {job['title']}", timeout=60,
        )
        if commit.returncode != 0:
            raise ValueError((commit.stderr or commit.stdout or "Unable to commit agent changes").strip())
    base_commit = str(job.get("baseCommit") or "").strip()
    if not base_commit:
        merge_base = _git(repo_root, "merge-base", job["branchName"], "HEAD")
        if merge_base.returncode != 0:
            raise ValueError("Unable to determine agent branch base")
        base_commit = merge_base.stdout.strip()
    commits = _git(repo_root, "rev-list", "--reverse", f"{base_commit}..{job['branchName']}")
    commit_ids = [value for value in commits.stdout.splitlines() if value]
    if commits.returncode != 0 or not commit_ids:
        raise ValueError("Agent worktree contains no commits to integrate")
    cherry_pick = _git(repo_root, "cherry-pick", *commit_ids, timeout=180)
    if cherry_pick.returncode != 0:
        _git(repo_root, "cherry-pick", "--abort")
        raise ValueError(f"Integration conflict: {(cherry_pick.stderr or cherry_pick.stdout).strip()[-2000:]}")
    integrated = _git(repo_root, "rev-parse", "HEAD")
    return {
        "resultCommit": commit_ids[-1],
        "integratedCommit": integrated.stdout.strip(),
        "qualitySummary": quality,
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
    if job["assignedAgent"] == "local":
        worker = Path(__file__).with_name("local_worker.py").resolve()
        return [executable, str(worker), "--model", LOCAL_MODEL, "--endpoint", LOCAL_AI_URL, instructions]
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
                    managed_worktree INTEGER NOT NULL DEFAULT 0,
                    base_ref TEXT NOT NULL DEFAULT '',
                    scope_paths_json TEXT NOT NULL DEFAULT '[]',
                    source_organization_id TEXT NOT NULL DEFAULT '',
                    source_project_id TEXT NOT NULL DEFAULT '',
                    source_work_item_id TEXT NOT NULL DEFAULT '',
                    base_commit TEXT NOT NULL DEFAULT '',
                    result_commit TEXT NOT NULL DEFAULT '',
                    integrated_commit TEXT NOT NULL DEFAULT '',
                    quality_summary TEXT NOT NULL DEFAULT '',
                    integration_error TEXT NOT NULL DEFAULT '',
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
                CREATE TABLE IF NOT EXISTS coordinator_autonomous_shift (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                    enabled INTEGER NOT NULL DEFAULT 0,
                    started_at TEXT,
                    ends_at TEXT,
                    retry_minutes INTEGER NOT NULL DEFAULT 60,
                    auto_approve INTEGER NOT NULL DEFAULT 1,
                    updated_at TEXT NOT NULL
                );
                """
            )
            connection.execute(
                """INSERT OR IGNORE INTO coordinator_autonomous_shift
                   (singleton,enabled,retry_minutes,auto_approve,updated_at)
                   VALUES(1,0,60,1,?)""",
                (utc_now(),),
            )
            job_columns = {row["name"] for row in connection.execute("PRAGMA table_info(coordinator_jobs)")}
            if "attempt" not in job_columns:
                connection.execute("ALTER TABLE coordinator_jobs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0")
            if "agent_session_id" not in job_columns:
                connection.execute("ALTER TABLE coordinator_jobs ADD COLUMN agent_session_id TEXT NOT NULL DEFAULT ''")
            if "review_feedback" not in job_columns:
                connection.execute("ALTER TABLE coordinator_jobs ADD COLUMN review_feedback TEXT NOT NULL DEFAULT ''")
            if "managed_worktree" not in job_columns:
                connection.execute("ALTER TABLE coordinator_jobs ADD COLUMN managed_worktree INTEGER NOT NULL DEFAULT 0")
            if "base_ref" not in job_columns:
                connection.execute("ALTER TABLE coordinator_jobs ADD COLUMN base_ref TEXT NOT NULL DEFAULT ''")
            if "scope_paths_json" not in job_columns:
                connection.execute("ALTER TABLE coordinator_jobs ADD COLUMN scope_paths_json TEXT NOT NULL DEFAULT '[]'")
            if "source_organization_id" not in job_columns:
                connection.execute("ALTER TABLE coordinator_jobs ADD COLUMN source_organization_id TEXT NOT NULL DEFAULT ''")
            if "source_project_id" not in job_columns:
                connection.execute("ALTER TABLE coordinator_jobs ADD COLUMN source_project_id TEXT NOT NULL DEFAULT ''")
            if "source_work_item_id" not in job_columns:
                connection.execute("ALTER TABLE coordinator_jobs ADD COLUMN source_work_item_id TEXT NOT NULL DEFAULT ''")
            for column in ("base_commit", "result_commit", "integrated_commit", "quality_summary", "integration_error"):
                if column not in job_columns:
                    connection.execute(f"ALTER TABLE coordinator_jobs ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_coordinator_jobs_source_work_item "
                "ON coordinator_jobs(source_organization_id, source_project_id, source_work_item_id, created_at)"
            )
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
            "managedWorktree": bool(row["managed_worktree"]),
            "baseRef": row["base_ref"],
            "scopePaths": json.loads(row["scope_paths_json"] or "[]"),
            "sourceOrganizationId": row["source_organization_id"],
            "sourceProjectId": row["source_project_id"],
            "sourceWorkItemId": row["source_work_item_id"],
            "baseCommit": row["base_commit"],
            "resultCommit": row["result_commit"],
            "integratedCommit": row["integrated_commit"],
            "qualitySummary": row["quality_summary"],
            "integrationError": row["integration_error"],
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

    def get_autonomous_shift(self) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM coordinator_autonomous_shift WHERE singleton=1"
            ).fetchone()
        return {
            "enabled": bool(row["enabled"]),
            "startedAt": row["started_at"],
            "endsAt": row["ends_at"],
            "retryMinutes": row["retry_minutes"],
            "autoApprove": bool(row["auto_approve"]),
            "updatedAt": row["updated_at"],
        }

    def save_autonomous_shift(
        self, *, enabled: bool, started_at: str | None, ends_at: str | None,
        retry_minutes: int = 60, auto_approve: bool = True,
    ) -> dict[str, Any]:
        retry_minutes = max(5, min(int(retry_minutes), 1440))
        with self._lock, self._connect() as connection:
            connection.execute(
                """UPDATE coordinator_autonomous_shift
                   SET enabled=?,started_at=?,ends_at=?,retry_minutes=?,auto_approve=?,updated_at=?
                   WHERE singleton=1""",
                (1 if enabled else 0, started_at, ends_at, retry_minutes,
                 1 if auto_approve else 0, utc_now()),
            )
        return self.get_autonomous_shift()

    def create_job(self, payload: JobCreate) -> dict[str, Any]:
        payload.validate()
        job_id = str(uuid.uuid4())
        now = utc_now()
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO coordinator_jobs(
                    id,title,instructions,assigned_agent,status,worktree_path,
                    branch_name,created_by,requires_review,max_turns,managed_worktree,base_ref,scope_paths_json,
                    source_organization_id,source_project_id,source_work_item_id,created_at,updated_at
                    ,base_commit
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
                    int(payload.managed_worktree),
                    payload.base_ref,
                    json.dumps([path.strip().strip("/") for path in payload.scope_paths]),
                    payload.source_organization_id.strip(),
                    payload.source_project_id.strip(),
                    payload.source_work_item_id.strip(),
                    now,
                    now,
                    payload.base_commit.strip(),
                ),
            )
            self.append_event(
                "job.created",
                job_id=job_id,
                actor=payload.created_by,
                payload={
                    "assignedAgent": payload.assigned_agent,
                    "branchName": payload.branch_name,
                    "sourceWorkItemId": payload.source_work_item_id,
                },
                connection=connection,
            )
        return self.get_job(job_id)

    def update_integration_result(
        self, job_id: str, *, result_commit: str = "", integrated_commit: str = "",
        quality_summary: str = "", integration_error: str = "",
    ) -> dict[str, Any]:
        with self._lock, self._connect() as connection:
            connection.execute(
                """UPDATE coordinator_jobs SET result_commit=?,integrated_commit=?,quality_summary=?,
                   integration_error=?,updated_at=? WHERE id=?""",
                (result_commit, integrated_commit, quality_summary[:4000], integration_error[:4000], utc_now(), job_id),
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

    def list_jobs(self, status: str | None = None, limit: int = 100,
                  source_work_item_id: str | None = None) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 500))
        with self._connect() as connection:
            if source_work_item_id:
                query = "SELECT * FROM coordinator_jobs WHERE source_work_item_id=?"
                args: list[Any] = [source_work_item_id]
                if status:
                    if status not in JOB_STATUSES:
                        raise ValueError("unknown status")
                    query += " AND status=?"
                    args.append(status)
                query += " ORDER BY created_at DESC LIMIT ?"
                args.append(limit)
                rows = connection.execute(query, args).fetchall()
            elif status:
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

    def recover_interrupted_jobs(self) -> list[dict[str, Any]]:
        recovered = []
        for job in self.list_jobs("running", limit=500):
            recovered.append(
                self.transition_job(
                    job["id"],
                    "failed",
                    actor="coordinator-recovery",
                    error="Coordinator restarted while the agent process was running; review the worktree and retry safely.",
                )
            )
        return recovered

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
            "review": {"waiting_approval", "integrating", "completed", "failed", "cancelled"},
            "waiting_approval": {"completed", "failed", "cancelled", "queued"},
            "integrating": {"completed", "failed"},
            "failed": {"queued", "review"},
            "cancelled": {"queued"},
            "rate_limited": {"queued", "cancelled"},
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
