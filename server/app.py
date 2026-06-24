#!/usr/bin/env python3
"""Dependency-free local API and static server for the RackPilot workspace."""

from __future__ import annotations

import argparse
import hmac
import hashlib
import json
import logging
import mimetypes
import os
import re
import signal
import socket
import socketserver
import sqlite3
import secrets
import threading
import time
import uuid
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import parse_qs, urlparse
import urllib.request
import urllib.error
import subprocess

from server.migrations import MigrationRunner

ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = ROOT / "web"
DEFAULT_DB = ROOT / "data" / "fieldos.db"
MIGRATIONS_DIR = ROOT / "server" / "migrations"
OPENAPI_PATH = ROOT / "docs" / "openapi.yaml"
MAX_BODY_BYTES = 2 * 1024 * 1024
ALLOWED_STATUSES = {"ideas", "backlog", "ready", "progress", "blocked", "review", "testing", "done"}
ALLOWED_PRIORITIES = {"critical", "high", "medium", "low"}
ALLOWED_PROJECT_STATUSES = {"planned", "active", "on_hold", "completed", "cancelled"}
ALLOWED_BUILDING_STATUSES = {"planned", "active", "on_hold", "completed"}
DEFAULT_ORGANIZATION_ID = "local-dev"
ROLE_POLICIES = {
    "Technician":     {"projectRead", "fieldProgress"},
    "Supervisor":     {"projectRead", "fieldProgress", "projectManage", "logsRead"},
    "ProjectManager": {"projectRead", "fieldProgress", "projectManage", "logsRead", "developmentWorkspace"},
    "Administrator":  {"projectRead", "fieldProgress", "projectManage", "logsRead", "apiMonitor", "adminPanel", "developmentWorkspace", "secretsManage", "agentContext"},
}
# Permissions that require a real Bearer session — dev-mode header not accepted
SESSION_REQUIRED_PERMISSIONS = frozenset({"secretsManage", "agentContext"})
TASK_PROGRESS = {"ideas": 0, "backlog": 0, "ready": 10, "progress": 50, "blocked": 25, "review": 75, "testing": 90, "done": 100}
UNIT_PROGRESS = {"not_started": 0, "ongoing": 50, "blocked": 25, "complete": 100}
WORK_ITEM_TRANSITIONS = {
    "ideas": {"backlog", "ready"}, "backlog": {"ideas", "ready"},
    "ready": {"backlog", "progress"}, "progress": {"blocked", "review"},
    "blocked": {"backlog", "progress"}, "review": {"progress", "testing"},
    "testing": {"progress", "done"}, "done": {"progress"},
}
DEFAULT_WORK_TYPES = (
    ("data", "data", "Data", "#62a8ff", 0),
    ("termination", "termination", "Termination", "#ffb45c", 1),
    ("fiber", "fiber", "Fiber", "#d987ff", 2),
    ("access-control", "access_control", "Access Control", "#31d4a2", 3),
    ("cctv", "cctv", "CCTV", "#ff7185", 4),
    ("network", "network", "Network", "#7c8cff", 5),
    ("commissioning", "commissioning", "Commissioning", "#42d697", 6),
    ("other", "other", "Other", "#8893a6", 7),
    ("nsp-inspection", "nsp_inspection", "NSP Inspection", "#4dd5c7", 8),
    ("conduit", "conduit", "Conduit", "#f29b62", 9),
    ("wifi", "wifi", "WiFi", "#61d58d", 10),
    ("audiovisual", "audiovisual", "Audio Visual", "#da7bf5", 11),
)
DEFAULT_WORK_ACTIONS = (
    ("data-prewire","data","prewire","Prewire",0),("data-terminated-tested","data","terminated_tested","Terminated & Tested",1),("data-trimout","data","trimout","Trimout",2),
    ("fiber-prewire","fiber","prewire","Prewire",0),("fiber-terminated-tested","fiber","terminated_tested","Terminated & Tested",1),("fiber-as-built","fiber","as_built_sent","As Built Sent",2),
    ("termination-terminate","termination","terminate","Terminate",0),("termination-test","termination","test","Test",1),
    ("cctv-prewire","cctv","prewire","Prewire",0),("cctv-installed","cctv","installed","Installed",1),("cctv-verified","cctv","view_verified","View Verified",2),
    ("access-prewire","access-control","prewire","Prewire",0),("access-installed","access-control","installed","Installed",1),("access-operational","access-control","operational","Operational",2),
    ("conduit-installed","conduit","installed","Installed",0),("conduit-closed","conduit","junctions_closed","Junctions Closed",1),
    ("wifi-prewire","wifi","prewire","Prewire",0),("wifi-installed","wifi","installed","Installed",1),("wifi-operational","wifi","operational","Operational",2),
    ("av-prewire","audiovisual","prewire","Prewire",0),("av-installed","audiovisual","installed","Installed",1),("av-operational","audiovisual","operational","Operational",2),
    ("nsp-prewire","nsp-inspection","prewire","Prewire",0),("nsp-tested","nsp-inspection","terminated_tested","Terminated & Tested",1),("nsp-as-built","nsp-inspection","as_built_sent","As Built Sent",2),
    ("network-prewire","network","prewire","Prewire",0),("network-installed","network","installed","Installed",1),("network-operational","network","operational","Operational",2),
    ("commissioning-test","commissioning","test","Test",0),("commissioning-verify","commissioning","verify","Verify",1),("other-update","other","update","Update",0),
)

logging.basicConfig(level=logging.INFO, format='%(message)s')
LOGGER = logging.getLogger("fieldos")


def normalize_role(value: str | None) -> str:
    return value if value in ROLE_POLICIES else "Administrator"


def role_can(role: str, permission: str) -> bool:
    return permission in ROLE_POLICIES.get(normalize_role(role), ROLE_POLICIES["Administrator"])


SESSION_TTL_SECONDS = 8 * 3600  # 8-hour sessions

def _hash_password(password: str, salt: bytes | None = None) -> str:
    if salt is None:
        salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
    return f"scrypt:{salt.hex()}:{dk.hex()}"

def _verify_password(password: str, stored: str) -> bool:
    try:
        _, salt_hex, hash_hex = stored.split(":")
        salt = bytes.fromhex(salt_hex)
        dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False

def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# ── Secrets encryption (HMAC-SHA256 counter-mode stream cipher, stdlib only) ──

def _load_or_create_master_key(key_path: Path) -> bytes:
    """Load master key from file or generate a new one (chmod 600)."""
    if key_path.exists():
        data = key_path.read_bytes()
        if len(data) == 32:
            return data
    key = secrets.token_bytes(32)
    key_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.write_bytes(key)
    key_path.chmod(0o600)
    return key

def _derive_key(master: bytes, context: str) -> bytes:
    """Derive a 32-byte purpose-specific key via HKDF-like HMAC expand."""
    return hmac.new(master, context.encode(), "sha256").digest()

def _hmac_ctr(key: bytes, nonce: bytes, data: bytes) -> bytes:
    """XOR data with HMAC-SHA256 keystream (CTR mode using HMAC as PRF)."""
    result = bytearray(len(data))
    offset = 0
    block = 0
    while offset < len(data):
        ks_block = hmac.new(key, nonce + block.to_bytes(4, "big"), "sha256").digest()
        for b in ks_block:
            if offset >= len(data):
                break
            result[offset] = data[offset] ^ b
            offset += 1
        block += 1
    return bytes(result)

def encrypt_secret(master: bytes, name: str, plaintext: str) -> str:
    """Return hex(nonce):hex(ciphertext):hex(mac) — encrypt-then-MAC."""
    enc_key = _derive_key(master, f"enc:{name}")
    mac_key = _derive_key(master, f"mac:{name}")
    nonce = secrets.token_bytes(16)
    ct = _hmac_ctr(enc_key, nonce, plaintext.encode())
    mac = hmac.new(mac_key, nonce + ct, "sha256").digest()
    return f"{nonce.hex()}:{ct.hex()}:{mac.hex()}"

def decrypt_secret(master: bytes, name: str, stored: str) -> str | None:
    """Verify MAC then decrypt; returns None on tamper."""
    try:
        nonce_hex, ct_hex, mac_hex = stored.split(":")
        nonce, ct = bytes.fromhex(nonce_hex), bytes.fromhex(ct_hex)
        mac_key = _derive_key(master, f"mac:{name}")
        expected = hmac.new(mac_key, nonce + ct, "sha256").digest()
        if not hmac.compare_digest(expected, bytes.fromhex(mac_hex)):
            return None
        enc_key = _derive_key(master, f"enc:{name}")
        return _hmac_ctr(enc_key, nonce, ct).decode()
    except Exception:
        return None


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def audit_event_hash(organization_id: str, event_id: str, project_id: str, entity_type: str, entity_id: str, action: str, old_value: str, new_value: str, source: str, created_at: str, previous_hash: str) -> str:
    canonical = json.dumps([organization_id, event_id, project_id, entity_type, entity_id, action, old_value, new_value, source, created_at, previous_hash], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def discover_lan_ip() -> str | None:
    """Return the address selected by the OS for local network traffic."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 9))
        address = probe.getsockname()[0]
        return address if not address.startswith("127.") else None
    except OSError:
        return None
    finally:
        probe.close()


def ensure_agent_token(db_path: Path) -> tuple[str, Path | None]:
    configured=os.getenv("RACKPILOT_AGENT_TOKEN") or os.getenv("FIELDOS_AGENT_TOKEN")
    if configured: return configured,None
    token_path=db_path.parent / "agent.token"
    if token_path.exists(): return token_path.read_text(encoding="utf-8").strip(),token_path
    token_path.parent.mkdir(parents=True,exist_ok=True)
    token_path.write_text(secrets.token_urlsafe(32),encoding="utf-8")
    token_path.chmod(0o600)
    return token_path.read_text(encoding="utf-8").strip(),token_path


def _build_platform_growth() -> dict[str, Any]:
    """Return daily commit/migration/files-changed metrics from git log."""
    repo = Path(__file__).parent.parent
    try:
        raw = subprocess.check_output(
            ["git", "log", "--format=%ad|%H|%s", "--date=short", "--stat"],
            cwd=repo, text=True, stderr=subprocess.DEVNULL, timeout=5
        )
    except Exception:
        return {"days": [], "totalCommits": 0, "totalMigrations": 0}

    days: dict[str, dict[str, Any]] = {}
    current_date = current_subject = ""
    insertions = deletions = 0

    for line in raw.splitlines():
        if "|" in line and len(line.split("|")) == 3:
            if current_date:
                entry = days.setdefault(current_date, {"date": current_date, "commits": 0, "migrations": 0, "insertions": 0, "deletions": 0, "subjects": []})
                entry["commits"] += 1
                entry["insertions"] += insertions
                entry["deletions"] += deletions
                if current_subject.startswith(("feat", "fix", "perf")):
                    entry["subjects"].append(current_subject[:70])
            current_date, _, current_subject = line.split("|", 2)
            insertions = deletions = 0
        elif "migration" in line.lower() or (current_date and "server/migrations/" in line):
            if current_date:
                days.setdefault(current_date, {"date": current_date, "commits": 0, "migrations": 0, "insertions": 0, "deletions": 0, "subjects": []})
                days[current_date]["migrations"] += 1
        elif "insertion" in line or "deletion" in line:
            m = re.findall(r"(\d+) insertion", line)
            d = re.findall(r"(\d+) deletion", line)
            if m: insertions += int(m[0])
            if d: deletions += int(d[0])

    if current_date:
        entry = days.setdefault(current_date, {"date": current_date, "commits": 0, "migrations": 0, "insertions": 0, "deletions": 0, "subjects": []})
        entry["commits"] += 1
        entry["insertions"] += insertions
        entry["deletions"] += deletions

    sorted_days = sorted(days.values(), key=lambda x: x["date"])
    cumulative = 0
    for d in sorted_days:
        cumulative += d["commits"]
        d["cumulative"] = cumulative

    return {
        "days": sorted_days,
        "totalCommits": cumulative,
        "totalMigrations": sum(d["migrations"] for d in sorted_days),
    }


def _build_agent_context(store: "WorkspaceStore") -> dict[str, Any]:
    """Assemble a complete machine-readable context snapshot for AI agents."""
    repo = Path(__file__).parent.parent

    # Git: recent commits
    try:
        raw = subprocess.check_output(
            ["git", "log", "--format=%ad|%s|%H", "--date=short", "-n", "20"],
            cwd=repo, text=True, stderr=subprocess.DEVNULL, timeout=5
        ).strip().splitlines()
        recent_commits = [
            {"date": p[0], "subject": p[1], "hash": p[2][:8]}
            for line in raw
            if len(p := line.split("|", 2)) == 3
        ]
    except Exception:
        recent_commits = []

    # Git: migration files list
    try:
        migrations_dir = repo / "server" / "migrations"
        migrations = sorted(p.name for p in migrations_dir.glob("*.sql"))
    except Exception:
        migrations = []

    # Tasks from workspace
    ws = store.get()
    tasks = ws.get("tasks", [])
    done_ids = {t["id"] for t in tasks if t["status"] == "done"}

    def task_summary(t: dict) -> dict:
        return {
            "id": t["id"], "title": t["title"],
            "area": t.get("area", ""), "priority": t.get("priority", ""),
            "dependsOn": t.get("dependsOn") or [],
            "description": (t.get("description") or "")[:200],
        }

    ready_tasks = [
        task_summary(t) for t in tasks
        if t["status"] in ("ready", "backlog")
        and t.get("priority") in ("critical", "high")
        and all(d in done_ids for d in (t.get("dependsOn") or []))
    ]
    in_progress = [task_summary(t) for t in tasks if t["status"] == "progress"]
    recently_done = [task_summary(t) for t in tasks if t["status"] == "done"][-10:]

    # Feature guides summary
    try:
        with store._connect() as conn:
            guide_rows = conn.execute("SELECT task_id FROM feature_guides").fetchall()
        guided_ids = {r["task_id"] for r in guide_rows}
    except Exception:
        guided_ids = set()

    implemented = [
        {**task_summary(t), "hasGuide": t["id"] in guided_ids}
        for t in tasks if t["status"] == "done"
    ]

    return {
        "meta": {
            "platform": "RackPilot by Valeronix",
            "description": "AI-native field operations platform — dependency-free Python HTTP + SQLite + Vanilla JS",
            "schemaVersion": store.migration_result.current_version,
            "generatedAt": utc_now(),
        },
        "stack": {
            "backend": "Pure Python stdlib — no pip packages ever",
            "database": "SQLite with numbered transactional migrations (server/migrations/NNN_*.sql)",
            "frontend": "Vanilla HTML/CSS/ES-modules — no bundler, no frameworks",
            "auth": "scrypt passwords, SHA-256 Bearer session tokens, 8h TTL",
            "encryption": "HMAC-CTR stream cipher (stdlib), master key at data/.master_key",
            "testing": "npm run check — 82 Python unittest tests must pass",
            "server": "scripts/serve.sh binds 0.0.0.0:4173",
        },
        "rules": [
            "NEVER install pip packages — stdlib + SQLite only, always",
            "ALL schema changes via numbered migrations — never ALTER TABLE manually",
            "Every public mutation endpoint must check _require_permission()",
            "Every material domain change must produce an audit_log entry",
            "Run npm run check before every commit — all 82 tests must be green",
            "Update schema version constants in test_server.py and test_backup.py after new migration",
            "Commit message: feat/fix/perf/chore(scope): description + Co-Authored-By trailer",
            "X-RackPilot-Role header is dev-mode only — production uses Bearer sessions",
            "Never commit secrets, master_key, .env, or plaintext passwords",
            "Add tasks to workspace kanban for all work done (via SQLite update or API)",
        ],
        "team": {
            "agents": [
                {"id": "claude",   "name": "Claude",   "role": "Strategic Partner",   "model": "claude-sonnet-4-6", "focus": "Architecture, security, AI features, pairing with Codex"},
                {"id": "codex",    "name": "Codex",    "role": "Lead Developer",       "focus": "Feature implementation, refactoring, test coverage"},
                {"id": "scout",    "name": "Scout",    "role": "System Monitor",       "focus": "Health checks, anomaly detection"},
                {"id": "guardian", "name": "Guardian", "role": "Security & Audit",     "focus": "Permission checks, audit trail integrity"},
                {"id": "relay",    "name": "Relay",    "role": "Sync & Integrations",  "focus": "Git sync, webhooks, external connectors"},
                {"id": "analyst",  "name": "Analyst",  "role": "Reports & Analytics",  "focus": "Metrics, daily reports, platform growth chart"},
            ],
            "collaboration": "Claude and Codex are equal partners. Codex picks up ready tasks; Claude handles architecture decisions, security review, and AI integration.",
        },
        "development": {
            "readyTasks": ready_tasks[:15],
            "inProgress": in_progress,
            "recentlyDone": recently_done,
            "recentCommits": recent_commits,
        },
        "platform": {
            "implemented": implemented,
            "migrations": migrations,
            "totalTasks": len(tasks),
            "doneCount": len(done_ids),
        },
        "handoff": {
            "howToStart": [
                "1. Read this context: GET /api/v1/agent/context (or docs/AGENT_CONTEXT.json)",
                "2. Check readyTasks — pick the highest priority item with deps satisfied",
                "3. Implement: edit server/app.py and/or web/app.js and/or web/index.html",
                "4. Add migration if schema changes (server/migrations/NNN_description.sql)",
                "5. Run: npm run check — all tests must pass",
                "6. Update schema version in tests if migration added",
                "7. git add + git commit with proper message",
                "8. Update workspace task status (mark done in kanban)",
            ],
            "keyFiles": {
                "server": "server/app.py",
                "migrations": "server/migrations/",
                "frontend_js": "web/app.js",
                "frontend_html": "web/index.html",
                "frontend_css": "web/styles.css",
                "tests": "tests/",
                "startScript": "scripts/serve.sh",
                "envExample": ".env.example",
            },
        },
    }


def _write_agent_context_file(context: dict, repo: Path) -> None:
    """Write context snapshot to docs/AGENT_CONTEXT.json for filesystem-based agents."""
    out = repo / "docs" / "AGENT_CONTEXT.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(context, ensure_ascii=False, indent=2), encoding="utf-8")


class WorkspaceStore:
    """SQLite-backed tenant workspaces with optimistic concurrency."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.migration_result = MigrationRunner(db_path, MIGRATIONS_DIR).apply()
        self._master_key = _load_or_create_master_key(db_path.parent / ".master_key")
        self._seal_legacy_audit_events()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.db_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=5000")
        connection.execute("PRAGMA synchronous=NORMAL")   # safe with WAL, ~2× faster writes
        connection.execute("PRAGMA cache_size=-8000")     # 8 MB page cache per connection
        connection.execute("PRAGMA temp_store=MEMORY")    # temp tables in RAM
        connection.execute("PRAGMA mmap_size=67108864")   # 64 MB memory-mapped I/O
        connection.create_function("fieldos_audit_hash", 11, audit_event_hash, deterministic=True)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _seal_legacy_audit_events(self) -> None:
        with self._lock, self._connect() as connection:
            rows = connection.execute("""SELECT rowid, organization_id, id, project_id, entity_type, entity_id, action,
                       old_value, new_value, source, created_at, previous_hash, event_hash
                FROM project_change_log ORDER BY organization_id, project_id, rowid""").fetchall()
            previous_by_project: dict[tuple[str, str], str] = {}
            for row in rows:
                key = (row["organization_id"], row["project_id"])
                previous = previous_by_project.get(key, "")
                if row["event_hash"]:
                    previous_by_project[key] = row["event_hash"]
                    continue
                event_hash = audit_event_hash(row["organization_id"], row["id"], row["project_id"], row["entity_type"], row["entity_id"], row["action"], row["old_value"], row["new_value"], row["source"], row["created_at"], previous)
                connection.execute("UPDATE project_change_log SET previous_hash = ?, event_hash = ? WHERE organization_id = ? AND id = ?", (previous, event_hash, row["organization_id"], row["id"]))
                previous_by_project[key] = event_hash

    def verify_audit_integrity(self, organization_id: str, project_id: str | None = None) -> dict[str, Any]:
        query = """SELECT rowid, organization_id, id, project_id, entity_type, entity_id, action,
                          old_value, new_value, source, created_at, previous_hash, event_hash
                   FROM project_change_log WHERE organization_id = ?"""
        parameters: list[Any] = [organization_id]
        if project_id:
            query += " AND project_id = ?"
            parameters.append(project_id)
        query += " ORDER BY project_id, rowid"
        with self._connect() as connection:
            rows = connection.execute(query, parameters).fetchall()
        previous_by_project: dict[str, str] = {}
        failures: list[str] = []
        for row in rows:
            previous = previous_by_project.get(row["project_id"], "")
            expected = audit_event_hash(row["organization_id"], row["id"], row["project_id"], row["entity_type"], row["entity_id"], row["action"], row["old_value"], row["new_value"], row["source"], row["created_at"], previous)
            if row["previous_hash"] != previous or row["event_hash"] != expected:
                failures.append(row["id"])
            previous_by_project[row["project_id"]] = row["event_hash"]
        return {"organizationId": organization_id, "projectId": project_id, "valid": not failures, "eventCount": len(rows), "failureCount": len(failures), "verifiedAt": utc_now()}

    def get(self, organization_id: str = DEFAULT_ORGANIZATION_ID) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT revision, payload, updated_at FROM workspace_states WHERE organization_id = ?",
                (organization_id,),
            ).fetchone()
        if row is None:
            return {"initialized": False, "organizationId": organization_id, "revision": 0, "tasks": [], "audit": [], "updatedAt": None}
        payload = json.loads(row["payload"])
        return {
            "initialized": True,
            "organizationId": organization_id,
            "revision": row["revision"],
            "tasks": payload.get("tasks", []),
            "audit": payload.get("audit", []),
            "updatedAt": row["updated_at"],
        }

    def etag(self, organization_id: str = DEFAULT_ORGANIZATION_ID) -> str:
        """Cheap revision-only query for ETag — avoids deserialising the full payload."""
        with self._connect() as connection:
            row = connection.execute(
                "SELECT revision FROM workspace_states WHERE organization_id = ?",
                (organization_id,),
            ).fetchone()
        rev = row["revision"] if row else 0
        return f'"{organization_id}:{rev}"'

    def save(self, tasks: list[dict[str, Any]], audit: list[dict[str, Any]], expected_revision: int, organization_id: str = DEFAULT_ORGANIZATION_ID) -> dict[str, Any]:
        payload = json.dumps({"tasks": tasks, "audit": audit[-30:]}, ensure_ascii=False, separators=(",", ":"))
        updated_at = utc_now()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT revision FROM workspace_states WHERE organization_id = ?",
                (organization_id,),
            ).fetchone()
            current_revision = row["revision"] if row else 0
            if expected_revision != current_revision:
                connection.rollback()
                raise RevisionConflict(current_revision)
            next_revision = current_revision + 1
            connection.execute(
                """
                INSERT INTO workspace_states (organization_id, revision, payload, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(organization_id) DO UPDATE SET
                    revision = excluded.revision,
                    payload = excluded.payload,
                    updated_at = excluded.updated_at
                """,
                (organization_id, next_revision, payload, updated_at),
            )
            connection.commit()
        return {"organizationId": organization_id, "revision": next_revision, "updatedAt": updated_at}

    def get_idempotency(self, key: str, organization_id: str = DEFAULT_ORGANIZATION_ID) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT request_hash, status, response_json FROM idempotency_records WHERE organization_id = ? AND key = ?",
                (organization_id, key),
            ).fetchone()
        if row is None:
            return None
        return {"requestHash": row["request_hash"], "status": row["status"], "response": json.loads(row["response_json"])}

    def save_idempotency(self, key: str, request_hash: str, status: int, response: dict[str, Any], organization_id: str = DEFAULT_ORGANIZATION_ID) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO idempotency_records
                (organization_id, key, request_hash, status, response_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (organization_id, key, request_hash, status, json.dumps(response, ensure_ascii=False), utc_now()),
            )

    def organization_exists(self, organization_id: str) -> bool:
        with self._connect() as connection:
            return connection.execute(
                "SELECT 1 FROM organizations WHERE id = ? AND status = 'active'",
                (organization_id,),
            ).fetchone() is not None

    def list_organizations(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, name, slug, status, created_at FROM organizations ORDER BY name"
            ).fetchall()
        return [{"id": row["id"], "name": row["name"], "slug": row["slug"], "status": row["status"], "createdAt": row["created_at"]} for row in rows]

    def record_compute_node(self, organization_id: str, node_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        name, hostname = payload.get("name"), payload.get("hostname")
        metric = payload.get("metric")
        if not isinstance(name,str) or not name.strip() or len(name)>120 or not isinstance(hostname,str) or not hostname.strip() or len(hostname)>255:
            raise ValueError("Valid node name and hostname are required")
        if not isinstance(metric,dict): raise ValueError("metric is required")
        cpu=float(metric.get("cpuPercent",0)); memory_used=int(metric.get("memoryUsedBytes",0)); memory_total=int(metric.get("memoryTotalBytes",0)); load=float(metric.get("loadAverage",0))
        battery=metric.get("batteryPercent"); battery=None if battery is None else float(battery)
        if not 0<=cpu<=100 or memory_used<0 or memory_total<0 or memory_used>memory_total or load<0 or (battery is not None and not 0<=battery<=100): raise ValueError("Invalid node metrics")
        compute_enabled=bool(payload.get("computeEnabled",False)); now=utc_now(); metric_id=str(uuid.uuid4())
        with self._lock,self._connect() as connection:
            connection.execute("""INSERT INTO compute_nodes
                (organization_id,id,name,hostname,platform,architecture,total_memory_bytes,agent_opt_in,compute_enabled,agent_version,last_seen_at,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,id) DO UPDATE SET
                name=excluded.name,hostname=excluded.hostname,platform=excluded.platform,architecture=excluded.architecture,
                total_memory_bytes=excluded.total_memory_bytes,agent_opt_in=excluded.agent_opt_in,
                compute_enabled=CASE WHEN excluded.agent_opt_in=0 THEN 0 ELSE compute_nodes.compute_enabled END,agent_version=excluded.agent_version,
                last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at""",
                (organization_id,node_id,name.strip(),hostname.strip(),str(payload.get("platform","macOS"))[:64],str(payload.get("architecture","arm64"))[:32],memory_total,1 if compute_enabled else 0,1 if compute_enabled else 0,str(payload.get("agentVersion","unknown"))[:32],now,now,now))
            connection.execute("""INSERT INTO compute_node_metrics
                (organization_id,id,node_id,cpu_percent,memory_used_bytes,memory_total_bytes,battery_percent,power_source,charging,thermal_state,load_average,recorded_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (organization_id,metric_id,node_id,cpu,memory_used,memory_total,battery,str(metric.get("powerSource","unknown"))[:32],None if metric.get("charging") is None else (1 if metric.get("charging") else 0),str(metric.get("thermalState","unknown"))[:32],load,now))
            connection.execute("""DELETE FROM compute_node_metrics WHERE organization_id=? AND node_id=? AND id NOT IN
                (SELECT id FROM compute_node_metrics WHERE organization_id=? AND node_id=? ORDER BY recorded_at DESC LIMIT 720)""",(organization_id,node_id,organization_id,node_id))
        return {"ok":True,"nodeId":node_id,"recordedAt":now}

    def list_compute_nodes(self, organization_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            nodes=connection.execute("SELECT * FROM compute_nodes WHERE organization_id=? ORDER BY name",(organization_id,)).fetchall()
            metrics=connection.execute("""SELECT * FROM (
                SELECT metric.*,ROW_NUMBER() OVER(PARTITION BY node_id ORDER BY recorded_at DESC) AS sequence
                FROM compute_node_metrics metric WHERE organization_id=?
            ) WHERE sequence<=60 ORDER BY node_id,recorded_at""",(organization_id,)).fetchall()
        metrics_by_node: dict[str,list[dict[str,Any]]]={}
        for metric in metrics:
            metrics_by_node.setdefault(metric["node_id"],[]).append({"cpuPercent":metric["cpu_percent"],"memoryUsedBytes":metric["memory_used_bytes"],"memoryTotalBytes":metric["memory_total_bytes"],"batteryPercent":metric["battery_percent"],"powerSource":metric["power_source"],"charging":None if metric["charging"] is None else bool(metric["charging"]),"thermalState":metric["thermal_state"],"loadAverage":metric["load_average"],"recordedAt":metric["recorded_at"]})
        now=datetime.now(timezone.utc)
        return [{"id":node["id"],"name":node["name"],"hostname":node["hostname"],"platform":node["platform"],"architecture":node["architecture"],"totalMemoryBytes":node["total_memory_bytes"],"agentOptIn":bool(node["agent_opt_in"]),"computeEnabled":bool(node["compute_enabled"]),"agentVersion":node["agent_version"],"lastSeenAt":node["last_seen_at"],"online":(now-datetime.fromisoformat(node["last_seen_at"])).total_seconds()<20,"metrics":metrics_by_node.get(node["id"],[])} for node in nodes]

    def set_compute_node_enabled(self,organization_id: str,node_id: str,enabled: bool) -> dict[str,Any]:
        with self._lock,self._connect() as connection:
            node=connection.execute("SELECT agent_opt_in FROM compute_nodes WHERE organization_id=? AND id=?",(organization_id,node_id)).fetchone()
            if node is None: raise LookupError("Compute node not found")
            if enabled and not node["agent_opt_in"]: raise ValueError("Node agent has not opted in to compute")
            connection.execute("UPDATE compute_nodes SET compute_enabled=?,updated_at=? WHERE organization_id=? AND id=?",(1 if enabled else 0,utc_now(),organization_id,node_id))
        return {"nodeId":node_id,"computeEnabled":enabled}

    def get_git_sync_settings(self,organization_id: str) -> dict[str,Any]:
        with self._connect() as connection:
            row=connection.execute("""SELECT remote_url,branch_name,commit_strategy,auto_commit,auto_push,include_docs,
                last_commit_hash,last_sync_status,last_sync_message,updated_at FROM git_sync_settings WHERE organization_id=?""",(organization_id,)).fetchone()
        if row is None:
            return {"remoteUrl":"","branchName":"main","commitStrategy":"per_task","autoCommit":True,"autoPush":False,"includeDocs":True,"lastCommitHash":None,"lastSyncStatus":"not_configured","lastSyncMessage":"Git remote is not configured","updatedAt":None,"secretMode":"external_credential"}
        return {"remoteUrl":row["remote_url"],"branchName":row["branch_name"],"commitStrategy":row["commit_strategy"],"autoCommit":bool(row["auto_commit"]),"autoPush":bool(row["auto_push"]),"includeDocs":bool(row["include_docs"]),"lastCommitHash":row["last_commit_hash"],"lastSyncStatus":row["last_sync_status"],"lastSyncMessage":row["last_sync_message"],"updatedAt":row["updated_at"],"secretMode":"external_credential"}

    def save_git_sync_settings(self,organization_id: str,payload: dict[str,Any]) -> dict[str,Any]:
        remote_url=str(payload.get("remoteUrl","")).strip()
        branch_name=str(payload.get("branchName","main")).strip() or "main"
        strategy=payload.get("commitStrategy","per_task")
        if len(remote_url)>500: raise ValueError("Remote URL is too long")
        if remote_url and not (remote_url.startswith("git@") or remote_url.startswith("https://")): raise ValueError("Remote URL must use git@ SSH or https://")
        if not re.fullmatch(r"[A-Za-z0-9._/-]{1,120}",branch_name): raise ValueError("Invalid branch name")
        if strategy not in {"manual","per_task","per_release"}: raise ValueError("Invalid commit strategy")
        auto_commit=bool(payload.get("autoCommit",True)); auto_push=bool(payload.get("autoPush",False)); include_docs=bool(payload.get("includeDocs",True))
        status="configured" if remote_url else "not_configured"
        message="Git sync configured; credentials are managed outside RackPilot." if remote_url else "Git remote is not configured"
        now=utc_now()
        with self._lock,self._connect() as connection:
            connection.execute("""INSERT INTO git_sync_settings
                (organization_id,remote_url,branch_name,commit_strategy,auto_commit,auto_push,include_docs,last_sync_status,last_sync_message,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET
                remote_url=excluded.remote_url,branch_name=excluded.branch_name,commit_strategy=excluded.commit_strategy,
                auto_commit=excluded.auto_commit,auto_push=excluded.auto_push,include_docs=excluded.include_docs,
                last_sync_status=excluded.last_sync_status,last_sync_message=excluded.last_sync_message,updated_at=excluded.updated_at""",
                (organization_id,remote_url,branch_name,strategy,1 if auto_commit else 0,1 if auto_push else 0,1 if include_docs else 0,status,message,now))
        return self.get_git_sync_settings(organization_id)

    def get_platform_settings(self,organization_id: str) -> dict[str,Any]:
        with self._connect() as connection:
            row=connection.execute("""SELECT default_language,timezone,role_mode,telemetry_mode,log_retention_days,updated_at
                FROM platform_settings WHERE organization_id=?""",(organization_id,)).fetchone()
        if row is None:
            return {"defaultLanguage":"en","timezone":"America/Halifax","roleMode":"planned","telemetryMode":"standard","logRetentionDays":365,"updatedAt":None}
        return {"defaultLanguage":row["default_language"],"timezone":row["timezone"],"roleMode":row["role_mode"],"telemetryMode":row["telemetry_mode"],"logRetentionDays":row["log_retention_days"],"updatedAt":row["updated_at"]}

    def save_platform_settings(self,organization_id: str,payload: dict[str,Any]) -> dict[str,Any]:
        language=payload.get("defaultLanguage","en")
        timezone_name=str(payload.get("timezone","America/Halifax")).strip() or "America/Halifax"
        role_mode=payload.get("roleMode","planned")
        telemetry_mode=payload.get("telemetryMode","standard")
        retention=int(payload.get("logRetentionDays",365))
        if language not in {"en","ru"}: raise ValueError("Invalid default language")
        if not re.fullmatch(r"[A-Za-z0-9_./+-]{1,80}",timezone_name): raise ValueError("Invalid timezone")
        if role_mode not in {"planned","enforced"}: raise ValueError("Invalid role mode")
        if telemetry_mode not in {"minimal","standard","diagnostic"}: raise ValueError("Invalid telemetry mode")
        if retention < 30 or retention > 3650: raise ValueError("Log retention must be between 30 and 3650 days")
        now=utc_now()
        with self._lock,self._connect() as connection:
            connection.execute("""INSERT INTO platform_settings
                (organization_id,default_language,timezone,role_mode,telemetry_mode,log_retention_days,updated_at)
                VALUES (?,?,?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET
                default_language=excluded.default_language,timezone=excluded.timezone,role_mode=excluded.role_mode,
                telemetry_mode=excluded.telemetry_mode,log_retention_days=excluded.log_retention_days,updated_at=excluded.updated_at""",
                (organization_id,language,timezone_name,role_mode,telemetry_mode,retention,now))
        return self.get_platform_settings(organization_id)

    def list_logs(self,organization_id: str,filters: dict[str,Any] | None=None) -> dict[str,Any]:
        filters=filters or {}
        source=str(filters.get("source","all"))
        project_id=filters.get("projectId")
        entity_type=filters.get("entityType")
        query=str(filters.get("q","")).strip().lower()
        limit=max(1,min(int(filters.get("limit",100)),500))
        events: list[dict[str,Any]]=[]
        if source in {"all","project"}:
            sql="""SELECT log.project_id,project.code AS project_code,project.name AS project_name,
                          log.entity_type,log.entity_id,log.action,log.old_value,log.new_value,log.source,log.created_at
                   FROM project_change_log log
                   LEFT JOIN projects project ON project.organization_id=log.organization_id AND project.id=log.project_id
                   WHERE log.organization_id=?"""
            parameters: list[Any]=[organization_id]
            if isinstance(project_id,str) and project_id:
                sql+=" AND log.project_id=?"; parameters.append(project_id)
            if isinstance(entity_type,str) and entity_type and entity_type!="all":
                sql+=" AND log.entity_type=?"; parameters.append(entity_type)
            sql+=" ORDER BY log.created_at DESC LIMIT ?"; parameters.append(limit)
            with self._connect() as connection:
                rows=connection.execute(sql,parameters).fetchall()
            for row in rows:
                new_value=json.loads(row["new_value"] or "{}")
                old_value=json.loads(row["old_value"] or "{}")
                message=f"{row['entity_type']} {row['action']}"
                if isinstance(new_value,dict):
                    message=new_value.get("title") or new_value.get("name") or new_value.get("code") or message
                events.append({"source":"project","category":"project","projectId":row["project_id"],"projectCode":row["project_code"],"projectName":row["project_name"],"entityType":row["entity_type"],"entityId":row["entity_id"],"action":row["action"],"message":str(message),"oldValue":old_value,"newValue":new_value,"actor":row["source"],"createdAt":row["created_at"]})
        if source in {"all","workspace"}:
            workspace = self.get(organization_id)
            for event in workspace.get("audit",[])[:limit]:
                events.append({"source":"workspace","category":"development","projectId":None,"projectCode":None,"projectName":"Development Workspace","entityType":"task","entityId":None,"action":"audit","message":str(event.get("text","")),"oldValue":{},"newValue":{},"actor":"workspace","createdAt":event.get("at")})
        if query:
            events=[event for event in events if query in json.dumps(event,ensure_ascii=False).lower()]
        events=sorted(events,key=lambda value: str(value.get("createdAt") or ""),reverse=True)[:limit]
        return {"organizationId":organization_id,"logs":events,"count":len(events),"filters":{"source":source,"projectId":project_id,"entityType":entity_type,"q":query,"limit":limit}}

    def get_development_agent_status(self,organization_id: str) -> dict[str,Any]:
        with self._connect() as connection:
            row=connection.execute("SELECT status,message,needs_action,continuation_requested,updated_at FROM development_agent_status WHERE organization_id=?",(organization_id,)).fetchone()
        if row is None: return {"status":"idle","message":"Codex не запущен","needsAction":False,"continuationRequested":False,"updatedAt":None}
        return {"status":row["status"],"message":row["message"],"needsAction":bool(row["needs_action"]),"continuationRequested":bool(row["continuation_requested"]),"updatedAt":row["updated_at"]}

    def set_development_agent_status(self,organization_id: str,payload: dict[str,Any]) -> dict[str,Any]:
        status=payload.get("status");message=payload.get("message","")
        if status not in {"working","idle","waiting","blocked","limit"}: raise ValueError("Invalid agent status")
        if not isinstance(message,str) or len(message)>300: raise ValueError("Invalid agent message")
        now=utc_now()
        with self._lock,self._connect() as connection:
            connection.execute("""INSERT INTO development_agent_status (organization_id,status,message,needs_action,continuation_requested,updated_at)
                VALUES (?,?,?,?,0,?) ON CONFLICT(organization_id) DO UPDATE SET status=excluded.status,message=excluded.message,
                needs_action=excluded.needs_action,continuation_requested=0,updated_at=excluded.updated_at""",
                (organization_id,status,message,1 if payload.get("needsAction") else 0,now))
        return self.get_development_agent_status(organization_id)

    def request_development_continuation(self,organization_id: str) -> dict[str,Any]:
        now=utc_now()
        with self._lock,self._connect() as connection:
            connection.execute("""INSERT INTO development_agent_status (organization_id,status,message,needs_action,continuation_requested,updated_at)
                VALUES (?,'waiting','Пользователь запросил продолжение разработки',0,1,?) ON CONFLICT(organization_id) DO UPDATE SET
                continuation_requested=1,message='Пользователь запросил продолжение разработки',updated_at=excluded.updated_at""",(organization_id,now))
        return self.get_development_agent_status(organization_id)

    def create_organization(self, organization_id: str, name: str, slug: str) -> None:
        with self._connect() as connection:
            now = utc_now()
            connection.execute(
                "INSERT INTO organizations (id, name, slug, status, created_at) VALUES (?, ?, ?, 'active', ?)",
                (organization_id, name, slug, now),
            )
            connection.executemany(
                """INSERT INTO work_types
                   (organization_id, id, code, name, color, position, active, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, 1, ?)""",
                [(organization_id, type_id, code, type_name, color, position, now) for type_id, code, type_name, color, position in DEFAULT_WORK_TYPES],
            )
            connection.executemany(
                """INSERT INTO work_type_actions
                   (organization_id, id, work_type_id, code, name, position)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                [(organization_id, action_id, work_type_id, code, action_name, position) for action_id, work_type_id, code, action_name, position in DEFAULT_WORK_ACTIONS],
            )

    def list_workflow_configuration(self,organization_id: str) -> list[dict[str,Any]]:
        with self._connect() as connection:
            types=connection.execute("SELECT id,code,name,color,position,active,version FROM work_types WHERE organization_id=? ORDER BY position",(organization_id,)).fetchall()
            actions=connection.execute("SELECT id,work_type_id,code,name,position,active,version FROM work_type_actions WHERE organization_id=? ORDER BY work_type_id,position",(organization_id,)).fetchall()
        return [{"id":value["id"],"code":value["code"],"name":value["name"],"color":value["color"],"position":value["position"],"active":bool(value["active"]),"version":value["version"],"actions":[{"id":action["id"],"code":action["code"],"name":action["name"],"position":action["position"],"active":bool(action["active"]),"version":action["version"]} for action in actions if action["work_type_id"]==value["id"]]} for value in types]

    def save_workflow_configuration(self,organization_id: str,payload: dict[str,Any],work_type_id: str | None=None) -> dict[str,Any]:
        code,name,color=payload.get("code"),payload.get("name"),payload.get("color","#7c8cff");actions=payload.get("actions",[])
        if not isinstance(code,str) or not code.strip() or len(code)>48 or not all(character.isalnum() or character in "_-" for character in code): raise ValueError("Invalid work type code")
        if not isinstance(name,str) or not name.strip() or len(name)>120: raise ValueError("Invalid work type name")
        if not isinstance(color,str) or not re.fullmatch(r"#[0-9A-Fa-f]{6}",color): raise ValueError("Color must use #RRGGBB")
        if not isinstance(actions,list) or not actions or len(actions)>30: raise ValueError("At least one action is required")
        normalized=[];seen=set()
        for index,action in enumerate(actions):
            if not isinstance(action,dict): raise ValueError("Invalid action")
            action_code,action_name=action.get("code"),action.get("name")
            if not isinstance(action_code,str) or not action_code.strip() or len(action_code)>48 or not all(character.isalnum() or character in "_-" for character in action_code) or action_code in seen: raise ValueError("Invalid or duplicate action code")
            if not isinstance(action_name,str) or not action_name.strip() or len(action_name)>120: raise ValueError("Invalid action name")
            seen.add(action_code);normalized.append((action_code.strip(),action_name.strip(),index))
        now=utc_now()
        with self._lock,self._connect() as connection:
            if work_type_id:
                current=connection.execute("SELECT version FROM work_types WHERE organization_id=? AND id=?",(organization_id,work_type_id)).fetchone()
                if current is None: raise LookupError("Work type not found")
                expected=payload.get("expectedVersion")
                if expected!=current["version"]: raise EntityVersionConflict(current["version"])
                connection.execute("UPDATE work_types SET code=?,name=?,color=?,version=version+1,updated_at=? WHERE organization_id=? AND id=? AND version=?",(code.strip(),name.strip(),color.lower(),now,organization_id,work_type_id,expected))
                existing={row["code"]:row for row in connection.execute("SELECT id,code FROM work_type_actions WHERE organization_id=? AND work_type_id=?",(organization_id,work_type_id))}
            else:
                work_type_id=str(uuid.uuid4());position=connection.execute("SELECT COALESCE(MAX(position),-1)+1 AS value FROM work_types WHERE organization_id=?",(organization_id,)).fetchone()["value"]
                try: connection.execute("INSERT INTO work_types (organization_id,id,code,name,color,position,active,created_at,version,updated_at) VALUES (?,?,?,?,?,?,1,?,1,?)",(organization_id,work_type_id,code.strip(),name.strip(),color.lower(),position,now,now))
                except sqlite3.IntegrityError as error: raise ValueError("Work type code already exists") from error
                existing={}
            for action_code,action_name,position in normalized:
                if action_code in existing:
                    connection.execute("UPDATE work_type_actions SET name=?,position=?,active=1,version=version+1 WHERE organization_id=? AND id=?",(action_name,position,organization_id,existing[action_code]["id"]))
                else:
                    connection.execute("INSERT INTO work_type_actions (organization_id,id,work_type_id,code,name,position,active,version) VALUES (?,?,?,?,?,?,1,1)",(organization_id,str(uuid.uuid4()),work_type_id,action_code,action_name,position))
        return next(value for value in self.list_workflow_configuration(organization_id) if value["id"]==work_type_id)

    def list_custom_field_definitions(self,organization_id: str) -> list[dict[str,Any]]:
        with self._connect() as connection:
            rows=connection.execute("SELECT id,scope,code,label,data_type,options_json,required,position,active,version FROM custom_field_definitions WHERE organization_id=? ORDER BY scope,position",(organization_id,)).fetchall()
        return [{"id":row["id"],"scope":row["scope"],"code":row["code"],"label":row["label"],"dataType":row["data_type"],"options":json.loads(row["options_json"]),"required":bool(row["required"]),"position":row["position"],"active":bool(row["active"]),"version":row["version"]} for row in rows]

    def save_custom_field_definition(self,organization_id: str,payload: dict[str,Any],definition_id: str | None=None) -> dict[str,Any]:
        scope,code,label,data_type=payload.get("scope"),payload.get("code"),payload.get("label"),payload.get("dataType")
        options=payload.get("options",[])
        if scope not in {"location","unit"}: raise ValueError("Invalid custom field scope")
        if not isinstance(code,str) or not code.strip() or len(code)>48 or not all(character.isalnum() or character in "_-" for character in code): raise ValueError("Invalid custom field code")
        if not isinstance(label,str) or not label.strip() or len(label)>120: raise ValueError("Invalid custom field label")
        if data_type not in {"text","number","boolean","date","select"}: raise ValueError("Invalid custom field type")
        if not isinstance(options,list) or len(options)>50 or any(not isinstance(value,str) or not value.strip() or len(value)>120 for value in options): raise ValueError("Invalid custom field options")
        options=list(dict.fromkeys(value.strip() for value in options));now=utc_now()
        with self._lock,self._connect() as connection:
            if definition_id:
                current=connection.execute("SELECT version FROM custom_field_definitions WHERE organization_id=? AND id=?",(organization_id,definition_id)).fetchone()
                if current is None: raise LookupError("Custom field not found")
                expected=payload.get("expectedVersion")
                if expected!=current["version"]: raise EntityVersionConflict(current["version"])
                try: connection.execute("""UPDATE custom_field_definitions SET scope=?,code=?,label=?,data_type=?,options_json=?,required=?,active=?,version=version+1,updated_at=? WHERE organization_id=? AND id=? AND version=?""",(scope,code.strip(),label.strip(),data_type,json.dumps(options,ensure_ascii=False),1 if payload.get("required") else 0,1 if payload.get("active",True) else 0,now,organization_id,definition_id,expected))
                except sqlite3.IntegrityError as error: raise ValueError("Custom field code already exists in this scope") from error
            else:
                definition_id=str(uuid.uuid4());position=connection.execute("SELECT COALESCE(MAX(position),-1)+1 AS value FROM custom_field_definitions WHERE organization_id=? AND scope=?",(organization_id,scope)).fetchone()["value"]
                try: connection.execute("""INSERT INTO custom_field_definitions (organization_id,id,scope,code,label,data_type,options_json,required,position,active,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?)""",(organization_id,definition_id,scope,code.strip(),label.strip(),data_type,json.dumps(options,ensure_ascii=False),1 if payload.get("required") else 0,position,now,now))
                except sqlite3.IntegrityError as error: raise ValueError("Custom field code already exists in this scope") from error
        return next(value for value in self.list_custom_field_definitions(organization_id) if value["id"]==definition_id)

    def validate_custom_fields(self,organization_id: str,scope: str,values: dict[str,Any]) -> None:
        definitions=[value for value in self.list_custom_field_definitions(organization_id) if value["scope"]==scope and value["active"]]
        for definition in definitions:
            value=values.get(definition["code"])
            if definition["required"] and (value is None or value==""): raise ValueError(f"Custom field {definition['label']} is required")
            if value is None or value=="": continue
            if definition["dataType"]=="number" and (isinstance(value,bool) or not isinstance(value,(int,float))): raise ValueError(f"Custom field {definition['label']} must be a number")
            if definition["dataType"]=="boolean" and not isinstance(value,bool): raise ValueError(f"Custom field {definition['label']} must be boolean")
            if definition["dataType"] in {"text","date","select"} and not isinstance(value,str): raise ValueError(f"Custom field {definition['label']} must be text")
            if definition["dataType"]=="select" and value not in definition["options"]: raise ValueError(f"Invalid option for {definition['label']}")

    def list_projects(self, organization_id: str = DEFAULT_ORGANIZATION_ID) -> list[dict[str, Any]]:
        workspace = self.get(organization_id)
        all_tasks = workspace["tasks"]
        with self._connect() as connection:
            projects = connection.execute(
                """SELECT id, code, name, description, status, priority, kind, start_date,
                          target_date, version, created_at, updated_at
                   FROM projects WHERE organization_id = ?
                   ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                            WHEN 'medium' THEN 2 ELSE 3 END, created_at""",
                (organization_id,),
            ).fetchall()
            stages = connection.execute(
                """SELECT id, project_id, code, name, task_area, position, status
                   FROM project_stages WHERE organization_id = ?
                   ORDER BY project_id, position""",
                (organization_id,),
            ).fetchall()
            buildings = connection.execute(
                "SELECT id, project_id, code, name, address, status, version FROM buildings WHERE organization_id = ? ORDER BY project_id, name",
                (organization_id,),
            ).fetchall()
            work_items = connection.execute(
                """SELECT id, project_id, building_id, stage_id, work_type_id, title, description, status,
                          priority, assignee_user_id, start_date, due_date, estimated_minutes,
                          actual_minutes, version
                   FROM project_work_items WHERE organization_id = ? ORDER BY project_id, created_at""",
                (organization_id,),
            ).fetchall()
            dependencies = connection.execute(
                """SELECT project_id, dependent_item_id, predecessor_item_id
                   FROM work_item_dependencies WHERE organization_id = ?""",
                (organization_id,),
            ).fetchall()
            work_types = connection.execute(
                """SELECT id, code, name, color, position
                   FROM work_types WHERE organization_id = ? AND active = 1 ORDER BY position""",
                (organization_id,),
            ).fetchall()
            work_type_scopes = connection.execute(
                """SELECT project_id, work_type_id FROM project_work_type_scopes
                   WHERE organization_id = ? AND active = 1""",
                (organization_id,),
            ).fetchall()
            activity = connection.execute(
                """SELECT project_id, entity_type, entity_id, action, new_value, created_at
                   FROM project_change_log WHERE organization_id = ? ORDER BY created_at DESC""",
                (organization_id,),
            ).fetchall()
            work_actions = connection.execute(
                """SELECT id, work_type_id, code, name, position FROM work_type_actions
                   WHERE organization_id = ? AND active=1 ORDER BY work_type_id, position""", (organization_id,)
            ).fetchall()
            locations = connection.execute(
                """SELECT id, project_id, building_id, parent_location_id, code, name, kind, suite_total, custom_fields, version
                   FROM project_locations WHERE organization_id = ? ORDER BY project_id, code""", (organization_id,)
            ).fetchall()
            daily_updates = connection.execute(
                """SELECT id, project_id, location_id, work_type_id, action_id, work_date, status,
                          percent_complete, quantity_completed, comments, version, created_at, updated_at
                   FROM daily_progress_entries WHERE organization_id = ? ORDER BY work_date DESC, created_at DESC""", (organization_id,)
            ).fetchall()
            issues = connection.execute(
                """SELECT id, project_id, progress_entry_id, location_id, work_type_id, title,
                          description, severity, status, version, created_at
                   FROM project_issues WHERE organization_id = ? ORDER BY created_at DESC""", (organization_id,)
            ).fetchall()
            units = connection.execute(
                """SELECT id,project_id,location_id,code,name,position,notes,custom_fields,version FROM project_units
                   WHERE organization_id=? AND active=1 ORDER BY location_id,position""", (organization_id,)
            ).fetchall()
            unit_progress_rows = connection.execute(
                """SELECT id,project_id,location_id,unit_id,work_type_id,action_id,status,completed_on,comments,version,updated_at
                   FROM unit_progress WHERE organization_id=?""", (organization_id,)
            ).fetchall()
            audio_rows = connection.execute(
                """SELECT location_id,project_id,zone_type,speaker_count,display_count,source_description,equipment_notes,version
                   FROM audio_zone_details WHERE organization_id=?""", (organization_id,)
            ).fetchall()
        stages_by_project: dict[str, list[sqlite3.Row]] = {}
        for stage in stages:
            stages_by_project.setdefault(stage["project_id"], []).append(stage)
        scoped_work_type_ids_by_project: dict[str, set[str]] = {}
        for scope in work_type_scopes:
            scoped_work_type_ids_by_project.setdefault(scope["project_id"], set()).add(scope["work_type_id"])
        active_work_type_ids = {work_type["id"] for work_type in work_types}
        result = []
        for project in projects:
            project_id = project["id"]
            scoped_work_type_ids = scoped_work_type_ids_by_project.get(project_id, active_work_type_ids)
            project_work_types = [work_type for work_type in work_types if work_type["id"] in scoped_work_type_ids]
            development_tasks = [
                task for task in all_tasks
                if task.get("projectId") == project_id
                or (project_id == "fieldos-platform" and not task.get("projectId"))
            ]
            project_items = [dict(item) for item in work_items if item["project_id"] == project_id]
            project_buildings = [dict(building) for building in buildings if building["project_id"] == project_id]
            project_locations = [dict(location) for location in locations if location["project_id"] == project_id]
            children_by_parent: dict[str | None, list[dict[str, Any]]] = {}
            for location in project_locations:
                children_by_parent.setdefault(location["parent_location_id"], []).append(location)
            ordered_locations: list[dict[str, Any]] = []
            def append_location_branch(parent_id: str | None, depth: int) -> None:
                for child in sorted(children_by_parent.get(parent_id, []), key=lambda value: value["code"]):
                    child["depth"] = depth
                    ordered_locations.append(child)
                    append_location_branch(child["id"], depth + 1)
            append_location_branch(None, 0)
            for orphan in project_locations:
                if orphan not in ordered_locations:
                    orphan["depth"] = 0
                    ordered_locations.append(orphan)
            project_locations = ordered_locations
            project_updates = [dict(update) for update in daily_updates if update["project_id"] == project_id]
            project_issues = [dict(issue) for issue in issues if issue["project_id"] == project_id]
            project_units = [dict(value) for value in units if value["project_id"] == project_id]
            project_unit_progress = [dict(value) for value in unit_progress_rows if value["project_id"] == project_id]
            audio_by_location = {value["location_id"]: dict(value) for value in audio_rows if value["project_id"] == project_id}
            status_by_item = {item["id"]: item["status"] for item in project_items}
            dependency_map: dict[str, list[str]] = {}
            for dependency in dependencies:
                if dependency["project_id"] == project_id:
                    dependency_map.setdefault(dependency["dependent_item_id"], []).append(dependency["predecessor_item_id"])
            for item in project_items:
                item["depends_on"] = dependency_map.get(item["id"], [])
                item["blocked_by"] = [predecessor for predecessor in item["depends_on"] if status_by_item.get(predecessor) != "done"]
                item["effective_status"] = "blocked" if item["status"] != "done" and item["blocked_by"] else item["status"]
            task_states = [task.get("status") for task in development_tasks] + [item["effective_status"] for item in project_items]
            task_progress_values = [TASK_PROGRESS.get(status, 0) for status in task_states]
            project_stages = []
            for stage in stages_by_project.get(project_id, []):
                stage_states = [task.get("status") for task in development_tasks if stage["task_area"] and task.get("area") == stage["task_area"]]
                stage_states += [item["effective_status"] for item in project_items if item["stage_id"] == stage["id"]]
                stage_progress = round(sum(TASK_PROGRESS.get(status, 0) for status in stage_states) / len(stage_states)) if stage_states else 0
                project_stages.append({
                    "id": stage["id"], "code": stage["code"], "name": stage["name"],
                    "status": stage["status"], "position": stage["position"],
                    "taskCount": len(stage_states), "progress": stage_progress,
                })
            work_type_progress = []
            for work_type in project_work_types:
                typed_items = [item for item in project_items if item["work_type_id"] == work_type["id"]]
                typed_states = [item["effective_status"] for item in typed_items]
                latest_by_scope: dict[tuple[str, str], dict[str, Any]] = {}
                for update in project_updates:
                    if update["work_type_id"] == work_type["id"]:
                        latest_by_scope.setdefault((update["location_id"], update["action_id"]), update)
                daily_values = [update["percent_complete"] for update in latest_by_scope.values()]
                unit_values = [UNIT_PROGRESS.get(progress["status"], 0) for progress in project_unit_progress if progress["work_type_id"] == work_type["id"]]
                task_values = [TASK_PROGRESS.get(status, 0) for status in typed_states]
                evidence_values = daily_values + unit_values + task_values
                typed_progress = round(sum(evidence_values) / len(evidence_values)) if evidence_values else 0
                work_type_progress.append({
                    "id": work_type["id"], "code": work_type["code"], "name": work_type["name"],
                    "color": work_type["color"], "taskCount": len(typed_items), "progress": typed_progress,
                    "done": sum(status == "done" for status in typed_states),
                    "blocked": sum(status == "blocked" for status in typed_states),
                    "fieldUpdateCount": len(daily_values) + len(unit_values),
                })
            field_progress_values = [value["progress"] for value in work_type_progress if value["fieldUpdateCount"]]
            project_progress_values = task_progress_values + field_progress_values
            progress = round(sum(project_progress_values) / len(project_progress_values)) if project_progress_values else 0
            work_type_by_id = {value["id"]: value["name"] for value in project_work_types}
            action_by_id = {value["id"]: value["name"] for value in work_actions}
            location_by_id = {value["id"]: value["name"] for value in project_locations}
            result.append({
                "id": project_id, "code": project["code"], "name": project["name"],
                "description": project["description"], "status": project["status"],
                "priority": project["priority"], "kind": project["kind"], "startDate": project["start_date"],
                "targetDate": project["target_date"], "version": project["version"],
                "createdAt": project["created_at"], "updatedAt": project["updated_at"],
                "progress": progress,
                "workTypeProgress": work_type_progress,
                "workTypes": [{
                    "id": value["id"], "code": value["code"], "name": value["name"], "color": value["color"],
                    "actions": [{"id": action["id"], "code": action["code"], "name": action["name"]} for action in work_actions if action["work_type_id"] == value["id"]],
                } for value in project_work_types],
                "taskSummary": {
                    "total": len(task_states),
                    "done": sum(status == "done" for status in task_states),
                    "active": sum(status in {"progress", "review", "testing"} for status in task_states),
                    "blocked": sum(status == "blocked" for status in task_states),
                },
                "buildingCount": len(project_buildings),
                "buildings": [{
                    "id": building["id"], "code": building["code"], "name": building["name"],
                    "address": building["address"], "status": building["status"], "version": building["version"],
                    "workItemCount": sum(item["building_id"] == building["id"] for item in project_items),
                } for building in project_buildings],
                "workItems": [{
                    "id": item["id"], "buildingId": item["building_id"], "stageId": item["stage_id"], "workTypeId": item["work_type_id"],
                    "title": item["title"], "description": item["description"], "status": item["status"],
                    "effectiveStatus": item["effective_status"], "dependsOn": item["depends_on"],
                    "blockedBy": item["blocked_by"],
                    "priority": item["priority"], "assigneeUserId": item["assignee_user_id"],
                    "startDate": item["start_date"], "dueDate": item["due_date"],
                    "estimatedMinutes": item["estimated_minutes"], "actualMinutes": item["actual_minutes"],
                    "version": item["version"],
                } for item in project_items],
                "stages": project_stages,
                "locations": [{
                    "id": value["id"], "buildingId": value["building_id"], "parentLocationId": value["parent_location_id"], "depth": value["depth"], "code": value["code"],
                    "name": value["name"], "kind": value["kind"], "suiteTotal": value["suite_total"], "customFields": json.loads(value["custom_fields"]), "version": value["version"],
                    "audioDetails": ({"zoneType":audio_by_location[value["id"]]["zone_type"],"speakerCount":audio_by_location[value["id"]]["speaker_count"],"displayCount":audio_by_location[value["id"]]["display_count"],"sourceDescription":audio_by_location[value["id"]]["source_description"],"equipmentNotes":audio_by_location[value["id"]]["equipment_notes"],"version":audio_by_location[value["id"]]["version"]} if value["id"] in audio_by_location else None),
                    "units": [{
                        "id":unit["id"],"code":unit["code"],"name":unit["name"],"position":unit["position"],"notes":unit["notes"],"customFields":json.loads(unit["custom_fields"]),"version":unit["version"],
                        "progress":[{"id":progress["id"],"workTypeId":progress["work_type_id"],"actionId":progress["action_id"],"status":progress["status"],"completedOn":progress["completed_on"],"comments":progress["comments"],"version":progress["version"],"updatedAt":progress["updated_at"]} for progress in project_unit_progress if progress["unit_id"]==unit["id"]],
                    } for unit in project_units if unit["location_id"]==value["id"]],
                } for value in project_locations],
                "dailyUpdates": [{
                    "id": value["id"], "locationId": value["location_id"], "locationName": location_by_id.get(value["location_id"], ""),
                    "workTypeId": value["work_type_id"], "workTypeName": work_type_by_id.get(value["work_type_id"], ""),
                    "actionId": value["action_id"], "actionName": action_by_id.get(value["action_id"], ""),
                    "workDate": value["work_date"], "status": value["status"], "percentComplete": value["percent_complete"],
                    "quantityCompleted": value["quantity_completed"], "comments": value["comments"], "version": value["version"],
                    "createdAt": value["created_at"], "updatedAt": value["updated_at"],
                } for value in project_updates[:50]],
                "issues": [{
                    "id": value["id"], "progressEntryId": value["progress_entry_id"], "locationId": value["location_id"],
                    "workTypeId": value["work_type_id"], "title": value["title"], "description": value["description"],
                    "severity": value["severity"], "status": value["status"], "version": value["version"], "createdAt": value["created_at"],
                } for value in project_issues],
                "activity": [{
                    "entityType": event["entity_type"], "entityId": event["entity_id"],
                    "action": event["action"], "newValue": json.loads(event["new_value"]),
                    "createdAt": event["created_at"],
                } for event in activity if event["project_id"] == project_id][:100],
            })
        return result

    def create_project(self, organization_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        name = payload.get("name")
        code = payload.get("code")
        status = payload.get("status", "planned")
        priority = payload.get("priority", "medium")
        if not isinstance(name, str) or not name.strip() or len(name) > 120:
            raise ValueError("Project name is required and must not exceed 120 characters")
        if not isinstance(code, str) or not code.strip() or len(code) > 32 or not all(character.isalnum() or character in "-_" for character in code):
            raise ValueError("Project code must contain only letters, numbers, '-' or '_'")
        if status not in ALLOWED_PROJECT_STATUSES or priority not in ALLOWED_PRIORITIES:
            raise ValueError("Invalid project status or priority")
        project_id = str(uuid.uuid4())
        now = utc_now()
        stages = (("planning", "Planning"), ("survey", "Site Survey"), ("installation", "Installation"), ("commissioning", "Commissioning"), ("handover", "Handover"))
        try:
            with self._connect() as connection:
                active_work_type_rows = connection.execute(
                    "SELECT id FROM work_types WHERE organization_id=? AND active=1 ORDER BY position",
                    (organization_id,),
                ).fetchall()
                active_work_type_ids = [row["id"] for row in active_work_type_rows]
                requested_work_type_ids = payload.get("workTypeIds")
                if requested_work_type_ids is None:
                    selected_work_type_ids = active_work_type_ids
                elif isinstance(requested_work_type_ids, list) and requested_work_type_ids and all(isinstance(value, str) for value in requested_work_type_ids):
                    selected_work_type_ids = []
                    for work_type_id in requested_work_type_ids:
                        if work_type_id not in active_work_type_ids:
                            raise ValueError(f"Unknown or inactive work type: {work_type_id}")
                        if work_type_id not in selected_work_type_ids:
                            selected_work_type_ids.append(work_type_id)
                else:
                    raise ValueError("Project must include at least one work type")
                connection.execute(
                    """INSERT INTO projects
                       (organization_id, id, code, name, description, status, priority,
                        start_date, target_date, version, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""",
                    (organization_id, project_id, code.strip().upper(), name.strip(), str(payload.get("description", ""))[:1000], status, priority, payload.get("startDate"), payload.get("targetDate"), now, now),
                )
                connection.executemany(
                    """INSERT INTO project_stages
                       (organization_id, id, project_id, code, name, task_area, position, status, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, NULL, ?, 'planned', ?, ?)""",
                    [(organization_id, str(uuid.uuid4()), project_id, stage_code, stage_name, position, now, now) for position, (stage_code, stage_name) in enumerate(stages)],
                )
                connection.executemany(
                    """INSERT INTO project_work_type_scopes
                       (organization_id, project_id, work_type_id, active, created_at)
                       VALUES (?, ?, ?, 1, ?)""",
                    [(organization_id, project_id, work_type_id, now) for work_type_id in selected_work_type_ids],
                )
                connection.execute(
                    """INSERT INTO project_change_log
                       (organization_id, id, project_id, entity_type, entity_id, action, old_value, new_value, source, created_at)
                       VALUES (?, ?, ?, 'project', ?, 'created', '{}', ?, 'api', ?)""",
                    (organization_id, str(uuid.uuid4()), project_id, project_id, json.dumps({"code": code.strip().upper(), "name": name.strip(), "workTypeIds": selected_work_type_ids}), now),
                )
        except sqlite3.IntegrityError as error:
            raise ValueError("Project code already exists in this organization") from error
        return next(project for project in self.list_projects(organization_id) if project["id"] == project_id)

    def get_project(self, organization_id: str, project_id: str) -> dict[str, Any] | None:
        return next((project for project in self.list_projects(organization_id) if project["id"] == project_id), None)

    def create_building(self, organization_id: str, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        project = self.get_project(organization_id, project_id)
        if project is None:
            raise LookupError("Project not found")
        if project["kind"] != "customer":
            raise ValueError("Buildings can only be added to customer projects")
        name, code = payload.get("name"), payload.get("code")
        status = payload.get("status", "planned")
        if not isinstance(name, str) or not name.strip() or len(name) > 120:
            raise ValueError("Building name is required and must not exceed 120 characters")
        if not isinstance(code, str) or not code.strip() or len(code) > 32 or not all(character.isalnum() or character in "-_" for character in code):
            raise ValueError("Building code must contain only letters, numbers, '-' or '_'")
        if status not in ALLOWED_BUILDING_STATUSES:
            raise ValueError("Invalid building status")
        building_id, now = str(uuid.uuid4()), utc_now()
        try:
            with self._connect() as connection:
                connection.execute(
                    """INSERT INTO buildings
                       (organization_id, id, project_id, code, name, address, status, version, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""",
                    (organization_id, building_id, project_id, code.strip().upper(), name.strip(), str(payload.get("address", ""))[:500], status, now, now),
                )
                connection.execute(
                    """INSERT INTO project_change_log
                       (organization_id, id, project_id, entity_type, entity_id, action, old_value, new_value, source, created_at)
                       VALUES (?, ?, ?, 'building', ?, 'created', '{}', ?, 'api', ?)""",
                    (organization_id, str(uuid.uuid4()), project_id, building_id, json.dumps({"code": code.strip().upper(), "name": name.strip()}), now),
                )
        except sqlite3.IntegrityError as error:
            raise ValueError("Building code already exists in this project") from error
        return next(building for building in self.get_project(organization_id, project_id)["buildings"] if building["id"] == building_id)  # type: ignore[index]

    def create_work_item(self, organization_id: str, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        project = self.get_project(organization_id, project_id)
        if project is None:
            raise LookupError("Project not found")
        if project["kind"] != "customer":
            raise ValueError("Field work items can only be added to customer projects")
        title = payload.get("title")
        status, priority = payload.get("status", "backlog"), payload.get("priority", "medium")
        if not isinstance(title, str) or not title.strip() or len(title) > 120:
            raise ValueError("Work item title is required and must not exceed 120 characters")
        if status not in ALLOWED_STATUSES or priority not in ALLOWED_PRIORITIES:
            raise ValueError("Invalid work item status or priority")
        building_id, stage_id = payload.get("buildingId"), payload.get("stageId")
        if building_id and not any(building["id"] == building_id for building in project["buildings"]):
            raise ValueError("Building does not belong to this project")
        if stage_id and not any(stage["id"] == stage_id for stage in project["stages"]):
            raise ValueError("Stage does not belong to this project")
        estimated = payload.get("estimatedMinutes")
        if estimated is not None and (not isinstance(estimated, int) or estimated < 0):
            raise ValueError("estimatedMinutes must be a non-negative integer")
        work_type_id = payload.get("workTypeId", "other")
        valid_work_type_ids = {work_type["id"] for work_type in project["workTypeProgress"]}
        if not isinstance(work_type_id, str) or work_type_id not in valid_work_type_ids:
            raise ValueError("Work type does not belong to this organization")
        depends_on_ids = payload.get("dependsOnIds", [])
        if not isinstance(depends_on_ids, list) or len(depends_on_ids) > 100 or any(not isinstance(value, str) for value in depends_on_ids):
            raise ValueError("dependsOnIds must be an array of work item IDs")
        depends_on_ids = list(dict.fromkeys(depends_on_ids))
        known_item_ids = {item["id"] for item in project["workItems"]}
        if any(value not in known_item_ids for value in depends_on_ids):
            raise ValueError("Dependency does not belong to this project")
        assignee_user_id = payload.get("assigneeUserId")
        if assignee_user_id:
            with self._connect() as connection:
                membership = connection.execute(
                    "SELECT 1 FROM memberships WHERE organization_id = ? AND user_id = ? AND status = 'active'",
                    (organization_id, assignee_user_id),
                ).fetchone()
            if membership is None:
                raise ValueError("Assignee is not an active member of this organization")
        item_id, now = str(uuid.uuid4()), utc_now()
        with self._connect() as connection:
            connection.execute(
                """INSERT INTO project_work_items
                   (organization_id, id, project_id, building_id, stage_id, work_type_id, title, description,
                    status, priority, assignee_user_id, start_date, due_date, estimated_minutes,
                    actual_minutes, version, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)""",
                (organization_id, item_id, project_id, building_id, stage_id, work_type_id, title.strip(), str(payload.get("description", ""))[:1000], status, priority, assignee_user_id, payload.get("startDate"), payload.get("dueDate"), estimated, now, now),
            )
            connection.executemany(
                """INSERT INTO work_item_dependencies
                   (organization_id, project_id, dependent_item_id, predecessor_item_id, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                [(organization_id, project_id, item_id, predecessor_id, now) for predecessor_id in depends_on_ids],
            )
            connection.execute(
                """INSERT INTO project_change_log
                   (organization_id, id, project_id, entity_type, entity_id, action, old_value, new_value, source, created_at)
                   VALUES (?, ?, ?, 'work_item', ?, 'created', '{}', ?, 'api', ?)""",
                (organization_id, str(uuid.uuid4()), project_id, item_id, json.dumps({"title": title.strip(), "workTypeId": work_type_id, "status": status}), now),
            )
        return next(item for item in self.get_project(organization_id, project_id)["workItems"] if item["id"] == item_id)  # type: ignore[index]

    def create_location(self, organization_id: str, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        project = self.get_project(organization_id, project_id)
        if project is None:
            raise LookupError("Project not found")
        code, name = payload.get("code"), payload.get("name")
        kind, building_id = payload.get("kind", "floor"), payload.get("buildingId")
        parent_location_id, custom_fields = payload.get("parentLocationId"), payload.get("customFields", {})
        suite_total = payload.get("suiteTotal")
        if not isinstance(code, str) or not code.strip() or len(code) > 32:
            raise ValueError("Location code is required")
        if not isinstance(name, str) or not name.strip() or len(name) > 120:
            raise ValueError("Location name is required")
        if kind not in {"floor", "suite", "room", "area"}:
            raise ValueError("Invalid location kind")
        if suite_total is not None and (not isinstance(suite_total, int) or suite_total < 0):
            raise ValueError("suiteTotal must be a non-negative integer")
        if building_id and not any(value["id"] == building_id for value in project["buildings"]):
            raise ValueError("Building does not belong to this project")
        parent = next((value for value in project["locations"] if value["id"] == parent_location_id), None) if parent_location_id else None
        if parent_location_id and parent is None:
            raise ValueError("Parent location does not belong to this project")
        if parent and parent["buildingId"] and building_id and parent["buildingId"] != building_id:
            raise ValueError("Child location must use the same building as its parent")
        if parent and not building_id:
            building_id = parent["buildingId"]
        if not isinstance(custom_fields, dict):
            raise ValueError("customFields must be an object")
        self.validate_custom_fields(organization_id,"location",custom_fields)
        custom_fields_json = json.dumps(custom_fields, ensure_ascii=False, separators=(",", ":"))
        if len(custom_fields_json.encode("utf-8")) > 16384:
            raise ValueError("customFields exceeds 16 KiB")
        location_id, now = str(uuid.uuid4()), utc_now()
        try:
            with self._connect() as connection:
                connection.execute(
                    """INSERT INTO project_locations
                       (organization_id,id,project_id,building_id,parent_location_id,code,name,kind,suite_total,custom_fields,version,created_at,updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)""",
                    (organization_id, location_id, project_id, building_id, parent_location_id, code.strip().upper(), name.strip(), kind, suite_total, custom_fields_json, now, now),
                )
                connection.execute(
                    """INSERT INTO project_change_log
                       (organization_id,id,project_id,entity_type,entity_id,action,old_value,new_value,source,created_at)
                       VALUES (?,?,?,'location',?,'created','{}',?,'api',?)""",
                    (organization_id, str(uuid.uuid4()), project_id, location_id, json.dumps({"code": code.strip().upper(), "name": name.strip(), "parentLocationId": parent_location_id, "customFields": custom_fields}, ensure_ascii=False), now),
                )
                if kind == "floor" and suite_total:
                    connection.executemany(
                        """INSERT INTO project_units
                           (organization_id,id,project_id,location_id,code,name,position,active,version,created_at,updated_at)
                           VALUES (?,?,?,?,?,?,?,1,1,?,?)""",
                        [(organization_id,str(uuid.uuid4()),project_id,location_id,f"{code.strip().upper()}-U{index:02d}",f"Unit {index}",index-1,now,now) for index in range(1,suite_total+1)],
                    )
                audio = payload.get("audioDetails")
                if kind == "area" and isinstance(audio, dict):
                    connection.execute(
                        """INSERT INTO audio_zone_details
                           (organization_id,location_id,project_id,zone_type,speaker_count,display_count,source_description,equipment_notes,version,updated_at)
                           VALUES (?,?,?,?,?,?,?,?,1,?)""",
                        (organization_id,location_id,project_id,str(audio.get("zoneType","common_area"))[:64],audio.get("speakerCount"),audio.get("displayCount"),str(audio.get("sourceDescription",""))[:500],str(audio.get("equipmentNotes",""))[:1000],now),
                    )
        except sqlite3.IntegrityError as error:
            raise ValueError("Location code already exists in this project") from error
        return next(value for value in self.get_project(organization_id, project_id)["locations"] if value["id"] == location_id)  # type: ignore[index]

    def update_location(self, organization_id: str, project_id: str, location_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        project = self.get_project(organization_id, project_id)
        location = next((value for value in (project or {}).get("locations", []) if value["id"] == location_id), None)
        if location is None: raise LookupError("Location not found")
        expected = payload.get("expectedVersion")
        if expected != location["version"]: raise EntityVersionConflict(location["version"])
        code=str(payload.get("code",location["code"])).strip().upper(); name=str(payload.get("name",location["name"])).strip()
        kind=payload.get("kind",location["kind"]); suite_total=payload.get("suiteTotal",location["suiteTotal"]); building_id=payload.get("buildingId",location["buildingId"])
        parent_location_id=payload.get("parentLocationId",location["parentLocationId"]); custom_fields=payload.get("customFields",location["customFields"])
        if not code or not name or kind not in {"floor","suite","room","area"}: raise ValueError("Invalid location data")
        if suite_total is not None and (not isinstance(suite_total,int) or suite_total < 0): raise ValueError("Invalid suiteTotal")
        if not isinstance(custom_fields,dict): raise ValueError("customFields must be an object")
        self.validate_custom_fields(organization_id,"location",custom_fields)
        custom_fields_json=json.dumps(custom_fields,ensure_ascii=False,separators=(",",":"))
        if len(custom_fields_json.encode("utf-8")) > 16384: raise ValueError("customFields exceeds 16 KiB")
        by_id={value["id"]:value for value in project["locations"]}
        parent=by_id.get(parent_location_id) if parent_location_id else None
        if parent_location_id and parent is None: raise ValueError("Parent location does not belong to this project")
        cursor=parent; seen={location_id}
        while cursor:
            if cursor["id"] in seen: raise ValueError("Location hierarchy cycle")
            seen.add(cursor["id"]); cursor=by_id.get(cursor["parentLocationId"])
        if parent and parent["buildingId"] and building_id and parent["buildingId"] != building_id: raise ValueError("Child location must use the same building as its parent")
        if parent and not building_id: building_id=parent["buildingId"]
        audio=payload.get("audioDetails"); now=utc_now()
        with self._lock, self._connect() as connection:
            connection.execute(
                """UPDATE project_locations SET building_id=?,parent_location_id=?,code=?,name=?,kind=?,suite_total=?,custom_fields=?,version=version+1,updated_at=?
                   WHERE organization_id=? AND project_id=? AND id=? AND version=?""",
                (building_id,parent_location_id,code,name,kind,suite_total,custom_fields_json,now,organization_id,project_id,location_id,expected),
            )
            if kind=="area" and isinstance(audio,dict):
                connection.execute(
                    """INSERT INTO audio_zone_details
                       (organization_id,location_id,project_id,zone_type,speaker_count,display_count,source_description,equipment_notes,version,updated_at)
                       VALUES (?,?,?,?,?,?,?,?,1,?) ON CONFLICT(organization_id,location_id) DO UPDATE SET
                       zone_type=excluded.zone_type,speaker_count=excluded.speaker_count,display_count=excluded.display_count,
                       source_description=excluded.source_description,equipment_notes=excluded.equipment_notes,version=audio_zone_details.version+1,updated_at=excluded.updated_at""",
                    (organization_id,location_id,project_id,str(audio.get("zoneType","common_area"))[:64],audio.get("speakerCount"),audio.get("displayCount"),str(audio.get("sourceDescription",""))[:500],str(audio.get("equipmentNotes",""))[:1000],now),
                )
            connection.execute("""INSERT INTO project_change_log
                (organization_id,id,project_id,entity_type,entity_id,action,old_value,new_value,source,created_at)
                VALUES (?,?,?,'location',?,'updated',?,?,'api',?)""",
                (organization_id,str(uuid.uuid4()),project_id,location_id,json.dumps({"parentLocationId":location["parentLocationId"],"customFields":location["customFields"]},ensure_ascii=False),json.dumps({"parentLocationId":parent_location_id,"customFields":custom_fields},ensure_ascii=False),now))
        return next(value for value in self.get_project(organization_id,project_id)["locations"] if value["id"]==location_id)  # type: ignore[index]

    def set_unit_progress(self, organization_id: str, project_id: str, location_id: str, unit_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        project=self.get_project(organization_id,project_id)
        location=next((value for value in (project or {}).get("locations",[]) if value["id"]==location_id),None)
        unit=next((value for value in (location or {}).get("units",[]) if value["id"]==unit_id),None)
        if unit is None: raise LookupError("Unit not found")
        work_type_id,action_id=payload.get("workTypeId"),payload.get("actionId")
        work_type=next((value for value in project["workTypes"] if value["id"]==work_type_id),None)  # type: ignore[index]
        if work_type is None or action_id not in {value["id"] for value in work_type["actions"]}: raise ValueError("Invalid work type or action")
        status=payload.get("status","complete")
        if status not in {"not_started","ongoing","complete","blocked"}: raise ValueError("Invalid unit status")
        now=utc_now(); completed_on=str(payload.get("completedOn") or datetime.now(timezone.utc).date()) if status=="complete" else None
        with self._lock, self._connect() as connection:
            current=connection.execute("SELECT id,version,status FROM unit_progress WHERE organization_id=? AND unit_id=? AND work_type_id=? AND action_id=?",(organization_id,unit_id,work_type_id,action_id)).fetchone()
            if current:
                expected=payload.get("expectedVersion",current["version"])
                if expected != current["version"]: raise EntityVersionConflict(current["version"])
                progress_id=current["id"]
                connection.execute("UPDATE unit_progress SET status=?,completed_on=?,comments=?,version=version+1,updated_at=? WHERE organization_id=? AND id=? AND version=?",(status,completed_on,str(payload.get("comments",""))[:500],now,organization_id,progress_id,expected))
            else:
                progress_id=str(uuid.uuid4())
                connection.execute("""INSERT INTO unit_progress
                    (organization_id,id,project_id,location_id,unit_id,work_type_id,action_id,status,completed_on,comments,version,updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,1,?)""",(organization_id,progress_id,project_id,location_id,unit_id,work_type_id,action_id,status,completed_on,str(payload.get("comments",""))[:500],now))
            connection.execute("""INSERT INTO project_change_log
                (organization_id,id,project_id,entity_type,entity_id,action,old_value,new_value,source,created_at)
                VALUES (?,?,?,'unit_progress',?,'updated','{}',?,'api',?)""",(organization_id,str(uuid.uuid4()),project_id,progress_id,json.dumps({"unitId":unit_id,"workTypeId":work_type_id,"actionId":action_id,"status":status,"completedOn":completed_on}),now))
        refreshed=self.get_project(organization_id,project_id)
        return next(value for value in next(loc for loc in refreshed["locations"] if loc["id"]==location_id)["units"] if value["id"]==unit_id)  # type: ignore[index]

    def create_unit(self,organization_id: str,project_id: str,location_id: str,payload: dict[str,Any]) -> dict[str,Any]:
        project=self.get_project(organization_id,project_id)
        location=next((value for value in (project or {}).get("locations",[]) if value["id"]==location_id),None)
        if location is None: raise LookupError("Location not found")
        code,name=payload.get("code"),payload.get("name")
        if not isinstance(code,str) or not code.strip() or len(code)>32 or not isinstance(name,str) or not name.strip() or len(name)>120: raise ValueError("Valid unit code and name are required")
        custom_fields=payload.get("customFields",{})
        if not isinstance(custom_fields,dict): raise ValueError("customFields must be an object")
        self.validate_custom_fields(organization_id,"unit",custom_fields)
        custom_json=json.dumps(custom_fields,ensure_ascii=False,separators=(",",":"))
        if len(custom_json.encode("utf-8"))>16384: raise ValueError("customFields exceeds 16 KiB")
        unit_id,now=str(uuid.uuid4()),utc_now()
        with self._lock,self._connect() as connection:
            position=connection.execute("SELECT COALESCE(MAX(position),-1)+1 AS next_position FROM project_units WHERE organization_id=? AND location_id=?",(organization_id,location_id)).fetchone()["next_position"]
            try:
                connection.execute("""INSERT INTO project_units
                    (organization_id,id,project_id,location_id,code,name,position,active,version,created_at,updated_at,notes,custom_fields)
                    VALUES (?,?,?,?,?,?,?,1,1,?,?,?,?)""",
                    (organization_id,unit_id,project_id,location_id,code.strip().upper(),name.strip(),position,now,now,str(payload.get("notes",""))[:2000],custom_json))
            except sqlite3.IntegrityError as error: raise ValueError("Unit code already exists in this location") from error
            connection.execute("""INSERT INTO project_change_log
                (organization_id,id,project_id,entity_type,entity_id,action,old_value,new_value,source,created_at)
                VALUES (?,?,?,'unit',?,'created','{}',?,'api',?)""",
                (organization_id,str(uuid.uuid4()),project_id,unit_id,json.dumps({"locationId":location_id,"code":code.strip().upper(),"name":name.strip()},ensure_ascii=False),now))
        refreshed=self.get_project(organization_id,project_id)
        return next(value for value in next(loc for loc in refreshed["locations"] if loc["id"]==location_id)["units"] if value["id"]==unit_id)  # type: ignore[index]

    def update_unit(self,organization_id: str,project_id: str,location_id: str,unit_id: str,payload: dict[str,Any]) -> dict[str,Any]:
        project=self.get_project(organization_id,project_id)
        location=next((value for value in (project or {}).get("locations",[]) if value["id"]==location_id),None)
        unit=next((value for value in (location or {}).get("units",[]) if value["id"]==unit_id),None)
        if unit is None: raise LookupError("Unit not found")
        expected=payload.get("expectedVersion")
        if expected!=unit["version"]: raise EntityVersionConflict(unit["version"])
        code=str(payload.get("code",unit["code"])).strip().upper();name=str(payload.get("name",unit["name"])).strip();notes=str(payload.get("notes",unit["notes"]))[:2000];custom_fields=payload.get("customFields",unit["customFields"])
        if not code or len(code)>32 or not name or len(name)>120 or not isinstance(custom_fields,dict): raise ValueError("Invalid unit data")
        self.validate_custom_fields(organization_id,"unit",custom_fields)
        custom_json=json.dumps(custom_fields,ensure_ascii=False,separators=(",",":"))
        if len(custom_json.encode("utf-8"))>16384: raise ValueError("customFields exceeds 16 KiB")
        now=utc_now()
        with self._lock,self._connect() as connection:
            try:
                connection.execute("""UPDATE project_units SET code=?,name=?,notes=?,custom_fields=?,version=version+1,updated_at=?
                    WHERE organization_id=? AND project_id=? AND location_id=? AND id=? AND version=?""",
                    (code,name,notes,custom_json,now,organization_id,project_id,location_id,unit_id,expected))
            except sqlite3.IntegrityError as error: raise ValueError("Unit code already exists in this location") from error
            connection.execute("""INSERT INTO project_change_log
                (organization_id,id,project_id,entity_type,entity_id,action,old_value,new_value,source,created_at)
                VALUES (?,?,?,'unit',?,'updated',?,?,'api',?)""",
                (organization_id,str(uuid.uuid4()),project_id,unit_id,json.dumps({"code":unit["code"],"name":unit["name"],"notes":unit["notes"]},ensure_ascii=False),json.dumps({"code":code,"name":name,"notes":notes},ensure_ascii=False),now))
        refreshed=self.get_project(organization_id,project_id)
        return next(value for value in next(loc for loc in refreshed["locations"] if loc["id"]==location_id)["units"] if value["id"]==unit_id)  # type: ignore[index]

    def generate_daily_report(self, organization_id: str, project_id: str, work_date: str) -> dict[str, Any]:
        project=self.get_project(organization_id,project_id)
        if project is None: raise LookupError("Project not found")
        groups: dict[tuple[str,str,str],list[str]]={}
        for location in project["locations"]:
            for unit in location["units"]:
                for progress in unit["progress"]:
                    if progress["completedOn"]==work_date and progress["status"]=="complete":
                        work=next((value["name"] for value in project["workTypes"] if value["id"]==progress["workTypeId"]),progress["workTypeId"])
                        action=next((action["name"] for value in project["workTypes"] if value["id"]==progress["workTypeId"] for action in value["actions"] if action["id"]==progress["actionId"]),progress["actionId"])
                        groups.setdefault((location["name"],work,action),[]).append(unit["name"])
        lines=[f"Daily update — {project['name']} — {work_date}"]
        for (location,work,action),units in groups.items(): lines.append(f"• {location} / {work} / {action}: {', '.join(units)}")
        for update in project["dailyUpdates"]:
            if update["workDate"]==work_date: lines.append(f"• {update['locationName']} / {update['workTypeName']} / {update['actionName']}: {update['percentComplete']}%{(' — '+update['comments']) if update['comments'] else ''}")
        open_issues=[value for value in project["issues"] if value["status"]!="resolved" and value["createdAt"].startswith(work_date)]
        if open_issues:
            lines.append("Issues:"); lines.extend(f"• [{value['severity'].upper()}] {value['description']}" for value in open_issues)
        if len(lines)==1: lines.append("No completed work recorded for this date.")
        return {"projectId":project_id,"date":work_date,"text":"\n".join(lines),"unitCompletions":sum(len(value) for value in groups.values()),"updates":sum(value["workDate"]==work_date for value in project["dailyUpdates"]),"issues":len(open_issues)}

    def save_daily_update(self, organization_id: str, project_id: str, payload: dict[str, Any], entry_id: str | None = None) -> dict[str, Any]:
        project = self.get_project(organization_id, project_id)
        if project is None:
            raise LookupError("Project not found")
        location_id, work_type_id, action_id = payload.get("locationId"), payload.get("workTypeId"), payload.get("actionId")
        status = payload.get("status", "ongoing")
        percent = payload.get("percentComplete", 0)
        quantity = payload.get("quantityCompleted")
        if location_id not in {value["id"] for value in project["locations"]}:
            raise ValueError("Location does not belong to this project")
        work_type = next((value for value in project["workTypes"] if value["id"] == work_type_id), None)
        if work_type is None or action_id not in {value["id"] for value in work_type["actions"]}:
            raise ValueError("Invalid work type or action")
        if status not in {"not_started", "ongoing", "complete", "blocked"}:
            raise ValueError("Invalid progress status")
        if not isinstance(percent, int) or not 0 <= percent <= 100:
            raise ValueError("percentComplete must be between 0 and 100")
        if quantity is not None and (not isinstance(quantity, int) or quantity < 0):
            raise ValueError("quantityCompleted must be a non-negative integer")
        if status == "complete": percent = 100
        if status == "not_started": percent = 0
        comments = str(payload.get("comments", ""))[:2000]
        now, work_date = utc_now(), str(payload.get("workDate") or datetime.now(timezone.utc).date())
        with self._lock, self._connect() as connection:
            if entry_id:
                expected = payload.get("expectedVersion")
                current = connection.execute(
                    "SELECT version, status, percent_complete FROM daily_progress_entries WHERE organization_id=? AND project_id=? AND id=?",
                    (organization_id, project_id, entry_id),
                ).fetchone()
                if current is None: raise LookupError("Daily update not found")
                if current["version"] != expected: raise EntityVersionConflict(current["version"])
                version = current["version"] + 1
                connection.execute(
                    """UPDATE daily_progress_entries SET location_id=?,work_type_id=?,action_id=?,work_date=?,status=?,
                              percent_complete=?,quantity_completed=?,comments=?,version=?,updated_at=?
                       WHERE organization_id=? AND project_id=? AND id=? AND version=?""",
                    (location_id,work_type_id,action_id,work_date,status,percent,quantity,comments,version,now,organization_id,project_id,entry_id,expected),
                )
                action_name, old_value = "updated", {"status": current["status"], "percentComplete": current["percent_complete"], "version": current["version"]}
            else:
                entry_id, version, action_name, old_value = str(uuid.uuid4()), 1, "created", {}
                connection.execute(
                    """INSERT INTO daily_progress_entries
                       (organization_id,id,project_id,location_id,work_type_id,action_id,work_date,status,percent_complete,
                        quantity_completed,comments,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (organization_id,entry_id,project_id,location_id,work_type_id,action_id,work_date,status,percent,quantity,comments,version,now,now),
                )
            connection.execute(
                """INSERT INTO project_change_log
                   (organization_id,id,project_id,entity_type,entity_id,action,old_value,new_value,source,created_at)
                   VALUES (?,?,?,'daily_update',?,?,?,?, 'api',?)""",
                (organization_id,str(uuid.uuid4()),project_id,entry_id,action_name,json.dumps(old_value),json.dumps({"status":status,"percentComplete":percent,"workTypeId":work_type_id}),now),
            )
            issue_description = str(payload.get("issueDescription", "")).strip()
            if issue_description and not entry_id.startswith("invalid"):
                issue_id = str(uuid.uuid4())
                severity = payload.get("issueSeverity", "medium")
                if severity not in {"low","medium","high","critical"}: raise ValueError("Invalid issue severity")
                connection.execute(
                    """INSERT INTO project_issues
                       (organization_id,id,project_id,progress_entry_id,location_id,work_type_id,title,description,severity,status,version,created_at,updated_at)
                       VALUES (?,?,?,?,?,?,?, ?,?,'open',1,?,?)""",
                    (organization_id,issue_id,project_id,entry_id,location_id,work_type_id,issue_description[:120],issue_description[:2000],severity,now,now),
                )
                connection.execute(
                    """INSERT INTO project_change_log
                       (organization_id,id,project_id,entity_type,entity_id,action,old_value,new_value,source,created_at)
                       VALUES (?,?,?,'issue',?,'created','{}',?,'api',?)""",
                    (organization_id,str(uuid.uuid4()),project_id,issue_id,json.dumps({"title":issue_description[:120],"severity":severity}),now),
                )
        return next(value for value in self.get_project(organization_id, project_id)["dailyUpdates"] if value["id"] == entry_id)  # type: ignore[index]

    def add_work_item_dependency(self, organization_id: str, project_id: str, item_id: str, predecessor_id: str) -> dict[str, Any]:
        project = self.get_project(organization_id, project_id)
        if project is None:
            raise LookupError("Project not found")
        item_by_id = {item["id"]: item for item in project["workItems"]}
        if item_id not in item_by_id or predecessor_id not in item_by_id:
            raise LookupError("Work item not found")
        if item_id == predecessor_id:
            raise ValueError("A work item cannot depend on itself")
        graph = {item["id"]: set(item.get("dependsOn", [])) for item in project["workItems"]}
        pending = [predecessor_id]
        visited: set[str] = set()
        while pending:
            current = pending.pop()
            if current == item_id:
                raise ValueError("Dependency would create a cycle")
            if current not in visited:
                visited.add(current)
                pending.extend(graph.get(current, set()))
        now = utc_now()
        try:
            with self._connect() as connection:
                connection.execute(
                    """INSERT INTO work_item_dependencies
                       (organization_id, project_id, dependent_item_id, predecessor_item_id, created_at)
                       VALUES (?, ?, ?, ?, ?)""",
                    (organization_id, project_id, item_id, predecessor_id, now),
                )
                connection.execute(
                    """INSERT INTO project_change_log
                       (organization_id, id, project_id, entity_type, entity_id, action, old_value, new_value, source, created_at)
                       VALUES (?, ?, ?, 'work_item', ?, 'dependency_added', '{}', ?, 'api', ?)""",
                    (organization_id, str(uuid.uuid4()), project_id, item_id, json.dumps({"predecessorId": predecessor_id}), now),
                )
        except sqlite3.IntegrityError as error:
            raise ValueError("Dependency already exists") from error
        return next(item for item in self.get_project(organization_id, project_id)["workItems"] if item["id"] == item_id)  # type: ignore[index]

    def update_work_item(self, organization_id: str, project_id: str, item_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        expected_version = payload.get("expectedVersion")
        if not isinstance(expected_version, int) or expected_version < 1:
            raise ValueError("expectedVersion is required")
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """SELECT title, description, status, priority, building_id, stage_id,
                          due_date, estimated_minutes, actual_minutes, version
                   FROM project_work_items
                   WHERE organization_id = ? AND project_id = ? AND id = ?""",
                (organization_id, project_id, item_id),
            ).fetchone()
            if row is None:
                raise LookupError("Work item not found")
            if row["version"] != expected_version:
                raise EntityVersionConflict(row["version"])
            next_status = payload.get("status", row["status"])
            if next_status != row["status"] and next_status not in WORK_ITEM_TRANSITIONS[row["status"]]:
                raise InvalidTransition(row["status"], next_status)
            blockers = [value["predecessor_item_id"] for value in connection.execute(
                """SELECT dependency.predecessor_item_id
                   FROM work_item_dependencies dependency
                   JOIN project_work_items predecessor
                     ON predecessor.organization_id = dependency.organization_id
                    AND predecessor.id = dependency.predecessor_item_id
                   WHERE dependency.organization_id = ? AND dependency.project_id = ?
                     AND dependency.dependent_item_id = ? AND predecessor.status <> 'done'""",
                (organization_id, project_id, item_id),
            ).fetchall()]
            if blockers and next_status in {"progress", "review", "testing", "done"}:
                raise DependenciesIncomplete(blockers)
            priority = payload.get("priority", row["priority"])
            if priority not in ALLOWED_PRIORITIES:
                raise ValueError("Invalid work item priority")
            actual_minutes = payload.get("actualMinutes", row["actual_minutes"])
            if not isinstance(actual_minutes, int) or actual_minutes < 0:
                raise ValueError("actualMinutes must be a non-negative integer")
            estimated_minutes = payload.get("estimatedMinutes", row["estimated_minutes"])
            if estimated_minutes is not None and (not isinstance(estimated_minutes, int) or estimated_minutes < 0):
                raise ValueError("estimatedMinutes must be a non-negative integer")
            title = payload.get("title", row["title"])
            if not isinstance(title, str) or not title.strip() or len(title) > 120:
                raise ValueError("Invalid work item title")
            old_value = {"status": row["status"], "priority": row["priority"], "actualMinutes": row["actual_minutes"], "version": row["version"]}
            next_version, now = row["version"] + 1, utc_now()
            connection.execute(
                """UPDATE project_work_items SET title = ?, description = ?, status = ?, priority = ?,
                          due_date = ?, estimated_minutes = ?, actual_minutes = ?, version = ?, updated_at = ?
                   WHERE organization_id = ? AND project_id = ? AND id = ? AND version = ?""",
                (title.strip(), str(payload.get("description", row["description"]))[:1000], next_status, priority,
                 payload.get("dueDate", row["due_date"]), estimated_minutes,
                 actual_minutes, next_version, now, organization_id, project_id, item_id, expected_version),
            )
            new_value = {"status": next_status, "priority": priority, "actualMinutes": actual_minutes, "version": next_version}
            connection.execute(
                """INSERT INTO project_change_log
                   (organization_id, id, project_id, entity_type, entity_id, action, old_value, new_value, source, created_at)
                   VALUES (?, ?, ?, 'work_item', ?, 'updated', ?, ?, 'api', ?)""",
                (organization_id, str(uuid.uuid4()), project_id, item_id, json.dumps(old_value), json.dumps(new_value), now),
            )
        project = self.get_project(organization_id, project_id)
        return next(item for item in project["workItems"] if item["id"] == item_id)  # type: ignore[index]

    # ── Auth / Session ──────────────────────────────────────────────────────

    def ensure_initial_credentials(self) -> str | None:
        """Generate a one-time password for local-admin if none exists. Returns it (print to log); None if already set."""
        with self._connect() as connection:
            row = connection.execute(
                "SELECT 1 FROM password_credentials WHERE user_id = 'local-admin'"
            ).fetchone()
            if row:
                return None
            password = secrets.token_urlsafe(12)
            connection.execute(
                "INSERT INTO password_credentials (user_id, password_hash, must_change, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
                ("local-admin", _hash_password(password), utc_now(), utc_now()),
            )
            return password

    def login(self, email: str, password: str) -> dict[str, Any] | None:
        """Validate email+password. On success create a session and return {token, user, role, expiresAt}."""
        with self._connect() as connection:
            user = connection.execute(
                "SELECT u.id, u.display_name, m.organization_id, m.role "
                "FROM users u JOIN memberships m ON m.user_id = u.id "
                "WHERE u.email = ? AND m.status = 'active' LIMIT 1",
                (email,),
            ).fetchone()
            if not user:
                return None
            cred = connection.execute(
                "SELECT password_hash FROM password_credentials WHERE user_id = ?",
                (user["id"],),
            ).fetchone()
            if not cred or not _verify_password(password, cred["password_hash"]):
                return None
            token = secrets.token_urlsafe(32)
            token_hash = _hash_token(token)
            now = utc_now()
            expires = datetime.fromtimestamp(
                time.time() + SESSION_TTL_SECONDS, tz=timezone.utc
            ).isoformat()
            connection.execute(
                "INSERT INTO sessions (token_hash, user_id, organization_id, role, created_at, expires_at, last_seen_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (token_hash, user["id"], user["organization_id"], user["role"], now, expires, now),
            )
            return {
                "token": token,
                "user": {"id": user["id"], "displayName": user["display_name"], "email": email},
                "organizationId": user["organization_id"],
                "role": user["role"],
                "expiresAt": expires,
            }

    def validate_session(self, token: str) -> dict[str, Any] | None:
        """Return session context dict or None if expired/invalid."""
        token_hash = _hash_token(token)
        with self._connect() as connection:
            row = connection.execute(
                "SELECT s.user_id, s.organization_id, s.role, s.expires_at, u.email, u.display_name "
                "FROM sessions s JOIN users u ON u.id = s.user_id "
                "WHERE s.token_hash = ?",
                (token_hash,),
            ).fetchone()
            if not row:
                return None
            if row["expires_at"] < utc_now():
                connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
                return None
            # Slide expiry on activity
            new_expires = datetime.fromtimestamp(
                time.time() + SESSION_TTL_SECONDS, tz=timezone.utc
            ).isoformat()
            connection.execute(
                "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
                (utc_now(), new_expires, token_hash),
            )
            return {
                "userId": row["user_id"],
                "email": row["email"],
                "displayName": row["display_name"],
                "organizationId": row["organization_id"],
                "role": row["role"],
            }

    def logout_session(self, token: str) -> None:
        token_hash = _hash_token(token)
        with self._connect() as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))

    # ── Secrets Vault ────────────────────────────────────────────────────────

    def list_secrets(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, name, description, category, created_at, updated_at, created_by FROM secrets_vault ORDER BY category, name"
            ).fetchall()
        return [dict(r) for r in rows]

    def create_secret(self, name: str, value: str, description: str, category: str, created_by: str) -> dict[str, Any]:
        if not name or not value:
            raise ValueError("name and value are required")
        encrypted = encrypt_secret(self._master_key, name, value)
        now = utc_now()
        secret_id = str(uuid.uuid4())
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO secrets_vault (id, name, description, category, encrypted, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (secret_id, name, description, category, encrypted, now, now, created_by),
            )
        return {"id": secret_id, "name": name, "description": description, "category": category, "createdAt": now}

    def get_secret_value(self, secret_id: str) -> str | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT name, encrypted FROM secrets_vault WHERE id = ?", (secret_id,)
            ).fetchone()
        if not row:
            return None
        return decrypt_secret(self._master_key, row["name"], row["encrypted"])

    def update_secret(self, secret_id: str, value: str | None, description: str | None) -> bool:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT name FROM secrets_vault WHERE id = ?", (secret_id,)
            ).fetchone()
            if not row:
                return False
            updates: list[str] = ["updated_at = ?"]
            params: list[Any] = [utc_now()]
            if description is not None:
                updates.append("description = ?")
                params.append(description)
            if value is not None:
                updates.append("encrypted = ?")
                params.append(encrypt_secret(self._master_key, row["name"], value))
            params.append(secret_id)
            connection.execute(f"UPDATE secrets_vault SET {', '.join(updates)} WHERE id = ?", params)
        return True

    def delete_secret(self, secret_id: str) -> bool:
        with self._connect() as connection:
            cursor = connection.execute("DELETE FROM secrets_vault WHERE id = ?", (secret_id,))
        return cursor.rowcount > 0

    # ── Feature Guides (self-documenting platform) ───────────────────────────

    def list_feature_docs(self) -> list[dict[str, Any]]:
        """Return all tasks (done/progress/planned) joined with their guides."""
        with self._connect() as connection:
            guides = {
                row["task_id"]: dict(row)
                for row in connection.execute("SELECT * FROM feature_guides").fetchall()
            }
        ws = self.get()
        tasks = ws.get("tasks", [])
        result = []
        for t in tasks:
            g = guides.get(t["id"])
            result.append({
                "id": t["id"],
                "title": t.get("title", ""),
                "description": t.get("description", ""),
                "status": t.get("status", "backlog"),
                "area": t.get("area", ""),
                "priority": t.get("priority", ""),
                "type": t.get("type", "Feature"),
                "guide": g["content"] if g else None,
                "guideGeneratedBy": g["generated_by"] if g else None,
                "guideUpdatedAt": g["updated_at"] if g else None,
            })
        return result

    def save_feature_guide(self, task_id: str, content: str, generated_by: str = "manual", model: str | None = None) -> None:
        now = utc_now()
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO feature_guides (task_id, content, generated_by, model, created_at, updated_at) VALUES (?,?,?,?,?,?) "
                "ON CONFLICT(task_id) DO UPDATE SET content=excluded.content, generated_by=excluded.generated_by, model=excluded.model, updated_at=excluded.updated_at",
                (task_id, content, generated_by, model, now, now),
            )

    # ── AI Gateway store helpers ─────────────────────────────────────────────

    def list_ai_providers(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute("SELECT id,name,provider,model,enabled,priority,base_url,secret_id,config,created_at FROM ai_providers ORDER BY priority DESC").fetchall()
        return [dict(r) for r in rows]

    def save_ai_provider(self, data: dict) -> dict[str, Any]:
        now = utc_now()
        pid = data.get("id") or str(uuid.uuid4())
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO ai_providers (id,name,provider,base_url,secret_id,model,enabled,priority,config,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
                "name=excluded.name,provider=excluded.provider,base_url=excluded.base_url,"
                "secret_id=excluded.secret_id,model=excluded.model,enabled=excluded.enabled,"
                "priority=excluded.priority,config=excluded.config,updated_at=excluded.updated_at",
                (pid, data["name"], data["provider"], data.get("base_url"),
                 data.get("secret_id"), data["model"], int(data.get("enabled", 1)),
                 int(data.get("priority", 0)), json.dumps(data.get("config", {})), now, now),
            )
        return {"id": pid}

    def delete_ai_provider(self, pid: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM ai_providers WHERE id=?", (pid,))
        return cur.rowcount > 0

    def get_ai_usage(self, org: str, days: int = 30) -> dict[str, Any]:
        since = datetime.fromtimestamp(time.time() - days * 86400, tz=timezone.utc).isoformat()
        with self._connect() as conn:
            totals = conn.execute(
                "SELECT purpose, model, COUNT(*) as requests, SUM(total_tokens) as tokens, "
                "SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as errors, "
                "AVG(latency_ms) as avg_latency "
                "FROM ai_requests WHERE organization_id=? AND created_at>=? "
                "GROUP BY purpose, model ORDER BY tokens DESC",
                (org, since),
            ).fetchall()
            daily = conn.execute(
                "SELECT substr(created_at,1,10) as day, SUM(total_tokens) as tokens, COUNT(*) as requests "
                "FROM ai_requests WHERE organization_id=? AND created_at>=? "
                "GROUP BY day ORDER BY day",
                (org, since),
            ).fetchall()
            budget = conn.execute(
                "SELECT monthly_limit FROM ai_budgets WHERE organization_id=? AND purpose='*'", (org,)
            ).fetchone()
        return {
            "byPurpose": [dict(r) for r in totals],
            "daily": [dict(r) for r in daily],
            "monthlyLimit": budget["monthly_limit"] if budget else None,
            "periodDays": days,
        }

    # ── Object Storage ───────────────────────────────────────────────────────

    @property
    def _objects_dir(self) -> Path:
        d = self.db_path.parent / "objects"
        d.mkdir(exist_ok=True)
        return d

    def _org_quota_bytes(self) -> int:
        return 500 * 1024 * 1024  # 500 MB default

    def list_objects(self, org: str, project_id: str | None = None) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if project_id:
                rows = conn.execute(
                    "SELECT id,name,mime_type,size_bytes,scan_result,safe_preview,project_id,created_by,created_at FROM objects "
                    "WHERE organization_id=? AND project_id=? ORDER BY created_at DESC",
                    (org, project_id),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT id,name,mime_type,size_bytes,scan_result,safe_preview,project_id,created_by,created_at FROM objects "
                    "WHERE organization_id=? ORDER BY created_at DESC LIMIT 200",
                    (org,),
                ).fetchall()
        return [dict(r) for r in rows]

    def store_object(self, org: str, project_id: str | None, name: str,
                     mime_type: str, data: bytes, created_by: str) -> dict[str, Any]:
        # Security scan — raises ValueError for blocked content
        scan_result, safe_preview = scan_file(name, mime_type, data)

        # Quota check
        with self._connect() as conn:
            used = conn.execute(
                "SELECT COALESCE(SUM(size_bytes),0) as s FROM objects WHERE organization_id=?", (org,)
            ).fetchone()["s"]
        if used + len(data) > self._org_quota_bytes():
            raise ValueError(f"Storage quota exceeded ({used // (1024*1024)} MB used)")

        obj_id = str(uuid.uuid4())
        ext = Path(name).suffix[:10] or ""
        rel_path = f"{org}/{obj_id}{ext}"
        abs_path = self._objects_dir / rel_path
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        abs_path.write_bytes(data)

        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO objects (id,organization_id,project_id,name,mime_type,size_bytes,storage_path,scan_result,safe_preview,created_by,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (obj_id, org, project_id, name, mime_type, len(data), rel_path, scan_result, 1 if safe_preview else 0, created_by, now, now),
            )
        return {"id": obj_id, "name": name, "mimeType": mime_type, "sizeBytes": len(data),
                "scanResult": scan_result, "safePreview": safe_preview, "createdAt": now}

    def get_object(self, org: str, obj_id: str) -> tuple[dict[str, Any], bytes] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM objects WHERE id=? AND organization_id=?", (obj_id, org)
            ).fetchone()
        if not row:
            return None
        path = self._objects_dir / row["storage_path"]
        if not path.exists():
            return None
        return dict(row), path.read_bytes()

    def delete_object(self, org: str, obj_id: str) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT storage_path FROM objects WHERE id=? AND organization_id=?", (obj_id, org)
            ).fetchone()
            if not row:
                return False
            conn.execute("DELETE FROM objects WHERE id=? AND organization_id=?", (obj_id, org))
        try:
            (self._objects_dir / row["storage_path"]).unlink(missing_ok=True)
        except OSError:
            pass
        return True

    def get_storage_stats(self, org: str) -> dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) as count, COALESCE(SUM(size_bytes),0) as total FROM objects WHERE organization_id=?",
                (org,),
            ).fetchone()
        return {"count": row["count"], "totalBytes": row["total"], "quotaBytes": self._org_quota_bytes()}

    # ── Privacy Controls ─────────────────────────────────────────────────────

    _DEFAULT_PURPOSES: list[tuple[str, int]] = [
        ("ai_requests", 90),
        ("audit_log", 365),
        ("field_telemetry", 30),
        ("object_storage", 0),
    ]

    def ensure_privacy_defaults(self, org: str) -> None:
        """Insert missing per-org privacy rows with safe defaults."""
        now = utc_now()
        with self._connect() as conn:
            existing = {r["purpose"] for r in conn.execute(
                "SELECT purpose FROM privacy_settings WHERE organization_id=?", (org,)
            ).fetchall()}
            for purpose, retention in self._DEFAULT_PURPOSES:
                if purpose not in existing:
                    conn.execute(
                        "INSERT INTO privacy_settings (id,organization_id,purpose,enabled,retention_days,redact_fields,notes,updated_at) VALUES (?,?,?,1,?,'[]','',?)",
                        (str(uuid.uuid4()), org, purpose, retention, now),
                    )

    def list_privacy_settings(self, org: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM privacy_settings WHERE organization_id=? ORDER BY purpose", (org,)
            ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["redact_fields"] = json.loads(d["redact_fields"] or "[]")
            result.append(d)
        return result

    def save_privacy_setting(self, org: str, purpose: str, enabled: bool,
                             retention_days: int, redact_fields: list[str], notes: str) -> dict[str, Any]:
        now = utc_now()
        with self._connect() as conn:
            existing = conn.execute(
                "SELECT id FROM privacy_settings WHERE organization_id=? AND purpose=?", (org, purpose)
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE privacy_settings SET enabled=?,retention_days=?,redact_fields=?,notes=?,updated_at=? "
                    "WHERE organization_id=? AND purpose=?",
                    (1 if enabled else 0, retention_days, json.dumps(redact_fields), notes, now, org, purpose),
                )
                row_id = existing["id"]
            else:
                row_id = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO privacy_settings (id,organization_id,purpose,enabled,retention_days,redact_fields,notes,updated_at) VALUES (?,?,?,?,?,?,?,?)",
                    (row_id, org, purpose, 1 if enabled else 0, retention_days, json.dumps(redact_fields), notes, now),
                )
        return {"id": row_id, "purpose": purpose, "enabled": enabled, "retentionDays": retention_days}

    def run_retention_purge(self, org: str) -> dict[str, int]:
        """Delete records older than their retention window. Returns counts."""
        settings = {s["purpose"]: s for s in self.list_privacy_settings(org)}
        deleted: dict[str, int] = {}
        with self._connect() as conn:
            for purpose, cfg in settings.items():
                days = cfg["retention_days"]
                if days <= 0 or not cfg["enabled"]:
                    continue
                cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
                if purpose == "ai_requests":
                    cur = conn.execute("DELETE FROM ai_requests WHERE organization_id=? AND created_at<?", (org, cutoff))
                    deleted["ai_requests"] = cur.rowcount
                elif purpose == "audit_log":
                    cur = conn.execute("DELETE FROM audit_log WHERE organization_id=? AND created_at<?", (org, cutoff))
                    deleted["audit_log"] = cur.rowcount
        return deleted

    # ── Audit Log ────────────────────────────────────────────────────────────

    def audit(self, org: str, actor_id: str | None, actor_role: str | None,
              action: str, target_type: str | None = None, target_id: str | None = None,
              outcome: str = "ok", ip: str | None = None) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO audit_log (id,organization_id,actor_id,actor_role,action,target_type,target_id,outcome,ip,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (str(uuid.uuid4()), org, actor_id, actor_role, action, target_type, target_id, outcome, ip, utc_now()),
            )

    def list_audit_log(self, org: str, limit: int = 100) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM audit_log WHERE organization_id=? ORDER BY created_at DESC LIMIT ?", (org, limit)
            ).fetchall()
        return [dict(r) for r in rows]


# ── File Security Scanner ─────────────────────────────────────────────────────

# Extension blocklist: never store executables or scripts
_BLOCKED_EXTENSIONS: frozenset[str] = frozenset({
    ".exe", ".bat", ".cmd", ".com", ".scr", ".pif",  # Windows executables
    ".sh", ".bash", ".zsh", ".fish", ".csh",          # Unix scripts
    ".ps1", ".psm1", ".psd1",                          # PowerShell
    ".py", ".rb", ".pl", ".php", ".lua",               # Interpreted scripts
    ".js", ".mjs", ".vbs", ".wsf",                     # Web/Windows scripts
    ".jar", ".war", ".ear",                            # Java archives (runnable)
    ".dll", ".so", ".dylib",                           # Shared libraries
    ".elf",                                             # Linux binary
    ".dmg", ".pkg",                                    # macOS installers
    ".msi", ".inf",                                    # Windows installers
})

# MIME allowlist
_ALLOWED_MIMES: frozenset[str] = frozenset({
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
    "image/bmp", "image/tiff",
    "application/pdf",
    "text/plain", "text/csv", "text/markdown", "text/html",
    "application/json", "application/xml", "text/xml",
    "application/zip", "application/gzip", "application/x-tar",
    "application/x-7z-compressed", "application/x-rar-compressed",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "video/mp4", "video/webm", "video/ogg", "video/quicktime",
    "audio/mpeg", "audio/wav", "audio/ogg", "audio/flac",
    "application/octet-stream",
})

# MIME types that are safe to render inline (no download required)
_PREVIEW_SAFE: frozenset[str] = frozenset({
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
    "application/pdf", "text/plain", "text/csv",
})

# Magic byte signatures: (offset, bytes) → canonical mime
_MAGIC: list[tuple[int, bytes, str]] = [
    (0, b"\xff\xd8\xff", "image/jpeg"),
    (0, b"\x89PNG\r\n\x1a\n", "image/png"),
    (0, b"GIF87a", "image/gif"),
    (0, b"GIF89a", "image/gif"),
    (0, b"RIFF", "image/webp"),           # further check bytes 8-11 == WEBP
    (0, b"%PDF", "application/pdf"),
    (0, b"PK\x03\x04", "application/zip"),
    (0, b"PK\x05\x06", "application/zip"),
    (0, b"\x1f\x8b", "application/gzip"),
    (0, b"BZh", "application/x-bzip2"),
    (0, b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "application/msword"),
    (0, b"MZ", "application/x-dosexec"),   # Windows PE — always block
    (0, b"\x7fELF", "application/x-elf"),  # Linux ELF — always block
    (0, b"#!", "text/x-script"),            # shebang — always block
]


def _detect_mime_from_magic(data: bytes) -> str | None:
    head = data[:16]
    for offset, sig, mime in _MAGIC:
        if head[offset:offset + len(sig)] == sig:
            if mime == "image/webp" and len(data) >= 12 and data[8:12] == b"WEBP":
                return "image/webp"
            if mime == "image/webp":
                continue  # RIFF but not WEBP
            return mime
    return None


def scan_file(name: str, mime_type: str, data: bytes) -> tuple[str, bool]:
    """
    Returns (scan_result, safe_preview).
    scan_result: 'clean' | 'quarantine' | 'blocked'
    Raises ValueError for always-blocked content.
    """
    ext = Path(name).suffix.lower()

    # Hard block: dangerous extensions
    if ext in _BLOCKED_EXTENSIONS:
        raise ValueError(f"File type '{ext}' is not permitted")

    detected = _detect_mime_from_magic(data)

    # Hard block: executable magic bytes
    if detected in {"application/x-dosexec", "application/x-elf", "text/x-script"}:
        raise ValueError("Executable content detected — upload rejected")

    # MIME type not in allowlist
    claim = mime_type.split(";")[0].strip().lower()
    if claim not in _ALLOWED_MIMES:
        raise ValueError(f"MIME type '{claim}' is not permitted")

    # Mismatch between claimed and detected MIME → quarantine (don't serve inline)
    if detected and detected not in {claim, "application/octet-stream"}:
        # Allow common aliases
        aliases = {
            ("application/zip", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            ("application/zip", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            ("application/zip", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        }
        if (detected, claim) not in aliases and (claim, detected) not in aliases:
            safe_preview = False
            return "quarantine", safe_preview

    safe_preview = claim in _PREVIEW_SAFE
    return "clean", safe_preview


class AIGateway:
    """Provider-agnostic AI request router with token logging and budget checks."""

    def __init__(self, store: "WorkspaceStore"):
        self.store = store

    def _get_api_key(self, provider_row: Any) -> str | None:
        if provider_row["secret_id"]:
            value = self.store.get_secret_value(provider_row["secret_id"])
            if value:
                return value
        env_map = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY"}
        env_key = env_map.get(provider_row["provider"], "")
        return os.environ.get(env_key) if env_key else None

    def _log_request(self, provider_id: str | None, org: str, user: str | None,
                     purpose: str, model: str, prompt_t: int, compl_t: int,
                     latency: int | None, status: str, error: str | None = None) -> None:
        with self.store._connect() as conn:
            conn.execute(
                "INSERT INTO ai_requests (id,provider_id,organization_id,user_id,purpose,model,"
                "prompt_tokens,completion_tokens,total_tokens,latency_ms,status,error,created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (str(uuid.uuid4()), provider_id, org, user, purpose, model,
                 prompt_t, compl_t, prompt_t + compl_t, latency, status, error, utc_now()),
            )

    def _check_budget(self, org: str, purpose: str, estimated_tokens: int) -> tuple[bool, str]:
        month_start = datetime.now(timezone.utc).strftime("%Y-%m-01T00:00:00+00:00")
        with self.store._connect() as conn:
            budget = conn.execute(
                "SELECT monthly_limit FROM ai_budgets "
                "WHERE organization_id=? AND (purpose=? OR purpose='*') "
                "ORDER BY purpose DESC LIMIT 1",
                (org, purpose),
            ).fetchone()
            if not budget:
                return True, "no_budget_set"
            used = conn.execute(
                "SELECT COALESCE(SUM(total_tokens),0) as s FROM ai_requests "
                "WHERE organization_id=? AND created_at>=?",
                (org, month_start),
            ).fetchone()["s"]
        if used + estimated_tokens > budget["monthly_limit"]:
            return False, f"monthly_budget_exceeded ({used}/{budget['monthly_limit']} tokens)"
        return True, "ok"

    def call(self, *, purpose: str, messages: list[dict], org: str,
             user: str | None = None, model: str | None = None,
             max_tokens: int = 500) -> dict[str, Any]:
        t0 = time.perf_counter()
        with self.store._connect() as conn:
            prow = conn.execute(
                "SELECT * FROM ai_providers WHERE enabled=1 ORDER BY priority DESC LIMIT 1"
            ).fetchone()

        use_model = model or (prow["model"] if prow else "claude-haiku-4-5-20251001")
        provider = prow["provider"] if prow else "anthropic"
        api_key = (self._get_api_key(prow) if prow else None) or os.environ.get("ANTHROPIC_API_KEY", "")

        if not api_key:
            raise ValueError("No API key available for AI gateway")

        est_tokens = sum(len(m.get("content", "")) for m in messages) // 4 + max_tokens
        allowed, reason = self._check_budget(org, purpose, est_tokens)
        if not allowed:
            self._log_request(prow["id"] if prow else None, org, user, purpose, use_model, 0, 0, None, "blocked", reason)
            raise ValueError(f"AI request blocked: {reason}")

        pid = prow["id"] if prow else None
        try:
            if provider == "anthropic":
                result = _anthropic_chat(api_key, use_model, messages, max_tokens)
            else:
                raise ValueError(f"Provider '{provider}' not yet supported")
            latency = int((time.perf_counter() - t0) * 1000)
            self._log_request(pid, org, user, purpose, use_model, result["prompt_tokens"], result["completion_tokens"], latency, "ok")
            return result
        except Exception as err:
            latency = int((time.perf_counter() - t0) * 1000)
            self._log_request(pid, org, user, purpose, use_model, 0, 0, latency, "error", str(err)[:500])
            raise


def _anthropic_chat(api_key: str, model: str, messages: list[dict], max_tokens: int) -> dict[str, Any]:
    body = json.dumps({"model": model, "max_tokens": max_tokens, "messages": messages}).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    usage = data.get("usage", {})
    return {
        "text": data["content"][0]["text"].strip(),
        "model": data.get("model", model),
        "prompt_tokens": usage.get("input_tokens", 0),
        "completion_tokens": usage.get("output_tokens", 0),
    }


def _call_claude_for_guide(task_id: str, title: str, description: str, area: str, api_key: str) -> str:
    """Generate a user-facing feature guide via _anthropic_chat (goes through gateway logging)."""
    prompt = (
        f"You are writing a concise user guide for a feature in RackPilot — an AI-native field operations platform.\n\n"
        f"Feature: {title}\nArea: {area}\nDescription: {description}\n\n"
        f"Write a guide in Russian with these exact sections (use markdown headers):\n"
        f"## Что это\nOne or two sentences: what this feature is.\n\n"
        f"## Зачем это нужно\nOne or two sentences: the business/technical motivation.\n\n"
        f"## Как использовать\nNumbered steps or a short paragraph. Be concrete and specific to this feature.\n\n"
        f"## Заметки\nAny requirements, caveats, or tips. If none, write \"—\".\n\n"
        f"Be concise. Total length: 120–200 words. Do not mention the feature ID."
    )
    result = _anthropic_chat(api_key, "claude-haiku-4-5-20251001", [{"role": "user", "content": prompt}], 400)
    return result["text"]


class RevisionConflict(Exception):
    def __init__(self, current_revision: int):
        super().__init__(f"Revision conflict; current revision is {current_revision}")
        self.current_revision = current_revision


class EntityVersionConflict(Exception):
    def __init__(self, current_version: int):
        super().__init__(f"Entity version conflict; current version is {current_version}")
        self.current_version = current_version


class InvalidTransition(Exception):
    def __init__(self, current_status: str, requested_status: str):
        super().__init__(f"Transition {current_status} → {requested_status} is not allowed")
        self.current_status = current_status
        self.requested_status = requested_status


class DependenciesIncomplete(Exception):
    def __init__(self, blocker_ids: list[str]):
        super().__init__("Work item has incomplete dependencies")
        self.blocker_ids = blocker_ids


class ApiMetricsRecorder:
    """In-memory API telemetry for the local admin monitoring surface."""

    def __init__(self, retention: int = 500):
        self.retention = retention
        self._events: list[dict[str, Any]] = []
        self._lock = threading.RLock()

    def record(self, event: dict[str, Any]) -> None:
        with self._lock:
            self._events.append(event)
            if len(self._events) > self.retention:
                self._events = self._events[-self.retention:]

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            events = list(self._events)
        durations = sorted(float(event["durationMs"]) for event in events)
        count = len(events)
        status_counts = Counter(str(event["status"]) for event in events)
        method_counts = Counter(str(event["method"]) for event in events)
        route_counts = Counter(str(event["route"]) for event in events)
        p95_index = max(0, min(count - 1, int(count * 0.95) - 1)) if count else 0
        return {
            "requestCount": count,
            "averageMs": round(sum(durations) / count, 2) if count else 0,
            "p95Ms": round(durations[p95_index], 2) if count else 0,
            "errorCount": sum(1 for event in events if int(event["status"]) >= 400),
            "statusCounts": dict(sorted(status_counts.items())),
            "methodCounts": dict(sorted(method_counts.items())),
            "topRoutes": [{"route": route, "count": value} for route, value in route_counts.most_common(8)],
            "recent": list(reversed(events[-80:])),
            "updatedAt": utc_now(),
            "retention": self.retention,
        }


def validate_workspace(payload: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    if not isinstance(payload, dict):
        raise ValueError("JSON object expected")
    tasks = payload.get("tasks")
    audit = payload.get("audit", [])
    revision = payload.get("expectedRevision")
    if not isinstance(tasks, list) or not isinstance(audit, list) or not isinstance(revision, int):
        raise ValueError("tasks, audit and expectedRevision are required")
    if len(tasks) > 5000 or len(audit) > 1000:
        raise ValueError("Workspace limit exceeded")
    seen_ids: set[str] = set()
    for task in tasks:
        if not isinstance(task, dict):
            raise ValueError("Invalid task")
        task_id = task.get("id")
        title = task.get("title")
        if not isinstance(task_id, str) or not task_id or task_id in seen_ids:
            raise ValueError("Task IDs must be unique strings")
        if not isinstance(title, str) or not title.strip() or len(title) > 120:
            raise ValueError(f"Invalid title for {task_id}")
        if task.get("status") not in ALLOWED_STATUSES or task.get("priority") not in ALLOWED_PRIORITIES:
            raise ValueError(f"Invalid workflow value for {task_id}")
        seen_ids.add(task_id)
    return tasks, audit, revision


class FieldOSHandler(BaseHTTPRequestHandler):
    server_version = "RackPilot/0.33"

    @property
    def store(self) -> WorkspaceStore:
        return self.server.store  # type: ignore[attr-defined]

    def do_GET(self) -> None:
        self._start_request()
        path = urlparse(self.path).path
        if path in {"/api/health", "/api/v1/health"}:
            self._json(HTTPStatus.OK, {"status": "ok", "service": "rackpilot-local", "apiVersion": "v1", "schemaVersion": self.store.migration_result.current_version, "time": utc_now()})
            return
        if path == "/api/v1/auth/me":
            if not self.session_context:
                self._error(HTTPStatus.UNAUTHORIZED, "unauthenticated", "No active session")
                return
            self._json(HTTPStatus.OK, {"user": self.session_context})
            return
        if path == "/api/v1/organizations":
            self._json(HTTPStatus.OK, {"organizations": self.store.list_organizations()})
            return
        if path == "/api/v1/audit/integrity":
            if not self._require_permission("logsRead"):
                return
            project_id = parse_qs(urlparse(self.path).query).get("projectId", [None])[0]
            self._json(HTTPStatus.OK, self.store.verify_audit_integrity(self.organization_id, project_id))
            return
        if path == "/api/v1/logs":
            if not self._require_permission("logsRead"): return
            query=parse_qs(urlparse(self.path).query)
            self._json(HTTPStatus.OK,self.store.list_logs(self.organization_id,{
                "source":query.get("source",["all"])[0],
                "projectId":query.get("projectId",[None])[0],
                "entityType":query.get("entityType",["all"])[0],
                "q":query.get("q",[""])[0],
                "limit":query.get("limit",[100])[0],
            }))
            return
        if path == "/api/v1/admin/compute-nodes":
            if not self._require_permission("adminPanel"): return
            self._json(HTTPStatus.OK,{"organizationId":self.organization_id,"nodes":self.store.list_compute_nodes(self.organization_id)})
            return
        if path == "/api/v1/admin/git-sync":
            if not self._require_permission("adminPanel"): return
            self._json(HTTPStatus.OK,{"organizationId":self.organization_id,"settings":self.store.get_git_sync_settings(self.organization_id)})
            return
        if path == "/api/v1/admin/api-metrics":
            if not self._require_permission("apiMonitor"): return
            self._json(HTTPStatus.OK,{"organizationId":self.organization_id,"access":"administrator","metrics":self.server.api_metrics.snapshot()})  # type: ignore[attr-defined]
            return
        if path == "/api/v1/admin/platform-settings":
            if not self._require_permission("adminPanel"): return
            self._json(HTTPStatus.OK,{"organizationId":self.organization_id,"settings":self.store.get_platform_settings(self.organization_id)})
            return
        if path == "/api/v1/admin/work-types":
            if not self._require_permission("adminPanel"): return
            self._json(HTTPStatus.OK,{"organizationId":self.organization_id,"workTypes":self.store.list_workflow_configuration(self.organization_id)})
            return
        if path == "/api/v1/admin/custom-fields":
            if not self._require_permission("adminPanel"): return
            self._json(HTTPStatus.OK,{"organizationId":self.organization_id,"customFields":self.store.list_custom_field_definitions(self.organization_id)})
            return
        if path == "/api/v1/admin/secrets":
            if not self._require_permission("secretsManage"): return
            self._json(HTTPStatus.OK, {"secrets": self.store.list_secrets()})
            return
        if path == "/api/v1/admin/platform-growth":
            if not self._require_permission("adminPanel"): return
            self._json(HTTPStatus.OK, _build_platform_growth())
            return
        if path == "/api/v1/admin/feature-docs":
            if not self._require_permission("adminPanel"): return
            self._json(HTTPStatus.OK, {"features": self.store.list_feature_docs()})
            return
        if path == "/api/v1/admin/ai-gateway/providers":
            if not self._require_permission("adminPanel"): return
            self._json(HTTPStatus.OK, {"providers": self.store.list_ai_providers()})
            return
        if path == "/api/v1/admin/ai-gateway/usage":
            if not self._require_permission("adminPanel"): return
            days = int(self.query_params.get("days", ["30"])[0])
            self._json(HTTPStatus.OK, self.store.get_ai_usage(self.organization_id, min(days, 365)))
            return
        if path == "/api/v1/admin/privacy":
            if not self._require_permission("adminPanel"): return
            self._json(HTTPStatus.OK, {"settings": self.store.list_privacy_settings(self.organization_id)})
            return
        if path == "/api/v1/admin/audit-log":
            if not self._require_permission("adminPanel"): return
            limit = min(int(self.query_params.get("limit", ["100"])[0]), 500)
            self._json(HTTPStatus.OK, {"entries": self.store.list_audit_log(self.organization_id, limit)})
            return
        if path == "/api/v1/agent/context":
            if not self._require_permission("agentContext"): return
            ctx = _build_agent_context(self.store)
            repo = Path(__file__).parent.parent
            threading.Thread(target=_write_agent_context_file, args=(ctx, repo), daemon=True).start()
            self._json(HTTPStatus.OK, ctx)
            return
        if path.startswith("/api/v1/admin/secrets/") and path.endswith("/reveal"):
            if not self._require_permission("secretsManage"): return
            secret_id = path.split("/")[-2]
            value = self.store.get_secret_value(secret_id)
            if value is None:
                self._error(HTTPStatus.NOT_FOUND, "not_found", "Secret not found or integrity check failed")
                return
            self._json(HTTPStatus.OK, {"value": value})
            return
        if path == "/api/v1/development-agent/status":
            if not self._require_organization(): return
            self._json(HTTPStatus.OK,{"organizationId":self.organization_id,"agent":self.store.get_development_agent_status(self.organization_id)})
            return
        if path == "/api/v1/projects":
            if not self._require_permission("projectRead"):
                return
            self._json(HTTPStatus.OK, {"organizationId": self.organization_id, "projects": self.store.list_projects(self.organization_id)})
            return
        if path.startswith("/api/v1/projects/"):
            if not self._require_permission("projectRead"):
                return
            parts = path.strip("/").split("/")
            if len(parts) == 4:
                project = self.store.get_project(self.organization_id, parts[3])
                if project is None:
                    self._error(HTTPStatus.NOT_FOUND, "project_not_found", "Project not found")
                    return
                self._json(HTTPStatus.OK, {"organizationId": self.organization_id, "project": project})
                return
            if len(parts) == 5 and parts[4] == "daily-report":
                work_date = parse_qs(urlparse(self.path).query).get("date", [str(datetime.now(timezone.utc).date())])[0]
                try:
                    self._json(HTTPStatus.OK, self.store.generate_daily_report(self.organization_id, parts[3], work_date))
                except LookupError as error:
                    self._error(HTTPStatus.NOT_FOUND, "project_not_found", str(error))
                return
            if len(parts) == 5 and parts[4] == "objects":
                objects = self.store.list_objects(self.organization_id, parts[3])
                stats = self.store.get_storage_stats(self.organization_id)
                self._json(HTTPStatus.OK, {"objects": objects, "stats": stats})
                return
        # Object download / delete
        if path.startswith("/api/v1/objects/"):
            obj_id = path[len("/api/v1/objects/"):]
            if not obj_id:
                self._error(HTTPStatus.BAD_REQUEST, "missing_id", "Object ID required"); return
            if not self._require_permission("projectRead"): return
            result = self.store.get_object(self.organization_id, obj_id)
            if not result:
                self._error(HTTPStatus.NOT_FOUND, "not_found", "Object not found"); return
            meta, data = result
            if meta.get("scan_result") == "quarantine":
                self._error(HTTPStatus.FORBIDDEN, "quarantine", "File is quarantined — cannot be served"); return
            self.send_response(HTTPStatus.OK)
            self._security_headers()
            self.send_header("Content-Type", meta["mime_type"])
            self.send_header("Content-Length", str(len(data)))
            safe_name = "".join(c if c.isalnum() or c in "-_." else "_" for c in meta["name"])
            disposition = "inline" if meta.get("safe_preview") else "attachment"
            self.send_header("Content-Disposition", f'{disposition}; filename="{safe_name}"')
            self.send_header("Cache-Control", "private, max-age=3600")
            self.end_headers()
            self.wfile.write(data)
            return
        if path in {"/api/workspace", "/api/v1/workspace"}:
            if not self._require_permission("developmentWorkspace"):
                return
            etag = self.store.etag(self.organization_id)
            if self.headers.get("If-None-Match") == etag:
                self.send_response(HTTPStatus.NOT_MODIFIED)
                self._security_headers()
                self.send_header("ETag", etag)
                self.end_headers()
                return
            self._json(HTTPStatus.OK, self.store.get(self.organization_id), extra_headers={"ETag": etag})
            return
        if path == "/api/v1/openapi.yaml":
            self._serve_file(OPENAPI_PATH, "application/yaml; charset=utf-8")
            return
        if path == "/floorplan":
            fp = WEB_ROOT / "floorplan.html"
            if not fp.is_file():
                self._error(HTTPStatus.NOT_FOUND, "not_found", "Resource not found")
                return
            data = fp.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            # Relaxed CSP for experimental page: allows inline styles/scripts and CDN
            self.send_header("Content-Security-Policy",
                "default-src 'self'; "
                "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
                "style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data: blob:; "
                "connect-src 'self' https://cdn.jsdelivr.net; "
                "worker-src blob:; "
                "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
            )
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
            return
        self._serve_static(path)

    def do_PUT(self) -> None:
        self._start_request()
        if urlparse(self.path).path not in {"/api/workspace", "/api/v1/workspace"}:
            self._error(HTTPStatus.NOT_FOUND, "not_found", "Route not found")
            return
        if not self._require_permission("developmentWorkspace"):
            return
        try:
            payload = self._read_json()
            tasks, audit, revision = validate_workspace(payload)
            request_hash = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
            idempotency_key = self.headers.get("Idempotency-Key")
            if idempotency_key:
                if len(idempotency_key) > 128:
                    raise ValueError("Idempotency-Key exceeds 128 characters")
                cached = self.store.get_idempotency(idempotency_key, self.organization_id)
                if cached:
                    if cached["requestHash"] != request_hash:
                        self._error(HTTPStatus.CONFLICT, "idempotency_key_reused", "Idempotency key was used with a different request")
                        return
                    self._json(HTTPStatus(cached["status"]), cached["response"])
                    return
            result = self.store.save(tasks, audit, revision, self.organization_id)
            response = {"ok": True, **result}
            if idempotency_key:
                self.store.save_idempotency(idempotency_key, request_hash, HTTPStatus.OK, response, self.organization_id)
            self._json(HTTPStatus.OK, response)
        except RevisionConflict as conflict:
            self._error(HTTPStatus.CONFLICT, "revision_conflict", "Workspace revision is stale", {"currentRevision": conflict.current_revision})
        except (ValueError, json.JSONDecodeError) as error:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(error))

    def do_POST(self) -> None:
        self._start_request()
        path = urlparse(self.path).path
        parts = path.strip("/").split("/")
        if path == "/api/v1/auth/login":
            self._handle_auth_login()
            return
        if path == "/api/v1/auth/logout":
            self._handle_auth_logout()
            return
        if path == "/api/v1/floorplan/analyze":
            self._handle_floorplan_analyze()
            return
        if path=="/api/v1/admin/work-types":
            if not self._require_permission("adminPanel"): return
            try:
                payload=self._read_json()
                if not isinstance(payload,dict): raise ValueError("JSON object expected")
                self._json(HTTPStatus.CREATED,{"organizationId":self.organization_id,"workType":self.store.save_workflow_configuration(self.organization_id,payload)})
            except (ValueError,json.JSONDecodeError) as error: self._error(HTTPStatus.BAD_REQUEST,"invalid_request",str(error))
            return
        if path=="/api/v1/admin/custom-fields":
            if not self._require_permission("adminPanel"): return
            try:
                payload=self._read_json()
                if not isinstance(payload,dict): raise ValueError("JSON object expected")
                self._json(HTTPStatus.CREATED,{"organizationId":self.organization_id,"customField":self.store.save_custom_field_definition(self.organization_id,payload)})
            except (ValueError,json.JSONDecodeError) as error: self._error(HTTPStatus.BAD_REQUEST,"invalid_request",str(error))
            return
        if path == "/api/v1/admin/feature-docs/generate":
            if not self._require_permission("adminPanel"): return
            try:
                body = self._read_json()
                task_id = str(body.get("taskId", "")).strip()
                if not task_id:
                    self._error(HTTPStatus.BAD_REQUEST, "missing_field", "taskId required"); return
                api_key = os.environ.get("ANTHROPIC_API_KEY", "")
                if not api_key:
                    self._error(HTTPStatus.SERVICE_UNAVAILABLE, "no_api_key", "ANTHROPIC_API_KEY not configured"); return
                # Find task
                ws = self.store.get()
                task = next((t for t in ws.get("tasks", []) if t["id"] == task_id), None)
                if not task:
                    self._error(HTTPStatus.NOT_FOUND, "not_found", f"Task {task_id} not found"); return
                guide = _call_claude_for_guide(
                    task_id, task.get("title", ""), task.get("description", ""), task.get("area", ""), api_key
                )
                self.store.save_feature_guide(task_id, guide, generated_by="claude", model="claude-haiku-4-5-20251001")
                self._json(HTTPStatus.OK, {"taskId": task_id, "guide": guide})
            except (json.JSONDecodeError, ValueError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            except Exception as err:
                self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "generation_failed", str(err))
            return
        if path == "/api/v1/admin/feature-docs/save":
            if not self._require_permission("adminPanel"): return
            try:
                body = self._read_json()
                task_id = str(body.get("taskId", "")).strip()
                content = str(body.get("content", "")).strip()
                if not task_id or not content:
                    self._error(HTTPStatus.BAD_REQUEST, "missing_fields", "taskId and content required"); return
                self.store.save_feature_guide(task_id, content, generated_by="manual")
                self._json(HTTPStatus.OK, {"ok": True})
            except (json.JSONDecodeError, ValueError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        if path == "/api/v1/admin/ai-gateway/providers":
            if not self._require_permission("adminPanel"): return
            try:
                data = self._read_json()
                result = self.store.save_ai_provider(data)
                self._json(HTTPStatus.OK, result)
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        if path.startswith("/api/v1/admin/ai-gateway/providers/") and parts[-1] == "delete":
            if not self._require_permission("adminPanel"): return
            pid = parts[-2]
            if self.store.delete_ai_provider(pid):
                self._json(HTTPStatus.OK, {"ok": True})
            else:
                self._error(HTTPStatus.NOT_FOUND, "not_found", "Provider not found")
            return
        if path == "/api/v1/admin/privacy":
            if not self._require_permission("adminPanel"): return
            try:
                body = self._read_json()
                purpose = str(body.get("purpose", "")).strip()
                if not purpose: raise ValueError("purpose required")
                enabled = bool(body.get("enabled", True))
                retention = int(body.get("retention_days", 90))
                redact = [str(f) for f in body.get("redact_fields", [])]
                notes = str(body.get("notes", ""))
                sess = self.session_context or {}
                result = self.store.save_privacy_setting(self.organization_id, purpose, enabled, retention, redact, notes)
                self.store.audit(self.organization_id, sess.get("userId"), sess.get("role"), "privacy.update", "privacy_setting", purpose, "ok")
                self._json(HTTPStatus.OK, {"setting": result})
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        if path == "/api/v1/admin/secrets":
            if not self._require_permission("secretsManage"): return
            try:
                body = self._read_json()
                name = str(body.get("name", "")).strip()
                value = str(body.get("value", "")).strip()
                description = str(body.get("description", "")).strip()
                category = str(body.get("category", "api_key")).strip()
                created_by = (self.session_context or {}).get("userId", "local-admin")
                secret = self.store.create_secret(name, value, description, category, created_by)
                self._json(HTTPStatus.CREATED, {"secret": secret})
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        if path.startswith("/api/v1/admin/secrets/") and parts[-1] == "delete":
            if not self._require_permission("secretsManage"): return
            secret_id = parts[-2]
            if self.store.delete_secret(secret_id):
                self._json(HTTPStatus.OK, {"ok": True})
            else:
                self._error(HTTPStatus.NOT_FOUND, "not_found", "Secret not found")
            return
        if path=="/api/v1/admin/git-sync":
            if not self._require_permission("adminPanel"): return
            try:
                payload=self._read_json()
                if not isinstance(payload,dict): raise ValueError("JSON object expected")
                self._json(HTTPStatus.OK,{"organizationId":self.organization_id,"settings":self.store.save_git_sync_settings(self.organization_id,payload)})
            except (ValueError,json.JSONDecodeError) as error: self._error(HTTPStatus.BAD_REQUEST,"invalid_request",str(error))
            return
        if path=="/api/v1/admin/platform-settings":
            if not self._require_permission("adminPanel"): return
            try:
                payload=self._read_json()
                if not isinstance(payload,dict): raise ValueError("JSON object expected")
                self._json(HTTPStatus.OK,{"organizationId":self.organization_id,"settings":self.store.save_platform_settings(self.organization_id,payload)})
            except (ValueError,json.JSONDecodeError) as error: self._error(HTTPStatus.BAD_REQUEST,"invalid_request",str(error))
            return
        if path=="/api/v1/development-agent/continue":
            if not self._require_organization(): return
            self._json(HTTPStatus.ACCEPTED,{"organizationId":self.organization_id,"agent":self.store.request_development_continuation(self.organization_id)})
            return
        if path=="/api/v1/development-agent/status":
            if not self._require_organization(): return
            supplied=self.headers.get("X-Agent-Token","")
            if not supplied or not hmac.compare_digest(supplied,self.server.agent_token):  # type: ignore[attr-defined]
                self._error(HTTPStatus.UNAUTHORIZED,"agent_unauthorized","Invalid agent token");return
            try:
                payload=self._read_json()
                if not isinstance(payload,dict): raise ValueError("JSON object expected")
                self._json(HTTPStatus.OK,{"organizationId":self.organization_id,"agent":self.store.set_development_agent_status(self.organization_id,payload)})
            except (ValueError,json.JSONDecodeError) as error: self._error(HTTPStatus.BAD_REQUEST,"invalid_request",str(error))
            return
        if len(parts)==5 and parts[:4]==["api","v1","telemetry","nodes"]:
            if not self._require_organization(): return
            supplied=self.headers.get("X-Agent-Token","")
            if not supplied or not hmac.compare_digest(supplied,self.server.agent_token):  # type: ignore[attr-defined]
                self._error(HTTPStatus.UNAUTHORIZED,"agent_unauthorized","Invalid agent token")
                return
            try:
                payload=self._read_json()
                if not isinstance(payload,dict): raise ValueError("JSON object expected")
                self._json(HTTPStatus.CREATED,self.store.record_compute_node(self.organization_id,parts[4],payload))
            except (ValueError,json.JSONDecodeError) as error:
                self._error(HTTPStatus.BAD_REQUEST,"invalid_request",str(error))
            return
        # Object upload: POST /api/v1/projects/:id/objects — raw binary body
        if path.startswith("/api/v1/projects/") and len(parts) == 5 and parts[4] == "objects":
            if not self._require_permission("projectManage"): return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size <= 0 or size > 50 * 1024 * 1024:
                    self._error(HTTPStatus.BAD_REQUEST, "invalid_size", "File must be 1 byte – 50 MB"); return
                raw_name = self.headers.get("X-File-Name", "upload")
                file_name = "".join(c if c.isalnum() or c in "-_. " else "_" for c in raw_name)[:200] or "upload"
                mime_type = self.headers.get("Content-Type", "application/octet-stream").split(";")[0].strip()
                data = self.rfile.read(size)
                created_by = (self.session_context or {}).get("userId", "local-admin")
                obj = self.store.store_object(self.organization_id, parts[3], file_name, mime_type, data, created_by)
                self._json(HTTPStatus.CREATED, {"object": obj})
            except ValueError as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        # Object delete: POST /api/v1/objects/:id/delete
        if path.startswith("/api/v1/objects/") and parts[-1] == "delete":
            if not self._require_permission("projectManage"): return
            obj_id = parts[-2]
            if self.store.delete_object(self.organization_id, obj_id):
                self._json(HTTPStatus.OK, {"ok": True})
            else:
                self._error(HTTPStatus.NOT_FOUND, "not_found", "Object not found")
            return
        if path != "/api/v1/projects" and not path.startswith("/api/v1/projects/"):
            self._error(HTTPStatus.NOT_FOUND, "not_found", "Route not found")
            return
        if path == "/api/v1/projects":
            if not self._require_permission("projectManage"):
                return
        elif path.startswith("/api/v1/projects/"):
            permission = "fieldProgress" if (len(parts) == 5 and parts[4] == "daily-updates") else "projectManage"
            if len(parts)==7 and parts[4]=="locations" and parts[6]=="units":
                permission = "projectManage"
            if not self._require_permission(permission):
                return
        elif not self._require_organization():
            return
        try:
            payload = self._read_json()
            if not isinstance(payload, dict):
                raise ValueError("JSON object expected")
            idempotency_key = self.headers.get("Idempotency-Key")
            request_hash = hashlib.sha256(json.dumps({"path": path, "payload": payload}, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
            if idempotency_key:
                if len(idempotency_key) > 128:
                    raise ValueError("Idempotency-Key exceeds 128 characters")
                cached = self.store.get_idempotency(idempotency_key, self.organization_id)
                if cached:
                    if cached["requestHash"] != request_hash:
                        self._error(HTTPStatus.CONFLICT, "idempotency_key_reused", "Idempotency key was used with a different request")
                        return
                    self._json(HTTPStatus(cached["status"]), cached["response"])
                    return
            if path == "/api/v1/projects":
                project = self.store.create_project(self.organization_id, payload)
                response = {"organizationId": self.organization_id, "project": project}
            else:
                parts = path.strip("/").split("/")
                if len(parts)==7 and parts[4]=="locations" and parts[6]=="units":
                    unit=self.store.create_unit(self.organization_id,parts[3],parts[5],payload)
                    response={"organizationId":self.organization_id,"unit":unit}
                elif len(parts) == 7 and parts[4] == "work-items" and parts[6] == "dependencies":
                    predecessor_id = payload.get("predecessorId")
                    if not isinstance(predecessor_id, str) or not predecessor_id:
                        raise ValueError("predecessorId is required")
                    work_item = self.store.add_work_item_dependency(self.organization_id, parts[3], parts[5], predecessor_id)
                    response = {"organizationId": self.organization_id, "workItem": work_item}
                elif len(parts) != 5 or parts[4] not in {"buildings", "work-items", "locations", "daily-updates"}:
                    self._error(HTTPStatus.NOT_FOUND, "not_found", "Route not found")
                    return
                elif parts[4] == "buildings":
                    building = self.store.create_building(self.organization_id, parts[3], payload)
                    response = {"organizationId": self.organization_id, "building": building}
                elif parts[4] == "work-items":
                    work_item = self.store.create_work_item(self.organization_id, parts[3], payload)
                    response = {"organizationId": self.organization_id, "workItem": work_item}
                elif parts[4] == "locations":
                    location = self.store.create_location(self.organization_id, parts[3], payload)
                    response = {"organizationId": self.organization_id, "location": location}
                else:
                    daily_update = self.store.save_daily_update(self.organization_id, parts[3], payload)
                    response = {"organizationId": self.organization_id, "dailyUpdate": daily_update}
            if idempotency_key:
                self.store.save_idempotency(idempotency_key, request_hash, HTTPStatus.CREATED, response, self.organization_id)
            self._json(HTTPStatus.CREATED, response)
        except LookupError as error:
            self._error(HTTPStatus.NOT_FOUND, "project_not_found", str(error))
        except (ValueError, json.JSONDecodeError) as error:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(error))

    def do_PATCH(self) -> None:
        self._start_request()
        path = urlparse(self.path).path
        parts = path.strip("/").split("/")
        admin_node_route = len(parts)==6 and parts[:4]==["api","v1","admin","compute-nodes"] and parts[5]=="enabled"
        workflow_route = len(parts)==5 and parts[:4]==["api","v1","admin","work-types"]
        custom_field_route = len(parts)==5 and parts[:4]==["api","v1","admin","custom-fields"]
        regular_route = len(parts) == 6 and parts[:3] == ["api", "v1", "projects"] and parts[4] in {"work-items", "daily-updates", "locations"}
        unit_detail_route = len(parts)==8 and parts[:3]==["api","v1","projects"] and parts[4]=="locations" and parts[6]=="units"
        unit_route = len(parts) == 9 and parts[:3] == ["api", "v1", "projects"] and parts[4] == "locations" and parts[6] == "units" and parts[8] == "progress"
        if not regular_route and not unit_route and not unit_detail_route and not admin_node_route and not workflow_route and not custom_field_route:
            self._error(HTTPStatus.NOT_FOUND, "not_found", "Route not found")
            return
        if admin_node_route or workflow_route or custom_field_route:
            if not self._require_permission("adminPanel"):
                return
        elif unit_route or (regular_route and parts[4] == "daily-updates"):
            if not self._require_permission("fieldProgress"):
                return
        else:
            if not self._require_permission("projectManage"):
                return
        try:
            payload = self._read_json()
            if not isinstance(payload, dict):
                raise ValueError("JSON object expected")
            idempotency_key = self.headers.get("Idempotency-Key")
            request_hash = hashlib.sha256(json.dumps({"path": path, "payload": payload}, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
            if idempotency_key:
                if len(idempotency_key) > 128:
                    raise ValueError("Idempotency-Key exceeds 128 characters")
                cached = self.store.get_idempotency(idempotency_key, self.organization_id)
                if cached:
                    if cached["requestHash"] != request_hash:
                        self._error(HTTPStatus.CONFLICT, "idempotency_key_reused", "Idempotency key was used with a different request")
                        return
                    self._json(HTTPStatus(cached["status"]), cached["response"])
                    return
            if custom_field_route:
                custom_field=self.store.save_custom_field_definition(self.organization_id,payload,parts[4])
                response={"organizationId":self.organization_id,"customField":custom_field}
            elif workflow_route:
                work_type=self.store.save_workflow_configuration(self.organization_id,payload,parts[4])
                response={"organizationId":self.organization_id,"workType":work_type}
            elif admin_node_route:
                enabled=payload.get("enabled")
                if not isinstance(enabled,bool): raise ValueError("enabled must be boolean")
                response={"organizationId":self.organization_id,**self.store.set_compute_node_enabled(self.organization_id,parts[4],enabled)}
            elif unit_detail_route:
                unit=self.store.update_unit(self.organization_id,parts[3],parts[5],parts[7],payload)
                response={"organizationId":self.organization_id,"unit":unit}
            elif unit_route:
                unit = self.store.set_unit_progress(self.organization_id, parts[3], parts[5], parts[7], payload)
                response = {"organizationId": self.organization_id, "unit": unit}
            elif parts[4] == "work-items":
                work_item = self.store.update_work_item(self.organization_id, parts[3], parts[5], payload)
                response = {"organizationId": self.organization_id, "workItem": work_item}
            elif parts[4] == "daily-updates":
                daily_update = self.store.save_daily_update(self.organization_id, parts[3], payload, parts[5])
                response = {"organizationId": self.organization_id, "dailyUpdate": daily_update}
            else:
                location = self.store.update_location(self.organization_id, parts[3], parts[5], payload)
                response = {"organizationId": self.organization_id, "location": location}
            if idempotency_key:
                self.store.save_idempotency(idempotency_key, request_hash, HTTPStatus.OK, response, self.organization_id)
            self._json(HTTPStatus.OK, response)
        except EntityVersionConflict as conflict:
            self._error(HTTPStatus.CONFLICT, "version_conflict", "Entity version is stale", {"currentVersion": conflict.current_version})
        except InvalidTransition as transition:
            self._error(HTTPStatus.CONFLICT, "invalid_transition", str(transition), {"currentStatus": transition.current_status, "requestedStatus": transition.requested_status})
        except DependenciesIncomplete as blocked:
            self._error(HTTPStatus.CONFLICT, "dependencies_incomplete", str(blocked), {"blockerIds": blocked.blocker_ids})
        except LookupError as error:
            self._error(HTTPStatus.NOT_FOUND, "work_item_not_found", str(error))
        except (ValueError, json.JSONDecodeError) as error:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(error))

    def do_OPTIONS(self) -> None:
        self._start_request()
        self.send_response(HTTPStatus.NO_CONTENT)
        self._security_headers()
        self.send_header("Allow", "GET, POST, PUT, PATCH, OPTIONS")
        self.end_headers()

    def _start_request(self) -> None:
        self.request_started_at = time.perf_counter()
        candidate = self.headers.get("X-Request-ID", "")
        self.request_id = candidate if 0 < len(candidate) <= 64 and all(character.isalnum() or character in "-_." for character in candidate) else str(uuid.uuid4())
        parsed_url = urlparse(self.path)
        self.query_params = parse_qs(parsed_url.query)
        self.session_context: dict[str, Any] | None = None
        # Try Bearer session first
        auth_header = self.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:].strip()
            if token:
                self.session_context = self.store.validate_session(token)
        if self.session_context:
            self.organization_id = self.session_context["organizationId"]
            self.current_role = normalize_role(self.session_context["role"])
        else:
            # Dev-mode fallback: client-controlled headers (LAN only, no production use)
            organization = self.headers.get("X-Organization-ID", DEFAULT_ORGANIZATION_ID)
            self.organization_id = organization if 0 < len(organization) <= 64 and all(character.isalnum() or character in "-_" for character in organization) else ""
            self.current_role = normalize_role(self.headers.get("X-RackPilot-Role"))

    @property
    def _is_authenticated_session(self) -> bool:
        """True only when request is backed by a valid Bearer session (not dev-mode header)."""
        return self.session_context is not None

    def _require_organization(self) -> bool:
        if not self.organization_id or not self.store.organization_exists(self.organization_id):
            self._error(HTTPStatus.NOT_FOUND, "organization_not_found", "Organization does not exist or is inactive")
            return False
        # Cross-org guard: session org must match request org
        if self.session_context and self.session_context["organizationId"] != self.organization_id:
            self._error(HTTPStatus.FORBIDDEN, "org_mismatch", "Session organization does not match request organization")
            return False
        return True

    def _require_permission(self, permission: str) -> bool:
        if not self._require_organization():
            return False
        if not role_can(getattr(self, "current_role", "Administrator"), permission):
            self._error(HTTPStatus.FORBIDDEN, "forbidden", f"Role {self.current_role} cannot perform {permission}", {"role": self.current_role, "permission": permission})
            return False
        # Certain permissions require a real session (no dev-mode fallback)
        if permission in SESSION_REQUIRED_PERMISSIONS and not self._is_authenticated_session:
            self._error(HTTPStatus.UNAUTHORIZED, "session_required", f"Permission '{permission}' requires a Bearer session — dev-mode header not accepted")
            return False
        return True

    def _read_json(self) -> Any:
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid Content-Length") from error
        if size <= 0 or size > MAX_BODY_BYTES:
            raise ValueError("Request body size is invalid")
        return json.loads(self.rfile.read(size).decode("utf-8"))

    def _serve_static(self, request_path: str) -> None:
        relative = "index.html" if request_path == "/" else request_path.lstrip("/")
        candidate = (WEB_ROOT / relative).resolve()
        if WEB_ROOT.resolve() not in candidate.parents and candidate != WEB_ROOT.resolve():
            self._json(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
            return
        if not candidate.is_file():
            self._error(HTTPStatus.NOT_FOUND, "not_found", "Resource not found")
            return
        content_type, _ = mimetypes.guess_type(candidate.name)
        self._serve_file(candidate, content_type or "application/octet-stream")

    def _serve_file(self, candidate: Path, content_type: str) -> None:
        if not candidate.is_file():
            self._error(HTTPStatus.NOT_FOUND, "not_found", "Resource not found")
            return
        data = candidate.read_bytes()
        self.send_response(HTTPStatus.OK)
        self._security_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def _json(self, status: HTTPStatus, payload: dict[str, Any], extra_headers: dict[str, str] | None = None) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        path = urlparse(self.path).path
        if path.startswith("/api/") and hasattr(self.server, "api_metrics"):
            duration_ms = round((time.perf_counter() - getattr(self, "request_started_at", time.perf_counter())) * 1000, 2)
            self.server.api_metrics.record({  # type: ignore[attr-defined]
                "createdAt": utc_now(),
                "requestId": getattr(self, "request_id", ""),
                "organizationId": getattr(self, "organization_id", DEFAULT_ORGANIZATION_ID),
                "method": self.command,
                "route": path,
                "status": int(status),
                "durationMs": duration_ms,
                "responseBytes": len(data),
            })
        self.send_response(status)
        self._security_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _handle_auth_login(self) -> None:
        try:
            body = self._read_json()
        except (json.JSONDecodeError, ValueError):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_json", "Body must be JSON {email, password}")
            return
        email = str(body.get("email", "")).strip().lower()
        password = str(body.get("password", ""))
        if not email or not password:
            self._error(HTTPStatus.BAD_REQUEST, "missing_fields", "email and password are required")
            return
        result = self.store.login(email, password)
        ip = self.headers.get("X-Forwarded-For", self.client_address[0])
        if not result:
            self.store.audit(self.organization_id, None, None, "login", "session", None, "denied", ip)
            self._error(HTTPStatus.UNAUTHORIZED, "invalid_credentials", "Invalid email or password")
            return
        self.store.audit(self.organization_id, result["user"]["id"], result["role"], "login", "session", None, "ok", ip)
        self._json(HTTPStatus.OK, result)

    def _handle_auth_logout(self) -> None:
        auth_header = self.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:].strip()
            sess = self.session_context or {}
            ip = self.headers.get("X-Forwarded-For", self.client_address[0])
            self.store.audit(self.organization_id, sess.get("userId"), sess.get("role"), "logout", "session", None, "ok", ip)
            self.store.logout_session(token)
        self._json(HTTPStatus.OK, {"ok": True})

    def _handle_floorplan_analyze(self) -> None:
        """Experimental: receive base64 floor-plan image, call Claude vision, return room JSON."""
        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        if not api_key:
            self._error(HTTPStatus.SERVICE_UNAVAILABLE, "no_api_key", "ANTHROPIC_API_KEY is not configured on this server")
            return
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > 25_000_000:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "too_large", "Image payload exceeds 25 MB limit")
            return
        try:
            body = json.loads(self.rfile.read(content_length))
        except json.JSONDecodeError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_json", "Body must be JSON")
            return
        image_b64 = body.get("image", "")
        mime_type = body.get("mimeType", "image/jpeg")
        if not image_b64:
            self._error(HTTPStatus.BAD_REQUEST, "missing_image", "Field 'image' (base64) is required")
            return
        prompt = """You are a precise architectural plan parser. Analyze this floor plan image carefully.

STEP 1 — Measure the image bounds mentally: treat the entire floor plan drawing area as a 100×100 grid, (0,0) at top-left, x right, y down.

STEP 2 — Identify every enclosed space (rooms, corridors, stairwells, elevators, shafts, bathrooms, apartments etc.). For EACH space:
- Estimate its bounding rectangle as tightly as possible
- x, y = top-left corner of that rectangle (0–100)
- width, height = size of that rectangle (0–100)
- Spaces must NOT overlap unless one physically contains another
- Adjacent rooms share a wall edge: e.g. room A ends at x=30, room B starts at x=30

STEP 3 — Identify door openings. For each door note which room it belongs to, which wall side (north=top, south=bottom, west=left, east=right), and the fractional position along that wall (0.0=start, 1.0=end).

Return ONLY this JSON (no markdown, no text outside JSON):
{
  "building_type": "residential|commercial|industrial|mixed",
  "notes": "brief description of what you see",
  "image_aspect": 1.4,
  "rooms": [
    {"id":"r1","name":"exact label from plan or descriptive name","type":"apartment|corridor|stairwell|elevator|lobby|bathroom|bedroom|office|storage|utility|parking|balcony|other","x":5,"y":10,"width":20,"height":15}
  ],
  "doors": [
    {"from_room":"r1","to_room":"r2_or_null","wall_side":"north|south|east|west","pos":0.5,"width_pct":0.12}
  ]
}

Be precise. If the plan shows 10 apartments, return 10 apartment entries with accurate relative sizes and positions. Prefer accuracy over completeness — only include what you can place confidently."""
        payload = {
            "model": "claude-sonnet-4-6",
            "max_tokens": 4096,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": mime_type, "data": image_b64}},
                    {"type": "text",  "text": prompt},
                ],
            }],
        }
        try:
            req = urllib.request.Request(
                "https://api.anthropic.com/v1/messages",
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
            )
            with urllib.request.urlopen(req, timeout=90) as resp:
                result = json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            body_text = exc.read().decode("utf-8", errors="ignore")[:300]
            self._error(HTTPStatus.BAD_GATEWAY, "api_error", f"Claude API {exc.code}: {body_text}")
            return
        except Exception as exc:
            self._error(HTTPStatus.BAD_GATEWAY, "api_error", str(exc))
            return
        text = (result.get("content") or [{}])[0].get("text", "")
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            match = re.search(r'\{.*\}', text, re.DOTALL)
            if not match:
                self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "parse_error", "Could not parse AI response as JSON")
                return
            try:
                data = json.loads(match.group())
            except json.JSONDecodeError:
                self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "parse_error", "Malformed JSON in AI response")
                return
        self._json(HTTPStatus.OK, data)

    def _error(self, status: HTTPStatus, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        self._json(status, {"error": {"code": code, "message": message, "details": details or {}}, "requestId": self.request_id})

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-API-Version", "1")
        self.send_header("X-Request-ID", getattr(self, "request_id", "static"))
        self.send_header("X-Organization-ID", getattr(self, "organization_id", DEFAULT_ORGANIZATION_ID))
        self.send_header("X-RackPilot-Role", getattr(self, "current_role", "Administrator"))
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")

    def log_message(self, format: str, *args: Any) -> None:
        LOGGER.info(json.dumps({"event": "http_request", "client": self.client_address[0], "method": self.command, "path": self.path, "message": format % args}))


class FieldOSServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def server_bind(self) -> None:
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = port

    def __init__(self, address: tuple[str, int], store: WorkspaceStore, agent_token: str):
        super().__init__(address, FieldOSHandler)
        self.store = store
        self.agent_token = agent_token
        self.api_metrics = ApiMetricsRecorder()
        self.ai_gateway = AIGateway(store)


def main() -> None:
    parser = argparse.ArgumentParser(description="RackPilot local development server")
    parser.add_argument("--host", default=os.getenv("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "4173")))
    parser.add_argument("--db", type=Path, default=Path(os.getenv("RACKPILOT_DB") or os.getenv("FIELDOS_DB", DEFAULT_DB)))
    args = parser.parse_args()

    agent_token,agent_token_path=ensure_agent_token(args.db)
    store = WorkspaceStore(args.db)
    initial_password = store.ensure_initial_credentials()
    if initial_password:
        LOGGER.warning(json.dumps({"event": "initial_admin_password", "email": "admin@local.fieldos", "password": initial_password, "note": "Change this at Admin → Security. Shown only once."}))
    # Ensure privacy defaults for all orgs
    try:
        with store._connect() as _conn:
            _orgs = [r["id"] for r in _conn.execute("SELECT id FROM organizations").fetchall()]
        for _oid in _orgs:
            store.ensure_privacy_defaults(_oid)
            store.run_retention_purge(_oid)
    except Exception as _e:
        LOGGER.warning(json.dumps({"event": "privacy_init_failed", "error": str(_e)}))
    # Write agent context snapshot for filesystem-based agents (Codex)
    try:
        _write_agent_context_file(_build_agent_context(store), Path(__file__).parent.parent)
        LOGGER.info(json.dumps({"event": "agent_context_written", "path": "docs/AGENT_CONTEXT.json"}))
    except Exception as _e:
        LOGGER.warning(json.dumps({"event": "agent_context_write_failed", "error": str(_e)}))
    server = FieldOSServer((args.host, args.port), store, agent_token)

    def stop(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    urls = [f"http://127.0.0.1:{args.port}"]
    if args.host in {"0.0.0.0", "::"}:
        lan_ip = discover_lan_ip()
        if lan_ip:
            urls.append(f"http://{lan_ip}:{args.port}")
    else:
        urls = [f"http://{args.host}:{args.port}"]
    LOGGER.info(json.dumps({"event": "server_started", "urls": urls, "bind": args.host, "db": str(args.db)}))
    LOGGER.info(json.dumps({"event":"agent_enrollment","tokenPath":str(agent_token_path) if agent_token_path else "RACKPILOT_AGENT_TOKEN"}))
    if args.host in {"0.0.0.0", "::"}:
        LOGGER.warning(json.dumps({"event": "security_notice", "message": "LAN mode has no authentication; use only on a trusted network"}))
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
        LOGGER.info(json.dumps({"event": "server_stopped"}))


if __name__ == "__main__":
    main()
