#!/usr/bin/env python3
"""Dependency-free local API and static server for the RackPilot workspace."""

from __future__ import annotations

import argparse
import hmac
import hashlib
import io
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
from datetime import datetime, timezone, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import parse_qs, urlparse
import urllib.request
import urllib.error
import subprocess

from server.migrations import MigrationRunner
from server.ai_router import AIRouter, classify as ai_classify
from server.connectors import deliver_once, _RETRY_DELAYS, _MAX_ATTEMPTS, WebhookDeliveryWorker

ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = ROOT / "web"
DEFAULT_DB = ROOT / "data" / "fieldos.db"
MIGRATIONS_DIR = ROOT / "server" / "migrations"
OPENAPI_PATH = ROOT / "docs" / "openapi.yaml"
MAX_BODY_BYTES = 2 * 1024 * 1024
ALLOWED_STATUSES = {"ideas", "backlog", "ready", "progress", "blocked", "review", "testing", "done"}

_RUNBOOKS = [
    {
        "id": "rb-001", "title": "High P95 Latency",
        "trigger": "P95 latency > 500ms for 5 consecutive minutes",
        "severity": "warning",
        "steps": [
            "Check /api/v1/admin/api-metrics for top slow routes",
            "Run EXPLAIN QUERY PLAN on the top route's SQL (sqlite3 data/rackpilot.db)",
            "Verify no full table scans: add index if needed and run migration",
            "Restart server process if latency persists after index fix",
        ],
        "escalation": "If p95 > 2000ms for 30min, enable request logging and notify on-call",
    },
    {
        "id": "rb-002", "title": "Elevated Error Rate (>1%)",
        "trigger": "Error rate > 1% over last 100 requests",
        "severity": "warning",
        "steps": [
            "Identify which status codes are elevated in /api/v1/admin/api-metrics",
            "For 5xx: check server log for tracebacks (grep ERROR rackpilot.log)",
            "For 4xx spike: check if a client is sending malformed requests",
            "Roll back last migration if errors started after schema change",
        ],
        "escalation": "If availability < 95% for 10min, declare incident and restore from backup",
    },
    {
        "id": "rb-003", "title": "Database Corruption / Write Failure",
        "trigger": "sqlite3.DatabaseError or PRAGMA integrity_check fails",
        "severity": "critical",
        "steps": [
            "STOP all write traffic: bring server offline",
            "Run: sqlite3 data/rackpilot.db 'PRAGMA integrity_check'",
            "If corrupt: restore latest backup from data/backups/",
            "Verify backup: python3 -c \"import sqlite3; sqlite3.connect('data/fieldos.db').execute('SELECT 1')\"",
            "Restart server, verify migration runner completes cleanly",
        ],
        "escalation": "Preserve corrupted file at data/fieldos.db.corrupt.$(date +%s) before restore",
    },
    {
        "id": "rb-004", "title": "Backup Verification Failure",
        "trigger": "Backup checksum mismatch or integrity_check returns errors",
        "severity": "critical",
        "steps": [
            "Do NOT overwrite the current DB with a bad backup",
            "Run POST /api/v1/admin/backup to create a fresh verified backup",
            "Check backup logs for retention policy issues",
            "Verify disk space: df -h data/",
        ],
        "escalation": "If all recent backups fail integrity_check, treat as corruption (RB-003)",
    },
    {
        "id": "rb-005", "title": "Authentication Failures Spike",
        "trigger": ">10 failed logins in 5 minutes from one IP",
        "severity": "warning",
        "steps": [
            "Review audit_log for failed_login events: SELECT * FROM audit_log WHERE event_type='failed_login' ORDER BY created_at DESC LIMIT 20",
            "Identify source IP from X-Forwarded-For header in server logs",
            "Force-rotate affected user's password via admin panel if account appears compromised",
            "Consider enabling MFA for all Administrator accounts",
        ],
        "escalation": "If admin account locked, use CLI: python3 server/app.py --reset-admin (NOT YET IMPLEMENTED — manual DB update)",
    },
]
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
    configured=os.getenv("RACKPILOT_AGENT_TOKEN") or os.getenv("RACKPILOT_AGENT_TOKEN")
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
            field_evidence_values: list[int] = []
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
                # Combined for display in work-type card (tasks + field evidence)
                display_values = daily_values + unit_values + task_values
                typed_progress = round(sum(display_values) / len(display_values)) if display_values else 0
                work_type_progress.append({
                    "id": work_type["id"], "code": work_type["code"], "name": work_type["name"],
                    "color": work_type["color"], "taskCount": len(typed_items), "progress": typed_progress,
                    "done": sum(status == "done" for status in typed_states),
                    "blocked": sum(status == "blocked" for status in typed_states),
                    "fieldUpdateCount": len(daily_values) + len(unit_values),
                })
                # For overall project progress, collect pure field evidence separately
                # to avoid double-counting tasks that are already in task_progress_values
                field_evidence_values.extend(daily_values + unit_values)
            # Overall: tasks + field evidence (no double-counting)
            project_progress_values = task_progress_values + field_evidence_values
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
        project = self.get_project(organization_id, project_id)
        if project is None:
            raise LookupError("Project not found")

        # Unit completions grouped by location / work type / action
        unit_groups: dict[tuple[str, str, str], list[str]] = {}
        for location in project["locations"]:
            for unit in location["units"]:
                for progress in unit["progress"]:
                    if progress["completedOn"] == work_date and progress["status"] == "complete":
                        work = next((v["name"] for v in project["workTypes"] if v["id"] == progress["workTypeId"]), progress["workTypeId"])
                        action = next((a["name"] for v in project["workTypes"] if v["id"] == progress["workTypeId"] for a in v["actions"] if a["id"] == progress["actionId"]), progress["actionId"])
                        unit_groups.setdefault((location["name"], work, action), []).append(unit["name"])

        # Daily progress updates for this date
        day_updates = [u for u in project["dailyUpdates"] if u["workDate"] == work_date]

        # Issues opened on this date (any status)
        day_issues = [i for i in project["issues"] if i["createdAt"].startswith(work_date)]
        open_issues = [i for i in day_issues if i["status"] != "resolved"]

        # Work items changed today (from change log) — pull from audit
        with self._connect() as conn:
            wi_events = conn.execute(
                """SELECT entity_type, action, old_value, new_value, created_at
                   FROM project_change_log
                   WHERE organization_id=? AND project_id=? AND created_at LIKE ?
                     AND entity_type IN ('work_item','work_item_dep')
                   ORDER BY created_at""",
                (organization_id, project_id, f"{work_date}%"),
            ).fetchall()
            # Fetch any saved note for the day
            saved_note = conn.execute(
                "SELECT note, updated_at FROM daily_log_notes WHERE organization_id=? AND project_id=? AND work_date=?",
                (organization_id, project_id, work_date),
            ).fetchone() if conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='daily_log_notes'"
            ).fetchone() else None

        # Build structured sections
        sections = []
        if unit_groups:
            items = []
            for (loc, work, action), units in unit_groups.items():
                items.append({"location": loc, "workType": work, "action": action, "units": units, "count": len(units)})
            sections.append({"type": "unit_completions", "title": "Выполненные units", "items": items})

        if day_updates:
            sections.append({
                "type": "progress_updates",
                "title": "Обновления прогресса",
                "items": [{"location": u["locationName"], "workType": u["workTypeName"],
                            "action": u["actionName"], "percent": u["percentComplete"],
                            "comments": u.get("comments", "")} for u in day_updates],
            })

        if wi_events:
            wi_items = []
            for ev in wi_events:
                old = json.loads(ev["old_value"]) if ev["old_value"] else {}
                new = json.loads(ev["new_value"]) if ev["new_value"] else {}
                if old.get("status") != new.get("status"):
                    wi_items.append({"action": "status_change", "from": old.get("status"), "to": new.get("status")})
            if wi_items:
                sections.append({"type": "work_item_events", "title": "Изменения задач", "items": wi_items})

        if open_issues:
            sections.append({
                "type": "issues",
                "title": f"Проблемы ({len(open_issues)} открыто)",
                "items": [{"severity": i["severity"], "description": i["description"], "status": i["status"]} for i in open_issues],
            })

        # Plain-text summary for copy-paste / field note
        lines = [f"Daily update — {project['name']} — {work_date}"]
        for (loc, work, action), units in unit_groups.items():
            lines.append(f"• {loc} / {work} / {action}: {', '.join(units)}")
        for u in day_updates:
            lines.append(f"• {u['locationName']} / {u['workTypeName']} / {u['actionName']}: {u['percentComplete']}%"
                         + (f" — {u['comments']}" if u.get("comments") else ""))
        for i in open_issues:
            lines.append(f"• [{i['severity'].upper()}] {i['description']}")
        if len(lines) == 1:
            lines.append("No completed work recorded for this date.")

        unit_completions = sum(len(v) for v in unit_groups.values())
        return {
            "projectId": project_id,
            "projectName": project["name"],
            "date": work_date,
            "text": "\n".join(lines),
            "manualNote": saved_note["note"] if saved_note else "",
            "sections": sections,
            # top-level fields kept for backwards compat
            "unitCompletions": unit_completions,
            "updates": len(day_updates),
            "issues": len(open_issues),
            "stats": {
                "unitCompletions": unit_completions,
                "progressUpdates": len(day_updates),
                "issuesOpened": len(day_issues),
                "issuesOpen": len(open_issues),
                "workItemEvents": len(wi_events),
            },
        }

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
        result = next(value for value in self.get_project(organization_id, project_id)["dailyUpdates"] if value["id"] == entry_id)  # type: ignore[index]
        loc_name = next((loc["name"] for loc in project["locations"] if loc["id"] == location_id), location_id or "")
        wt_name = work_type["name"] if work_type else ""
        actor = payload.get("_actorName", "")
        self._record_activity(organization_id, project_id, None, actor,
                              "daily_update" if action_name == "created" else "daily_update_edit",
                              f"{'Создан' if action_name == 'created' else 'Обновлён'} отчёт — {loc_name} · {wt_name} · {percent}%")
        return result

    def get_progress_history(self, organization_id: str, project_id: str, from_date: str, to_date: str) -> dict[str, Any]:
        """Daily progress snapshots from daily_progress_entries + unit completions per day."""
        project = self.get_project(organization_id, project_id)
        if project is None:
            raise LookupError("Project not found")

        with self._connect() as conn:
            # Daily progress entries grouped by work_date
            dp_rows = conn.execute(
                """SELECT work_date, work_type_id, location_id, action_id, percent_complete
                   FROM daily_progress_entries
                   WHERE organization_id=? AND project_id=? AND work_date BETWEEN ? AND ?
                   ORDER BY work_date, work_type_id""",
                (organization_id, project_id, from_date, to_date),
            ).fetchall()

            # Unit completions grouped by work_date + work_type
            uc_rows = conn.execute(
                """SELECT u.completed_on AS work_date, u.work_type_id,
                          COUNT(*) AS completed_count
                   FROM unit_progress u
                   JOIN project_units pu ON pu.id = u.unit_id
                   WHERE u.organization_id=? AND u.project_id=?
                     AND u.status='complete' AND u.completed_on BETWEEN ? AND ?
                   GROUP BY u.completed_on, u.work_type_id
                   ORDER BY u.completed_on""",
                (organization_id, project_id, from_date, to_date),
            ).fetchall()

        # Build work type name map
        wt_names = {wt["id"]: wt["name"] for wt in project.get("workTypes", [])}
        wt_colors = {wt["id"]: wt["color"] for wt in project.get("workTypes", [])}

        # Aggregate by date
        by_date: dict[str, dict[str, Any]] = {}
        for row in dp_rows:
            d = row["work_date"]
            if d not in by_date:
                by_date[d] = {"date": d, "progressByType": {}, "unitsByType": {}}
            wt = row["work_type_id"]
            entry = by_date[d]["progressByType"].setdefault(wt, {"sum": 0, "count": 0})
            entry["sum"] += row["percent_complete"]
            entry["count"] += 1

        for row in uc_rows:
            d = row["work_date"]
            if d not in by_date:
                by_date[d] = {"date": d, "progressByType": {}, "unitsByType": {}}
            by_date[d]["unitsByType"][row["work_type_id"]] = row["completed_count"]

        # Compute average per type per day
        days = []
        for d in sorted(by_date.keys()):
            entry = by_date[d]
            type_summaries = []
            for wt_id, agg in entry["progressByType"].items():
                avg = round(agg["sum"] / agg["count"]) if agg["count"] else 0
                type_summaries.append({
                    "id": wt_id, "name": wt_names.get(wt_id, wt_id),
                    "color": wt_colors.get(wt_id, "#7c8cff"),
                    "avgPercent": avg, "entryCount": agg["count"],
                    "unitsDone": entry["unitsByType"].get(wt_id, 0),
                })
            days.append({"date": d, "byType": type_summaries})

        return {
            "projectId": project_id,
            "projectName": project["name"],
            "from": from_date,
            "to": to_date,
            "days": days,
        }

    def calculate_critical_path(self, organization_id: str, project_id: str) -> dict[str, Any]:
        """Longest dependency chain and per-item slack using topological DP."""
        with self._connect() as conn:
            items = conn.execute(
                "SELECT id, code, title, status, estimated_minutes FROM project_work_items "
                "WHERE organization_id=? AND project_id=? AND status<>'done'",
                (organization_id, project_id),
            ).fetchall()
            deps = conn.execute(
                "SELECT dependent_item_id, predecessor_item_id FROM work_item_dependencies "
                "WHERE organization_id=? AND project_id=?",
                (organization_id, project_id),
            ).fetchall()

        id_to_item = {r['id']: dict(r) for r in items}
        successors: dict[str, list[str]] = {i: [] for i in id_to_item}
        predecessors: dict[str, list[str]] = {i: [] for i in id_to_item}
        for dep in deps:
            dep_id, pred_id = dep['dependent_item_id'], dep['predecessor_item_id']
            if dep_id in id_to_item and pred_id in id_to_item:
                successors.setdefault(pred_id, []).append(dep_id)
                predecessors.setdefault(dep_id, []).append(pred_id)

        # Topological sort (Kahn's algorithm)
        in_degree = {i: len(predecessors.get(i, [])) for i in id_to_item}
        queue = [i for i, d in in_degree.items() if d == 0]
        topo: list[str] = []
        while queue:
            node = queue.pop(0)
            topo.append(node)
            for s in successors.get(node, []):
                in_degree[s] -= 1
                if in_degree[s] == 0:
                    queue.append(s)

        # Earliest start (forward pass)
        est: dict[str, int] = {i: 0 for i in id_to_item}
        dur: dict[str, int] = {i: (id_to_item[i].get('estimated_minutes') or 60) for i in id_to_item}
        for node in topo:
            for s in successors.get(node, []):
                est[s] = max(est[s], est[node] + dur[node])

        project_duration = max((est[i] + dur[i] for i in id_to_item), default=0)

        # Latest finish (backward pass)
        lft: dict[str, int] = {i: project_duration for i in id_to_item}
        for node in reversed(topo):
            for s in successors.get(node, []):
                lft[node] = min(lft[node], lft[s] - dur[node])

        # Slack = LFT − EST − duration; critical = slack == 0
        critical_ids: set[str] = set()
        item_data = []
        for i in id_to_item:
            slack = lft[i] - est[i] - dur[i]
            is_critical = slack <= 0 and est[i] + dur[i] <= project_duration
            if is_critical:
                critical_ids.add(i)
            item_data.append({
                'id': i, 'code': id_to_item[i]['code'], 'title': id_to_item[i]['title'],
                'status': id_to_item[i]['status'],
                'est_minutes': dur[i], 'earliest_start': est[i],
                'slack_minutes': max(0, slack), 'is_critical': is_critical,
            })

        # Critical path sequence (topological order among critical nodes)
        cp_sequence = [d for d in item_data if d['is_critical']]
        cp_sequence.sort(key=lambda x: x['earliest_start'])

        return {
            'project_duration_minutes': project_duration,
            'critical_path': cp_sequence,
            'all_items': item_data,
        }

    def sync_blocked_status(self, organization_id: str, project_id: str, completed_item_id: str) -> list[str]:
        """After item completes, auto-unblock items that were only waiting on it.
        Returns list of item IDs that transitioned from blocked→ready."""
        with self._connect() as conn:
            # Find items that depended on the completed item
            dependents = conn.execute(
                "SELECT dependent_item_id FROM work_item_dependencies "
                "WHERE organization_id=? AND project_id=? AND predecessor_item_id=?",
                (organization_id, project_id, completed_item_id),
            ).fetchall()
            unblocked: list[str] = []
            for dep in dependents:
                dep_id = dep['dependent_item_id']
                item_row = conn.execute(
                    "SELECT status FROM project_work_items WHERE organization_id=? AND id=?",
                    (organization_id, dep_id),
                ).fetchone()
                if not item_row or item_row['status'] != 'blocked':
                    continue
                # Check if there are any remaining incomplete predecessors
                remaining = conn.execute(
                    "SELECT COUNT(*) as cnt FROM work_item_dependencies d "
                    "JOIN project_work_items p ON p.id=d.predecessor_item_id "
                    "WHERE d.organization_id=? AND d.dependent_item_id=? AND p.status<>'done'",
                    (organization_id, dep_id),
                ).fetchone()
                if remaining and remaining['cnt'] == 0:
                    conn.execute(
                        "UPDATE project_work_items SET status='ready', version=version+1, updated_at=? "
                        "WHERE organization_id=? AND id=?",
                        (_now(), organization_id, dep_id),
                    )
                    unblocked.append(dep_id)
        return unblocked

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

    def list_active_sessions(self, org: str) -> list[dict[str, Any]]:
        now = utc_now()
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT s.token_hash, s.user_id, s.role, s.created_at, s.expires_at, "
                "s.last_seen_at, s.ip_address, s.user_agent, s.revoked, "
                "u.email, u.display_name "
                "FROM sessions s LEFT JOIN users u ON u.id=s.user_id "
                "WHERE s.organization_id=? AND s.revoked=0 AND s.expires_at > ? "
                "ORDER BY s.last_seen_at DESC",
                (org, now),
            ).fetchall()
        return [{
            "tokenHash": r["token_hash"][:8] + "…",  # never expose full hash
            "userId": r["user_id"],
            "email": r["email"],
            "displayName": r["display_name"],
            "role": r["role"],
            "createdAt": r["created_at"],
            "expiresAt": r["expires_at"],
            "lastSeenAt": r["last_seen_at"],
            "ipAddress": r["ip_address"],
            "userAgent": (r["user_agent"] or "")[:80],
        } for r in rows]

    def revoke_session(self, org: str, token_hash_prefix: str) -> int:
        with self._connect() as conn:
            result = conn.execute(
                "UPDATE sessions SET revoked=1 WHERE organization_id=? AND token_hash LIKE ?",
                (org, token_hash_prefix + "%"),
            )
        return result.rowcount

    def validate_session(self, token: str) -> dict[str, Any] | None:
        """Return session context dict or None if expired/invalid."""
        token_hash = _hash_token(token)
        with self._connect() as connection:
            row = connection.execute(
                "SELECT s.user_id, s.organization_id, s.role, s.expires_at, s.revoked, u.email, u.display_name "
                "FROM sessions s JOIN users u ON u.id = s.user_id "
                "WHERE s.token_hash = ?",
                (token_hash,),
            ).fetchone()
            if not row:
                return None
            if row["revoked"]:
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

    _TEXT_MIMES: frozenset[str] = frozenset({
        "text/plain", "text/csv", "text/markdown", "text/html",
        "application/json", "application/xml", "text/xml",
        "application/pdf",
    })
    _CHUNK_SIZE = 400    # target words per chunk
    _CHUNK_OVERLAP = 40  # overlap words between adjacent chunks

    @staticmethod
    def _pdf_extract_text(data: bytes) -> str:
        """
        Minimal PDF text extraction without external libraries.
        Parses BT...ET text blocks from the raw PDF byte stream.
        Handles Tj, TJ, ' operators. Falls back to empty on failure.
        """
        import re as _re
        try:
            raw = data.decode("latin-1", errors="replace")
            # Decode compressed streams is not attempted — only uncompressed text blocks
            blocks: list[str] = []
            for bt_block in _re.findall(r'BT(.*?)ET', raw, _re.DOTALL):
                words: list[str] = []
                # TJ: [(string) spacing (string) ...]
                for tj in _re.findall(r'\[(.*?)\]TJ', bt_block, _re.DOTALL):
                    for s in _re.findall(r'\((.*?)\)', tj):
                        words.append(s)
                    words.append(' ')
                # Tj / ' : (string) Tj
                for tj in _re.findall(r'\(([^)]*)\)\s*(?:Tj|\')', bt_block):
                    words.append(tj + ' ')
                text = ''.join(words)
                # Unescape PDF escape sequences
                text = text.replace('\\n', '\n').replace('\\r', '\r') \
                           .replace('\\t', '\t').replace('\\(', '(').replace('\\)', ')')
                if text.strip():
                    blocks.append(text)
            return '\n'.join(blocks)[:65536]
        except Exception:
            return ''

    def _extract_text(self, mime_type: str, data: bytes) -> str | None:
        """Extract indexable plain text from file content."""
        mime = mime_type.split(";")[0].strip()
        if mime not in self._TEXT_MIMES:
            return None
        if mime == "application/pdf":
            text = self._pdf_extract_text(data)
            return text or None
        try:
            text = data.decode("utf-8", errors="replace")
            # Strip HTML tags for html mime
            if mime in ("text/html", "application/xml", "text/xml"):
                import re as _re
                text = _re.sub(r'<[^>]+>', ' ', text)
                text = _re.sub(r'\s+', ' ', text).strip()
            return text[:65536]
        except Exception:
            return None

    @staticmethod
    def _chunk_text(text: str, chunk_size: int, overlap: int) -> list[str]:
        """Split text into overlapping word-count chunks."""
        if not text:
            return []
        words = text.split()
        if not words:
            return []
        chunks: list[str] = []
        step = max(1, chunk_size - overlap)
        i = 0
        while i < len(words):
            chunk_words = words[i : i + chunk_size]
            chunks.append(' '.join(chunk_words))
            i += step
        return chunks

    def _ingest_chunks(self, conn: Any, obj_id: str, org: str,
                       project_id: str | None, text: str) -> None:
        """Chunk text and insert into knowledge_chunks + knowledge_fts."""
        conn.execute("DELETE FROM knowledge_fts WHERE object_id=?", (obj_id,))
        conn.execute("DELETE FROM knowledge_chunks WHERE object_id=?", (obj_id,))
        chunks = self._chunk_text(text, self._CHUNK_SIZE, self._CHUNK_OVERLAP)
        now = utc_now()
        for idx, chunk in enumerate(chunks):
            chunk_id = str(uuid.uuid4())
            token_count = len(chunk.split())
            conn.execute(
                "INSERT INTO knowledge_chunks (id,organization_id,object_id,project_id,"
                "chunk_index,chunk_text,token_count,created_at) VALUES (?,?,?,?,?,?,?,?)",
                (chunk_id, org, obj_id, project_id, idx, chunk, token_count, now),
            )
            conn.execute(
                "INSERT INTO knowledge_fts (chunk_id,object_id,project_id,chunk_text)"
                " VALUES (?,?,?,?)",
                (chunk_id, obj_id, project_id or '', chunk),
            )

    def _fts_index(self, conn: Any, obj_id: str, name: str, description: str,
                   extracted_text: str | None, tags: list[str]) -> None:
        conn.execute("DELETE FROM objects_fts WHERE obj_id=?", (obj_id,))
        if extracted_text or name:
            conn.execute(
                "INSERT INTO objects_fts (obj_id,name,description,extracted_text,tags) VALUES (?,?,?,?,?)",
                (obj_id, name, description, extracted_text or "", json.dumps(tags)),
            )

    def list_objects(self, org: str, project_id: str | None = None,
                     root_only: bool = True) -> list[dict[str, Any]]:
        """List objects. root_only=True returns only version roots (parent_id IS NULL)."""
        with self._connect() as conn:
            parent_clause = "AND parent_id IS NULL" if root_only else ""
            if project_id:
                rows = conn.execute(
                    f"SELECT id,name,mime_type,size_bytes,scan_result,safe_preview,version_number,"
                    f"parent_id,description,tags,project_id,created_by,created_at FROM objects "
                    f"WHERE organization_id=? AND project_id=? {parent_clause} ORDER BY created_at DESC",
                    (org, project_id),
                ).fetchall()
            else:
                rows = conn.execute(
                    f"SELECT id,name,mime_type,size_bytes,scan_result,safe_preview,version_number,"
                    f"parent_id,description,tags,project_id,created_by,created_at FROM objects "
                    f"WHERE organization_id=? {parent_clause} ORDER BY created_at DESC LIMIT 200",
                    (org,),
                ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            try: d["tags"] = json.loads(d["tags"] or "[]")
            except Exception: d["tags"] = []
            result.append(d)
        return result

    def list_object_versions(self, org: str, obj_id: str) -> list[dict[str, Any]]:
        """Return all versions of a document (the root + its children), newest first."""
        with self._connect() as conn:
            root = conn.execute(
                "SELECT id,parent_id FROM objects WHERE id=? AND organization_id=?", (obj_id, org)
            ).fetchone()
            if not root:
                return []
            root_id = root["id"] if root["parent_id"] is None else root["parent_id"]
            rows = conn.execute(
                "SELECT id,name,mime_type,size_bytes,version_number,scan_result,created_by,created_at "
                "FROM objects WHERE organization_id=? AND (id=? OR parent_id=?) ORDER BY version_number DESC",
                (org, root_id, root_id),
            ).fetchall()
        return [dict(r) for r in rows]

    def search_objects(self, org: str, query: str, project_id: str | None = None,
                       limit: int = 20) -> list[dict[str, Any]]:
        """FTS5 full-text search over documents."""
        if not query.strip():
            return []
        fts_query = " OR ".join(f'"{w}"' for w in query.split()[:10])
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT o.id,o.name,o.mime_type,o.size_bytes,o.scan_result,o.version_number,"
                "o.project_id,o.created_at,o.description,o.tags, "
                "snippet(objects_fts,3,'<b>','</b>','…',20) AS snippet "
                "FROM objects_fts f JOIN objects o ON o.id=f.obj_id "
                "WHERE objects_fts MATCH ? AND o.organization_id=?"
                + (" AND o.project_id=?" if project_id else "")
                + " ORDER BY rank LIMIT ?",
                (fts_query, org) + ((project_id,) if project_id else ()) + (limit,),
            ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            try: d["tags"] = json.loads(d["tags"] or "[]")
            except Exception: d["tags"] = []
            result.append(d)
        return result

    def store_object(self, org: str, project_id: str | None, name: str,
                     mime_type: str, data: bytes, created_by: str,
                     description: str = "", tags: list[str] | None = None) -> dict[str, Any]:
        # Security scan — raises ValueError for blocked content
        scan_result, safe_preview = scan_file(name, mime_type, data)

        # Quota check
        with self._connect() as conn:
            used = conn.execute(
                "SELECT COALESCE(SUM(size_bytes),0) as s FROM objects WHERE organization_id=?", (org,)
            ).fetchone()["s"]
        if used + len(data) > self._org_quota_bytes():
            raise ValueError(f"Storage quota exceeded ({used // (1024*1024)} MB used)")

        # Versioning: if a root document with the same name exists in this project, create a child version
        parent_id: str | None = None
        version_number = 1
        with self._connect() as conn:
            existing = conn.execute(
                "SELECT id, version_number FROM objects "
                "WHERE organization_id=? AND project_id IS ? AND name=? AND parent_id IS NULL "
                "ORDER BY version_number DESC LIMIT 1",
                (org, project_id, name),
            ).fetchone()
            if existing:
                parent_id = existing["id"]
                # Find max version among all siblings
                max_v = conn.execute(
                    "SELECT MAX(version_number) as m FROM objects "
                    "WHERE organization_id=? AND (id=? OR parent_id=?)",
                    (org, existing["id"], existing["id"]),
                ).fetchone()["m"] or 1
                version_number = max_v + 1

        obj_id = str(uuid.uuid4())
        ext = Path(name).suffix[:10] or ""
        rel_path = f"{org}/{obj_id}{ext}"
        abs_path = self._objects_dir / rel_path
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        abs_path.write_bytes(data)

        extracted_text = self._extract_text(mime_type, data)
        tags_list = tags or []
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO objects (id,organization_id,project_id,name,mime_type,size_bytes,storage_path,"
                "scan_result,safe_preview,parent_id,version_number,extracted_text,description,tags,"
                "created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (obj_id, org, project_id, name, mime_type, len(data), rel_path,
                 scan_result, 1 if safe_preview else 0,
                 parent_id, version_number, extracted_text,
                 description, json.dumps(tags_list), created_by, now, now),
            )
            self._fts_index(conn, obj_id, name, description, extracted_text, tags_list)
            if extracted_text:
                self._ingest_chunks(conn, obj_id, org, project_id, extracted_text)
        return {
            "id": obj_id, "name": name, "mimeType": mime_type, "sizeBytes": len(data),
            "scanResult": scan_result, "safePreview": safe_preview,
            "versionNumber": version_number, "parentId": parent_id,
            "hasText": extracted_text is not None, "chunkCount": len(self._chunk_text(extracted_text or '', self._CHUNK_SIZE, self._CHUNK_OVERLAP)),
            "createdAt": now,
        }

    _ALLOWED_ENTITY_TYPES = {"asset", "location", "project", "door", "room"}

    def link_object_to_entity(self, org: str, obj_id: str, entity_type: str | None, entity_id: str | None) -> dict[str, Any]:
        """Attach or detach a document to/from an entity (asset/location/project/door/room)."""
        if entity_type is not None and entity_type not in self._ALLOWED_ENTITY_TYPES:
            raise ValueError(f"Invalid entity type; allowed: {', '.join(self._ALLOWED_ENTITY_TYPES)}")
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id, name FROM objects WHERE id=? AND organization_id=?", (obj_id, org)
            ).fetchone()
            if row is None:
                raise LookupError("Document not found")
            conn.execute(
                "UPDATE objects SET linked_entity_type=?, linked_entity_id=?, updated_at=? WHERE id=?",
                (entity_type, entity_id, utc_now(), obj_id),
            )
        return {"id": obj_id, "linkedEntityType": entity_type, "linkedEntityId": entity_id}

    def list_objects_for_entity(self, org: str, entity_type: str, entity_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, name, mime_type, size_bytes, version_number, linked_entity_type, linked_entity_id, created_at "
                "FROM objects WHERE organization_id=? AND linked_entity_type=? AND linked_entity_id=? "
                "AND parent_id IS NULL ORDER BY created_at DESC",
                (org, entity_type, entity_id),
            ).fetchall()
        return [{"id": r["id"], "name": r["name"], "mimeType": r["mime_type"],
                 "sizeBytes": r["size_bytes"], "versionNumber": r["version_number"],
                 "createdAt": r["created_at"]} for r in rows]

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
            conn.execute("DELETE FROM objects_fts WHERE obj_id=?", (obj_id,))
            conn.execute("DELETE FROM knowledge_fts WHERE object_id=?", (obj_id,))
            conn.execute("DELETE FROM knowledge_chunks WHERE object_id=?", (obj_id,))
        try:
            (self._objects_dir / row["storage_path"]).unlink(missing_ok=True)
        except OSError:
            pass
        return True

    def get_user_allowed_projects(self, org: str, user_id: str) -> list[str] | None:
        """
        Returns list of project_ids the user is assigned to, or None if they have
        org-wide access (admin/manager roles).
        """
        with self._connect() as conn:
            # Check user role — admins and managers see everything
            session = conn.execute(
                "SELECT role FROM sessions WHERE user_id=? AND organization_id=? "
                "AND expires_at > ? ORDER BY issued_at DESC LIMIT 1",
                (user_id, org, utc_now()),
            ).fetchone()
            if session and session["role"] in ("admin", "manager"):
                return None  # unrestricted
            # Tech / viewer: return their assigned project IDs
            rows = conn.execute(
                "SELECT DISTINCT project_id FROM project_assignments "
                "WHERE organization_id=? AND member_id IN ("
                "  SELECT id FROM team_members WHERE organization_id=? AND user_id=?"
                ")",
                (org, org, user_id),
            ).fetchall()
        assigned = [r["project_id"] for r in rows]
        return assigned  # empty list = no assignments yet

    def search_knowledge(self, org: str, query: str,
                         project_id: str | None = None,
                         allowed_project_ids: list[str] | None = None,
                         limit: int = 10,
                         user_id: str | None = None,
                         user_role: str = "") -> list[dict[str, Any]]:
        """
        BM25-ranked chunk search across knowledge_fts with permission gate.

        allowed_project_ids=None  → org-wide access (admin)
        allowed_project_ids=[]    → no access — returns empty
        allowed_project_ids=[...]  → restricted to those projects only
        """
        if not query.strip():
            return []
        # Permission gate: merge explicit project filter + access list
        effective_projects: list[str] | None = None
        if allowed_project_ids is not None:
            if project_id:
                # User must be allowed to access the requested project
                if project_id not in allowed_project_ids:
                    self._log_retrieval(org, user_id, user_role, query, allowed_project_ids, 0, 0)
                    return []
                effective_projects = [project_id]
            else:
                effective_projects = allowed_project_ids
        elif project_id:
            effective_projects = [project_id]

        fts_query = ' OR '.join(
            f'"{word}"' for word in query.split()[:8] if len(word) > 1
        ) or f'"{query}"'

        with self._connect() as conn:
            # Build permission-aware WHERE clause
            conditions = [
                "kf.object_id IN (SELECT id FROM objects WHERE organization_id=?)",
                "o.access_policy != 'restricted'",  # never return restricted objects
            ]
            params: list[Any] = [org]

            if effective_projects is not None:
                if not effective_projects:
                    # No allowed projects → empty result
                    self._log_retrieval(org, user_id, user_role, query, allowed_project_ids or [], 0, 0)
                    return []
                placeholders = ",".join("?" * len(effective_projects))
                conditions.append(
                    f"(o.access_policy = 'org' OR o.project_id IN ({placeholders}))"
                )
                params.extend(effective_projects)

            params.append(fts_query)
            params.append(limit * 2)  # fetch extra; will filter restricted post-hoc

            where_clause = " AND ".join(conditions)
            rows = conn.execute(
                f"SELECT kf.chunk_id, kf.object_id, kf.project_id, kf.chunk_text, "
                f"o.name AS object_name, o.mime_type, o.project_id AS obj_project_id, "
                f"o.access_policy, "
                f"snippet(knowledge_fts,3,'<b>','</b>','…',30) AS snippet, "
                f"rank "
                f"FROM knowledge_fts kf "
                f"JOIN objects o ON o.id=kf.object_id "
                f"WHERE {where_clause} AND knowledge_fts MATCH ? "
                f"ORDER BY rank LIMIT ?",
                params,
            ).fetchall()

        results = [dict(r) for r in rows if r["access_policy"] != "restricted"]
        filtered = len(rows) - len(results)
        results = results[:limit]
        self._log_retrieval(org, user_id, user_role, query,
                            allowed_project_ids if allowed_project_ids is not None else [],
                            len(results), filtered)
        return results

    def _log_retrieval(self, org: str, user_id: str | None, user_role: str,
                       query: str, allowed_projects: list[str],
                       result_count: int, filtered_count: int) -> None:
        log_id = str(uuid.uuid4())
        now = utc_now()
        try:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO retrieval_log (id,organization_id,user_id,user_role,"
                    "query,allowed_projects,result_count,filtered_count,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                    (log_id, org, user_id, user_role,
                     query[:500], json.dumps(allowed_projects),
                     result_count, filtered_count, now),
                )
        except Exception:
            pass  # audit failure must not break retrieval

    def set_object_policy(self, org: str, obj_id: str, policy: str) -> dict[str, Any]:
        if policy not in ("org", "project", "restricted"):
            raise ValueError(f"Invalid policy: {policy}")
        with self._connect() as conn:
            row = conn.execute("SELECT id FROM objects WHERE id=? AND organization_id=?", (obj_id, org)).fetchone()
            if not row: raise LookupError("Object not found")
            conn.execute("UPDATE objects SET access_policy=? WHERE id=?", (policy, obj_id))
        return {"id": obj_id, "accessPolicy": policy}

    def list_retrieval_log(self, org: str, limit: int = 50) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM retrieval_log WHERE organization_id=? ORDER BY created_at DESC LIMIT ?",
                (org, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    def rebuild_knowledge_index(self, org: str) -> dict[str, int]:
        """Reprocess all text-extractable objects and rebuild chunk index."""
        rebuilt = 0
        skipped = 0
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, project_id, name, mime_type, storage_path, extracted_text "
                "FROM objects WHERE organization_id=? AND extracted_text IS NOT NULL",
                (org,),
            ).fetchall()
            for row in rows:
                try:
                    text = row["extracted_text"]
                    if text:
                        self._ingest_chunks(conn, row["id"], org, row["project_id"], text)
                        rebuilt += 1
                    else:
                        skipped += 1
                except Exception:
                    skipped += 1
        return {"rebuilt": rebuilt, "skipped": skipped}

    _EXPORT_SCHEMA = "rackpilot-project-export/2"

    def export_project(self, org: str, project_id: str) -> dict[str, Any]:
        with self._connect() as conn:
            proj = conn.execute(
                "SELECT * FROM projects WHERE organization_id=? AND id=?", (org, project_id)
            ).fetchone()
            if not proj:
                raise LookupError(f"project {project_id} not found")
            buildings = conn.execute(
                "SELECT id,code,name,address,floors,attributes FROM buildings "
                "WHERE organization_id=? AND project_id=?", (org, project_id)
            ).fetchall()
            locations = conn.execute(
                "SELECT id,code,name,kind,building_id,parent_location_id,suite_total,"
                "floor_number,area_sqm,attributes FROM project_locations "
                "WHERE organization_id=? AND project_id=?", (org, project_id)
            ).fetchall()
            work_items = conn.execute(
                "SELECT id,code,title,description,status,priority,work_type_id,"
                "location_id,building_id,due_date,attributes FROM work_items "
                "WHERE organization_id=? AND project_id=?", (org, project_id)
            ).fetchall()
            daily = conn.execute(
                "SELECT id,work_date,location_id,member_id,notes,completion_percent,"
                "quantity,status FROM daily_updates "
                "WHERE organization_id=? AND project_id=?", (org, project_id)
            ).fetchall()
            assets = conn.execute(
                "SELECT id,name,asset_type,make,model,serial,status,location_id,building_id,attributes "
                "FROM assets WHERE organization_id=? AND project_id=?", (org, project_id)
            ).fetchall()
            issues = conn.execute(
                "SELECT id,title,description,severity,status,location_id,created_at "
                "FROM project_issues WHERE organization_id=? AND project_id=?", (org, project_id)
            ).fetchall()
            comments = conn.execute(
                "SELECT id,parent_id,author_id,author_name,body,created_at "
                "FROM project_comments WHERE organization_id=? AND project_id=?", (org, project_id)
            ).fetchall()
            assignments = conn.execute(
                "SELECT member_id,role_on_project,assigned_at "
                "FROM project_assignments WHERE organization_id=? AND project_id=?", (org, project_id)
            ).fetchall()

        def _rows(rows: list) -> list[dict]:
            return [dict(r) for r in rows]

        return {
            "schema": self._EXPORT_SCHEMA,
            "exported_at": _now(),
            "project": dict(proj),
            "buildings": _rows(buildings),
            "locations": _rows(locations),
            "work_items": _rows(work_items),
            "daily_updates": _rows(daily),
            "assets": _rows(assets),
            "issues": _rows(issues),
            "comments": _rows(comments),
            "assignments": _rows(assignments),
        }

    def import_project(self, org: str, payload: dict[str, Any], actor_id: str) -> dict[str, Any]:
        _COMPAT_SCHEMAS = {"rackpilot-project-export/1", "rackpilot-project-export/2"}
        if payload.get("schema") not in _COMPAT_SCHEMAS:
            raise ValueError("unsupported export schema")
        proj = payload.get("project", {})
        if not isinstance(proj, dict) or not proj.get("id"):
            raise ValueError("missing project data")
        buildings = payload.get("buildings", [])
        locations = payload.get("locations", [])
        work_items = payload.get("work_items", [])
        daily = payload.get("daily_updates", [])
        imported = {"buildings": 0, "locations": 0, "work_items": 0, "daily_updates": 0}

        with self._connect() as conn:
            # Upsert project
            existing = conn.execute(
                "SELECT id FROM projects WHERE organization_id=? AND id=?", (org, proj["id"])
            ).fetchone()
            if not existing:
                conn.execute(
                    "INSERT OR IGNORE INTO projects(id,organization_id,code,name,description,"
                    "status,progress,start_date,end_date,created_at,updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (proj["id"], org, proj.get("code",""), proj.get("name",""),
                     proj.get("description",""), proj.get("status","active"),
                     proj.get("progress",0), proj.get("start_date"),
                     proj.get("end_date"), proj.get("created_at",_now()), _now())
                )
            for b in buildings:
                conn.execute(
                    "INSERT OR IGNORE INTO buildings(id,organization_id,project_id,code,name,"
                    "address,floors,attributes,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                    (b["id"], org, proj["id"], b.get("code",""), b.get("name",""),
                     b.get("address"), b.get("floors",1),
                     b.get("attributes","{}"), b.get("created_at",_now()))
                )
                imported["buildings"] += 1
            for loc in locations:
                conn.execute(
                    "INSERT OR IGNORE INTO project_locations(id,organization_id,project_id,"
                    "code,name,kind,building_id,parent_location_id,suite_total,"
                    "floor_number,area_sqm,attributes,created_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (loc["id"], org, proj["id"], loc.get("code",""), loc.get("name",""),
                     loc.get("kind","area"), loc.get("building_id"),
                     loc.get("parent_location_id"), loc.get("suite_total"),
                     loc.get("floor_number"), loc.get("area_sqm"),
                     loc.get("attributes","{}"), loc.get("created_at",_now()))
                )
                imported["locations"] += 1
            for wi in work_items:
                conn.execute(
                    "INSERT OR IGNORE INTO work_items(id,organization_id,project_id,code,"
                    "title,description,status,priority,work_type_id,location_id,building_id,"
                    "due_date,attributes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (wi["id"], org, proj["id"], wi.get("code",""), wi.get("title",""),
                     wi.get("description"), wi.get("status","open"), wi.get("priority","medium"),
                     wi.get("work_type_id"), wi.get("location_id"), wi.get("building_id"),
                     wi.get("due_date"), wi.get("attributes","{}"), wi.get("created_at",_now()))
                )
                imported["work_items"] += 1
            for du in daily:
                conn.execute(
                    "INSERT OR IGNORE INTO daily_updates(id,organization_id,project_id,"
                    "work_date,location_id,member_id,notes,completion_percent,quantity,"
                    "status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (du["id"], org, proj["id"], du.get("work_date",""),
                     du.get("location_id"), du.get("member_id",actor_id),
                     du.get("notes",""), du.get("completion_percent"),
                     du.get("quantity"), du.get("status","in_progress"),
                     du.get("created_at",_now()))
                )
                imported["daily_updates"] += 1
            self._audit(conn, org, actor_id, "project_imported",
                        {"project_id": proj["id"], "imported": imported})
        return {"ok": True, "project_id": proj["id"], "imported": imported}

    # -- AI router config -------------------------------------------------------

    def get_ai_router(self, org: str) -> AIRouter:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT provider, model, env_key_var, max_tokens, temperature, enabled "
                "FROM ai_router_config WHERE organization_id=?", (org,)
            ).fetchone()
        if not row:
            return AIRouter.default()
        return AIRouter(dict(row))

    def get_ai_router_config(self, org: str) -> dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT provider, model, env_key_var, max_tokens, temperature, enabled "
                "FROM ai_router_config WHERE organization_id=?", (org,)
            ).fetchone()
        if not row:
            return {"provider": "local", "model": "local", "env_key_var": "ANTHROPIC_API_KEY",
                    "max_tokens": 1024, "temperature": 0.3, "enabled": True}
        return dict(row)

    def save_ai_router_config(self, org: str, config: dict[str, Any]) -> None:
        allowed_providers = {"anthropic", "openai", "local"}
        provider = config.get("provider", "local")
        if provider not in allowed_providers:
            raise ValueError(f"provider must be one of {allowed_providers}")
        with self._connect() as conn:
            existing = conn.execute(
                "SELECT id FROM ai_router_config WHERE organization_id=?", (org,)
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE ai_router_config SET provider=?, model=?, env_key_var=?, "
                    "max_tokens=?, temperature=?, enabled=?, updated_at=? "
                    "WHERE organization_id=?",
                    (provider, config.get("model", "claude-haiku-4-5-20251001"),
                     config.get("env_key_var", "ANTHROPIC_API_KEY"),
                     int(config.get("max_tokens", 1024)),
                     float(config.get("temperature", 0.3)),
                     1 if config.get("enabled", True) else 0,
                     _now(), org)
                )
            else:
                conn.execute(
                    "INSERT INTO ai_router_config(id, organization_id, provider, model, "
                    "env_key_var, max_tokens, temperature, enabled, updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?)",
                    (_uid(), org, provider,
                     config.get("model", "claude-haiku-4-5-20251001"),
                     config.get("env_key_var", "ANTHROPIC_API_KEY"),
                     int(config.get("max_tokens", 1024)),
                     float(config.get("temperature", 0.3)),
                     1 if config.get("enabled", True) else 0,
                     _now())
                )

    def log_ai_invocation(
        self, org: str, user_id: str | None, intent: str,
        provider: str, model: str,
        prompt_tokens: int, completion_tokens: int,
        latency_ms: int, error: str | None,
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO ai_invocation_log(id, organization_id, user_id, intent, "
                "provider, model, prompt_tokens, completion_tokens, latency_ms, error, created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (_uid(), org, user_id, intent, provider, model,
                 prompt_tokens, completion_tokens, latency_ms, error, _now())
            )

    def list_ai_invocations(self, org: str, limit: int = 50) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, user_id, intent, provider, model, prompt_tokens, "
                "completion_tokens, latency_ms, error, created_at "
                "FROM ai_invocation_log WHERE organization_id=? "
                "ORDER BY created_at DESC LIMIT ?", (org, limit)
            ).fetchall()
        return [dict(r) for r in rows]

    # -- Field note parsing ---------------------------------------------------

    _NOTE_SYSTEM_PROMPT = """You are a field operations data extractor for a construction/AV installation management system.
Extract structured change proposals from a free-form field note.

Context will be provided as JSON with: project name, locations (id, code, name, kind), work_items (id, code, title, status).

Return ONLY valid JSON (no markdown, no explanation) in this exact schema:
{
  "proposed_changes": [
    {
      "type": "work_item_progress",
      "work_item_id": "<id or null>",
      "work_item_code": "<matched code or null>",
      "work_item_title": "<matched title or text fragment>",
      "completion_percent": <0-100 or null>,
      "new_status": "<open|in_progress|done|blocked or null>",
      "notes": "<extracted note text>",
      "confidence": <0.0-1.0>
    },
    {
      "type": "location_progress",
      "location_id": "<id or null>",
      "location_code": "<matched code or null>",
      "location_name": "<matched name or text fragment>",
      "notes": "<what was done at this location>",
      "completion_percent": <0-100 or null>,
      "confidence": <0.0-1.0>
    },
    {
      "type": "new_issue",
      "title": "<short issue title>",
      "description": "<detail>",
      "severity": "<low|medium|high|critical>",
      "location_id": "<id or null>",
      "confidence": <0.0-1.0>
    }
  ],
  "unrecognized": ["<text span that could not be mapped to any entity>"]
}

Rules:
- Only include changes with confidence >= 0.5
- Use the exact IDs from context when you can match an entity
- "unrecognized" should list text fragments you cannot confidently map
- If no changes found, return {"proposed_changes": [], "unrecognized": [<full text>]}
"""

    def _local_parse_note(
        self,
        raw_text: str,
        work_items: list[dict],
        locations: list[dict],
    ) -> dict[str, Any]:
        """Fallback regex-based extractor when no LLM is configured."""
        import re as _re
        changes = []
        unrecognized = [raw_text]

        pct_pattern = _re.compile(r'(\d{1,3})\s*%')
        done_words = {'готов', 'завершён', 'завершен', 'сделан', 'done', 'complete', 'finished', '100%'}
        issue_words = {'проблем', 'сломан', 'неисправ', 'error', 'broken', 'issue', 'fail'}

        low = raw_text.lower()

        # Match work items by code or title fragment
        for wi in work_items:
            code = (wi.get('code') or '').lower()
            title = (wi.get('title') or '').lower()
            if code and code in low or (len(title) > 4 and title[:12] in low):
                pct = next((int(m.group(1)) for m in pct_pattern.finditer(raw_text)), None)
                is_done = any(w in low for w in done_words)
                changes.append({
                    'type': 'work_item_progress',
                    'work_item_id': wi.get('id'),
                    'work_item_code': wi.get('code'),
                    'work_item_title': wi.get('title'),
                    'completion_percent': 100 if is_done else pct,
                    'new_status': 'done' if is_done else ('in_progress' if pct else None),
                    'notes': raw_text[:300],
                    'confidence': 0.7,
                })
                unrecognized = []
                break

        # Match locations
        for loc in locations:
            code = (loc.get('code') or '').lower()
            name = (loc.get('name') or '').lower()
            if (code and code in low) or (len(name) > 3 and name in low):
                changes.append({
                    'type': 'location_progress',
                    'location_id': loc.get('id'),
                    'location_code': loc.get('code'),
                    'location_name': loc.get('name'),
                    'notes': raw_text[:300],
                    'completion_percent': None,
                    'confidence': 0.65,
                })
                unrecognized = []
                break

        # Detect issues
        if any(w in low for w in issue_words):
            changes.append({
                'type': 'new_issue',
                'title': raw_text[:80],
                'description': raw_text[:400],
                'severity': 'medium',
                'location_id': None,
                'confidence': 0.6,
            })
            unrecognized = []

        return {
            'proposed_changes': changes,
            'unrecognized': unrecognized if not changes else [],
        }

    def parse_field_note(
        self, org: str, project_id: str, author_id: str, raw_text: str
    ) -> dict[str, Any]:
        with self._connect() as conn:
            work_items = conn.execute(
                "SELECT id, code, title, status FROM work_items "
                "WHERE organization_id=? AND project_id=? LIMIT 80",
                (org, project_id),
            ).fetchall()
            locations = conn.execute(
                "SELECT id, code, name, kind FROM project_locations "
                "WHERE organization_id=? AND project_id=? LIMIT 60",
                (org, project_id),
            ).fetchall()
            project = conn.execute(
                "SELECT name FROM projects WHERE organization_id=? AND id=?",
                (org, project_id),
            ).fetchone()

        wi_list = [dict(r) for r in work_items]
        loc_list = [dict(r) for r in locations]
        proj_name = project["name"] if project else project_id

        router = self.get_ai_router(org)
        provider = router.provider
        model = router.model
        parsed: dict[str, Any] = {}

        if router.available and provider != 'local':
            context = json.dumps({
                'project': proj_name,
                'work_items': wi_list,
                'locations': loc_list,
            }, ensure_ascii=False)
            prompt = f"Context:\n{context}\n\nField note:\n{raw_text}"
            try:
                result = router.invoke(prompt, system=self._NOTE_SYSTEM_PROMPT, max_tokens=1500)
                text = result.get('text', '')
                parsed = json.loads(text)
                self.log_ai_invocation(
                    org, author_id, 'parse_note',
                    result.get('provider', provider), result.get('model', model),
                    result.get('prompt_tokens', 0), result.get('completion_tokens', 0),
                    result.get('latency_ms', 0), None,
                )
            except (json.JSONDecodeError, KeyError):
                parsed = self._local_parse_note(raw_text, wi_list, loc_list)
            except Exception as exc:
                self.log_ai_invocation(org, author_id, 'parse_note', provider, model, 0, 0, 0, str(exc))
                parsed = self._local_parse_note(raw_text, wi_list, loc_list)
        else:
            parsed = self._local_parse_note(raw_text, wi_list, loc_list)

        draft_id = _uid()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO field_note_drafts(id, organization_id, project_id, author_id, "
                "raw_text, proposed_changes, unrecognized, provider, model, status, created_at, updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (draft_id, org, project_id, author_id, raw_text,
                 json.dumps(parsed.get('proposed_changes', []), ensure_ascii=False),
                 json.dumps(parsed.get('unrecognized', []), ensure_ascii=False),
                 provider, model, 'pending', _now(), _now()),
            )

        return {
            'draft_id': draft_id,
            'proposed_changes': parsed.get('proposed_changes', []),
            'unrecognized': parsed.get('unrecognized', []),
            'provider': provider,
            'model': model,
        }

    def apply_field_note(
        self, org: str, draft_id: str, actor_id: str,
        approved_changes: list[dict[str, Any]],
    ) -> dict[str, Any]:
        with self._connect() as conn:
            draft = conn.execute(
                "SELECT id, project_id, raw_text, status FROM field_note_drafts "
                "WHERE organization_id=? AND id=?", (org, draft_id)
            ).fetchone()
            if not draft:
                raise LookupError(f"draft {draft_id} not found")
            if draft['status'] == 'applied':
                raise ValueError("draft already applied")

        project_id = draft['project_id']
        raw_text = draft['raw_text']
        applied: dict[str, int] = {'daily_updates': 0, 'work_items': 0, 'issues': 0}

        with self._connect() as conn:
            for change in approved_changes:
                ctype = change.get('type')

                if ctype == 'work_item_progress':
                    wi_id = change.get('work_item_id')
                    pct = change.get('completion_percent')
                    new_status = change.get('new_status')
                    if wi_id and (pct is not None or new_status):
                        updates = []
                        if new_status:
                            updates.append(('status', new_status))
                        if updates:
                            conn.execute(
                                "UPDATE work_items SET status=?, updated_at=? "
                                "WHERE organization_id=? AND id=?",
                                (new_status or 'in_progress', _now(), org, wi_id),
                            )
                        # Create daily update entry
                        conn.execute(
                            "INSERT INTO daily_updates(id, organization_id, project_id, "
                            "work_date, member_id, notes, completion_percent, status, created_at) "
                            "VALUES(?,?,?,?,?,?,?,?,?)",
                            (_uid(), org, project_id, _now()[:10], actor_id,
                             change.get('notes', raw_text[:300]),
                             pct, new_status or 'in_progress', _now()),
                        )
                        applied['work_items'] += 1
                        applied['daily_updates'] += 1

                elif ctype == 'location_progress':
                    notes = change.get('notes', raw_text[:300])
                    pct = change.get('completion_percent')
                    loc_id = change.get('location_id')
                    conn.execute(
                        "INSERT INTO daily_updates(id, organization_id, project_id, "
                        "work_date, location_id, member_id, notes, completion_percent, status, created_at) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (_uid(), org, project_id, _now()[:10], loc_id, actor_id,
                         notes, pct, 'in_progress', _now()),
                    )
                    applied['daily_updates'] += 1

                elif ctype == 'new_issue':
                    conn.execute(
                        "INSERT INTO issues(id, organization_id, project_id, title, description, "
                        "severity, status, location_id, created_at, updated_at) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (_uid(), org, project_id,
                         change.get('title', 'Field note issue')[:200],
                         change.get('description', '')[:1000],
                         change.get('severity', 'medium'),
                         'open', change.get('location_id'), _now(), _now()),
                    )
                    applied['issues'] += 1

            conn.execute(
                "UPDATE field_note_drafts SET status='applied', applied_at=?, updated_at=? "
                "WHERE organization_id=? AND id=?",
                (_now(), _now(), org, draft_id),
            )
            self._audit(conn, org, actor_id, 'field_note_applied',
                        {'draft_id': draft_id, 'applied': applied})

        return {'ok': True, 'draft_id': draft_id, 'applied': applied}

    def reject_field_note(self, org: str, draft_id: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE field_note_drafts SET status='rejected', updated_at=? "
                "WHERE organization_id=? AND id=?",
                (_now(), org, draft_id),
            )

    def list_field_note_drafts(self, org: str, project_id: str, limit: int = 20) -> list[dict]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, author_id, raw_text, proposed_changes, unrecognized, "
                "provider, model, status, applied_at, created_at "
                "FROM field_note_drafts WHERE organization_id=? AND project_id=? "
                "ORDER BY created_at DESC LIMIT ?",
                (org, project_id, limit),
            ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d['proposed_changes'] = json.loads(d['proposed_changes'])
            d['unrecognized'] = json.loads(d['unrecognized'])
            result.append(d)
        return result

    # -- Specialized AI agents ------------------------------------------------

    _TECH_AGENT_SYSTEM = """You are a Technical Agent for a field operations platform.
You answer questions about equipment (assets), their relationships, service history, and configurations.
You are given JSON context containing relevant assets, relationships, and service events.
Rules:
- Answer concisely and factually based ONLY on the provided context
- Always cite your sources as [Asset: <code>] or [Event: <date>]
- If the context does not contain enough information, say so explicitly
- Prefer bullet points for lists of facts
- Output plain text (no markdown headers, no code blocks)
"""

    _DOC_AGENT_SYSTEM = """You are a Documentation Agent for a field operations platform.
You answer questions about project documents, technical specifications, and stored knowledge.
You are given JSON context containing relevant document chunks retrieved via full-text search.
Rules:
- Answer concisely based ONLY on the provided document chunks
- Always cite your sources as [Doc: <name>, chunk <n>]
- If the chunks don't answer the question, say so explicitly
- Do not hallucinate facts not present in the context
- Output plain text (no markdown headers, no code blocks)
"""

    def _build_tech_context(
        self, conn: sqlite3.Connection, org: str, query: str, project_id: str | None
    ) -> tuple[list[dict], str]:
        """Retrieve relevant assets + recent service events for technical agent."""
        # Simple keyword-based retrieval: match query words against asset name/type/notes
        words = [w.strip() for w in query.lower().split() if len(w.strip()) > 2][:6]
        rows = conn.execute(
            "SELECT id, code, name, asset_type, status, location_id, attributes "
            "FROM dt_assets WHERE organization_id=?" +
            (f" AND project_id=?" if project_id else ""),
            (org, project_id) if project_id else (org,),
        ).fetchall()
        assets = [dict(r) for r in rows]
        # Score by word match
        def score(a: dict) -> int:
            text = f"{a.get('name','')} {a.get('asset_type','')} {a.get('code','')}".lower()
            return sum(1 for w in words if w in text)
        assets = sorted(assets, key=score, reverse=True)[:10]

        sources: list[dict] = []
        for a in assets:
            events = conn.execute(
                "SELECT event_type, performed_at, technician_id, notes "
                "FROM asset_service_events WHERE asset_id=? ORDER BY performed_at DESC LIMIT 3",
                (a['id'],),
            ).fetchall()
            cfg = conn.execute(
                "SELECT config_snapshot, recorded_at FROM asset_configurations "
                "WHERE asset_id=? ORDER BY recorded_at DESC LIMIT 1",
                (a['id'],),
            ).fetchone()
            rels = conn.execute(
                "SELECT b.name as target_name, b.code as target_code, r.relation_type "
                "FROM dt_relationships r JOIN dt_assets b ON b.id=r.to_asset_id "
                "WHERE r.from_asset_id=? LIMIT 5",
                (a['id'],),
            ).fetchall()
            sources.append({
                'asset_code': a.get('code'), 'asset_name': a.get('name'),
                'type': a.get('asset_type'), 'status': a.get('status'),
                'service_events': [dict(e) for e in events],
                'latest_config': dict(cfg) if cfg else None,
                'relationships': [dict(r) for r in rels],
            })
        context_json = json.dumps(sources, ensure_ascii=False)[:6000]
        return sources, context_json

    def _build_doc_context(
        self, conn: sqlite3.Connection, org: str, query: str,
        project_id: str | None, allowed_project_ids: list[str] | None,
    ) -> tuple[list[dict], str]:
        """Retrieve relevant knowledge chunks for documentation agent."""
        tokens = [t for t in query.split() if len(t) > 2][:8]
        fts_query = " OR ".join(f'"{t}"' for t in tokens) if tokens else query[:100]
        try:
            rows = conn.execute(
                "SELECT kf.chunk_id, kf.object_id, kf.project_id, "
                "snippet(knowledge_fts, 3, '<b>', '</b>', '…', 20) as snippet, "
                "rank "
                "FROM knowledge_fts kf "
                "WHERE knowledge_fts MATCH ? "
                "ORDER BY rank LIMIT 8",
                (fts_query,),
            ).fetchall()
        except Exception:
            rows = []

        sources = []
        for row in rows:
            obj = conn.execute(
                "SELECT name, mime_type, project_id, access_policy "
                "FROM objects WHERE id=?", (row['object_id'],)
            ).fetchone()
            if not obj:
                continue
            if obj['access_policy'] == 'restricted':
                continue
            chunk = conn.execute(
                "SELECT chunk_index, chunk_text FROM knowledge_chunks WHERE id=?",
                (row['chunk_id'],),
            ).fetchone()
            sources.append({
                'object_name': obj['name'],
                'chunk_index': chunk['chunk_index'] if chunk else 0,
                'snippet': row['snippet'],
                'text': chunk['chunk_text'][:600] if chunk else '',
            })
        context_json = json.dumps(sources, ensure_ascii=False)[:6000]
        return sources, context_json

    def technical_agent_query(
        self, org: str, query: str, user_id: str,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        with self._connect() as conn:
            sources, context_json = self._build_tech_context(conn, org, query, project_id)

        router = self.get_ai_router(org)
        if not router.available:
            return {
                'answer': f"Technical agent unavailable (provider: {router.provider}). "
                          f"Configure API key or use 'local' provider.",
                'sources': sources,
                'provider': router.provider,
                'model': router.model,
            }

        prompt = f"Context (assets and service data):\n{context_json}\n\nQuestion: {query}"
        try:
            result = router.invoke(prompt, system=self._TECH_AGENT_SYSTEM, max_tokens=800)
            self.log_ai_invocation(
                org, user_id, 'technical_agent',
                result.get('provider', router.provider), result.get('model', router.model),
                result.get('prompt_tokens', 0), result.get('completion_tokens', 0),
                result.get('latency_ms', 0), None,
            )
            return {
                'answer': result.get('text', ''),
                'sources': sources,
                'provider': result.get('provider', router.provider),
                'model': result.get('model', router.model),
                'latency_ms': result.get('latency_ms', 0),
            }
        except RuntimeError as exc:
            self.log_ai_invocation(org, user_id, 'technical_agent', router.provider, router.model,
                                   0, 0, 0, str(exc))
            raise

    def documentation_agent_query(
        self, org: str, query: str, user_id: str,
        project_id: str | None = None,
        allowed_project_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        with self._connect() as conn:
            sources, context_json = self._build_doc_context(
                conn, org, query, project_id, allowed_project_ids
            )

        router = self.get_ai_router(org)
        if not router.available:
            return {
                'answer': f"Documentation agent unavailable (provider: {router.provider}). "
                          f"Configure API key or use 'local' provider.",
                'sources': sources,
                'provider': router.provider,
                'model': router.model,
            }

        if not sources:
            return {
                'answer': "No relevant documents found in the knowledge base for this query.",
                'sources': [],
                'provider': router.provider,
                'model': router.model,
                'latency_ms': 0,
            }

        prompt = f"Document chunks:\n{context_json}\n\nQuestion: {query}"
        try:
            result = router.invoke(prompt, system=self._DOC_AGENT_SYSTEM, max_tokens=800)
            self.log_ai_invocation(
                org, user_id, 'documentation_agent',
                result.get('provider', router.provider), result.get('model', router.model),
                result.get('prompt_tokens', 0), result.get('completion_tokens', 0),
                result.get('latency_ms', 0), None,
            )
            return {
                'answer': result.get('text', ''),
                'sources': sources,
                'provider': result.get('provider', router.provider),
                'model': result.get('model', router.model),
                'latency_ms': result.get('latency_ms', 0),
            }
        except RuntimeError as exc:
            self.log_ai_invocation(org, user_id, 'documentation_agent', router.provider, router.model,
                                   0, 0, 0, str(exc))
            raise

    # -- Webhook integration ---------------------------------------------------

    def create_webhook(
        self, org: str, name: str, url: str, secret_key: str,
        events: list[str], created_by: str,
    ) -> dict[str, Any]:
        wid = _uid()
        secret_hash = hashlib.sha256(secret_key.encode()).hexdigest()
        events_json = json.dumps(events or ['*'])
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO webhook_configs(id, organization_id, name, url, secret_hash, "
                "events, enabled, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,1,?,?,?)",
                (wid, org, name, url, secret_hash, events_json, created_by, _now(), _now()),
            )
        return {"id": wid, "name": name, "url": url, "events": events}

    def list_webhooks(self, org: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, name, url, events, enabled, created_at "
                "FROM webhook_configs WHERE organization_id=? ORDER BY created_at DESC",
                (org,),
            ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d['events'] = json.loads(d['events'])
            result.append(d)
        return result

    def toggle_webhook(self, org: str, webhook_id: str, enabled: bool) -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE webhook_configs SET enabled=?, updated_at=? WHERE organization_id=? AND id=?",
                (1 if enabled else 0, _now(), org, webhook_id),
            )

    def delete_webhook(self, org: str, webhook_id: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM webhook_configs WHERE organization_id=? AND id=?", (org, webhook_id)
            )

    def dispatch_event(self, org: str, event_type: str, payload: dict[str, Any]) -> int:
        """Queue delivery to all enabled webhooks that subscribe to this event type."""
        with self._connect() as conn:
            hooks = conn.execute(
                "SELECT id, url, secret_hash, events FROM webhook_configs "
                "WHERE organization_id=? AND enabled=1", (org,)
            ).fetchall()
            queued = 0
            now = _now()
            for hook in hooks:
                events = json.loads(hook['events'])
                if '*' not in events and event_type not in events:
                    continue
                delivery_id = _uid()
                full_payload = {
                    'id': delivery_id,
                    'organization_id': org,
                    'event': event_type,
                    'created_at': now,
                    'data': payload,
                }
                conn.execute(
                    "INSERT INTO webhook_deliveries(id, organization_id, webhook_id, event_type, "
                    "payload, attempts, next_retry_at, created_at) VALUES(?,?,?,?,?,0,?,?)",
                    (delivery_id, org, hook['id'],
                     event_type, json.dumps(full_payload, ensure_ascii=False),
                     now, now),
                )
                queued += 1
        return queued

    def flush_webhook_deliveries(self) -> int:
        """Process due deliveries. Called by WebhookDeliveryWorker thread."""
        now = _now()
        with self._connect() as conn:
            due = conn.execute(
                "SELECT d.id, d.webhook_id, d.event_type, d.payload, d.attempts, "
                "w.url, w.secret_hash "
                "FROM webhook_deliveries d "
                "JOIN webhook_configs w ON w.id=d.webhook_id "
                "WHERE d.next_retry_at IS NOT NULL AND d.next_retry_at <= ? "
                "ORDER BY d.next_retry_at LIMIT 50",
                (now,),
            ).fetchall()

        delivered = 0
        for row in due:
            attempts = row['attempts'] + 1
            payload = json.loads(row['payload'])
            status, error = deliver_once(
                row['url'], row['secret_hash'],
                row['event_type'], row['id'], payload,
            )
            success = 200 <= status < 300
            if success:
                with self._connect() as conn:
                    conn.execute(
                        "UPDATE webhook_deliveries SET attempts=?, last_status=?, last_error=NULL, "
                        "next_retry_at=NULL, delivered_at=? WHERE id=?",
                        (attempts, status, _now(), row['id']),
                    )
                delivered += 1
            else:
                delay_idx = min(attempts, _MAX_ATTEMPTS - 1)
                if attempts >= _MAX_ATTEMPTS:
                    next_retry = None
                else:
                    delay = _RETRY_DELAYS[delay_idx]
                    import datetime as _dt
                    next_dt = _dt.datetime.fromisoformat(now.replace('Z', '+00:00')) + _dt.timedelta(seconds=delay)
                    next_retry = next_dt.isoformat(timespec='seconds').replace('+00:00', 'Z')
                with self._connect() as conn:
                    conn.execute(
                        "UPDATE webhook_deliveries SET attempts=?, last_status=?, last_error=?, "
                        "next_retry_at=? WHERE id=?",
                        (attempts, status or 0, error, next_retry, row['id']),
                    )
        return delivered

    def list_deliveries(self, org: str, webhook_id: str | None = None, limit: int = 50) -> list[dict]:
        with self._connect() as conn:
            if webhook_id:
                rows = conn.execute(
                    "SELECT id, webhook_id, event_type, attempts, last_status, last_error, "
                    "next_retry_at, delivered_at, created_at "
                    "FROM webhook_deliveries WHERE organization_id=? AND webhook_id=? "
                    "ORDER BY created_at DESC LIMIT ?",
                    (org, webhook_id, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT id, webhook_id, event_type, attempts, last_status, last_error, "
                    "next_retry_at, delivered_at, created_at "
                    "FROM webhook_deliveries WHERE organization_id=? "
                    "ORDER BY created_at DESC LIMIT ?",
                    (org, limit),
                ).fetchall()
        return [dict(r) for r in rows]

    def global_search(self, org: str, query: str, limit: int = 20) -> dict[str, Any]:
        """Cross-entity search: projects, work items, locations, assets, issues, documents."""
        if not query.strip() or len(query) > 200:
            return {"query": query, "results": []}
        q = f"%{query.strip()}%"
        results: list[dict[str, Any]] = []
        with self._connect() as conn:
            # Projects
            for r in conn.execute(
                "SELECT id, name, code, status FROM projects "
                "WHERE organization_id=? AND (name LIKE ? OR code LIKE ? OR description LIKE ?) LIMIT ?",
                (org, q, q, q, limit),
            ).fetchall():
                results.append({"type": "project", "id": r["id"], "title": r["name"],
                                 "subtitle": r["code"], "status": r["status"]})
            # Work items
            for r in conn.execute(
                "SELECT wi.id, wi.title, COALESCE(wi.code,'') as code, wi.status, wi.project_id, p.name as project_name "
                "FROM project_work_items wi JOIN projects p ON p.id=wi.project_id AND p.organization_id=wi.organization_id "
                "WHERE wi.organization_id=? AND (wi.title LIKE ? OR COALESCE(wi.code,'') LIKE ? OR wi.description LIKE ?) LIMIT ?",
                (org, q, q, q, limit),
            ).fetchall():
                results.append({"type": "work_item", "id": r["id"], "projectId": r["project_id"],
                                 "title": r["title"], "subtitle": f"{r['code']} · {r['project_name']}".strip(" ·"), "status": r["status"]})
            # Locations
            for r in conn.execute(
                "SELECT pl.id, pl.name, pl.code, pl.project_id, p.name as project_name "
                "FROM project_locations pl JOIN projects p ON p.id=pl.project_id AND p.organization_id=pl.organization_id "
                "WHERE pl.organization_id=? AND (pl.name LIKE ? OR pl.code LIKE ?) LIMIT ?",
                (org, q, q, limit),
            ).fetchall():
                results.append({"type": "location", "id": r["id"], "projectId": r["project_id"],
                                 "title": r["name"], "subtitle": f"{r['code']} · {r['project_name']}"})
            # Assets
            for r in conn.execute(
                "SELECT id, name, make, model, status FROM dt_assets "
                "WHERE organization_id=? AND (name LIKE ? OR make LIKE ? OR model LIKE ? OR serial_number LIKE ?) LIMIT ?",
                (org, q, q, q, q, limit),
            ).fetchall():
                results.append({"type": "asset", "id": r["id"],
                                 "title": r["name"], "subtitle": f"{r['make'] or ''} {r['model'] or ''}".strip(),
                                 "status": r["status"]})
            # Issues
            for r in conn.execute(
                "SELECT id, title, severity, status, project_id FROM project_issues "
                "WHERE organization_id=? AND status='open' AND (title LIKE ? OR description LIKE ?) LIMIT ?",
                (org, q, q, limit),
            ).fetchall():
                results.append({"type": "issue", "id": r["id"], "projectId": r["project_id"],
                                 "title": r["title"], "subtitle": f"{r['severity']} · issue", "status": r["status"]})
            # Documents
            for r in conn.execute(
                "SELECT id, name, mime_type FROM objects "
                "WHERE organization_id=? AND parent_id IS NULL AND (name LIKE ? OR description LIKE ?) LIMIT ?",
                (org, q, q, limit),
            ).fetchall():
                results.append({"type": "document", "id": r["id"],
                                 "title": r["name"], "subtitle": r["mime_type"]})
        return {"query": query, "results": results[:limit]}

    def get_project_analytics(self, org: str, project_id: str) -> dict[str, Any]:
        """Velocity, risk, burndown, and milestone analytics for a project."""
        with self._connect() as conn:
            proj = conn.execute(
                "SELECT id, name, status, start_date, target_date FROM projects "
                "WHERE organization_id=? AND id=?", (org, project_id)
            ).fetchone()
            if proj is None:
                raise LookupError(f"project {project_id} not found")

            # Work item totals
            totals = conn.execute(
                "SELECT status, COUNT(*) as cnt, SUM(COALESCE(estimated_minutes,0)) as est_mins "
                "FROM project_work_items WHERE organization_id=? AND project_id=? GROUP BY status",
                (org, project_id),
            ).fetchall()
            by_status: dict[str, int] = {}
            est_by_status: dict[str, float] = {}
            for row in totals:
                by_status[row["status"]] = row["cnt"]
                est_by_status[row["status"]] = row["est_mins"] or 0

            total_items = sum(by_status.values())
            done_items = by_status.get("done", 0)
            blocked_items = by_status.get("blocked", 0)
            overdue_items = 0

            today = utc_now()[:10]
            # Items past due date
            if today:
                overdue_items = conn.execute(
                    "SELECT COUNT(*) FROM project_work_items "
                    "WHERE organization_id=? AND project_id=? AND status!='done' "
                    "AND due_date IS NOT NULL AND due_date < ?",
                    (org, project_id, today),
                ).fetchone()[0]

            # Velocity: daily updates in last 14 days
            vel_rows = conn.execute(
                "SELECT work_date, COUNT(*) as events, "
                "AVG(CAST(percent_complete AS REAL)) as avg_pct "
                "FROM daily_progress_entries WHERE organization_id=? AND project_id=? "
                "AND work_date >= date('now','-14 days') GROUP BY work_date ORDER BY work_date",
                (org, project_id),
            ).fetchall()
            velocity_days = [{"date": r["work_date"], "events": r["events"],
                              "avgPct": round(r["avg_pct"] or 0, 1)} for r in vel_rows]

            avg_events_per_day = (
                sum(d["events"] for d in velocity_days) / len(velocity_days)
                if velocity_days else 0
            )

            # Open issues by severity
            issue_rows = conn.execute(
                "SELECT severity, COUNT(*) as cnt FROM project_issues "
                "WHERE organization_id=? AND project_id=? AND status='open' GROUP BY severity",
                (org, project_id),
            ).fetchall()
            issues_by_severity = {r["severity"]: r["cnt"] for r in issue_rows}
            critical_issues = issues_by_severity.get("critical", 0) + issues_by_severity.get("high", 0)

            # Risk score: 0-100
            risk = 0
            if total_items:
                risk += round(blocked_items / total_items * 30)  # blocked ratio
                risk += round(overdue_items / total_items * 30)  # overdue ratio
            risk += min(20, critical_issues * 5)  # critical issues
            if avg_events_per_day < 1 and total_items and done_items < total_items:
                risk += 20  # low velocity
            risk = min(100, risk)

            # Progress percentage
            pct_done = round(done_items / total_items * 100) if total_items else 0

            # Estimated completion days
            remaining = total_items - done_items
            est_days = round(remaining / avg_events_per_day) if avg_events_per_day > 0 else None

        return {
            "projectId": project_id,
            "projectName": dict(proj)["name"],
            "totalItems": total_items,
            "doneItems": done_items,
            "blockedItems": blocked_items,
            "overdueItems": overdue_items,
            "pctDone": pct_done,
            "byStatus": by_status,
            "riskScore": risk,
            "riskLevel": "critical" if risk >= 70 else "high" if risk >= 40 else "medium" if risk >= 20 else "low",
            "avgEventsPerDay": round(avg_events_per_day, 2),
            "estimatedDaysRemaining": est_days,
            "velocityDays": velocity_days,
            "issuesBySeverity": issues_by_severity,
            "criticalIssues": critical_issues,
        }

    # ── Email Inbox (IMAP inventory parsing) ─────────────────────────────────

    def list_email_inboxes(self, org: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id,name,host,port,use_ssl,username,folder,filter_subject,filter_sender,"
                "target_warehouse_id,enabled,poll_interval,last_polled_at,last_uid,created_at "
                "FROM email_inbox_configs WHERE organization_id=? ORDER BY name",
                (org,),
            ).fetchall()
        return [dict(r) for r in rows]

    def create_email_inbox(self, org: str, payload: dict[str, Any]) -> dict[str, Any]:
        name = str(payload.get("name","")).strip()
        host = str(payload.get("host","")).strip()
        username = str(payload.get("username","")).strip()
        if not name or not host or not username:
            raise ValueError("name, host, and username are required")
        # Store password in secrets vault if provided
        password = payload.get("password","")
        secret_id = None
        if password:
            secret_id = self.store_secret(
                org, f"email-inbox-{name}-password",
                f"IMAP password for {username}@{host}",
                str(password), "email",
            )["id"]
        iid = str(uuid.uuid4()); now = utc_now()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO email_inbox_configs (id,organization_id,name,host,port,use_ssl,username,"
                "password_secret_id,folder,filter_subject,filter_sender,target_warehouse_id,"
                "enabled,poll_interval,last_uid,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,0,?,?)",
                (iid, org, name, host,
                 int(payload.get("port", 993)),
                 1 if payload.get("useSsl", True) else 0,
                 username, secret_id,
                 str(payload.get("folder","INBOX")),
                 str(payload.get("filterSubject",""))[:200],
                 str(payload.get("filterSender",""))[:200],
                 payload.get("targetWarehouseId"),
                 int(payload.get("pollInterval", 15)),
                 now, now),
            )
            row = conn.execute(
                "SELECT id,name,host,port,use_ssl,username,folder,filter_subject,filter_sender,"
                "target_warehouse_id,enabled,poll_interval,last_polled_at,last_uid,created_at "
                "FROM email_inbox_configs WHERE id=?", (iid,)
            ).fetchone()
        return dict(row)

    def delete_email_inbox(self, org: str, inbox_id: str) -> None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT password_secret_id FROM email_inbox_configs WHERE id=? AND organization_id=?",
                (inbox_id, org),
            ).fetchone()
            if not row: raise LookupError("Inbox not found")
            conn.execute("DELETE FROM email_inbox_configs WHERE id=?", (inbox_id,))
            # Clean up associated secret
            if row["password_secret_id"]:
                conn.execute("DELETE FROM secrets WHERE id=? AND organization_id=?",
                             (row["password_secret_id"], org))

    def list_email_processed(self, org: str, inbox_id: str, limit: int = 50) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM email_processed WHERE organization_id=? AND inbox_id=? "
                "ORDER BY created_at DESC LIMIT ?",
                (org, inbox_id, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    def poll_email_inbox(self, org: str, inbox_id: str,
                          ai_gateway: Any | None = None) -> dict[str, Any]:
        """Connect to IMAP, fetch new messages, parse for inventory movements."""
        import imaplib, email as _email
        from email.header import decode_header as _decode_header

        with self._connect() as conn:
            cfg = conn.execute(
                "SELECT * FROM email_inbox_configs WHERE id=? AND organization_id=? AND enabled=1",
                (inbox_id, org),
            ).fetchone()
        if not cfg:
            raise LookupError("Inbox not found or disabled")

        # Resolve password from secrets vault — NEVER logged
        password = ""
        if cfg["password_secret_id"]:
            password = self.get_secret_value(cfg["password_secret_id"]) or ""

        def _decode_str(value: Any) -> str:
            if value is None: return ""
            parts = _decode_header(str(value))
            result = []
            for chunk, enc in parts:
                if isinstance(chunk, bytes):
                    try: result.append(chunk.decode(enc or "utf-8", errors="replace"))
                    except Exception: result.append(chunk.decode("latin-1", errors="replace"))
                else:
                    result.append(str(chunk))
            return " ".join(result)

        def _extract_text(msg: Any) -> str:
            """Extract plaintext body from email."""
            if msg.is_multipart():
                parts = []
                for part in msg.walk():
                    ct = part.get_content_type()
                    if ct == "text/plain":
                        charset = part.get_content_charset() or "utf-8"
                        try: parts.append(part.get_payload(decode=True).decode(charset, errors="replace"))
                        except Exception: pass
                return "\n".join(parts)
            charset = msg.get_content_charset() or "utf-8"
            try: return msg.get_payload(decode=True).decode(charset, errors="replace")
            except Exception: return ""

        stats = {"fetched": 0, "skipped": 0, "parsed": 0, "errors": []}
        now = utc_now()

        try:
            # Connect IMAP
            if cfg["use_ssl"]:
                conn_imap = imaplib.IMAP4_SSL(cfg["host"], cfg["port"])
            else:
                conn_imap = imaplib.IMAP4(cfg["host"], cfg["port"])

            try:
                conn_imap.login(cfg["username"], password)
                conn_imap.select(cfg["folder"] or "INBOX", readonly=False)

                # Search for UNSEEN messages
                search_criteria = "UNSEEN"
                if cfg["filter_sender"]:
                    search_criteria = f'UNSEEN FROM "{cfg["filter_sender"]}"'
                _, data = conn_imap.search(None, search_criteria)
                msg_nums = data[0].split() if data[0] else []

                for num in msg_nums[-50:]:  # process at most 50 per poll
                    try:
                        _, msg_data = conn_imap.fetch(num, "(RFC822)")
                        raw = msg_data[0][1] if msg_data and msg_data[0] else None
                        if not raw: continue

                        msg = _email.message_from_bytes(raw)
                        message_id = msg.get("Message-ID","") or f"no-id-{num.decode()}"
                        subject = _decode_str(msg.get("Subject",""))
                        sender = _decode_str(msg.get("From",""))

                        # Skip if subject filter doesn't match
                        if cfg["filter_subject"] and cfg["filter_subject"].lower() not in subject.lower():
                            stats["skipped"] += 1
                            conn_imap.store(num, "+FLAGS", "\\Seen")
                            continue

                        # Skip already processed
                        with self._connect() as db:
                            already = db.execute(
                                "SELECT 1 FROM email_processed WHERE inbox_id=? AND message_id=?",
                                (inbox_id, message_id),
                            ).fetchone()
                        if already:
                            stats["skipped"] += 1
                            continue

                        stats["fetched"] += 1
                        body = _extract_text(msg)
                        note_text = f"Subject: {subject}\nFrom: {sender}\n\n{body[:3000]}"

                        pending_id = None
                        if ai_gateway:
                            try:
                                system_prompt = self.build_inventory_ai_prompt(org, cfg["target_warehouse_id"])
                                ai_response = ai_gateway.complete(
                                    f"{system_prompt}\n\nEmail content:\n{note_text}",
                                    max_tokens=512,
                                ) or ""
                                pending = self.create_inventory_pending_from_ai(
                                    org, note_text, ai_response, cfg["target_warehouse_id"]
                                )
                                pending_id = pending["id"]
                                stats["parsed"] += 1
                            except Exception as e:
                                stats["errors"].append(f"AI parse failed: {e}")
                        else:
                            # No AI — create pending with raw text, no suggestions
                            pending = self.create_inventory_pending(
                                org, "email", note_text, [],
                                ai_confidence=None, source_ref=message_id,
                            )
                            pending_id = pending["id"]

                        # Mark email as seen + log
                        conn_imap.store(num, "+FLAGS", "\\Seen")
                        eid = str(uuid.uuid4())
                        with self._connect() as db:
                            db.execute(
                                "INSERT OR IGNORE INTO email_processed "
                                "(id,organization_id,inbox_id,message_id,subject,sender,pending_id,status,created_at) "
                                "VALUES (?,?,?,?,?,?,?,?,?)",
                                (eid, org, inbox_id, message_id,
                                 subject[:300], sender[:300], pending_id, "processed", now),
                            )
                    except Exception as e:
                        stats["errors"].append(str(e)[:200])

                conn_imap.logout()
            except imaplib.IMAP4.error as e:
                raise ValueError(f"IMAP auth/connection error: {e}")
        except Exception as e:
            raise ValueError(f"Email poll failed: {e}")

        # Update last_polled_at
        with self._connect() as conn:
            conn.execute(
                "UPDATE email_inbox_configs SET last_polled_at=?,updated_at=? WHERE id=?",
                (now, now, inbox_id),
            )

        return {
            "inboxId": inbox_id, "polledAt": now,
            "fetched": stats["fetched"], "skipped": stats["skipped"],
            "parsed": stats["parsed"], "errors": stats["errors"],
        }

    def poll_all_due_inboxes(self, org: str, ai_gateway: Any | None = None) -> list[dict[str, Any]]:
        """Called by maintenance loop — polls inboxes where next poll time has passed."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, poll_interval, last_polled_at FROM email_inbox_configs "
                "WHERE organization_id=? AND enabled=1",
                (org,),
            ).fetchall()
        results = []
        now_ts = time.time()
        for row in rows:
            last = row["last_polled_at"]
            interval_sec = int(row["poll_interval"]) * 60
            if last:
                try:
                    last_ts = datetime.fromisoformat(last).timestamp()
                    if now_ts - last_ts < interval_sec:
                        continue
                except Exception:
                    pass
            try:
                result = self.poll_email_inbox(org, row["id"], ai_gateway)
                results.append(result)
            except Exception as e:
                results.append({"inboxId": row["id"], "error": str(e)})
        return results

    # ── Inventory Management ──────────────────────────────────────────────────

    # Warehouses
    def list_warehouses(self, org: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM warehouses WHERE organization_id=? AND active=1 ORDER BY name", (org,)
            ).fetchall()
        return [dict(r) for r in rows]

    def create_warehouse(self, org: str, payload: dict[str, Any]) -> dict[str, Any]:
        name = str(payload.get("name","")).strip()
        if not name: raise ValueError("Warehouse name required")
        wid = str(uuid.uuid4()); now = utc_now()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO warehouses (id,organization_id,name,location,description,active,created_at,updated_at) "
                "VALUES (?,?,?,?,?,1,?,?)",
                (wid, org, name, str(payload.get("location",""))[:200],
                 str(payload.get("description",""))[:500], now, now),
            )
            row = conn.execute("SELECT * FROM warehouses WHERE id=?", (wid,)).fetchone()
        return dict(row)

    def delete_warehouse(self, org: str, warehouse_id: str) -> None:
        with self._connect() as conn:
            r = conn.execute("UPDATE warehouses SET active=0,updated_at=? WHERE id=? AND organization_id=?",
                             (utc_now(), warehouse_id, org))
            if r.rowcount == 0: raise LookupError("Warehouse not found")

    # SKUs
    def list_skus(self, org: str, category: str | None = None) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if category:
                rows = conn.execute(
                    "SELECT * FROM inventory_skus WHERE organization_id=? AND active=1 AND category=? ORDER BY name",
                    (org, category)).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM inventory_skus WHERE organization_id=? AND active=1 ORDER BY name",
                    (org,)).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            try: d["tags"] = json.loads(d.get("tags") or "[]")
            except Exception: d["tags"] = []
            result.append(d)
        return result

    def create_sku(self, org: str, payload: dict[str, Any]) -> dict[str, Any]:
        name = str(payload.get("name","")).strip()
        sku_code = str(payload.get("skuCode","")).strip().upper()
        if not name: raise ValueError("SKU name required")
        if not sku_code: raise ValueError("skuCode required")
        sid = str(uuid.uuid4()); now = utc_now()
        tags = json.dumps(payload.get("tags",[]) if isinstance(payload.get("tags"), list) else [])
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO inventory_skus (id,organization_id,sku_code,name,description,category,unit,"
                "unit_cost,currency,tags,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)",
                (sid, org, sku_code, name, str(payload.get("description",""))[:500],
                 str(payload.get("category","general"))[:50],
                 str(payload.get("unit","pcs"))[:20],
                 payload.get("unitCost"), str(payload.get("currency","USD"))[:3],
                 tags, now, now),
            )
            row = conn.execute("SELECT * FROM inventory_skus WHERE id=?", (sid,)).fetchone()
        d = dict(row)
        try: d["tags"] = json.loads(d.get("tags") or "[]")
        except Exception: d["tags"] = []
        return d

    def search_skus(self, org: str, q: str) -> list[dict[str, Any]]:
        pattern = f"%{q}%"
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM inventory_skus WHERE organization_id=? AND active=1 "
                "AND (name LIKE ? OR sku_code LIKE ? OR description LIKE ?) ORDER BY name LIMIT 20",
                (org, pattern, pattern, pattern),
            ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            try: d["tags"] = json.loads(d.get("tags") or "[]")
            except Exception: d["tags"] = []
            result.append(d)
        return result

    # Stock levels
    def get_stock_levels(self, org: str, warehouse_id: str | None = None) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if warehouse_id:
                rows = conn.execute(
                    "SELECT s.*, k.name as sku_name, k.sku_code, k.unit, k.category, w.name as warehouse_name "
                    "FROM inventory_stock s "
                    "JOIN inventory_skus k ON k.id=s.sku_id "
                    "JOIN warehouses w ON w.id=s.warehouse_id "
                    "WHERE s.organization_id=? AND s.warehouse_id=? ORDER BY k.name",
                    (org, warehouse_id)).fetchall()
            else:
                rows = conn.execute(
                    "SELECT s.*, k.name as sku_name, k.sku_code, k.unit, k.category, w.name as warehouse_name "
                    "FROM inventory_stock s "
                    "JOIN inventory_skus k ON k.id=s.sku_id "
                    "JOIN warehouses w ON w.id=s.warehouse_id "
                    "WHERE s.organization_id=? ORDER BY w.name, k.name",
                    (org,)).fetchall()
        result = [dict(r) for r in rows]
        # Flag items below minimum
        for item in result:
            if item.get("min_quantity") is not None:
                item["belowMin"] = item["quantity"] < item["min_quantity"]
        return result

    def record_movement(self, org: str, payload: dict[str, Any],
                        source: str = "manual", source_ref: str | None = None) -> dict[str, Any]:
        """Apply a stock movement and update inventory_stock in one transaction."""
        warehouse_id = str(payload.get("warehouseId",""))
        sku_id = str(payload.get("skuId",""))
        movement_type = str(payload.get("movementType","receive"))
        quantity = payload.get("quantity")

        if not warehouse_id or not sku_id:
            raise ValueError("warehouseId and skuId required")
        if not isinstance(quantity, (int, float)) or quantity == 0:
            raise ValueError("quantity must be a non-zero number")
        if movement_type not in ("receive","issue","transfer","adjustment","return","loss"):
            raise ValueError(f"Invalid movement type: {movement_type}")

        # issue/loss/transfer out are negative
        delta = float(quantity)
        if movement_type in ("issue", "loss"):
            delta = -abs(delta)
        else:
            delta = abs(delta)

        mid = str(uuid.uuid4()); now = utc_now()
        with self._connect() as conn:
            # Verify warehouse + sku belong to org
            if not conn.execute("SELECT 1 FROM warehouses WHERE id=? AND organization_id=?",
                                (warehouse_id, org)).fetchone():
                raise LookupError("Warehouse not found")
            if not conn.execute("SELECT 1 FROM inventory_skus WHERE id=? AND organization_id=?",
                                (sku_id, org)).fetchone():
                raise LookupError("SKU not found")
            # Upsert stock level
            conn.execute(
                "INSERT INTO inventory_stock (id,organization_id,warehouse_id,sku_id,quantity,reserved,updated_at) "
                "VALUES (?,?,?,?,MAX(0,?),0,?) "
                "ON CONFLICT(warehouse_id,sku_id) DO UPDATE SET "
                "quantity=MAX(0,quantity+?), updated_at=?",
                (str(uuid.uuid4()), org, warehouse_id, sku_id, delta, now, delta, now),
            )
            # Record movement
            conn.execute(
                "INSERT INTO inventory_movements (id,organization_id,warehouse_id,sku_id,movement_type,"
                "quantity,reference,note,source,source_ref,recorded_by,project_id,created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (mid, org, warehouse_id, sku_id, movement_type, delta,
                 str(payload.get("reference",""))[:100],
                 str(payload.get("note",""))[:500],
                 source, source_ref, payload.get("recordedBy"), payload.get("projectId"), now),
            )
            stock = conn.execute(
                "SELECT quantity FROM inventory_stock WHERE warehouse_id=? AND sku_id=?",
                (warehouse_id, sku_id)).fetchone()
        return {
            "movementId": mid, "warehouseId": warehouse_id, "skuId": sku_id,
            "movementType": movement_type, "delta": delta,
            "newQuantity": stock["quantity"] if stock else 0,
            "createdAt": now,
        }

    def list_movements(self, org: str, sku_id: str | None = None,
                       warehouse_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        where = ["m.organization_id=?"]
        params: list[Any] = [org]
        if sku_id:
            where.append("m.sku_id=?"); params.append(sku_id)
        if warehouse_id:
            where.append("m.warehouse_id=?"); params.append(warehouse_id)
        params.append(limit)
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT m.*, k.name as sku_name, k.sku_code, k.unit, w.name as warehouse_name "
                f"FROM inventory_movements m "
                f"JOIN inventory_skus k ON k.id=m.sku_id "
                f"JOIN warehouses w ON w.id=m.warehouse_id "
                f"WHERE {' AND '.join(where)} ORDER BY m.created_at DESC LIMIT ?",
                params,
            ).fetchall()
        return [dict(r) for r in rows]

    # Pending AI/email approval queue
    def create_inventory_pending(self, org: str, source: str, raw_input: str,
                                  suggested_movements: list[dict[str, Any]],
                                  ai_confidence: float | None = None,
                                  source_ref: str | None = None) -> dict[str, Any]:
        pid = str(uuid.uuid4()); now = utc_now()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO inventory_pending (id,organization_id,source,source_ref,suggested_movements,"
                "raw_input,ai_confidence,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (pid, org, source, source_ref, json.dumps(suggested_movements),
                 raw_input[:10000], ai_confidence, "pending", now, now),
            )
            row = conn.execute("SELECT * FROM inventory_pending WHERE id=?", (pid,)).fetchone()
        d = dict(row)
        try: d["suggested_movements"] = json.loads(d["suggested_movements"])
        except Exception: d["suggested_movements"] = []
        return d

    def list_inventory_pending(self, org: str, status: str = "pending") -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM inventory_pending WHERE organization_id=? AND status=? ORDER BY created_at DESC",
                (org, status),
            ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            try: d["suggested_movements"] = json.loads(d["suggested_movements"])
            except Exception: d["suggested_movements"] = []
            result.append(d)
        return result

    def approve_inventory_pending(self, org: str, pending_id: str,
                                   reviewer: str | None, approved_indices: list[int] | None = None) -> dict[str, Any]:
        """Apply selected (or all) suggested movements, mark as approved."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM inventory_pending WHERE id=? AND organization_id=? AND status='pending'",
                (pending_id, org),
            ).fetchone()
        if not row:
            raise LookupError("Pending item not found or already reviewed")
        try:
            suggestions = json.loads(row["suggested_movements"])
        except Exception:
            suggestions = []

        if approved_indices is not None:
            to_apply = [suggestions[i] for i in approved_indices if 0 <= i < len(suggestions)]
        else:
            to_apply = suggestions

        applied = []
        errors = []
        for mv in to_apply:
            try:
                result = self.record_movement(org, mv, source="ai", source_ref=pending_id)
                applied.append(result)
            except Exception as e:
                errors.append({"movement": mv, "error": str(e)})

        now = utc_now()
        new_status = "approved" if not errors else "partial"
        with self._connect() as conn:
            conn.execute(
                "UPDATE inventory_pending SET status=?,reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=?",
                (new_status, reviewer, now, now, pending_id),
            )
        return {"pendingId": pending_id, "status": new_status,
                "applied": len(applied), "errors": errors}

    def reject_inventory_pending(self, org: str, pending_id: str, reviewer: str | None) -> None:
        now = utc_now()
        with self._connect() as conn:
            r = conn.execute(
                "UPDATE inventory_pending SET status='rejected',reviewed_by=?,reviewed_at=?,updated_at=? "
                "WHERE id=? AND organization_id=? AND status='pending'",
                (reviewer, now, now, pending_id, org),
            )
            if r.rowcount == 0: raise LookupError("Pending item not found or already reviewed")

    def build_inventory_ai_prompt(self, org: str, warehouse_id: str | None = None) -> str:
        """Build system prompt for inventory AI parsing — called by HTTP handler."""
        skus = self.list_skus(org)
        sku_catalog = "\n".join(
            f"- {s['sku_code']}: {s['name']} ({s['unit']}, category={s['category']})"
            for s in skus[:100]
        )
        warehouses = self.list_warehouses(org)
        wh_list = "\n".join(f"- id={w['id']} name={w['name']}" for w in warehouses)
        prompt = (
            "You are an inventory assistant. Extract stock movements from the user's note.\n"
            "Return ONLY a JSON object with key 'movements' (array) and 'confidence' (0-1).\n"
            "Each movement: {warehouseId, skuId, movementType, quantity, reference, note}\n"
            "movementType: receive|issue|transfer|adjustment|return|loss\n"
            "Match SKUs by name/code from the catalog. If unsure, set skuId=null and add sku_name_guess.\n\n"
            f"Available warehouses:\n{wh_list or 'None defined'}\n\n"
            f"SKU catalog:\n{sku_catalog or 'No SKUs defined'}\n\n"
            "Return JSON only, no explanation."
        )
        if warehouse_id:
            prompt += f"\nTarget warehouse: {warehouse_id}"
        return prompt

    def create_inventory_pending_from_ai(self, org: str, text: str,
                                          ai_response: str, warehouse_id: str | None = None) -> dict[str, Any]:
        """Parse AI response JSON and create pending approval entry."""
        import re as _re
        try:
            m = _re.search(r'\{.*\}', ai_response, _re.DOTALL)
            parsed = json.loads(m.group(0)) if m else {}
        except Exception:
            parsed = {}
        movements = parsed.get("movements", [])
        confidence = float(parsed.get("confidence", 0.5))
        pending = self.create_inventory_pending(
            org, "ai", text, movements, confidence,
            source_ref=f"ai-{utc_now()[:10]}"
        )
        pending["aiResponse"] = ai_response[:2000]
        return pending

    # XLSX import (stdlib only — XLSX is a ZIP of XML files)
    @staticmethod
    def _parse_xlsx_movements(data: bytes) -> list[dict[str, Any]]:
        """Parse an Excel file for inventory columns: SKU, Warehouse, Qty, Type, Reference."""
        import zipfile, xml.etree.ElementTree as ET
        NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        rows: list[dict[str, Any]] = []
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                # Shared strings
                shared: list[str] = []
                if "xl/sharedStrings.xml" in zf.namelist():
                    tree = ET.parse(zf.open("xl/sharedStrings.xml"))
                    for si in tree.getroot().findall(f".//{{{NS}}}si"):
                        texts = "".join(t.text or "" for t in si.iter(f"{{{NS}}}t"))
                        shared.append(texts)
                # First sheet
                sheet_name = "xl/worksheets/sheet1.xml"
                if sheet_name not in zf.namelist():
                    for n in zf.namelist():
                        if n.startswith("xl/worksheets/sheet") and n.endswith(".xml"):
                            sheet_name = n; break
                tree = ET.parse(zf.open(sheet_name))
                header: list[str] = []
                for i, row_el in enumerate(tree.getroot().findall(f".//{{{NS}}}row")):
                    cells = []
                    for c in row_el.findall(f"{{{NS}}}c"):
                        t = c.get("t","")
                        if t == "inlineStr":
                            is_el = c.find(f"{{{NS}}}is")
                            text = "".join(el.text or "" for el in (is_el.iter(f"{{{NS}}}t") if is_el is not None else []))
                            cells.append(text)
                            continue
                        v_el = c.find(f"{{{NS}}}v")
                        v = v_el.text if v_el is not None else ""
                        if t == "s" and v is not None:
                            cells.append(shared[int(v)] if int(v) < len(shared) else "")
                        else:
                            cells.append(v or "")
                    if i == 0:
                        header = [h.strip().lower() for h in cells]
                        continue
                    if not any(cells): continue
                    record = dict(zip(header, cells))
                    # Normalise keys
                    sku = record.get("sku") or record.get("sku_code") or record.get("артикул","")
                    wh  = record.get("warehouse") or record.get("склад","")
                    qty_raw = record.get("qty") or record.get("quantity") or record.get("количество","0")
                    mv_type = record.get("type") or record.get("movement_type") or "receive"
                    ref = record.get("reference") or record.get("ref") or record.get("po","")
                    try: qty = float(qty_raw)
                    except Exception: qty = 0
                    if sku and qty:
                        rows.append({
                            "sku_code_guess": sku.upper(), "warehouse_name_guess": wh,
                            "movementType": mv_type.strip().lower() or "receive",
                            "quantity": qty, "reference": str(ref)[:100],
                            "note": "xlsx-import", "skuId": None, "warehouseId": None,
                        })
        except Exception as e:
            rows.append({"error": str(e)})
        return rows

    def import_xlsx_inventory(self, org: str, data: bytes, recorded_by: str | None) -> dict[str, Any]:
        """Parse XLSX, resolve SKUs/warehouses, create pending approval."""
        raw_rows = self._parse_xlsx_movements(data)
        # Resolve SKU codes and warehouse names to IDs
        with self._connect() as conn:
            sku_map = {r["sku_code"]: r["id"] for r in
                       conn.execute("SELECT id,sku_code FROM inventory_skus WHERE organization_id=? AND active=1",
                                    (org,)).fetchall()}
            wh_map  = {r["name"].lower(): r["id"] for r in
                       conn.execute("SELECT id,name FROM warehouses WHERE organization_id=? AND active=1",
                                    (org,)).fetchall()}
        resolved = []
        for row in raw_rows:
            if "error" in row: continue
            row["skuId"] = sku_map.get(row.get("sku_code_guess",""))
            wh_guess = (row.get("warehouse_name_guess","") or "").lower()
            row["warehouseId"] = wh_map.get(wh_guess)
            row["recordedBy"] = recorded_by
            resolved.append(row)
        pending = self.create_inventory_pending(
            org, "import", f"xlsx-import ({len(resolved)} rows)",
            resolved, ai_confidence=None, source_ref="xlsx"
        )
        return pending

    # ── Material Reservations ─────────────────────────────────────────────────

    def list_reservations(self, org: str, project_id: str | None = None,
                           sku_id: str | None = None, status: str = "active") -> list[dict[str, Any]]:
        with self._connect() as conn:
            clauses = ["r.organization_id=?"]
            params: list[Any] = [org]
            if project_id:
                clauses.append("r.project_id=?"); params.append(project_id)
            if sku_id:
                clauses.append("r.sku_id=?"); params.append(sku_id)
            if status != "all":
                clauses.append("r.status=?"); params.append(status)
            rows = conn.execute(
                f"""SELECT r.*, s.name as sku_name, s.sku_code, s.unit,
                           w.name as warehouse_name
                    FROM material_reservations r
                    LEFT JOIN inventory_skus s ON s.id=r.sku_id
                    LEFT JOIN warehouses w ON w.id=r.warehouse_id
                    WHERE {' AND '.join(clauses)}
                    ORDER BY r.created_at DESC""", params
            ).fetchall()
        return [dict(row) for row in rows]

    def create_reservation(self, org: str, project_id: str, warehouse_id: str,
                            sku_id: str, quantity: float, note: str = "",
                            reserved_by: str | None = None) -> dict[str, Any]:
        with self._connect() as conn:
            # Validate project, warehouse, sku exist in org
            proj = conn.execute(
                "SELECT id FROM projects WHERE organization_id=? AND id=?", (org, project_id)
            ).fetchone()
            if not proj:
                raise ValueError("Project not found")
            avail = conn.execute(
                "SELECT quantity - reserved FROM inventory_stock WHERE organization_id=? AND warehouse_id=? AND sku_id=?",
                (org, warehouse_id, sku_id)
            ).fetchone()
            if avail is None or (avail[0] is not None and avail[0] < quantity):
                raise ValueError("Insufficient available stock for reservation")
            rid = str(uuid.uuid4())
            now = utc_now()
            conn.execute(
                """INSERT INTO material_reservations
                   (id,organization_id,project_id,warehouse_id,sku_id,quantity,consumed,status,note,reserved_by,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,0,'active',?,?,?,?)""",
                (rid, org, project_id, warehouse_id, sku_id, quantity, note, reserved_by, now, now)
            )
            # Mark reserved in stock table
            conn.execute(
                """UPDATE inventory_stock SET reserved=reserved+?, updated_at=?
                   WHERE organization_id=? AND warehouse_id=? AND sku_id=?""",
                (quantity, now, org, warehouse_id, sku_id)
            )
            row = conn.execute(
                """SELECT r.*, s.name as sku_name, s.sku_code, s.unit, w.name as warehouse_name
                   FROM material_reservations r
                   LEFT JOIN inventory_skus s ON s.id=r.sku_id
                   LEFT JOIN warehouses w ON w.id=r.warehouse_id
                   WHERE r.id=?""", (rid,)
            ).fetchone()
        self.audit(org, reserved_by, None, "reservation.create", "reservation", rid)
        return dict(row)

    def release_reservation(self, org: str, reservation_id: str,
                             actor: str | None = None) -> None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM material_reservations WHERE organization_id=? AND id=? AND status='active'",
                (org, reservation_id)
            ).fetchone()
            if not row:
                raise ValueError("Reservation not found or not active")
            now = utc_now()
            remaining = row["quantity"] - row["consumed"]
            conn.execute(
                "UPDATE material_reservations SET status='released', updated_at=? WHERE id=?",
                (now, reservation_id)
            )
            if remaining > 0:
                conn.execute(
                    """UPDATE inventory_stock SET reserved=MAX(0, reserved-?), updated_at=?
                       WHERE organization_id=? AND warehouse_id=? AND sku_id=?""",
                    (remaining, now, org, row["warehouse_id"], row["sku_id"])
                )
        self.audit(org, actor, None, "reservation.release", "reservation", reservation_id)

    def consume_from_reservation(self, org: str, reservation_id: str,
                                  quantity: float, actor: str | None = None) -> dict[str, Any]:
        """Record actual consumption from a reservation, creates movement."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM material_reservations WHERE organization_id=? AND id=? AND status='active'",
                (org, reservation_id)
            ).fetchone()
            if not row:
                raise ValueError("Reservation not found or not active")
            remaining = row["quantity"] - row["consumed"]
            if quantity > remaining:
                raise ValueError(f"Cannot consume {quantity}, only {remaining} remaining in reservation")
            now = utc_now()
            new_consumed = row["consumed"] + quantity
            new_status = "consumed" if new_consumed >= row["quantity"] else "active"
            conn.execute(
                "UPDATE material_reservations SET consumed=?, status=?, updated_at=? WHERE id=?",
                (new_consumed, new_status, now, reservation_id)
            )
            # Record movement
            mid = str(uuid.uuid4())
            conn.execute(
                """INSERT INTO inventory_movements
                   (id,organization_id,warehouse_id,sku_id,movement_type,quantity,reference,note,source,recorded_by,project_id,created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (mid, org, row["warehouse_id"], row["sku_id"], "issue", -quantity,
                 f"reservation:{reservation_id}", f"Consumed from project reservation",
                 "manual", actor, row["project_id"], now)
            )
            # Update stock (reduce quantity, reduce reserved)
            conn.execute(
                """UPDATE inventory_stock
                   SET quantity=quantity+?, reserved=MAX(0, reserved-?), updated_at=?
                   WHERE organization_id=? AND warehouse_id=? AND sku_id=?""",
                (-quantity, quantity, now, org, row["warehouse_id"], row["sku_id"])
            )
        self.audit(org, actor, None, "reservation.consume", "reservation", reservation_id)
        return {"reservationId": reservation_id, "consumed": quantity, "movementId": mid}

    # ── Budget Tracking ───────────────────────────────────────────────────────

    def get_budget_summary(self, org: str, project_id: str) -> dict[str, Any]:
        with self._connect() as conn:
            proj = conn.execute(
                "SELECT budget_amount, budget_currency FROM projects WHERE organization_id=? AND id=?",
                (org, project_id),
            ).fetchone()
            rows = conn.execute(
                "SELECT SUM(amount) as total, category FROM project_expenses "
                "WHERE organization_id=? AND project_id=? GROUP BY category",
                (org, project_id),
            ).fetchall()
        if not proj:
            raise LookupError("Project not found")
        spent = sum(r["total"] for r in rows if r["total"])
        by_cat = {r["category"]: r["total"] for r in rows}
        budget = proj["budget_amount"]
        return {
            "projectId": project_id,
            "budgetAmount": budget,
            "budgetCurrency": proj["budget_currency"] or "USD",
            "totalSpent": spent,
            "remaining": (budget - spent) if budget is not None else None,
            "utilizationPct": round((spent / budget * 100), 1) if budget else None,
            "byCategory": by_cat,
        }

    def list_expenses(self, org: str, project_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM project_expenses WHERE organization_id=? AND project_id=? ORDER BY expense_date DESC",
                (org, project_id),
            ).fetchall()
        return [dict(r) for r in rows]

    def add_expense(self, org: str, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        amount = payload.get("amount")
        if not isinstance(amount, (int, float)) or amount <= 0:
            raise ValueError("amount must be a positive number")
        expense_date = str(payload.get("expenseDate", utc_now()[:10]))
        eid = str(uuid.uuid4())
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO project_expenses (id,organization_id,project_id,category,description,"
                "amount,currency,expense_date,recorded_by,receipt_ref,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (eid, org, project_id,
                 str(payload.get("category","other"))[:50],
                 str(payload.get("description",""))[:500],
                 float(amount),
                 str(payload.get("currency","USD"))[:3],
                 expense_date,
                 payload.get("recordedBy"),
                 payload.get("receiptRef"),
                 now, now),
            )
            row = conn.execute("SELECT * FROM project_expenses WHERE id=?", (eid,)).fetchone()
        return dict(row)

    def set_project_budget(self, org: str, project_id: str, amount: float | None, currency: str = "USD") -> None:
        with self._connect() as conn:
            result = conn.execute(
                "UPDATE projects SET budget_amount=?, budget_currency=? WHERE organization_id=? AND id=?",
                (amount, currency[:3], org, project_id),
            )
            if result.rowcount == 0:
                raise LookupError("Project not found")

    def delete_expense(self, org: str, expense_id: str) -> None:
        with self._connect() as conn:
            result = conn.execute(
                "DELETE FROM project_expenses WHERE id=? AND organization_id=?", (expense_id, org)
            )
            if result.rowcount == 0:
                raise LookupError("Expense not found")

    # ── Work Item Comments ────────────────────────────────────────────────────

    def list_wi_comments(self, org: str, work_item_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM work_item_comments WHERE organization_id=? AND work_item_id=? ORDER BY created_at",
                (org, work_item_id),
            ).fetchall()
        return [dict(r) for r in rows]

    def add_wi_comment(self, org: str, work_item_id: str, project_id: str,
                       body: str, author_id: str | None, author_name: str) -> dict[str, Any]:
        body = str(body).strip()
        if not body:
            raise ValueError("Comment body required")
        cid = str(uuid.uuid4())
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO work_item_comments (id,organization_id,work_item_id,project_id,"
                "author_id,author_name,body,edited,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)",
                (cid, org, work_item_id, project_id, author_id, author_name[:100], body[:4000], now, now),
            )
            row = conn.execute("SELECT * FROM work_item_comments WHERE id=?", (cid,)).fetchone()
        return dict(row)

    def edit_wi_comment(self, org: str, comment_id: str, body: str) -> dict[str, Any]:
        body = str(body).strip()
        if not body:
            raise ValueError("Comment body required")
        now = utc_now()
        with self._connect() as conn:
            result = conn.execute(
                "UPDATE work_item_comments SET body=?,edited=1,updated_at=? WHERE id=? AND organization_id=?",
                (body[:4000], now, comment_id, org),
            )
            if result.rowcount == 0:
                raise LookupError("Comment not found")
            row = conn.execute("SELECT * FROM work_item_comments WHERE id=?", (comment_id,)).fetchone()
        return dict(row)

    def delete_wi_comment(self, org: str, comment_id: str) -> None:
        with self._connect() as conn:
            result = conn.execute(
                "DELETE FROM work_item_comments WHERE id=? AND organization_id=?", (comment_id, org)
            )
            if result.rowcount == 0:
                raise LookupError("Comment not found")

    # ── Project Milestones ────────────────────────────────────────────────────

    _MILESTONE_STATUSES = {"pending", "at_risk", "achieved", "missed"}

    def list_milestones(self, org: str, project_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM project_milestones WHERE organization_id=? AND project_id=? ORDER BY target_date",
                (org, project_id),
            ).fetchall()
        return [dict(r) for r in rows]

    def create_milestone(self, org: str, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        name = payload.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Milestone name required")
        target_date = payload.get("targetDate")
        if not isinstance(target_date, str) or len(target_date) != 10:
            raise ValueError("targetDate required (YYYY-MM-DD)")
        mid = str(uuid.uuid4())
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO project_milestones (id,organization_id,project_id,name,description,"
                "target_date,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (mid, org, project_id, name.strip(), str(payload.get("description",""))[:500],
                 target_date, "pending", now, now),
            )
            row = conn.execute("SELECT * FROM project_milestones WHERE id=?", (mid,)).fetchone()
        return dict(row)

    def update_milestone(self, org: str, milestone_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        row = None
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM project_milestones WHERE id=? AND organization_id=?", (milestone_id, org)
            ).fetchone()
        if row is None:
            raise LookupError("Milestone not found")
        now = utc_now()
        status = payload.get("status", row["status"])
        if status not in self._MILESTONE_STATUSES:
            raise ValueError(f"Invalid milestone status")
        achieved_at = now if status == "achieved" and row["status"] != "achieved" else row["achieved_at"]
        with self._connect() as conn:
            conn.execute(
                "UPDATE project_milestones SET name=?,description=?,target_date=?,status=?,achieved_at=?,updated_at=? "
                "WHERE id=? AND organization_id=?",
                (payload.get("name", row["name"]),
                 payload.get("description", row["description"]),
                 payload.get("targetDate", row["target_date"]),
                 status, achieved_at, now, milestone_id, org),
            )
            updated = conn.execute("SELECT * FROM project_milestones WHERE id=?", (milestone_id,)).fetchone()
        return dict(updated)

    def delete_milestone(self, org: str, milestone_id: str) -> None:
        with self._connect() as conn:
            result = conn.execute(
                "DELETE FROM project_milestones WHERE id=? AND organization_id=?", (milestone_id, org)
            )
            if result.rowcount == 0:
                raise LookupError("Milestone not found")

    # ── Org Settings ──────────────────────────────────────────────────────────

    def get_org_settings(self, org: str) -> dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM org_settings WHERE organization_id=?", (org,)).fetchone()
        if row:
            return dict(row)
        return {"organization_id": org, "timezone": "UTC", "locale": "en",
                "date_format": "YYYY-MM-DD", "currency": "USD", "work_week_start": 1}

    def update_org_settings(self, org: str, payload: dict[str, Any]) -> dict[str, Any]:
        now = utc_now()
        current = self.get_org_settings(org)
        tz = payload.get("timezone", current["timezone"])
        locale = payload.get("locale", current["locale"])
        date_fmt = payload.get("dateFormat", current["date_format"])
        currency = payload.get("currency", current["currency"])
        wws = payload.get("workWeekStart", current["work_week_start"])
        if not isinstance(wws, int) or wws not in range(7):
            raise ValueError("workWeekStart must be 0-6")
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO org_settings (organization_id,timezone,locale,date_format,currency,work_week_start,updated_at) "
                "VALUES (?,?,?,?,?,?,?) "
                "ON CONFLICT(organization_id) DO UPDATE SET "
                "timezone=excluded.timezone, locale=excluded.locale, date_format=excluded.date_format, "
                "currency=excluded.currency, work_week_start=excluded.work_week_start, updated_at=excluded.updated_at",
                (org, tz, locale, date_fmt, currency, wws, now),
            )
        return self.get_org_settings(org)

    # ── Scheduled Reports ────────────────────────────────────────────────────

    _REPORT_TYPES = {"project_summary", "issues", "team_presence", "velocity"}
    _CADENCES = {"daily", "weekly", "monthly"}

    def list_scheduled_reports(self, org: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM scheduled_reports WHERE organization_id=? ORDER BY name",
                (org,),
            ).fetchall()
        return [dict(r) for r in rows]

    def create_scheduled_report(self, org: str, payload: dict[str, Any]) -> dict[str, Any]:
        name = payload.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Report name required")
        report_type = payload.get("reportType", "project_summary")
        if report_type not in self._REPORT_TYPES:
            raise ValueError(f"reportType must be one of: {', '.join(self._REPORT_TYPES)}")
        cadence = payload.get("cadence", "weekly")
        if cadence not in self._CADENCES:
            raise ValueError(f"cadence must be one of: {', '.join(self._CADENCES)}")
        fmt = payload.get("format", "csv")
        if fmt not in {"csv", "json"}:
            raise ValueError("format must be csv or json")
        report_id = str(uuid.uuid4())
        now = utc_now()
        # Compute next_run_at: beginning of next appropriate period
        next_run = now[:10]  # simple: start of tomorrow for daily
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO scheduled_reports (id,organization_id,name,report_type,project_id,"
                "cadence,day_of_week,day_of_month,format,next_run_at,enabled,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)",
                (report_id, org, name.strip(), report_type, payload.get("projectId"),
                 cadence, payload.get("dayOfWeek"), payload.get("dayOfMonth"),
                 fmt, next_run, now, now),
            )
            row = conn.execute("SELECT * FROM scheduled_reports WHERE id=?", (report_id,)).fetchone()
        return dict(row)

    def delete_scheduled_report(self, org: str, report_id: str) -> None:
        with self._connect() as conn:
            result = conn.execute(
                "DELETE FROM scheduled_reports WHERE id=? AND organization_id=?", (report_id, org)
            )
            if result.rowcount == 0:
                raise LookupError("Report schedule not found")

    @staticmethod
    def _make_asset_label_svg(asset: dict[str, Any], base_url: str = "") -> str:
        """Generate an SVG label card for an asset (printable, A6-ish)."""
        name = asset.get("name", "")[:40]
        asset_id = asset.get("id", "")
        asset_type = asset.get("asset_type") or asset.get("assetType", "")
        make_model = f"{asset.get('make','')} {asset.get('model','')}".strip()
        serial = asset.get("serial_number", "") or asset.get("serialNumber", "")
        url = f"{base_url}/assets/{asset_id}"

        # Encode URL as a simple QR-like grid placeholder (real scannable QR needs a library)
        # We output a barcode-style SVG label instead, which includes the asset URL as text
        lines = [
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160" width="320" height="160" font-family="monospace">',
            f'  <rect width="320" height="160" fill="#fff" rx="8"/>',
            f'  <rect x="8" y="8" width="304" height="144" fill="none" stroke="#000" stroke-width="1.5" rx="6"/>',
            # Header bar
            f'  <rect x="8" y="8" width="304" height="30" fill="#111" rx="6"/>',
            f'  <text x="16" y="28" font-size="14" font-weight="bold" fill="#fff">RackPilot Asset</text>',
            f'  <text x="288" y="28" font-size="11" fill="#aaa" text-anchor="end">{asset_type}</text>',
            # Asset name
            f'  <text x="16" y="56" font-size="15" font-weight="bold" fill="#111">{name}</text>',
            # Make/model
            f'  <text x="16" y="74" font-size="11" fill="#555">{make_model}</text>',
            # Serial
            f'  <text x="16" y="90" font-size="10" fill="#777">S/N: {serial or "—"}</text>',
            # ID (truncated)
            f'  <text x="16" y="108" font-size="9" fill="#999">ID: {asset_id[:24]}…</text>',
            # URL
            f'  <text x="16" y="148" font-size="8" fill="#bbb">{url[:60]}</text>',
            # Barcode-like decoration (purely decorative)
            *[f'  <rect x="{200 + i*3}" y="110" width="{2 if i % 3 != 0 else 1}" height="32" fill="#111"/>'
              for i in range(36)],
            '</svg>',
        ]
        return "\n".join(lines)

    # ── Issue management ──────────────────────────────────────────────────────

    _ISSUE_TRANSITIONS: dict[str, list[str]] = {
        "open":        ["in_progress", "wont_fix"],
        "in_progress": ["resolved", "open"],
        "resolved":    ["closed", "open"],
        "closed":      ["open"],
        "wont_fix":    ["open"],
    }
    _ISSUE_STATUSES = set(_ISSUE_TRANSITIONS.keys())

    def get_issue(self, org: str, issue_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM project_issues WHERE id=? AND organization_id=?", (issue_id, org)
            ).fetchone()
        if row is None:
            return None
        r = dict(row)
        r["status"] = r.get("status_v2") or r.get("status") or "open"
        return r

    def transition_issue(self, org: str, issue_id: str, new_status: str,
                          resolution_note: str = "", resolved_by: str | None = None) -> dict[str, Any]:
        issue = self.get_issue(org, issue_id)
        if issue is None:
            raise LookupError("Issue not found")
        current = issue["status"]
        allowed = self._ISSUE_TRANSITIONS.get(current, [])
        if new_status not in allowed:
            raise InvalidTransition(current, new_status)
        now = utc_now()
        updates: dict[str, Any] = {"status_v2": new_status, "updated_at": now}
        if new_status in ("resolved", "closed", "wont_fix"):
            updates["resolved_at"] = now
            updates["resolved_by"] = resolved_by
            if resolution_note:
                updates["resolution_note"] = resolution_note
        elif new_status == "open":
            updates["resolved_at"] = None
            updates["resolved_by"] = None
        set_clause = ", ".join(f"{k}=?" for k in updates)
        with self._connect() as conn:
            conn.execute(
                f"UPDATE project_issues SET {set_clause} WHERE id=? AND organization_id=?",
                list(updates.values()) + [issue_id, org],
            )
        updated = self.get_issue(org, issue_id)
        # Push notification if resolved
        if new_status in ("resolved", "closed"):
            try:
                self.push_notification(
                    org, f"Проблема устранена",
                    f"«{issue.get('title','')}» → {new_status}" + (f": {resolution_note}" if resolution_note else ""),
                    notif_type="system",
                    entity_type="issue", entity_id=issue_id, project_id=issue.get("project_id"),
                )
            except Exception:
                pass
        return updated  # type: ignore[return-value]

    def assign_issue(self, org: str, issue_id: str, assigned_to: str | None) -> dict[str, Any]:
        issue = self.get_issue(org, issue_id)
        if issue is None:
            raise LookupError("Issue not found")
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                "UPDATE project_issues SET assigned_to=?, updated_at=? WHERE id=? AND organization_id=?",
                (assigned_to, now, issue_id, org),
            )
        return self.get_issue(org, issue_id)  # type: ignore[return-value]

    def list_issues(self, org: str, project_id: str | None = None,
                     status: str | None = None, severity: str | None = None) -> list[dict[str, Any]]:
        with self._connect() as conn:
            where = "organization_id=?"
            params: list[Any] = [org]
            if project_id:
                where += " AND project_id=?"
                params.append(project_id)
            if status:
                where += " AND (COALESCE(status_v2, status)=?)"
                params.append(status)
            if severity:
                where += " AND severity=?"
                params.append(severity)
            rows = conn.execute(
                f"SELECT * FROM project_issues WHERE {where} ORDER BY created_at DESC",
                params,
            ).fetchall()
        result = []
        for row in rows:
            r = dict(row)
            r["status"] = r.get("status_v2") or r.get("status") or "open"
            result.append(r)
        return result

    def get_team_workload(self, org: str, project_id: str | None = None) -> list[dict[str, Any]]:
        """Per-member open work item counts, grouped by status."""
        with self._connect() as conn:
            where = "wi.organization_id=? AND wi.status NOT IN ('done')"
            params: list[Any] = [org]
            if project_id:
                where += " AND wi.project_id=?"
                params.append(project_id)
            rows = conn.execute(
                f"SELECT wi.assignee_user_id, u.display_name, u.email, wi.status, COUNT(*) as cnt "
                f"FROM project_work_items wi "
                f"LEFT JOIN users u ON u.id=wi.assignee_user_id "
                f"WHERE {where} AND wi.assignee_user_id IS NOT NULL "
                f"GROUP BY wi.assignee_user_id, wi.status "
                f"ORDER BY u.display_name",
                params,
            ).fetchall()
        # Group by member
        members: dict[str, dict[str, Any]] = {}
        for row in rows:
            uid = row["assignee_user_id"]
            if uid not in members:
                members[uid] = {
                    "userId": uid,
                    "displayName": row["display_name"] or row["email"] or uid,
                    "byStatus": {}, "total": 0,
                }
            members[uid]["byStatus"][row["status"]] = row["cnt"]
            members[uid]["total"] += row["cnt"]
        return sorted(members.values(), key=lambda m: -m["total"])

    def sweep_overdue_items(self, org: str) -> dict[str, int]:
        """Find work items past due_date, push overdue notifications. Safe to call repeatedly."""
        today = utc_now()[:10]
        pushed = 0
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT wi.id, wi.title, wi.project_id, wi.due_date "
                "FROM project_work_items wi "
                "WHERE wi.organization_id=? AND wi.status NOT IN ('done','cancelled') "
                "AND wi.due_date IS NOT NULL AND wi.due_date < ? "
                "AND NOT EXISTS ("
                "  SELECT 1 FROM notifications n "
                "  WHERE n.organization_id=wi.organization_id "
                "    AND n.entity_type='work_item' AND n.entity_id=wi.id "
                "    AND n.type='overdue' AND n.created_at >= date('now','-1 day')"
                ")",
                (org, today),
            ).fetchall()
        for row in rows:
            try:
                self.push_notification(
                    org, "Задача просрочена",
                    f"«{row['title']}» — срок {row['due_date']}",
                    notif_type="overdue",
                    entity_type="work_item", entity_id=row["id"],
                    project_id=row["project_id"],
                )
                pushed += 1
            except Exception:
                pass
        return {"checked": len(rows), "pushed": pushed}

    def run_due_scheduled_reports(self, org: str) -> list[dict[str, Any]]:
        """Generate CSV for all enabled reports whose next_run_at <= now. Returns list of results."""
        today = utc_now()[:10]
        results = []
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM scheduled_reports WHERE organization_id=? AND enabled=1 AND next_run_at<=?",
                (org, today),
            ).fetchall()
        for row in rows:
            r = dict(row)
            try:
                # Generate report content
                if r["report_type"] == "project_summary":
                    analytics = self.get_project_analytics(org, r["project_id"]) if r["project_id"] else None
                    content = json.dumps(analytics or {"note": "all-projects summary"})
                elif r["report_type"] == "issues":
                    with self._connect() as conn:
                        issues = conn.execute(
                            "SELECT * FROM project_issues WHERE organization_id=? AND status='open' ORDER BY severity",
                            (org,),
                        ).fetchall()
                    content = json.dumps([dict(i) for i in issues])
                else:
                    content = json.dumps({"reportType": r["report_type"], "generatedAt": today})
                # Advance next_run_at
                now = utc_now()
                with self._connect() as conn:
                    conn.execute(
                        "UPDATE scheduled_reports SET last_run_at=?, next_run_at=?, updated_at=? WHERE id=?",
                        (now, today, now, r["id"]),
                    )
                results.append({"reportId": r["id"], "name": r["name"], "status": "generated",
                                "bytes": len(content.encode())})
            except Exception as exc:
                results.append({"reportId": r["id"], "name": r["name"], "status": "error", "error": str(exc)})
        return results

    # ── Project Templates ─────────────────────────────────────────────────────

    _TEMPLATE_CATEGORIES = {"general", "residential", "commercial", "data_centre"}

    def list_templates(self, org: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM project_templates WHERE organization_id=? ORDER BY category, name",
                (org,),
            ).fetchall()
        return [self._template_row(r) for r in rows]

    def get_template(self, org: str, template_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM project_templates WHERE id=? AND organization_id=?", (template_id, org)
            ).fetchone()
        return self._template_row(row) if row else None

    def _template_row(self, row: Any) -> dict[str, Any]:
        r = dict(row)
        r["scaffold"] = json.loads(r.get("scaffold") or "{}")
        return r

    def create_template(self, org: str, payload: dict[str, Any],
                         created_by: str | None = None) -> dict[str, Any]:
        name = payload.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Template name required")
        category = payload.get("category", "general")
        if category not in self._TEMPLATE_CATEGORIES:
            raise ValueError(f"category must be one of: {', '.join(self._TEMPLATE_CATEGORIES)}")
        scaffold = payload.get("scaffold", {})
        if not isinstance(scaffold, dict):
            raise ValueError("scaffold must be an object")
        tpl_id = str(uuid.uuid4())
        now = utc_now()
        with self._connect() as conn:
            try:
                conn.execute(
                    "INSERT INTO project_templates (id,organization_id,name,description,category,scaffold,"
                    "is_public,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,0,?,?,?)",
                    (tpl_id, org, name.strip(), str(payload.get("description",""))[:500],
                     category, json.dumps(scaffold), created_by, now, now),
                )
            except sqlite3.IntegrityError as e:
                raise ValueError("Template name already exists in this organization") from e
        return self.get_template(org, tpl_id)  # type: ignore[return-value]

    def delete_template(self, org: str, template_id: str) -> None:
        with self._connect() as conn:
            result = conn.execute(
                "DELETE FROM project_templates WHERE id=? AND organization_id=?", (template_id, org)
            )
            if result.rowcount == 0:
                raise LookupError("Template not found")

    def create_project_from_template(self, org: str, template_id: str,
                                      payload: dict[str, Any]) -> dict[str, Any]:
        """Create a project pre-populated with stages and work items from a template."""
        tpl = self.get_template(org, template_id)
        if tpl is None:
            raise LookupError("Template not found")
        scaffold = tpl["scaffold"]
        # Merge scaffold defaults with caller payload
        create_payload = {**payload}
        if not create_payload.get("description") and scaffold.get("description"):
            create_payload["description"] = scaffold["description"]
        project = self.create_project(org, create_payload)
        pid = project["id"]
        # Seed work items from scaffold
        for item in scaffold.get("workItems", []):
            if not isinstance(item, dict) or not item.get("title"):
                continue
            try:
                self.create_work_item(org, pid, {
                    "title": item["title"],
                    "status": item.get("status", "backlog"),
                    "priority": item.get("priority", "medium"),
                    "description": item.get("description", ""),
                })
            except Exception:
                pass  # skip invalid items silently
        return self.get_project(org, pid)  # type: ignore[return-value]

    # ── Notifications ────────────────────────────────────────────────────────

    def push_notification(self, org: str, title: str, body: str = "",
                           notif_type: str = "system", user_id: str | None = None,
                           entity_type: str | None = None, entity_id: str | None = None,
                           project_id: str | None = None) -> str:
        notif_id = str(uuid.uuid4())
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO notifications (id,organization_id,user_id,type,title,body,"
                "entity_type,entity_id,project_id,read,created_at) VALUES (?,?,?,?,?,?,?,?,?,0,?)",
                (notif_id, org, user_id, notif_type, title, body,
                 entity_type, entity_id, project_id, now),
            )
        return notif_id

    def list_notifications(self, org: str, user_id: str | None = None,
                            unread_only: bool = False, limit: int = 30) -> list[dict[str, Any]]:
        with self._connect() as conn:
            where = "organization_id=?"
            params: list[Any] = [org]
            if user_id:
                where += " AND (user_id=? OR user_id IS NULL)"
                params.append(user_id)
            if unread_only:
                where += " AND read=0"
            rows = conn.execute(
                f"SELECT * FROM notifications WHERE {where} ORDER BY created_at DESC LIMIT ?",
                params + [limit],
            ).fetchall()
        return [dict(r) for r in rows]

    def mark_notifications_read(self, org: str, notif_ids: list[str] | None = None,
                                  user_id: str | None = None) -> int:
        with self._connect() as conn:
            if notif_ids:
                placeholders = ",".join("?" * len(notif_ids))
                result = conn.execute(
                    f"UPDATE notifications SET read=1 WHERE organization_id=? AND id IN ({placeholders})",
                    [org] + notif_ids,
                )
            else:
                where = "organization_id=? AND read=0"
                params: list[Any] = [org]
                if user_id:
                    where += " AND (user_id=? OR user_id IS NULL)"
                    params.append(user_id)
                result = conn.execute(f"UPDATE notifications SET read=1 WHERE {where}", params)
        return result.rowcount

    # ── Connectors ──────────────────────────────────────────────────────────

    _CONNECTOR_TYPES = {"jobber", "ms365", "google_workspace", "webhook", "custom"}

    def list_connectors(self, org: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id,connector_type,name,enabled,status,last_sync_at,last_error,created_at "
                "FROM connectors WHERE organization_id=? ORDER BY name",
                (org,),
            ).fetchall()
        return [dict(r) for r in rows]

    def upsert_connector(self, org: str, connector_type: str, name: str,
                          config: dict[str, Any], enabled: bool = True) -> dict[str, Any]:
        if connector_type not in self._CONNECTOR_TYPES:
            raise ValueError(f"Unknown connector type; allowed: {', '.join(self._CONNECTOR_TYPES)}")
        now = utc_now()
        with self._connect() as conn:
            existing = conn.execute(
                "SELECT id FROM connectors WHERE organization_id=? AND connector_type=?",
                (org, connector_type),
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE connectors SET name=?,enabled=?,config=?,status='active',updated_at=? WHERE id=?",
                    (name, 1 if enabled else 0, json.dumps(config), now, existing["id"]),
                )
                rec_id = existing["id"]
            else:
                rec_id = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO connectors (id,organization_id,connector_type,name,enabled,config,status,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?)",
                    (rec_id, org, connector_type, name, 1 if enabled else 0, json.dumps(config), "active", now, now),
                )
            row = conn.execute("SELECT * FROM connectors WHERE id=?", (rec_id,)).fetchone()
        return dict(row)

    def queue_webhook_event(self, org: str, connector_id: str | None,
                             event_type: str, payload: dict[str, Any]) -> str:
        event_id = str(uuid.uuid4())
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO webhook_events (id,organization_id,connector_id,event_type,payload,status,attempts,next_attempt_at,created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (event_id, org, connector_id, event_type, json.dumps(payload), "pending", 0, now, now),
            )
        return event_id

    def flush_webhook_events(self, max_events: int = 50) -> dict[str, int]:
        """Deliver pending webhook events to active connectors. Call periodically."""
        import http.client as _http
        import urllib.parse as _up
        sent = failed = skipped = 0
        now = utc_now()
        with self._connect() as conn:
            # Grab pending events that are due (next_attempt_at <= now)
            events = conn.execute(
                "SELECT we.*, c.config as connector_config FROM webhook_events we "
                "LEFT JOIN connectors c ON c.id=we.connector_id AND c.organization_id=we.organization_id "
                "WHERE we.status='pending' AND we.next_attempt_at <= ? "
                "ORDER BY we.created_at LIMIT ?",
                (now, max_events),
            ).fetchall()
        for ev in events:
            ev = dict(ev)
            config_raw = ev.get("connector_config") or "{}"
            try:
                config = json.loads(config_raw)
            except Exception:
                config = {}
            target_url = config.get("url") or config.get("webhook_url")
            if not target_url:
                skipped += 1
                with self._connect() as conn:
                    conn.execute(
                        "UPDATE webhook_events SET status='failed',attempts=attempts+1 WHERE id=?",
                        (ev["id"],),
                    )
                continue
            try:
                parsed = _up.urlparse(target_url)
                body = json.dumps({
                    "eventId": ev["id"], "eventType": ev["event_type"],
                    "organizationId": ev["organization_id"],
                    "payload": json.loads(ev["payload"] or "{}"),
                    "timestamp": ev["created_at"],
                }).encode("utf-8")
                if parsed.scheme == "https":
                    conn_cls = _http.HTTPSConnection
                else:
                    conn_cls = _http.HTTPConnection
                c = conn_cls(parsed.netloc, timeout=5)
                path = parsed.path or "/"
                if parsed.query:
                    path += "?" + parsed.query
                c.request("POST", path, body=body, headers={
                    "Content-Type": "application/json",
                    "User-Agent": "RackPilot-Webhook/1",
                    "X-RackPilot-Event": ev["event_type"],
                })
                resp = c.getresponse()
                resp.read()
                if 200 <= resp.status < 300:
                    with self._connect() as conn:
                        conn.execute(
                            "UPDATE webhook_events SET status='delivered',attempts=attempts+1,delivered_at=? WHERE id=?",
                            (now, ev["id"]),
                        )
                    sent += 1
                else:
                    raise ValueError(f"HTTP {resp.status}")
            except Exception as exc:
                attempts = (ev.get("attempts") or 0) + 1
                # Exponential back-off: 2^attempts minutes, capped at 60min
                import math as _math
                delay_s = min(3600, int(60 * (2 ** _math.log2(max(1, attempts)))))
                next_attempt = utc_now()  # simplistic — offset not added to keep stdlib-only
                new_status = "pending" if attempts < 5 else "failed"
                with self._connect() as conn:
                    conn.execute(
                        "UPDATE webhook_events SET status=?,attempts=?,next_attempt_at=? WHERE id=?",
                        (new_status, attempts, next_attempt, ev["id"]),
                    )
                LOGGER.warning(json.dumps({"event": "webhook_delivery_failed", "eventId": ev["id"], "error": str(exc)}))
                failed += 1
        return {"sent": sent, "failed": failed, "skipped": skipped}

    # ── Compute Jobs ──────────────────────────────────────────────────────────

    _JOB_TYPES = {"ai_inference", "report_gen", "index_rebuild", "custom"}

    def submit_compute_job(self, org: str, job_type: str, payload: dict[str, Any],
                           priority: int = 5, created_by: str | None = None) -> dict[str, Any]:
        if job_type not in self._JOB_TYPES:
            raise ValueError(f"Unknown job_type; allowed: {', '.join(self._JOB_TYPES)}")
        job_id = str(uuid.uuid4())
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO compute_jobs (id,organization_id,job_type,payload,status,priority,created_by,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (job_id, org, job_type, json.dumps(payload), "pending", max(1, min(10, priority)),
                 created_by, now, now),
            )
        return {"id": job_id, "status": "pending", "jobType": job_type, "priority": priority}

    def dispatch_compute_job(self, org: str, job_id: str, node_id: str) -> dict[str, Any]:
        now = utc_now()
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM compute_jobs WHERE id=? AND organization_id=? AND status='pending'",
                (job_id, org)
            ).fetchone()
            if row is None:
                raise LookupError("Job not found or already dispatched")
            conn.execute(
                "UPDATE compute_jobs SET status='dispatched',node_id=?,dispatched_at=?,updated_at=? WHERE id=?",
                (node_id, now, now, job_id),
            )
            return dict(conn.execute("SELECT * FROM compute_jobs WHERE id=?", (job_id,)).fetchone())

    def complete_compute_job(self, org: str, job_id: str, result: dict[str, Any] | None = None,
                              error: str | None = None) -> None:
        now = utc_now()
        status = "failed" if error else "done"
        result_json = json.dumps({"error": error} if error else (result or {}))
        with self._connect() as conn:
            conn.execute(
                "UPDATE compute_jobs SET status=?,completed_at=?,result=?,updated_at=? WHERE id=? AND organization_id=?",
                (status, now, result_json, now, job_id, org),
            )

    def list_compute_jobs(self, org: str, status: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if status:
                rows = conn.execute(
                    "SELECT * FROM compute_jobs WHERE organization_id=? AND status=? "
                    "ORDER BY priority, created_at DESC LIMIT ?",
                    (org, status, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM compute_jobs WHERE organization_id=? "
                    "ORDER BY created_at DESC LIMIT ?",
                    (org, limit),
                ).fetchall()
        return [dict(r) for r in rows]

    # ── Service Monitors ──────────────────────────────────────────────────────

    def create_monitor(self, org: str, payload: dict[str, Any]) -> dict[str, Any]:
        mon_id = str(uuid.uuid4())
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO service_monitors (id,organization_id,asset_id,name,check_type,target,"
                "port,path,interval_seconds,enabled,last_status,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,1,'unknown',?,?)",
                (mon_id, org, payload.get("assetId"),
                 payload.get("name",""), payload.get("checkType","ping"),
                 payload.get("target",""), payload.get("port"), payload.get("path"),
                 int(payload.get("intervalSeconds",60)), now, now),
            )
            row = conn.execute("SELECT * FROM service_monitors WHERE id=?", (mon_id,)).fetchone()
        return dict(row)

    def list_monitors(self, org: str, asset_id: str | None = None) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if asset_id:
                rows = conn.execute(
                    "SELECT * FROM service_monitors WHERE organization_id=? AND asset_id=? ORDER BY name",
                    (org, asset_id),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM service_monitors WHERE organization_id=? ORDER BY name",
                    (org,),
                ).fetchall()
        return [dict(r) for r in rows]

    def record_monitor_event(self, org: str, monitor_id: str, status: str,
                              latency_ms: float | None = None, error: str | None = None) -> None:
        now = utc_now()
        event_id = str(uuid.uuid4())
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO monitor_events (id,monitor_id,organization_id,status,latency_ms,error_message,checked_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (event_id, monitor_id, org, status, latency_ms, error, now),
            )
            conn.execute(
                "UPDATE service_monitors SET last_check_at=?,last_status=?,last_latency_ms=?,updated_at=? WHERE id=?",
                (now, status, latency_ms, now, monitor_id),
            )

    def list_monitor_events(self, org: str, monitor_id: str, limit: int = 50) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM monitor_events WHERE monitor_id=? AND organization_id=? "
                "ORDER BY checked_at DESC LIMIT ?",
                (monitor_id, org, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    def delete_monitor(self, org: str, monitor_id: str) -> None:
        with self._connect() as conn:
            if not conn.execute(
                "SELECT 1 FROM service_monitors WHERE id=? AND organization_id=?", (monitor_id, org)
            ).fetchone():
                raise LookupError("Monitor not found")
            conn.execute("DELETE FROM service_monitors WHERE id=?", (monitor_id,))

    def get_storage_stats(self, org: str) -> dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) as count, COALESCE(SUM(size_bytes),0) as total FROM objects WHERE organization_id=?",
                (org,),
            ).fetchone()
        return {"count": row["count"], "totalBytes": row["total"], "quotaBytes": self._org_quota_bytes()}

    # ── Knowledge retrieval evaluation ────────────────────────────────────────

    def create_eval_case(self, org: str, payload: dict[str, Any], created_by: str | None) -> dict[str, Any]:
        if not payload.get("query", "").strip():
            raise ValueError("query is required")
        case_id = str(uuid.uuid4())
        now = utc_now()
        expected = payload.get("expectedDocNames", [])
        if not isinstance(expected, list):
            raise ValueError("expectedDocNames must be a list of strings")
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO retrieval_test_cases (id,organization_id,project_id,query,expected_doc_names,notes,created_by,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (case_id, org, payload.get("projectId"), payload["query"].strip(),
                 json.dumps(expected, ensure_ascii=False), payload.get("notes", ""),
                 created_by, now, now),
            )
        return self._eval_case_row_to_dict({"id": case_id, "organization_id": org,
            "project_id": payload.get("projectId"), "query": payload["query"].strip(),
            "expected_doc_names": json.dumps(expected), "notes": payload.get("notes", ""),
            "created_by": created_by, "created_at": now, "updated_at": now})

    def list_eval_cases(self, org: str, project_id: str | None = None) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if project_id:
                rows = conn.execute(
                    "SELECT * FROM retrieval_test_cases WHERE organization_id=? AND project_id=? ORDER BY created_at DESC",
                    (org, project_id),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM retrieval_test_cases WHERE organization_id=? ORDER BY created_at DESC LIMIT 200",
                    (org,),
                ).fetchall()
        return [self._eval_case_row_to_dict(r) for r in rows]

    def delete_eval_case(self, org: str, case_id: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM retrieval_test_cases WHERE id=? AND organization_id=?", (case_id, org)
            )
        return cur.rowcount > 0

    @staticmethod
    def _eval_case_row_to_dict(r: Any) -> dict[str, Any]:
        d = dict(r) if not isinstance(r, dict) else r
        try: d["expectedDocNames"] = json.loads(d.pop("expected_doc_names", "[]"))
        except Exception: d["expectedDocNames"] = []
        d.setdefault("projectId", d.pop("project_id", None))
        return d

    def run_retrieval_eval(self, org: str, project_id: str | None, ran_by: str | None,
                           k_precision: int = 3, k_recall: int = 5) -> dict[str, Any]:
        """Run all eval cases for org (or project), compute P@k and R@k."""
        cases = self.list_eval_cases(org, project_id)
        if not cases:
            raise LookupError("No evaluation test cases found")

        details = []
        total_precision = 0.0
        total_recall = 0.0
        hits = 0

        for case in cases:
            results = self.search_objects(org, case["query"], project_id=project_id, limit=max(k_precision, k_recall))
            result_names = [r["name"] for r in results]
            expected = set(case["expectedDocNames"])

            if not expected:
                details.append({"caseId": case["id"], "query": case["query"],
                                 "note": "no expected docs — skipped"})
                continue

            top_p = result_names[:k_precision]
            top_r = result_names[:k_recall]
            precision = sum(1 for n in top_p if n in expected) / k_precision if top_p else 0.0
            recall = sum(1 for n in top_r if n in expected) / len(expected) if expected else 0.0
            hit = any(n in expected for n in top_r)

            total_precision += precision
            total_recall += recall
            if hit: hits += 1

            details.append({
                "caseId": case["id"], "query": case["query"],
                "expected": sorted(expected), "retrieved": result_names[:k_recall],
                "precisionAtK": round(precision, 3), "recallAtK": round(recall, 3), "hit": hit,
            })

        valid = len(details)
        p_avg = round(total_precision / valid, 3) if valid else 0.0
        r_avg = round(total_recall / valid, 3) if valid else 0.0
        hit_rate = round(hits / valid, 3) if valid else 0.0

        run_id = str(uuid.uuid4())
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO retrieval_eval_runs (id,organization_id,project_id,case_count,precision_at_3,"
                "recall_at_5,hit_rate,details,ran_by,ran_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (run_id, org, project_id, len(cases), p_avg, r_avg, hit_rate,
                 json.dumps(details, ensure_ascii=False), ran_by, now),
            )
        return {
            "runId": run_id, "caseCount": len(cases), "validCases": valid,
            "precisionAt3": p_avg, "recallAt5": r_avg, "hitRate": hit_rate,
            "details": details, "ranAt": now,
        }

    def list_eval_runs(self, org: str, limit: int = 20) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id,project_id,case_count,precision_at_3,recall_at_5,hit_rate,ran_by,ran_at "
                "FROM retrieval_eval_runs WHERE organization_id=? ORDER BY ran_at DESC LIMIT ?",
                (org, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    # ── AI Approval Queue ─────────────────────────────────────────────────────

    _APPROVAL_TTL_HOURS = 72

    def propose_ai_action(self, org: str, proposed_by: str, action_type: str,
                          action_payload: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any]:
        """Create an approval request for a proposed AI mutation."""
        if not action_type.strip():
            raise ValueError("action_type is required")
        approval_id = str(uuid.uuid4())
        now = utc_now()
        expires = (datetime.now(timezone.utc) + timedelta(hours=self._APPROVAL_TTL_HOURS)).isoformat()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO ai_approvals (id,organization_id,proposed_by,action_type,"
                "action_payload,evidence,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (approval_id, org, proposed_by, action_type,
                 json.dumps(action_payload, ensure_ascii=False),
                 json.dumps(evidence, ensure_ascii=False),
                 "pending", now, expires),
            )
        self.audit(org, proposed_by, None, "ai_approval.proposed", "ai_approval", approval_id)
        return {"id": approval_id, "status": "pending", "createdAt": now, "expiresAt": expires}

    def list_ai_approvals(self, org: str, status: str | None = None) -> list[dict[str, Any]]:
        now = utc_now()
        with self._connect() as conn:
            # Expire stale pending items
            conn.execute(
                "UPDATE ai_approvals SET status='expired' WHERE organization_id=? AND status='pending' AND expires_at<=?",
                (org, now),
            )
            if status:
                rows = conn.execute(
                    "SELECT * FROM ai_approvals WHERE organization_id=? AND status=? ORDER BY created_at DESC LIMIT 100",
                    (org, status),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM ai_approvals WHERE organization_id=? ORDER BY created_at DESC LIMIT 100",
                    (org,),
                ).fetchall()
        return [self._approval_row(r) for r in rows]

    def review_ai_approval(self, org: str, approval_id: str, reviewer_id: str,
                           decision: str, note: str = "") -> dict[str, Any]:
        """decision must be 'approved' or 'rejected'."""
        if decision not in ("approved", "rejected"):
            raise ValueError("decision must be 'approved' or 'rejected'")
        now = utc_now()
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM ai_approvals WHERE id=? AND organization_id=?", (approval_id, org)
            ).fetchone()
            if not row:
                raise LookupError("Approval not found")
            if row["status"] != "pending":
                raise ValueError(f"Cannot review: approval is already '{row['status']}'")
            conn.execute(
                "UPDATE ai_approvals SET status=?,reviewed_by=?,reviewed_at=?,reviewer_note=? WHERE id=?",
                (decision, reviewer_id, now, note, approval_id),
            )
            updated = conn.execute("SELECT * FROM ai_approvals WHERE id=?", (approval_id,)).fetchone()
        self.audit(org, reviewer_id, None, f"ai_approval.{decision}", "ai_approval", approval_id)
        return self._approval_row(updated)

    @staticmethod
    def _approval_row(r: Any) -> dict[str, Any]:
        d = dict(r)
        for key in ("action_payload", "evidence"):
            try: d[key] = json.loads(d.get(key) or "{}")
            except Exception: d[key] = {}
        return d

    def expire_ai_approvals(self, org: str) -> int:
        """Expire pending approvals past their TTL. Returns count expired."""
        now = utc_now()
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE ai_approvals SET status='expired' WHERE organization_id=? AND status='pending' AND expires_at<=?",
                (org, now),
            )
        return cur.rowcount

    # ── Comments & Activity ───────────────────────────────────────────────────

    def add_comment(self, org: str, project_id: str, author_id: str | None,
                    author_name: str, body: str, parent_id: str | None = None) -> dict[str, Any]:
        body = body.strip()
        if not body:
            raise ValueError("Comment body cannot be empty")
        if len(body) > 4000:
            raise ValueError("Comment exceeds 4000 characters")
        # Verify project belongs to org
        with self._connect() as conn:
            if not conn.execute("SELECT 1 FROM projects WHERE id=? AND organization_id=?", (project_id, org)).fetchone():
                raise LookupError("Project not found")
            if parent_id and not conn.execute("SELECT 1 FROM project_comments WHERE id=? AND project_id=?", (parent_id, project_id)).fetchone():
                raise LookupError("Parent comment not found")

        # Extract @mentions (words starting with @)
        mentions = list({w[1:] for w in body.split() if w.startswith("@") and len(w) > 1})
        cmt_id = str(uuid.uuid4())
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO project_comments (id,organization_id,project_id,parent_id,author_id,author_name,body,mentions,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (cmt_id, org, project_id, parent_id, author_id, author_name, body, json.dumps(mentions), now, now),
            )
        self._record_activity(org, project_id, author_id, author_name, "comment",
                              f"{author_name or 'Someone'} добавил комментарий",
                              {"commentId": cmt_id, "preview": body[:120]})
        return {"id": cmt_id, "projectId": project_id, "parentId": parent_id,
                "authorId": author_id, "authorName": author_name, "body": body,
                "mentions": mentions, "edited": False, "deleted": False,
                "createdAt": now, "updatedAt": now}

    def list_comments(self, org: str, project_id: str, limit: int = 100) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if not conn.execute("SELECT 1 FROM projects WHERE id=? AND organization_id=?", (project_id, org)).fetchone():
                raise LookupError("Project not found")
            rows = conn.execute(
                "SELECT id,parent_id,author_id,author_name,body,mentions,edited,deleted,created_at,updated_at "
                "FROM project_comments WHERE organization_id=? AND project_id=? "
                "ORDER BY created_at ASC LIMIT ?",
                (org, project_id, limit),
            ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            try: d["mentions"] = json.loads(d.get("mentions") or "[]")
            except Exception: d["mentions"] = []
            if d.get("deleted"): d["body"] = ""  # redact deleted body
            result.append(d)
        return result

    def delete_comment(self, org: str, comment_id: str, requester_id: str | None) -> bool:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM project_comments WHERE id=? AND organization_id=?", (comment_id, org)).fetchone()
            if not row: return False
            conn.execute("UPDATE project_comments SET deleted=1,body='',updated_at=? WHERE id=?",
                         (utc_now(), comment_id))
        return True

    def list_activity(self, org: str, project_id: str, limit: int = 50) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id,actor_id,actor_name,event_type,summary,payload,created_at "
                "FROM project_activity WHERE organization_id=? AND project_id=? "
                "ORDER BY created_at DESC LIMIT ?",
                (org, project_id, limit),
            ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            try: d["payload"] = json.loads(d.get("payload") or "{}")
            except Exception: d["payload"] = {}
            result.append(d)
        return result

    def _record_activity(self, org: str, project_id: str, actor_id: str | None,
                         actor_name: str, event_type: str, summary: str,
                         payload: dict[str, Any] | None = None) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO project_activity (id,organization_id,project_id,actor_id,actor_name,event_type,summary,payload,created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (str(uuid.uuid4()), org, project_id, actor_id, actor_name,
                 event_type, summary, json.dumps(payload or {}, ensure_ascii=False), utc_now()),
            )

    # ── Team Members ─────────────────────────────────────────────────────────

    _VALID_AVAILABILITY = frozenset({"available", "busy", "off"})

    def create_team_member(self, org: str, payload: dict[str, Any]) -> dict[str, Any]:
        name = str(payload.get("name", "")).strip()
        if not name: raise ValueError("name is required")
        member_id = str(uuid.uuid4())
        now = utc_now()
        skills = payload.get("skills", [])
        if not isinstance(skills, list): skills = []
        availability = payload.get("availability", "available")
        if availability not in self._VALID_AVAILABILITY: availability = "available"
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO team_members (id,organization_id,user_id,name,email,role,trade,skills,phone,availability,notes,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (member_id, org, payload.get("userId"), name,
                 str(payload.get("email",""))[:200], str(payload.get("role","Technician"))[:50],
                 str(payload.get("trade",""))[:100], json.dumps(skills),
                 str(payload.get("phone",""))[:50], availability,
                 str(payload.get("notes",""))[:500], now, now),
            )
        return self._member_row({"id": member_id, "organization_id": org,
            "user_id": payload.get("userId"), "name": name,
            "email": payload.get("email",""), "role": payload.get("role","Technician"),
            "trade": payload.get("trade",""), "skills": json.dumps(skills),
            "phone": payload.get("phone",""), "availability": availability,
            "notes": payload.get("notes",""), "created_at": now, "updated_at": now})

    def update_team_member(self, org: str, member_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM team_members WHERE id=? AND organization_id=?", (member_id, org)).fetchone()
            if not row: raise LookupError("Team member not found")
            now = utc_now()
            skills = payload.get("skills", json.loads(row["skills"] or "[]"))
            if not isinstance(skills, list): skills = []
            availability = payload.get("availability", row["availability"])
            if availability not in self._VALID_AVAILABILITY: availability = row["availability"]
            conn.execute(
                "UPDATE team_members SET name=?,email=?,role=?,trade=?,skills=?,phone=?,availability=?,notes=?,updated_at=? WHERE id=?",
                (str(payload.get("name", row["name"])).strip() or row["name"],
                 str(payload.get("email", row["email"]))[:200],
                 str(payload.get("role", row["role"]))[:50],
                 str(payload.get("trade", row["trade"]))[:100],
                 json.dumps(skills),
                 str(payload.get("phone", row["phone"]))[:50],
                 availability,
                 str(payload.get("notes", row["notes"]))[:500],
                 now, member_id),
            )
            updated = conn.execute("SELECT * FROM team_members WHERE id=?", (member_id,)).fetchone()
        return self._member_row(updated)

    def delete_team_member(self, org: str, member_id: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM team_members WHERE id=? AND organization_id=?", (member_id, org))
        return cur.rowcount > 0

    def list_team_members(self, org: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT m.*, COUNT(DISTINCT a.project_id) as project_count "
                "FROM team_members m LEFT JOIN project_assignments a ON a.member_id=m.id "
                "WHERE m.organization_id=? GROUP BY m.id ORDER BY m.name",
                (org,),
            ).fetchall()
        return [self._member_row(r) for r in rows]

    def get_team_member(self, org: str, member_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM team_members WHERE id=? AND organization_id=?", (member_id, org)).fetchone()
        return self._member_row(row) if row else None

    @staticmethod
    def _member_row(r: Any) -> dict[str, Any]:
        d = dict(r)
        try: d["skills"] = json.loads(d.get("skills") or "[]")
        except Exception: d["skills"] = []
        return d

    def assign_member(self, org: str, project_id: str, member_id: str, role_on_project: str = "") -> dict[str, Any]:
        # Verify project exists in org
        with self._connect() as conn:
            if not conn.execute("SELECT 1 FROM projects WHERE id=? AND organization_id=?", (project_id, org)).fetchone():
                raise LookupError("Project not found")
            if not conn.execute("SELECT 1 FROM team_members WHERE id=? AND organization_id=?", (member_id, org)).fetchone():
                raise LookupError("Team member not found")
            asgn_id = str(uuid.uuid4())
            now = utc_now()
            conn.execute(
                "INSERT OR REPLACE INTO project_assignments (id,organization_id,project_id,member_id,role_on_project,assigned_at) "
                "VALUES (?,?,?,?,?,?)",
                (asgn_id, org, project_id, member_id, role_on_project[:100], now),
            )
        return {"id": asgn_id, "projectId": project_id, "memberId": member_id,
                "roleOnProject": role_on_project, "assignedAt": now}

    def remove_assignment(self, org: str, project_id: str, member_id: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM project_assignments WHERE organization_id=? AND project_id=? AND member_id=?",
                (org, project_id, member_id),
            )
        return cur.rowcount > 0

    def list_project_assignments(self, org: str, project_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT a.id, a.project_id, a.member_id, a.role_on_project, a.assigned_at, "
                "m.name, m.trade, m.availability, m.skills "
                "FROM project_assignments a JOIN team_members m ON m.id=a.member_id "
                "WHERE a.organization_id=? AND a.project_id=? ORDER BY m.name",
                (org, project_id),
            ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            try: d["skills"] = json.loads(d.get("skills") or "[]")
            except Exception: d["skills"] = []
            result.append(d)
        return result

    # ── Team Presence ─────────────────────────────────────────────────────────

    def upsert_presence(self, org: str, project_id: str, member_id: str, presence_date: str,
                        check_in: str | None = None, check_out: str | None = None,
                        notes: str = "", recorded_by: str | None = None) -> dict[str, Any]:
        now = utc_now()
        rec_id = str(uuid.uuid4())
        with self._connect() as conn:
            existing = conn.execute(
                "SELECT id FROM team_presence WHERE organization_id=? AND project_id=? AND member_id=? AND presence_date=?",
                (org, project_id, member_id, presence_date),
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE team_presence SET check_in=?,check_out=?,notes=?,updated_at=? WHERE id=?",
                    (check_in, check_out, notes, now, existing["id"]),
                )
                rec_id = existing["id"]
            else:
                conn.execute(
                    "INSERT INTO team_presence (id,organization_id,project_id,member_id,presence_date,check_in,check_out,notes,recorded_by,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (rec_id, org, project_id, member_id, presence_date, check_in, check_out, notes, recorded_by, now, now),
                )
        return {"id": rec_id, "projectId": project_id, "memberId": member_id, "presenceDate": presence_date,
                "checkIn": check_in, "checkOut": check_out}

    def list_presence(self, org: str, project_id: str, from_date: str, to_date: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT p.*, m.name as member_name, m.trade "
                "FROM team_presence p JOIN team_members m ON m.id=p.member_id "
                "WHERE p.organization_id=? AND p.project_id=? AND p.presence_date BETWEEN ? AND ? "
                "ORDER BY p.presence_date DESC, m.name",
                (org, project_id, from_date, to_date),
            ).fetchall()
        return [{"id": r["id"], "memberId": r["member_id"], "memberName": r["member_name"],
                 "trade": r["trade"], "presenceDate": r["presence_date"],
                 "checkIn": r["check_in"], "checkOut": r["check_out"], "notes": r["notes"]}
                for r in rows]

    # ── Digital Twin ─────────────────────────────────────────────────────────

    def _asset_row(self, r: sqlite3.Row) -> dict[str, Any]:
        d = dict(r)
        for k in ("attributes",):
            try: d[k] = json.loads(d.get(k) or '{}')
            except (json.JSONDecodeError, TypeError): d[k] = {}
        return d

    def get_asset(self, org: str, asset_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM dt_assets WHERE id=? AND organization_id=?", (asset_id, org)
            ).fetchone()
        return self._asset_row(row) if row else None

    def create_asset(self, org: str, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        asset_id = str(uuid.uuid4())
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO dt_assets (id,organization_id,project_id,location_id,parent_asset_id,"
                "asset_type,name,make,model,serial_number,install_date,status,attributes,notes,created_at,updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (asset_id, org, project_id,
                 payload.get("locationId"), payload.get("parentAssetId"),
                 payload.get("assetType","device"), payload.get("name",""),
                 payload.get("make",""), payload.get("model",""),
                 payload.get("serialNumber",""), payload.get("installDate"),
                 payload.get("status","planned"),
                 json.dumps(payload.get("attributes",{})), payload.get("notes",""),
                 now, now),
            )
            row = conn.execute("SELECT * FROM dt_assets WHERE id=?", (asset_id,)).fetchone()
        return self._asset_row(row)

    def update_asset(self, org: str, asset_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        now = utc_now()
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM dt_assets WHERE id=? AND organization_id=?", (asset_id, org)).fetchone()
            if not row: raise LookupError("Asset not found")
            conn.execute(
                "UPDATE dt_assets SET location_id=?,asset_type=?,name=?,make=?,model=?,"
                "serial_number=?,install_date=?,status=?,attributes=?,notes=?,updated_at=? WHERE id=?",
                (payload.get("locationId", row["location_id"]),
                 payload.get("assetType", row["asset_type"]),
                 payload.get("name", row["name"]),
                 payload.get("make", row["make"]),
                 payload.get("model", row["model"]),
                 payload.get("serialNumber", row["serial_number"]),
                 payload.get("installDate", row["install_date"]),
                 payload.get("status", row["status"]),
                 json.dumps(payload.get("attributes", json.loads(row["attributes"] or "{}"))),
                 payload.get("notes", row["notes"]),
                 now, asset_id),
            )
            updated = conn.execute("SELECT * FROM dt_assets WHERE id=?", (asset_id,)).fetchone()
        return self._asset_row(updated)

    def delete_asset(self, org: str, asset_id: str) -> None:
        with self._connect() as conn:
            row = conn.execute("SELECT id FROM dt_assets WHERE id=? AND organization_id=?", (asset_id, org)).fetchone()
            if not row: raise LookupError("Asset not found")
            conn.execute("DELETE FROM dt_assets WHERE id=?", (asset_id,))

    def list_assets(self, org: str, project_id: str | None = None,
                    location_id: str | None = None, asset_type: str | None = None) -> list[dict[str, Any]]:
        with self._connect() as conn:
            where = ["organization_id=?"]
            params: list[Any] = [org]
            if project_id: where.append("project_id=?"); params.append(project_id)
            if location_id: where.append("location_id=?"); params.append(location_id)
            if asset_type: where.append("asset_type=?"); params.append(asset_type)
            rows = conn.execute(
                f"SELECT * FROM dt_assets WHERE {' AND '.join(where)} ORDER BY name ASC", params
            ).fetchall()
        return [self._asset_row(r) for r in rows]

    def create_relationship(self, org: str, from_id: str, to_id: str,
                            relation_type: str = "connects_to", label: str = "",
                            attributes: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._connect() as conn:
            for aid in (from_id, to_id):
                if not conn.execute("SELECT 1 FROM dt_assets WHERE id=? AND organization_id=?", (aid, org)).fetchone():
                    raise LookupError(f"Asset not found: {aid}")
            rel_id = str(uuid.uuid4())
            now = utc_now()
            conn.execute(
                "INSERT OR REPLACE INTO dt_relationships (id,organization_id,from_asset_id,to_asset_id,"
                "relation_type,label,attributes,created_at) VALUES (?,?,?,?,?,?,?,?)",
                (rel_id, org, from_id, to_id, relation_type, label,
                 json.dumps(attributes or {}), now),
            )
            row = conn.execute("SELECT * FROM dt_relationships WHERE id=?", (rel_id,)).fetchone()
        return dict(row)

    def delete_relationship(self, org: str, rel_id: str) -> None:
        with self._connect() as conn:
            row = conn.execute("SELECT id FROM dt_relationships WHERE id=? AND organization_id=?", (rel_id, org)).fetchone()
            if not row: raise LookupError("Relationship not found")
            conn.execute("DELETE FROM dt_relationships WHERE id=?", (rel_id,))

    def list_relationships(self, org: str, asset_id: str | None = None) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if asset_id:
                rows = conn.execute(
                    "SELECT r.*, a1.name as from_name, a2.name as to_name "
                    "FROM dt_relationships r "
                    "JOIN dt_assets a1 ON a1.id=r.from_asset_id "
                    "JOIN dt_assets a2 ON a2.id=r.to_asset_id "
                    "WHERE r.organization_id=? AND (r.from_asset_id=? OR r.to_asset_id=?)",
                    (org, asset_id, asset_id),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT r.*, a1.name as from_name, a2.name as to_name "
                    "FROM dt_relationships r "
                    "JOIN dt_assets a1 ON a1.id=r.from_asset_id "
                    "JOIN dt_assets a2 ON a2.id=r.to_asset_id "
                    "WHERE r.organization_id=? ORDER BY r.created_at DESC",
                    (org,),
                ).fetchall()
        return [dict(r) for r in rows]

    def get_digital_twin(self, org: str, project_id: str) -> dict[str, Any]:
        """Full graph snapshot for a project: assets + typed relationships."""
        assets = self.list_assets(org, project_id=project_id)
        asset_ids = {a["id"] for a in assets}
        all_rels = self.list_relationships(org)
        rels = [r for r in all_rels if r["from_asset_id"] in asset_ids or r["to_asset_id"] in asset_ids]
        return {"assets": assets, "relationships": rels}

    # ── Service History ───────────────────────────────────────────────────────

    def add_service_event(self, org: str, asset_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        with self._connect() as conn:
            if not conn.execute("SELECT 1 FROM dt_assets WHERE id=? AND organization_id=?", (asset_id, org)).fetchone():
                raise LookupError("Asset not found")
            evt_id = str(uuid.uuid4())
            now = utc_now()
            conn.execute(
                "INSERT INTO asset_service_events (id,organization_id,asset_id,event_type,performed_by,"
                "performed_at,description,attributes,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (evt_id, org, asset_id,
                 payload.get("eventType","note"),
                 payload.get("performedBy",""),
                 payload.get("performedAt", now),
                 payload.get("description","")[:2000],
                 json.dumps(payload.get("attributes",{})),
                 now),
            )
            row = conn.execute("SELECT * FROM asset_service_events WHERE id=?", (evt_id,)).fetchone()
        d = dict(row)
        try: d["attributes"] = json.loads(d["attributes"])
        except Exception: d["attributes"] = {}
        return d

    def list_service_events(self, org: str, asset_id: str, limit: int = 50) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM asset_service_events WHERE organization_id=? AND asset_id=? "
                "ORDER BY performed_at DESC LIMIT ?", (org, asset_id, limit)
            ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            try: d["attributes"] = json.loads(d["attributes"])
            except Exception: d["attributes"] = {}
            result.append(d)
        return result

    def save_config_snapshot(self, org: str, asset_id: str, config: dict[str, Any],
                             notes: str = "", recorded_by: str = "") -> dict[str, Any]:
        with self._connect() as conn:
            if not conn.execute("SELECT 1 FROM dt_assets WHERE id=? AND organization_id=?", (asset_id, org)).fetchone():
                raise LookupError("Asset not found")
            cfg_id = str(uuid.uuid4())
            now = utc_now()
            conn.execute(
                "INSERT INTO asset_configurations (id,organization_id,asset_id,config_snapshot,"
                "notes,recorded_at,recorded_by) VALUES (?,?,?,?,?,?,?)",
                (cfg_id, org, asset_id, json.dumps(config), notes[:1000], now, recorded_by),
            )
            row = conn.execute("SELECT * FROM asset_configurations WHERE id=?", (cfg_id,)).fetchone()
        d = dict(row)
        try: d["configSnapshot"] = json.loads(d.pop("config_snapshot"))
        except Exception: d["configSnapshot"] = {}
        return d

    def list_config_snapshots(self, org: str, asset_id: str, limit: int = 20) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM asset_configurations WHERE organization_id=? AND asset_id=? "
                "ORDER BY recorded_at DESC LIMIT ?", (org, asset_id, limit)
            ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            try: d["configSnapshot"] = json.loads(d.pop("config_snapshot"))
            except Exception: d["configSnapshot"] = {}
            result.append(d)
        return result

    # ── Document Bindings (FS-025) ────────────────────────────────────────────

    def bind_object(self, org: str, object_id: str, target_type: str, target_id: str, notes: str = "") -> dict[str, Any]:
        with self._connect() as conn:
            if not conn.execute("SELECT 1 FROM objects WHERE id=? AND organization_id=?", (object_id, org)).fetchone():
                raise LookupError("Object not found")
            bind_id = str(uuid.uuid4())
            now = utc_now()
            conn.execute(
                "INSERT OR REPLACE INTO object_bindings (id,organization_id,object_id,target_type,target_id,notes,created_at)"
                " VALUES (?,?,?,?,?,?,?)",
                (bind_id, org, object_id, target_type, target_id, notes[:500], now),
            )
            row = conn.execute("SELECT * FROM object_bindings WHERE object_id=? AND target_type=? AND target_id=?",
                               (object_id, target_type, target_id)).fetchone()
        return dict(row)

    def unbind_object(self, org: str, bind_id: str) -> None:
        with self._connect() as conn:
            if not conn.execute("SELECT 1 FROM object_bindings WHERE id=? AND organization_id=?", (bind_id, org)).fetchone():
                raise LookupError("Binding not found")
            conn.execute("DELETE FROM object_bindings WHERE id=?", (bind_id,))

    def list_bindings_for_target(self, org: str, target_type: str, target_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT b.*, o.name as object_name, o.mime_type, o.size_bytes "
                "FROM object_bindings b JOIN objects o ON o.id=b.object_id "
                "WHERE b.organization_id=? AND b.target_type=? AND b.target_id=?",
                (org, target_type, target_id),
            ).fetchall()
        return [dict(r) for r in rows]

    def list_bindings_for_object(self, org: str, object_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM object_bindings WHERE organization_id=? AND object_id=?",
                (org, object_id),
            ).fetchall()
        return [dict(r) for r in rows]

    # ── Time Tracking ────────────────────────────────────────────────────────

    def start_session(self, org: str, member_id: str, project_id: str,
                      work_type_id: str | None = None, notes: str = "") -> dict[str, Any]:
        with self._connect() as conn:
            if not conn.execute("SELECT 1 FROM team_members WHERE id=? AND organization_id=?", (member_id, org)).fetchone():
                raise LookupError("Team member not found")
            # Close any open session for this member first
            open_sess = conn.execute(
                "SELECT id FROM time_sessions WHERE member_id=? AND ended_at IS NULL", (member_id,)
            ).fetchone()
            if open_sess:
                now_end = utc_now()
                conn.execute("UPDATE time_sessions SET ended_at=?,updated_at=? WHERE id=?",
                             (now_end, now_end, open_sess["id"]))
            sess_id = str(uuid.uuid4())
            now = utc_now()
            conn.execute(
                "INSERT INTO time_sessions (id,organization_id,member_id,project_id,work_type_id,"
                "started_at,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (sess_id, org, member_id, project_id, work_type_id, now, notes[:500], now, now),
            )
        return {"id": sess_id, "memberId": member_id, "projectId": project_id, "startedAt": now, "status": "open"}

    def end_session(self, org: str, session_id: str, notes: str = "") -> dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM time_sessions WHERE id=? AND organization_id=?", (session_id, org)
            ).fetchone()
            if not row: raise LookupError("Session not found")
            if row["ended_at"]: raise ValueError("Session already ended")
            now = utc_now()
            started = datetime.fromisoformat(row["started_at"])
            duration = max(1, int((datetime.fromisoformat(now) - started).total_seconds() / 60))
            conn.execute(
                "UPDATE time_sessions SET ended_at=?,duration_min=?,notes=?,updated_at=? WHERE id=?",
                (now, duration, notes[:500] or row["notes"], now, session_id),
            )
            updated = conn.execute("SELECT * FROM time_sessions WHERE id=?", (session_id,)).fetchone()
        return dict(updated)

    def log_time(self, org: str, member_id: str, project_id: str,
                 duration_min: int, started_at: str, notes: str = "",
                 work_type_id: str | None = None) -> dict[str, Any]:
        """Manually log a completed time block."""
        if duration_min < 1 or duration_min > 1440:
            raise ValueError("duration_min must be between 1 and 1440")
        sess_id = str(uuid.uuid4())
        now = utc_now()
        ended_at = started_at  # same minute — manual entry
        with self._connect() as conn:
            if not conn.execute("SELECT 1 FROM team_members WHERE id=? AND organization_id=?", (member_id, org)).fetchone():
                raise LookupError("Team member not found")
            conn.execute(
                "INSERT INTO time_sessions (id,organization_id,member_id,project_id,work_type_id,"
                "started_at,ended_at,duration_min,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (sess_id, org, member_id, project_id, work_type_id,
                 started_at, ended_at, duration_min, notes[:500], now, now),
            )
        return {"id": sess_id, "memberId": member_id, "projectId": project_id,
                "durationMin": duration_min, "startedAt": started_at, "loggedAt": now}

    def list_time_sessions(self, org: str, member_id: str | None = None,
                           project_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        with self._connect() as conn:
            where = ["t.organization_id=?"]
            params: list[Any] = [org]
            if member_id: where.append("t.member_id=?"); params.append(member_id)
            if project_id: where.append("t.project_id=?"); params.append(project_id)
            params.append(limit)
            rows = conn.execute(
                f"SELECT t.*, m.name as member_name FROM time_sessions t "
                f"JOIN team_members m ON m.id=t.member_id "
                f"WHERE {' AND '.join(where)} ORDER BY t.started_at DESC LIMIT ?",
                params,
            ).fetchall()
        return [dict(r) for r in rows]

    def get_member_utilization(self, org: str, days: int = 30) -> list[dict[str, Any]]:
        """Per-member total hours and project breakdown for the last N days."""
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT m.id, m.name, m.trade, m.availability, "
                "COUNT(t.id) as session_count, "
                "COALESCE(SUM(t.duration_min),0) as total_min "
                "FROM team_members m "
                "LEFT JOIN time_sessions t ON t.member_id=m.id AND t.started_at>=? AND t.organization_id=? "
                "WHERE m.organization_id=? "
                "GROUP BY m.id ORDER BY total_min DESC",
                (since, org, org),
            ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["totalHours"] = round(d["total_min"] / 60, 1)
            result.append(d)
        return result

    def approve_session(self, org: str, session_id: str, approver_id: str) -> dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM time_sessions WHERE id=? AND organization_id=?", (session_id, org)).fetchone()
            if not row: raise LookupError("Session not found")
            now = utc_now()
            conn.execute("UPDATE time_sessions SET approved=1,approved_by=?,updated_at=? WHERE id=?",
                         (approver_id, now, session_id))
            updated = conn.execute("SELECT * FROM time_sessions WHERE id=?", (session_id,)).fetchone()
        return dict(updated)

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

    # ── MFA ──────────────────────────────────────────────────────────────────

    def get_mfa_status(self, user_id: str) -> dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM mfa_credentials WHERE user_id=?", (user_id,)).fetchone()
            if not row:
                return {"enabled": False, "enrolled": False}
            backup_count = conn.execute(
                "SELECT COUNT(*) AS n FROM mfa_backup_codes WHERE user_id=? AND used=0", (user_id,)
            ).fetchone()["n"]
        return {"enabled": bool(row["enabled"]), "enrolled": True, "backupCodesRemaining": backup_count}

    def mfa_begin_enrollment(self, user_id: str, email: str) -> dict[str, Any]:
        """Generate a new TOTP secret, store it (disabled), return URI for QR."""
        secret = _totp_new_secret()
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO mfa_credentials (user_id,totp_secret,enabled,updated_at) VALUES (?,?,0,?)",
                (user_id, secret, now),
            )
        uri = _totp_uri(secret, email)
        return {"secret": secret, "uri": uri}

    def mfa_confirm_enrollment(self, user_id: str, code: str) -> list[str] | None:
        """Verify TOTP code to activate MFA. Returns backup codes on success."""
        with self._connect() as conn:
            row = conn.execute("SELECT totp_secret FROM mfa_credentials WHERE user_id=?", (user_id,)).fetchone()
            if not row or not _totp_verify(row["totp_secret"], code):
                return None
            now = utc_now()
            conn.execute("UPDATE mfa_credentials SET enabled=1,enrolled_at=?,updated_at=? WHERE user_id=?", (now, now, user_id))
            # Generate 8 one-time backup codes
            conn.execute("DELETE FROM mfa_backup_codes WHERE user_id=?", (user_id,))
            plain_codes: list[str] = []
            for _ in range(8):
                plain = secrets.token_hex(4).upper()  # e.g. "A3F2B1C4"
                code_hash = hashlib.sha256(plain.encode()).hexdigest()
                conn.execute(
                    "INSERT INTO mfa_backup_codes (id,user_id,code_hash,used,created_at) VALUES (?,?,?,0,?)",
                    (str(uuid.uuid4()), user_id, code_hash, now),
                )
                plain_codes.append(plain)
        return plain_codes

    def mfa_disable(self, user_id: str) -> None:
        with self._connect() as conn:
            conn.execute("UPDATE mfa_credentials SET enabled=0,updated_at=? WHERE user_id=?", (utc_now(), user_id))

    def _mfa_use_backup(self, user_id: str, plain: str) -> bool:
        code_hash = hashlib.sha256(plain.strip().upper().encode()).hexdigest()
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id FROM mfa_backup_codes WHERE user_id=? AND code_hash=? AND used=0", (user_id, code_hash)
            ).fetchone()
            if not row:
                return False
            conn.execute("UPDATE mfa_backup_codes SET used=1 WHERE id=?", (row["id"],))
        return True

    def login(self, email: str, password: str,
               ip_address: str | None = None, user_agent: str | None = None) -> dict[str, Any] | None:
        """Returns None on bad credentials, or session dict.
        If MFA is required returns {mfaRequired: True, challengeToken: ...} instead."""
        with self._connect() as conn:
            user = conn.execute(
                "SELECT u.id, u.display_name, m.organization_id, m.role "
                "FROM users u JOIN memberships m ON m.user_id = u.id "
                "WHERE u.email = ? AND m.status = 'active' LIMIT 1",
                (email,),
            ).fetchone()
            if not user:
                return None
            cred = conn.execute("SELECT password_hash FROM password_credentials WHERE user_id=?", (user["id"],)).fetchone()
            if not cred or not _verify_password(password, cred["password_hash"]):
                return None
            mfa_row = conn.execute("SELECT totp_secret,enabled FROM mfa_credentials WHERE user_id=?", (user["id"],)).fetchone()

        if mfa_row and mfa_row["enabled"]:
            # Issue a short-lived challenge token instead of a full session
            challenge_token = secrets.token_urlsafe(24)
            token_hash = _hash_token(challenge_token)
            expires = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO mfa_challenges (token_hash,user_id,org_id,role,expires_at) VALUES (?,?,?,?,?)",
                    (token_hash, user["id"], user["organization_id"], user["role"], expires),
                )
            return {"mfaRequired": True, "challengeToken": challenge_token,
                    "user": {"id": user["id"], "displayName": user["display_name"], "email": email}}

        return self._create_session(user, email, ip_address=ip_address, user_agent=user_agent)

    def verify_mfa_challenge(self, challenge_token: str, code: str) -> dict[str, Any] | None:
        """Verify TOTP or backup code against challenge. Returns full session on success."""
        token_hash = _hash_token(challenge_token)
        with self._connect() as conn:
            ch = conn.execute(
                "SELECT * FROM mfa_challenges WHERE token_hash=? AND expires_at>?",
                (token_hash, utc_now()),
            ).fetchone()
            if not ch:
                return None
            mfa = conn.execute("SELECT totp_secret FROM mfa_credentials WHERE user_id=?", (ch["user_id"],)).fetchone()
            if not mfa:
                return None
            # Accept TOTP or backup code
            if not _totp_verify(mfa["totp_secret"], code) and not self._mfa_use_backup(ch["user_id"], code):
                return None
            conn.execute("DELETE FROM mfa_challenges WHERE token_hash=?", (token_hash,))
            user = conn.execute(
                "SELECT u.id, u.display_name, u.email, m.organization_id, m.role "
                "FROM users u JOIN memberships m ON m.user_id = u.id "
                "WHERE u.id = ? AND m.status = 'active' LIMIT 1",
                (ch["user_id"],),
            ).fetchone()
        if not user:
            return None
        return self._create_session(user, user["email"])

    def _create_session(self, user: Any, email: str,
                         ip_address: str | None = None, user_agent: str | None = None) -> dict[str, Any]:
        token = secrets.token_urlsafe(32)
        token_hash = _hash_token(token)
        now = utc_now()
        expires = datetime.fromtimestamp(time.time() + SESSION_TTL_SECONDS, tz=timezone.utc).isoformat()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO sessions (token_hash,user_id,organization_id,role,created_at,expires_at,last_seen_at,ip_address,user_agent) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (token_hash, user["id"], user["organization_id"], user["role"], now, expires, now,
                 ip_address, (user_agent or "")[:200]),
            )
        return {
            "token": token,
            "user": {"id": user["id"], "displayName": user["display_name"], "email": email},
            "organizationId": user["organization_id"],
            "role": user["role"],
            "expiresAt": expires,
        }


# ── TOTP MFA (RFC 6238, stdlib only) ─────────────────────────────────────────

import base64
import struct


def _totp_generate(secret_b32: str, t: int | None = None, digits: int = 6, step: int = 30) -> str:
    """Compute TOTP code from base32 secret at time t (default=now)."""
    key = base64.b32decode(secret_b32.upper().replace(" ", "").replace("-", ""))
    counter = int((t or time.time()) // step)
    msg = struct.pack(">Q", counter)
    h = hmac.new(key, msg, "sha1").digest()
    offset = h[-1] & 0x0F
    value = struct.unpack(">I", h[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % (10 ** digits)).zfill(digits)


def _totp_verify(secret_b32: str, code: str, window: int = 1) -> bool:
    """Verify TOTP code; allow ±window time steps to handle clock skew."""
    code = code.strip().replace(" ", "")
    if not code.isdigit() or len(code) != 6:
        return False
    now = int(time.time() // 30)
    for delta in range(-window, window + 1):
        if hmac.compare_digest(_totp_generate(secret_b32, (now + delta) * 30), code):
            return True
    return False


def _totp_new_secret() -> str:
    """Generate a new cryptographically random base32 TOTP secret (20 bytes = 160 bits)."""
    raw = secrets.token_bytes(20)
    return base64.b32encode(raw).decode()


def _totp_uri(secret_b32: str, email: str, issuer: str = "RackPilot") -> str:
    from urllib.parse import quote
    return (f"otpauth://totp/{quote(issuer)}:{quote(email)}"
            f"?secret={secret_b32}&issuer={quote(issuer)}&algorithm=SHA1&digits=6&period=30")


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

    def complete(self, prompt: str, *, org: str = DEFAULT_ORGANIZATION_ID,
                  max_tokens: int = 500, purpose: str = "general") -> str | None:
        """Convenience wrapper: single user message → text response."""
        try:
            result = self.call(purpose=purpose,
                               messages=[{"role": "user", "content": prompt}],
                               org=org, max_tokens=max_tokens)
            return result.get("text")
        except Exception:
            return None

    def vision(self, *, image_b64: str, media_type: str, prompt: str,
                org: str = DEFAULT_ORGANIZATION_ID,
                max_tokens: int = 512, purpose: str = "vision") -> str | None:
        """Send image + prompt to vision-capable model. Returns text or None."""
        t0 = time.perf_counter()
        with self.store._connect() as conn:
            prow = conn.execute(
                "SELECT * FROM ai_providers WHERE enabled=1 ORDER BY priority DESC LIMIT 1"
            ).fetchone()
        use_model = (prow["model"] if prow else None) or "claude-sonnet-4-6"
        # Vision requires a model that supports it — prefer sonnet/opus over haiku
        if "haiku" in use_model:
            use_model = "claude-sonnet-4-6"
        api_key = (self._get_api_key(prow) if prow else None) or os.environ.get("ANTHROPIC_API_KEY", "")
        if not api_key:
            return None
        pid = prow["id"] if prow else None
        try:
            result = _anthropic_vision(api_key, use_model, image_b64, media_type, prompt, max_tokens)
            latency = int((time.perf_counter() - t0) * 1000)
            self._log_request(pid, org, None, purpose, use_model,
                              result["prompt_tokens"], result["completion_tokens"], latency, "ok")
            return result.get("text")
        except Exception as err:
            latency = int((time.perf_counter() - t0) * 1000)
            self._log_request(pid, org, None, purpose, use_model, 0, 0, latency, "error", str(err)[:500])
            return None

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


def _anthropic_vision(api_key: str, model: str, image_b64: str,
                       media_type: str, prompt: str, max_tokens: int = 512) -> dict[str, Any]:
    """Send image + text to Anthropic vision endpoint (claude-* models support base64 images)."""
    messages = [{
        "role": "user",
        "content": [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": image_b64,
                },
            },
            {"type": "text", "text": prompt},
        ],
    }]
    body = json.dumps({"model": model, "max_tokens": max_tokens, "messages": messages}).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
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

    # SLO targets — tunable constants
    SLO_AVAILABILITY = 99.5   # % of non-5xx responses
    SLO_P95_MS = 500.0        # p95 latency budget ms
    SLO_ERROR_RATE = 1.0      # max % 4xx+5xx

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            events = list(self._events)
        durations = sorted(float(event["durationMs"]) for event in events)
        count = len(events)
        status_counts = Counter(str(event["status"]) for event in events)
        method_counts = Counter(str(event["method"]) for event in events)
        route_counts = Counter(str(event["route"]) for event in events)
        p95_index = max(0, min(count - 1, int(count * 0.95) - 1)) if count else 0
        avg_ms = round(sum(durations) / count, 2) if count else 0
        p95_ms = round(durations[p95_index], 2) if count else 0
        error_count = sum(1 for e in events if int(e["status"]) >= 400)
        server_error_count = sum(1 for e in events if int(e["status"]) >= 500)
        error_rate = round(100.0 * error_count / count, 2) if count else 0.0
        availability = round(100.0 * (count - server_error_count) / count, 2) if count else 100.0

        # SLO status
        slos = [
            {
                "name": "Availability",
                "target": f"{self.SLO_AVAILABILITY}%",
                "current": f"{availability}%",
                "ok": availability >= self.SLO_AVAILABILITY,
            },
            {
                "name": "P95 latency",
                "target": f"≤{self.SLO_P95_MS}ms",
                "current": f"{p95_ms}ms",
                "ok": p95_ms <= self.SLO_P95_MS or count == 0,
            },
            {
                "name": "Error rate",
                "target": f"≤{self.SLO_ERROR_RATE}%",
                "current": f"{error_rate}%",
                "ok": error_rate <= self.SLO_ERROR_RATE or count == 0,
            },
        ]
        return {
            "requestCount": count,
            "averageMs": avg_ms,
            "p95Ms": p95_ms,
            "errorCount": error_count,
            "errorRate": error_rate,
            "availability": availability,
            "statusCounts": dict(sorted(status_counts.items())),
            "methodCounts": dict(sorted(method_counts.items())),
            "topRoutes": [{"route": route, "count": value} for route, value in route_counts.most_common(8)],
            "recent": list(reversed(events[-80:])),
            "updatedAt": utc_now(),
            "retention": self.retention,
            "slos": slos,
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


class _RateLimiter:
    """Token-bucket per-IP rate limiter. stdlib only, thread-safe."""
    def __init__(self, requests_per_minute: int = 120, burst: int = 30) -> None:
        self._rpm = requests_per_minute
        self._burst = burst
        self._buckets: dict[str, tuple[float, float]] = {}  # ip → (tokens, last_refill_ts)
        self._lock = threading.Lock()

    def allow(self, ip: str) -> bool:
        now = time.monotonic()
        with self._lock:
            tokens, last = self._buckets.get(ip, (float(self._burst), now))
            elapsed = now - last
            tokens = min(self._burst, tokens + elapsed * (self._rpm / 60.0))
            if tokens < 1.0:
                self._buckets[ip] = (tokens, now)
                return False
            self._buckets[ip] = (tokens - 1.0, now)
            return True

    def cleanup(self) -> None:
        """Drop stale buckets (full buckets older than 10 min)."""
        now = time.monotonic()
        with self._lock:
            self._buckets = {
                ip: (t, ts) for ip, (t, ts) in self._buckets.items()
                if now - ts < 600
            }


_RATE_LIMITER = _RateLimiter(requests_per_minute=120, burst=30)


class _RateLimited(Exception):
    """Raised after a 429 response is sent so the handler exits cleanly."""


class FieldOSHandler(BaseHTTPRequestHandler):
    server_version = "RackPilot/0.33"

    @property
    def store(self) -> WorkspaceStore:
        return self.server.store  # type: ignore[attr-defined]

    def do_GET(self) -> None:
        try:
            self._start_request()
        except _RateLimited:
            return
        path = urlparse(self.path).path
        if path in {"/api/health", "/api/v1/health"}:
            self._json(HTTPStatus.OK, {"status": "ok", "service": "rackpilot-local", "apiVersion": "v1", "schemaVersion": self.store.migration_result.current_version, "time": utc_now()})
            return
        if path == "/api/v1/auth/me":
            if not self.session_context:
                self._error(HTTPStatus.UNAUTHORIZED, "unauthenticated", "No active session")
                return
            sess = self.session_context
            mfa_status = self.store.get_mfa_status(sess["userId"])
            self._json(HTTPStatus.OK, {"user": sess, "mfa": mfa_status})
            return
        if path == "/api/v1/auth/mfa/status":
            if not self.session_context:
                self._error(HTTPStatus.UNAUTHORIZED, "unauthenticated", "No active session"); return
            self._json(HTTPStatus.OK, {"mfa": self.store.get_mfa_status(self.session_context["userId"])})
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
        if path == "/api/v1/admin/runbooks":
            if not self._require_permission("adminPanel"): return
            self._json(HTTPStatus.OK, {"runbooks": _RUNBOOKS})
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
        if path == "/api/v1/admin/retrieval-eval":
            if not self._require_permission("adminPanel"): return
            cases = self.store.list_eval_cases(self.organization_id)
            runs = self.store.list_eval_runs(self.organization_id)
            self._json(HTTPStatus.OK, {"cases": cases, "runs": runs})
            return
        if path == "/api/v1/admin/ai-approvals":
            if not self._require_permission("adminPanel"): return
            status_filter = self.query_params.get("status", [None])[0]
            approvals = self.store.list_ai_approvals(self.organization_id, status_filter)
            self._json(HTTPStatus.OK, {"approvals": approvals})
            return
        # Knowledge search: GET /api/v1/knowledge/search?q=&projectId=&limit=
        if path == "/api/v1/knowledge/search":
            if not self._require_permission("projectRead"): return
            q = self.query_params.get("q", [""])[0].strip()
            project_id = self.query_params.get("projectId", [None])[0]
            limit = min(int(self.query_params.get("limit", ["10"])[0]), 50)
            ctx = self.session_context or {}
            user_id = ctx.get("userId")
            user_role = ctx.get("role","")
            # Derive per-user project scope (None = org-wide for admins)
            allowed = self.store.get_user_allowed_projects(self.organization_id, user_id) if user_id else []
            results = self.store.search_knowledge(
                self.organization_id, q, project_id,
                allowed_project_ids=allowed, limit=limit,
                user_id=user_id, user_role=user_role,
            )
            self._json(HTTPStatus.OK, {"results": results})
            return
        # Retrieval audit log: GET /api/v1/knowledge/log
        if path == "/api/v1/knowledge/log":
            if not self._require_permission("adminPanel"): return
            limit = min(int(self.query_params.get("limit", ["50"])[0]), 200)
            self._json(HTTPStatus.OK, {"log": self.store.list_retrieval_log(self.organization_id, limit)})
            return
        # Service history: GET /api/v1/assets/:id/service, GET /api/v1/assets/:id/configs
        if path.startswith("/api/v1/assets/") and parts[-1] == "service":
            if not self._require_permission("projectRead"): return
            asset_id = parts[-2]
            self._json(HTTPStatus.OK, {"events": self.store.list_service_events(self.organization_id, asset_id)})
            return
        if path.startswith("/api/v1/assets/") and parts[-1] == "configs":
            if not self._require_permission("projectRead"): return
            asset_id = parts[-2]
            self._json(HTTPStatus.OK, {"snapshots": self.store.list_config_snapshots(self.organization_id, asset_id)})
            return
        # Object bindings: GET /api/v1/objects/:id/bindings, GET /api/v1/bindings/:type/:id
        if path.startswith("/api/v1/objects/") and parts[-1] == "bindings":
            if not self._require_permission("projectRead"): return
            self._json(HTTPStatus.OK, {"bindings": self.store.list_bindings_for_object(self.organization_id, parts[-2])})
            return
        if path.startswith("/api/v1/bindings/") and len(parts) == 5:
            if not self._require_permission("projectRead"): return
            target_type, target_id = parts[3], parts[4]
            self._json(HTTPStatus.OK, {"documents": self.store.list_bindings_for_target(self.organization_id, target_type, target_id)})
            return
        # Digital Twin: GET /api/v1/projects/:id/twin, GET /api/v1/assets, GET /api/v1/assets/:id/relationships
        if len(parts) == 5 and parts[3] == "projects" and parts[5] == "twin":
            if not self._require_permission("projectRead"): return
            project_id = parts[4]
            self._json(HTTPStatus.OK, self.store.get_digital_twin(self.organization_id, project_id))
            return
        if path == "/api/v1/assets":
            if not self._require_permission("projectRead"): return
            project_id = self.query_params.get("projectId", [None])[0]
            location_id = self.query_params.get("locationId", [None])[0]
            asset_type = self.query_params.get("assetType", [None])[0]
            self._json(HTTPStatus.OK, {"assets": self.store.list_assets(self.organization_id, project_id, location_id, asset_type)})
            return
        if path.startswith("/api/v1/assets/") and parts[-1] == "relationships":
            if not self._require_permission("projectRead"): return
            self._json(HTTPStatus.OK, {"relationships": self.store.list_relationships(self.organization_id, parts[-2])})
            return
        # Time tracking: GET /api/v1/time, GET /api/v1/time/utilization
        if path == "/api/v1/time":
            if not self._require_permission("projectRead"): return
            member_id = self.query_params.get("memberId", [None])[0]
            project_id = self.query_params.get("projectId", [None])[0]
            limit = min(int(self.query_params.get("limit", ["100"])[0]), 500)
            self._json(HTTPStatus.OK, {"sessions": self.store.list_time_sessions(self.organization_id, member_id, project_id, limit)})
            return
        if path == "/api/v1/time/utilization":
            if not self._require_permission("projectRead"): return
            days = min(int(self.query_params.get("days", ["30"])[0]), 365)
            self._json(HTTPStatus.OK, {"utilization": self.store.get_member_utilization(self.organization_id, days)})
            return
        # Team members: GET /api/v1/team, GET /api/v1/team/:id
        if path == "/api/v1/team":
            if not self._require_permission("projectRead"): return
            self._json(HTTPStatus.OK, {"members": self.store.list_team_members(self.organization_id)})
            return
        if path.startswith("/api/v1/team/") and len(parts) == 3:
            if not self._require_permission("projectRead"): return
            member = self.store.get_team_member(self.organization_id, parts[2])
            if not member: self._error(HTTPStatus.NOT_FOUND, "not_found", "Team member not found"); return
            assignments = self.store.list_project_assignments(self.organization_id, None) if False else []
            self._json(HTTPStatus.OK, {"member": member})
            return
        # Project team: GET /api/v1/projects/:id/team
        if path.startswith("/api/v1/projects/") and len(parts) == 5 and parts[4] == "team":
            if not self._require_permission("projectRead"): return
            members = self.store.list_project_assignments(self.organization_id, parts[3])
            self._json(HTTPStatus.OK, {"members": members})
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
                qs = parse_qs(urlparse(self.path).query)
                q = qs.get("q", [None])[0]
                if q:
                    results = self.store.search_objects(self.organization_id, q, parts[3])
                    self._json(HTTPStatus.OK, {"results": results})
                else:
                    objects = self.store.list_objects(self.organization_id, parts[3])
                    stats = self.store.get_storage_stats(self.organization_id)
                    self._json(HTTPStatus.OK, {"objects": objects, "stats": stats})
                return
        # Comments: GET /api/v1/projects/:id/comments
        if path.startswith("/api/v1/projects/") and len(parts) == 5 and parts[4] == "comments":
            if not self._require_permission("projectRead"): return
            try:
                comments = self.store.list_comments(self.organization_id, parts[3])
                self._json(HTTPStatus.OK, {"comments": comments})
            except LookupError as err:
                self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
            return
        # Project progress history: GET /api/v1/projects/:id/progress-history?from=YYYY-MM-DD&to=YYYY-MM-DD
        if path.startswith("/api/v1/projects/") and len(parts) == 5 and parts[4] == "progress-history":
            if not self._require_permission("projectRead"): return
            qs = self._params()
            to_date = qs.get("to", utc_now()[:10])
            from_date = qs.get("from", "")
            if not from_date:
                # default: 30 days back
                from_dt = datetime.fromisoformat(to_date) - timedelta(days=30)
                from_date = from_dt.strftime("%Y-%m-%d")
            project_id = parts[3]
            try:
                result = self.store.get_progress_history(self.organization_id, project_id, from_date, to_date)
                self._json(HTTPStatus.OK, result)
            except LookupError as err:
                self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
            return
        # Project CSV report: GET /api/v1/projects/:id/report.csv
        if path_depth == 5 and parts[4] == "report.csv" and parts[2] == "projects":
            if not self._require_permission("projectRead"): return
            try:
                project_id = parts[3]
                with self.store._connect() as conn:
                    proj = conn.execute(
                        "SELECT name, code FROM projects WHERE organization_id=? AND id=?",
                        (self.organization_id, project_id)
                    ).fetchone()
                    if not proj:
                        self._error(HTTPStatus.NOT_FOUND, "not_found", "Project not found"); return
                    items = conn.execute(
                        "SELECT COALESCE(wi.code,'') as code, wi.title, wi.status, wi.priority, wi.due_date, "
                        "wi.estimated_minutes, wi.actual_minutes, wt.name as work_type, "
                        "pl.name as location, u.display_name as assignee "
                        "FROM project_work_items wi "
                        "LEFT JOIN work_types wt ON wt.id=wi.work_type_id AND wt.organization_id=wi.organization_id "
                        "LEFT JOIN project_locations pl ON pl.organization_id=wi.organization_id AND pl.id=wi.building_id "
                        "LEFT JOIN users u ON u.id=wi.assignee_user_id "
                        "WHERE wi.organization_id=? AND wi.project_id=? ORDER BY wi.code",
                        (self.organization_id, project_id)
                    ).fetchall()
                import csv, io
                out = io.StringIO()
                writer = csv.writer(out)
                writer.writerow(["Code","Title","Status","Priority","WorkType","Location","Assignee","DueDate","EstMins","ActMins"])
                for row in items:
                    writer.writerow([row["code"],row["title"],row["status"],row["priority"],
                                     row["work_type"] or "",row["location"] or "",
                                     row["assignee"] or "",
                                     row["due_date"] or "",row["estimated_minutes"] or "",
                                     row["actual_minutes"] or ""])
                filename = f"rp-{proj['code'] or project_id}-{utc_now()[:10]}.csv"
                csv_bytes = out.getvalue().encode("utf-8-sig")
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
                self.send_header("Content-Length", str(len(csv_bytes)))
                self.end_headers()
                self.wfile.write(csv_bytes)
            except Exception as err:
                self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "export_failed", str(err))
            return
        # Global search: GET /api/v1/search?q=...
        if path == "/api/v1/search":
            if not self._require_permission("projectRead"): return
            qs = self._params()
            query = qs.get("q", "").strip()[:200]
            if not query:
                self._json(HTTPStatus.OK, {"query": "", "results": []})
                return
            limit = max(5, min(50, int(qs.get("limit","20"))))
            results = self.store.global_search(self.organization_id, query, limit)
            self._json(HTTPStatus.OK, results)
            return
        # Project analytics: GET /api/v1/projects/:id/analytics
        if path_depth == 5 and parts[4] == "analytics" and parts[2] == "projects":
            if not self._require_permission("projectRead"): return
            try:
                data = self.store.get_project_analytics(self.organization_id, parts[3])
                self._json(HTTPStatus.OK, data)
            except LookupError as err:
                self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
            return
        # Team presence: GET /api/v1/projects/:id/presence?from=&to=
        if path_depth == 5 and parts[4] == "presence" and parts[2] == "projects":
            if not self._require_permission("projectRead"): return
            qs = self._params()
            project_id = parts[3]
            today = utc_now()[:10]
            from_date = qs.get("from", today)
            to_date = qs.get("to", today)
            records = self.store.list_presence(self.organization_id, project_id, from_date, to_date)
            self._json(HTTPStatus.OK, {"presence": records})
            return
        # Session management: GET /api/v1/admin/sessions
        if path == "/api/v1/admin/sessions":
            if not self._require_permission("adminPanel"): return
            sessions = self.store.list_active_sessions(self.organization_id)
            self._json(HTTPStatus.OK, {"sessions": sessions, "count": len(sessions)})
            return
        # Issues: GET /api/v1/issues?projectId=&status=&severity=
        if path == "/api/v1/issues":
            if not self._require_permission("projectRead"): return
            qs = self._params()
            issues = self.store.list_issues(
                self.organization_id,
                project_id=qs.get("projectId"),
                status=qs.get("status"),
                severity=qs.get("severity"),
            )
            self._json(HTTPStatus.OK, {"issues": issues, "total": len(issues)})
            return
        # Team workload: GET /api/v1/workload?projectId=
        if path == "/api/v1/workload":
            if not self._require_permission("projectRead"): return
            qs = self._params()
            workload = self.store.get_team_workload(self.organization_id, qs.get("projectId"))
            self._json(HTTPStatus.OK, {"workload": workload})
            return
        # Asset label SVG: GET /api/v1/assets/:id/label.svg
        # parts: ['','api','v1','assets',':id','label.svg']
        if len(parts) == 6 and parts[3] == "assets" and parts[5] == "label.svg":
            if not self._require_permission("projectRead"): return
            asset = self.store.get_asset(self.organization_id, parts[4])
            if asset is None:
                self._error(HTTPStatus.NOT_FOUND, "not_found", "Asset not found")
                return
            host = self.headers.get("Host", "localhost")
            svg = self.store._make_asset_label_svg(asset, f"http://{host}")
            body = svg.encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "image/svg+xml")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "public, max-age=3600")
            self.end_headers()
            self.wfile.write(body)
            return
        # Overdue sweep: GET /api/v1/admin/overdue-sweep
        if path == "/api/v1/admin/overdue-sweep":
            if not self._require_permission("adminRead"): return
            result = self.store.sweep_overdue_items(self.organization_id)
            self._json(HTTPStatus.OK, result)
            return
        # Email inboxes: GET /api/v1/admin/email-inboxes  and  /:id/log
        if path == "/api/v1/admin/email-inboxes":
            if not self._require_permission("adminPanel"): return
            self._json(HTTPStatus.OK, {"inboxes": self.store.list_email_inboxes(self.organization_id)})
            return
        if len(parts) == 7 and parts[3] == "admin" and parts[4] == "email-inboxes" and parts[6] == "log":
            if not self._require_permission("adminPanel"): return
            log = self.store.list_email_processed(self.organization_id, parts[5])
            self._json(HTTPStatus.OK, {"log": log})
            return
        # Inventory: GET /api/v1/inventory/warehouses|skus|stock|movements|pending
        if len(parts) >= 4 and parts[3] == "inventory":
            if not self._require_permission("projectRead"): return
            sub = parts[4] if len(parts) > 4 else ""
            org = self.organization_id
            if sub == "warehouses":
                self._json(HTTPStatus.OK, {"warehouses": self.store.list_warehouses(org)}); return
            if sub == "skus":
                cat = self.query_params.get("category",[None])[0]
                q = self.query_params.get("q",[None])[0]
                if q:
                    self._json(HTTPStatus.OK, {"skus": self.store.search_skus(org, q)}); return
                self._json(HTTPStatus.OK, {"skus": self.store.list_skus(org, cat)}); return
            if sub == "stock":
                wh = self.query_params.get("warehouseId",[None])[0]
                self._json(HTTPStatus.OK, {"stock": self.store.get_stock_levels(org, wh)}); return
            if sub == "movements":
                sku_id = self.query_params.get("skuId",[None])[0]
                wh = self.query_params.get("warehouseId",[None])[0]
                limit = int(self.query_params.get("limit",["100"])[0])
                self._json(HTTPStatus.OK, {"movements": self.store.list_movements(org, sku_id, wh, limit)}); return
            if sub == "pending":
                status = self.query_params.get("status",["pending"])[0]
                self._json(HTTPStatus.OK, {"pending": self.store.list_inventory_pending(org, status)}); return
            if sub == "reservations":
                project_id = self.query_params.get("projectId",[None])[0]
                sku_id = self.query_params.get("skuId",[None])[0]
                status = self.query_params.get("status",["active"])[0]
                self._json(HTTPStatus.OK, {
                    "reservations": self.store.list_reservations(org, project_id, sku_id, status)
                }); return
            self._error(HTTPStatus.NOT_FOUND, "not_found", "Unknown inventory route"); return
        # Budget: GET /api/v1/projects/:id/budget  and  /expenses
        if len(parts) == 6 and parts[3] == "projects" and parts[5] == "budget":
            if not self._require_permission("projectRead"): return
            try:
                self._json(HTTPStatus.OK, self.store.get_budget_summary(self.organization_id, parts[4]))
            except LookupError as err:
                self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
            return
        if len(parts) == 6 and parts[3] == "projects" and parts[5] == "expenses":
            if not self._require_permission("projectRead"): return
            self._json(HTTPStatus.OK, {"expenses": self.store.list_expenses(self.organization_id, parts[4])})
            return
        # Work item comments: GET /api/v1/work-items/:id/comments
        if len(parts) == 5 and parts[3] == "work-items" and parts[4] == "comments":
            if not self._require_permission("projectRead"): return
            self._json(HTTPStatus.OK, {"comments": self.store.list_comments(self.organization_id, parts[3])})
            return
        if len(parts) == 6 and parts[3] == "projects" and parts[5] == "work-items":
            pass  # handled in project detail
        if len(parts) == 7 and parts[3] == "projects" and parts[5] == "work-items" and parts[6] == "comments":
            if not self._require_permission("projectRead"): return
            wi_id = parts[4] if parts[3] == "projects" else parts[4]
            # route: /api/v1/projects/:pid/work-items/:wid/comments — extract wid
            wi_id = parts[6] if parts[5] == "work-items" else parts[4]
            # Correct parse: parts = ['','api','v1','projects',pid,'work-items',wid,'comments'] — len 8
            pass
        if len(parts) == 8 and parts[3] == "projects" and parts[5] == "work-items" and parts[7] == "comments":
            if not self._require_permission("projectRead"): return
            wi_id = parts[6]
            self._json(HTTPStatus.OK, {"comments": self.store.list_wi_comments(self.organization_id, wi_id)})
            return
        # Audit integrity: GET /api/v1/admin/audit-integrity
        if path == "/api/v1/admin/audit-integrity":
            if not self._require_permission("adminPanel"): return
            project_id = self.query_params.get("projectId", [None])[0]
            result = self.store.verify_audit_integrity(self.organization_id, project_id)
            self._json(HTTPStatus.OK, result)
            return
        # Org settings: GET /api/v1/admin/org-settings
        if path == "/api/v1/admin/org-settings":
            if not self._require_permission("adminPanel"): return
            self._json(HTTPStatus.OK, {"settings": self.store.get_org_settings(self.organization_id)})
            return
        # Milestones: GET /api/v1/projects/:id/milestones
        if len(parts) == 6 and parts[3] == "projects" and parts[5] == "milestones":
            if not self._require_permission("projectRead"): return
            project_id = parts[4]
            self._json(HTTPStatus.OK, {"milestones": self.store.list_milestones(self.organization_id, project_id)})
            return
        # Scheduled reports: GET /api/v1/admin/scheduled-reports
        if path == "/api/v1/admin/scheduled-reports":
            if not self._require_permission("adminRead"): return
            self._json(HTTPStatus.OK, {"reports": self.store.list_scheduled_reports(self.organization_id)})
            return
        # Templates: GET /api/v1/templates
        if path == "/api/v1/templates":
            if not self._require_permission("projectRead"): return
            self._json(HTTPStatus.OK, {"templates": self.store.list_templates(self.organization_id)})
            return
        if parts[:3] == ["", "api", "v1"] and len(parts) == 4 and parts[3] == "templates":
            pass  # handled above
        # Notifications: GET /api/v1/notifications
        if path == "/api/v1/notifications":
            if not self._require_permission("projectRead"): return
            qs = self._params()
            user_id = self.session_context.get("userId") or self.session_context.get("user_id")
            unread_only = qs.get("unread") == "true"
            notifs = self.store.list_notifications(self.organization_id, user_id, unread_only)
            unread_count = sum(1 for n in notifs if not n["read"])
            self._json(HTTPStatus.OK, {"notifications": notifs, "unreadCount": unread_count})
            return
        # Connectors: GET /api/v1/admin/connectors
        if path == "/api/v1/admin/connectors":
            if not self._require_permission("adminPanel"): return
            connectors = self.store.list_connectors(self.organization_id)
            self._json(HTTPStatus.OK, {"connectors": connectors})
            return
        # Compute jobs: GET /api/v1/admin/compute-jobs
        if path == "/api/v1/admin/compute-jobs":
            if not self._require_permission("adminPanel"): return
            qs = self._params()
            jobs = self.store.list_compute_jobs(self.organization_id, qs.get("status"), int(qs.get("limit","50")))
            self._json(HTTPStatus.OK, {"jobs": jobs})
            return
        # Service monitors: GET /api/v1/admin/monitors
        if path == "/api/v1/admin/monitors":
            if not self._require_permission("adminPanel"): return
            qs = self._params()
            monitors = self.store.list_monitors(self.organization_id, qs.get("assetId"))
            self._json(HTTPStatus.OK, {"monitors": monitors})
            return
        # Monitor events: GET /api/v1/admin/monitors/:id/events
        if path.startswith("/api/v1/admin/monitors/") and parts[-1] == "events":
            if not self._require_permission("adminPanel"): return
            events = self.store.list_monitor_events(self.organization_id, parts[-2])
            self._json(HTTPStatus.OK, {"events": events})
            return
        # Documents for entity: GET /api/v1/objects/by-entity?type=asset&id=xxx
        if path == "/api/v1/objects/by-entity":
            if not self._require_permission("projectRead"): return
            qs = self._params()
            entity_type = qs.get("type", "")
            entity_id = qs.get("id", "")
            if not entity_type or not entity_id:
                self._error(HTTPStatus.BAD_REQUEST, "missing_params", "type and id are required")
                return
            docs = self.store.list_objects_for_entity(self.organization_id, entity_type, entity_id)
            self._json(HTTPStatus.OK, {"documents": docs})
            return
        # Daily log note: GET /api/v1/projects/:id/daily-log-note?date=YYYY-MM-DD
        if path.startswith("/api/v1/projects/") and len(parts) == 5 and parts[4] == "daily-log-note":
            if not self._require_permission("projectRead"): return
            work_date = self._params().get("date", utc_now()[:10])
            with self.store._connect() as conn:
                row = conn.execute(
                    "SELECT note, updated_at FROM daily_log_notes WHERE organization_id=? AND project_id=? AND work_date=?",
                    (self.organization_id, parts[3], work_date),
                ).fetchone()
            self._json(HTTPStatus.OK, {"note": row["note"] if row else "", "updatedAt": row["updated_at"] if row else None})
            return
        # Critical path: GET /api/v1/projects/:id/critical-path
        if path.startswith("/api/v1/projects/") and len(parts) == 5 and parts[4] == "critical-path":
            if not self._require_permission("projectRead"): return
            try:
                result = self.store.calculate_critical_path(self.organization_id, parts[3])
                self._json(HTTPStatus.OK, result)
            except LookupError as err:
                self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
            return
        # Unit registry: GET /api/v1/projects/:id/units
        if path.startswith("/api/v1/projects/") and len(parts) == 5 and parts[4] == "units":
            if not self._require_permission("projectRead"): return
            project = self.store.get_project(self.organization_id, parts[3])
            if project is None:
                self._error(HTTPStatus.NOT_FOUND, "not_found", "Project not found")
                return
            flat_units = []
            for loc in project.get("locations", []):
                for unit in loc.get("units", []):
                    flat_units.append({
                        "id": unit["id"],
                        "code": unit["code"],
                        "name": unit["name"],
                        "notes": unit["notes"],
                        "version": unit["version"],
                        "locationId": loc["id"],
                        "locationName": loc["name"],
                        "customFields": unit.get("customFields", {}),
                    })
            self._json(HTTPStatus.OK, {"units": flat_units, "projectId": parts[3]})
            return
        # Field note drafts: GET /api/v1/projects/:id/notes
        if path.startswith("/api/v1/projects/") and len(parts) == 5 and parts[4] == "notes":
            if not self._require_permission("projectRead"): return
            try:
                limit = min(int(self.query_params.get("limit", ["20"])[0]), 50)
                drafts = self.store.list_field_note_drafts(self.organization_id, parts[3], limit)
                self._json(HTTPStatus.OK, {"drafts": drafts})
            except LookupError as err:
                self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
            return
        # Webhooks: GET /api/v1/webhooks
        if path == "/api/v1/webhooks":
            if not self._require_permission("adminPanel"): return
            hooks = self.store.list_webhooks(self.organization_id)
            self._json(HTTPStatus.OK, {"webhooks": hooks})
            return
        # Webhook deliveries: GET /api/v1/webhooks/:id/deliveries
        if path.startswith("/api/v1/webhooks/") and len(parts) == 5 and parts[4] == "deliveries":
            if not self._require_permission("adminPanel"): return
            limit = min(int(self.query_params.get("limit", ["30"])[0]), 100)
            deliveries = self.store.list_deliveries(self.organization_id, parts[3], limit)
            self._json(HTTPStatus.OK, {"deliveries": deliveries})
            return
        # AI status: GET /api/v1/ai/status
        if path == "/api/v1/ai/status":
            if not self._require_permission("adminPanel"): return
            config = self.store.get_ai_router_config(self.organization_id)
            router = self.store.get_ai_router(self.organization_id)
            key_set = bool(os.environ.get(config.get("env_key_var", "ANTHROPIC_API_KEY")))
            self._json(HTTPStatus.OK, {
                "config": config,
                "available": router.available,
                "key_set": key_set,
            })
            return
        # AI invocation log: GET /api/v1/ai/log
        if path == "/api/v1/ai/log":
            if not self._require_permission("adminPanel"): return
            limit = min(int(self.query_params.get("limit", ["50"])[0]), 200)
            log = self.store.list_ai_invocations(self.organization_id, limit)
            self._json(HTTPStatus.OK, {"log": log})
            return
        # Project export: GET /api/v1/projects/:id/export
        if path.startswith("/api/v1/projects/") and len(parts) == 5 and parts[4] == "export":
            if not self._require_permission("projectManage"): return
            try:
                payload = self.store.export_project(self.organization_id, parts[3])
                self._json(HTTPStatus.OK, payload)
            except LookupError as err:
                self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
            return
        # Activity: GET /api/v1/projects/:id/activity
        if path.startswith("/api/v1/projects/") and len(parts) == 5 and parts[4] == "activity":
            if not self._require_permission("projectRead"): return
            try:
                limit = min(int(self.query_params.get("limit", ["50"])[0]), 200)
                activity = self.store.list_activity(self.organization_id, parts[3], limit)
                self._json(HTTPStatus.OK, {"activity": activity})
            except LookupError as err:
                self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
            return
        # Object versions: GET /api/v1/objects/:id/versions
        if path.startswith("/api/v1/objects/") and path.endswith("/versions"):
            obj_id = path[len("/api/v1/objects/"):-len("/versions")]
            if not self._require_permission("projectRead"): return
            versions = self.store.list_object_versions(self.organization_id, obj_id)
            self._json(HTTPStatus.OK, {"versions": versions})
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
        try:
            self._start_request()
        except _RateLimited:
            return
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
        try:
            self._start_request()
        except _RateLimited:
            return
        path = urlparse(self.path).path
        parts = path.strip("/").split("/")
        if path == "/api/v1/auth/login":
            self._handle_auth_login()
            return
        if path == "/api/v1/auth/mfa/verify":
            self._handle_mfa_verify()
            return
        if path == "/api/v1/auth/mfa/enroll":
            self._handle_mfa_enroll_begin()
            return
        if path == "/api/v1/auth/mfa/confirm":
            self._handle_mfa_confirm()
            return
        if path == "/api/v1/auth/mfa/disable":
            self._handle_mfa_disable()
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
        # Service events: POST /api/v1/assets/:id/service
        if path.startswith("/api/v1/assets/") and parts[-1] == "service":
            if not self._require_permission("projectManage"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                evt = self.store.add_service_event(self.organization_id, parts[-2], payload)
                self._json(HTTPStatus.CREATED, {"event": evt})
            except (LookupError, ValueError, json.JSONDecodeError) as err:
                status = HTTPStatus.NOT_FOUND if isinstance(err, LookupError) else HTTPStatus.BAD_REQUEST
                self._error(status, "invalid_request", str(err))
            return
        # Config snapshot: POST /api/v1/assets/:id/configs
        if path.startswith("/api/v1/assets/") and parts[-1] == "configs":
            if not self._require_permission("projectManage"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                uid = (self.session_context or {}).get("userId","")
                snap = self.store.save_config_snapshot(self.organization_id, parts[-2],
                    payload.get("config",{}), payload.get("notes",""), uid)
                self._json(HTTPStatus.CREATED, {"snapshot": snap})
            except (LookupError, ValueError, json.JSONDecodeError) as err:
                status = HTTPStatus.NOT_FOUND if isinstance(err, LookupError) else HTTPStatus.BAD_REQUEST
                self._error(status, "invalid_request", str(err))
            return
        # Document bindings
        if path == "/api/v1/bindings":
            if not self._require_permission("projectManage"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                binding = self.store.bind_object(self.organization_id,
                    payload.get("objectId",""), payload.get("targetType","project"),
                    payload.get("targetId",""), payload.get("notes",""))
                self._json(HTTPStatus.CREATED, {"binding": binding})
            except (LookupError, ValueError, json.JSONDecodeError) as err:
                status = HTTPStatus.NOT_FOUND if isinstance(err, LookupError) else HTTPStatus.BAD_REQUEST
                self._error(status, "invalid_request", str(err))
            return
        if path.startswith("/api/v1/bindings/") and parts[-1] == "delete":
            if not self._require_permission("projectManage"): return
            try:
                self.store.unbind_object(self.organization_id, parts[-2])
                self._json(HTTPStatus.OK, {"ok": True})
            except LookupError as err: self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
            return
        # Digital Twin mutations
        if path == "/api/v1/assets":
            if not self._require_permission("projectManage"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict) or not payload.get("name"): raise ValueError("name required")
                asset = self.store.create_asset(self.organization_id, payload.get("projectId",""), payload)
                self._json(HTTPStatus.CREATED, {"asset": asset})
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        if path == "/api/v1/relationships":
            if not self._require_permission("projectManage"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                rel = self.store.create_relationship(self.organization_id,
                    payload.get("fromAssetId",""), payload.get("toAssetId",""),
                    payload.get("relationType","connects_to"),
                    payload.get("label",""), payload.get("attributes"))
                self._json(HTTPStatus.CREATED, {"relationship": rel})
            except (LookupError, ValueError, json.JSONDecodeError) as err:
                status = HTTPStatus.NOT_FOUND if isinstance(err, LookupError) else HTTPStatus.BAD_REQUEST
                self._error(status, "invalid_request", str(err))
            return
        # Time tracking
        if path == "/api/v1/time/log":
            if not self._require_permission("fieldProgress"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                uid = (self.session_context or {}).get("userId", "")
                result = self.store.log_time(self.organization_id,
                    payload.get("memberId", uid or ""),
                    payload.get("projectId",""),
                    int(payload.get("durationMin", 0)),
                    payload.get("startedAt", utc_now()),
                    payload.get("notes",""),
                    payload.get("workTypeId"),
                )
                self._json(HTTPStatus.CREATED, {"session": result})
            except (LookupError, ValueError, json.JSONDecodeError) as err:
                status = HTTPStatus.NOT_FOUND if isinstance(err, LookupError) else HTTPStatus.BAD_REQUEST
                self._error(status, "invalid_request", str(err))
            return
        if path == "/api/v1/time/start":
            if not self._require_permission("fieldProgress"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                result = self.store.start_session(self.organization_id,
                    payload.get("memberId",""), payload.get("projectId",""),
                    payload.get("workTypeId"), payload.get("notes",""))
                self._json(HTTPStatus.CREATED, {"session": result})
            except (LookupError, ValueError, json.JSONDecodeError) as err:
                status = HTTPStatus.NOT_FOUND if isinstance(err, LookupError) else HTTPStatus.BAD_REQUEST
                self._error(status, "invalid_request", str(err))
            return
        if path.startswith("/api/v1/time/") and parts[-1] == "end":
            if not self._require_permission("fieldProgress"): return
            session_id = parts[-2]
            try:
                payload = self._read_json()
                result = self.store.end_session(self.organization_id, session_id,
                    payload.get("notes","") if isinstance(payload, dict) else "")
                self._json(HTTPStatus.OK, {"session": result})
            except (LookupError, ValueError, json.JSONDecodeError) as err:
                status = HTTPStatus.NOT_FOUND if isinstance(err, LookupError) else HTTPStatus.BAD_REQUEST
                self._error(status, "invalid_request", str(err))
            return
        if path.startswith("/api/v1/time/") and parts[-1] == "approve":
            if not self._require_permission("projectManage"): return
            session_id = parts[-2]
            try:
                uid = (self.session_context or {}).get("userId","")
                if not uid: self._error(HTTPStatus.UNAUTHORIZED, "auth_required", "Must be authenticated"); return
                result = self.store.approve_session(self.organization_id, session_id, uid)
                self._json(HTTPStatus.OK, {"session": result})
            except (LookupError, ValueError) as err:
                status = HTTPStatus.NOT_FOUND if isinstance(err, LookupError) else HTTPStatus.BAD_REQUEST
                self._error(status, "invalid_request", str(err))
            return
        # Team members CRUD
        if path == "/api/v1/team":
            if not self._require_permission("projectManage"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                member = self.store.create_team_member(self.organization_id, payload)
                self._json(HTTPStatus.CREATED, {"member": member})
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        if path.startswith("/api/v1/team/") and parts[-1] == "delete":
            if not self._require_permission("projectManage"): return
            member_id = parts[-2]
            if self.store.delete_team_member(self.organization_id, member_id):
                self._json(HTTPStatus.OK, {"ok": True})
            else:
                self._error(HTTPStatus.NOT_FOUND, "not_found", "Team member not found")
            return
        # Project assignments: POST /api/v1/projects/:id/team (assign), :id/team/:mid/remove
        if path.startswith("/api/v1/projects/") and len(parts) == 5 and parts[4] == "team":
            if not self._require_permission("projectManage"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                result = self.store.assign_member(self.organization_id, parts[3],
                    payload.get("memberId",""), payload.get("roleOnProject",""))
                self._json(HTTPStatus.CREATED, {"assignment": result})
            except (LookupError, ValueError, json.JSONDecodeError) as err:
                status = HTTPStatus.NOT_FOUND if isinstance(err, LookupError) else HTTPStatus.BAD_REQUEST
                self._error(status, "invalid_request", str(err))
            return
        if path.startswith("/api/v1/projects/") and len(parts) == 7 and parts[4] == "team" and parts[6] == "remove":
            if not self._require_permission("projectManage"): return
            self.store.remove_assignment(self.organization_id, parts[3], parts[5])
            self._json(HTTPStatus.OK, {"ok": True})
            return
        # Bulk work item status: POST /api/v1/projects/:id/work-items/bulk-status
        if path.startswith("/api/v1/projects/") and len(parts) == 6 and parts[4] == "work-items" and parts[5] == "bulk-status":
            if not self._require_permission("projectManage"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                ids: list[str] = payload.get("ids", [])
                status: str = payload.get("status", "")
                if not ids or not status:
                    self._error(HTTPStatus.BAD_REQUEST, "missing_fields", "ids[] and status are required"); return
                if len(ids) > 100:
                    self._error(HTTPStatus.BAD_REQUEST, "too_many", "Max 100 items per bulk operation"); return
                updated, skipped = 0, 0
                project_id = parts[3]
                with self.store._connect() as conn:
                    for item_id in ids:
                        row = conn.execute(
                            "SELECT status, version FROM project_work_items "
                            "WHERE organization_id=? AND project_id=? AND id=?",
                            (self.organization_id, project_id, item_id)
                        ).fetchone()
                        if row is None:
                            skipped += 1; continue
                        if status not in WORK_ITEM_TRANSITIONS.get(row["status"], set()):
                            skipped += 1; continue
                        now = utc_now()
                        conn.execute(
                            "UPDATE project_work_items SET status=?,version=?,updated_at=? "
                            "WHERE organization_id=? AND project_id=? AND id=? AND version=?",
                            (status, row["version"] + 1, now,
                             self.organization_id, project_id, item_id, row["version"]),
                        )
                        self.store.audit(
                            self.organization_id, "bulk-api", project_id,
                            "work_item.bulk_status", "work_item", item_id,
                        )
                        updated += 1
                        if status == "done":
                            try:
                                self.store.sync_blocked_status(self.organization_id, project_id, item_id)
                            except Exception:
                                pass
                self._json(HTTPStatus.OK, {"updated": updated, "skipped": skipped})
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        # Team presence: POST /api/v1/projects/:id/presence
        if path.startswith("/api/v1/projects/") and len(parts) == 5 and parts[4] == "presence":
            if not self._require_permission("projectManage"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                result = self.store.upsert_presence(
                    self.organization_id, parts[3],
                    payload.get("memberId",""),
                    payload.get("presenceDate", utc_now()[:10]),
                    payload.get("checkIn"), payload.get("checkOut"),
                    payload.get("notes",""),
                    payload.get("recordedBy"),
                )
                self._json(HTTPStatus.CREATED, {"presence": result})
            except (LookupError, ValueError, json.JSONDecodeError) as err:
                status = HTTPStatus.NOT_FOUND if isinstance(err, LookupError) else HTTPStatus.BAD_REQUEST
                self._error(status, "invalid_request", str(err))
            return
        # Org settings: POST /api/v1/admin/org-settings
        if path == "/api/v1/admin/org-settings":
            if not self._require_permission("adminPanel"): return
            try:
                payload = self._read_json()
                settings = self.store.update_org_settings(self.organization_id, payload)
                self._json(HTTPStatus.OK, {"settings": settings})
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        # Email inbox POST routes
        if path == "/api/v1/admin/email-inboxes":
            if not self._require_permission("adminPanel"): return
            try:
                inbox = self.store.create_email_inbox(self.organization_id, self._read_json())
                self._json(HTTPStatus.CREATED, {"inbox": inbox})
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        if len(parts) == 7 and parts[3] == "admin" and parts[4] == "email-inboxes":
            if not self._require_permission("adminPanel"): return
            inbox_id = parts[5]; action = parts[6]
            if action == "delete":
                try:
                    self.store.delete_email_inbox(self.organization_id, inbox_id)
                    self._json(HTTPStatus.OK, {"deleted": True})
                except LookupError as err:
                    self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
                return
            if action == "poll":
                try:
                    ai = getattr(self.server, "ai_gateway", None)
                    result = self.store.poll_email_inbox(self.organization_id, inbox_id, ai)
                    self._json(HTTPStatus.OK, result)
                except (LookupError, ValueError) as err:
                    status = HTTPStatus.NOT_FOUND if isinstance(err, LookupError) else HTTPStatus.BAD_GATEWAY
                    self._error(status, "poll_error", str(err))
                return
        # Inventory POST routes
        if len(parts) >= 4 and parts[3] == "inventory":
            org = self.organization_id
            sub = parts[4] if len(parts) > 4 else ""
            try:
                if sub == "warehouses":
                    if not self._require_permission("adminPanel"): return
                    wh = self.store.create_warehouse(org, self._read_json())
                    self._json(HTTPStatus.CREATED, {"warehouse": wh}); return
                if len(parts) == 7 and sub == "warehouses" and parts[6] == "delete":
                    if not self._require_permission("adminPanel"): return
                    self.store.delete_warehouse(org, parts[5])
                    self._json(HTTPStatus.OK, {"deleted": True}); return
                if sub == "skus":
                    if not self._require_permission("projectManage"): return
                    sku = self.store.create_sku(org, self._read_json())
                    self._json(HTTPStatus.CREATED, {"sku": sku}); return
                if sub == "movements":
                    if not self._require_permission("projectManage"): return
                    result = self.store.record_movement(org, self._read_json())
                    self._json(HTTPStatus.CREATED, result); return
                if sub == "pending" and len(parts) == 7 and parts[6] in ("approve","reject"):
                    if not self._require_permission("projectManage"): return
                    pending_id = parts[5]; action = parts[6]
                    payload = self._read_json()
                    reviewer = payload.get("reviewer", self.current_role)
                    if action == "approve":
                        indices = payload.get("approvedIndices")
                        result = self.store.approve_inventory_pending(org, pending_id, reviewer, indices)
                        self._json(HTTPStatus.OK, result); return
                    else:
                        self.store.reject_inventory_pending(org, pending_id, reviewer)
                        self._json(HTTPStatus.OK, {"rejected": True}); return
                if sub == "ai-parse":
                    if not self._require_permission("projectManage"): return
                    payload = self._read_json()
                    text = str(payload.get("text","")).strip()
                    if not text:
                        self._error(HTTPStatus.BAD_REQUEST, "missing_text", "text required"); return
                    warehouse_id = payload.get("warehouseId")
                    system_prompt = self.store.build_inventory_ai_prompt(org, warehouse_id)
                    ai = self.server.ai_gateway  # type: ignore[attr-defined]
                    ai_response = ai.complete(f"{system_prompt}\n\nUser note:\n{text}", max_tokens=512) or ""
                    pending = self.store.create_inventory_pending_from_ai(org, text, ai_response, warehouse_id)
                    self._json(HTTPStatus.CREATED, pending); return
                if sub == "ai-photo":
                    if not self._require_permission("projectManage"): return
                    # Accept multipart or JSON with base64
                    content_type = self.headers.get("Content-Type","")
                    if "application/json" in content_type:
                        payload = self._read_json()
                        image_b64 = payload.get("imageBase64","")
                        media_type = payload.get("mediaType","image/jpeg")
                        warehouse_id = payload.get("warehouseId", _invSelectedWarehouseId := None)
                    else:
                        # Raw binary upload — treat as JPEG
                        cl = int(self.headers.get("Content-Length","0"))
                        if cl > 20_000_000:
                            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "too_large", "Max 20 MB"); return
                        raw = self.rfile.read(cl)
                        import base64 as _b64
                        image_b64 = _b64.b64encode(raw).decode()
                        media_type = content_type.split(";")[0].strip() or "image/jpeg"
                        warehouse_id = self.query_params.get("warehouseId",[None])[0]

                    if not image_b64:
                        self._error(HTTPStatus.BAD_REQUEST, "missing_image", "imageBase64 or raw body required"); return

                    ai = getattr(self.server, "ai_gateway", None)
                    if not ai:
                        self._error(HTTPStatus.SERVICE_UNAVAILABLE, "no_ai", "AI gateway not available"); return

                    system_prompt = self.store.build_inventory_ai_prompt(org, warehouse_id)
                    vision_prompt = (
                        f"{system_prompt}\n\n"
                        "Analyze this photo and identify any materials, cables, equipment, or supplies visible.\n"
                        "Describe what you see, then extract inventory movements as instructed above.\n"
                        "If you cannot identify an item with certainty, set skuId=null and add sku_name_guess with your best description.\n"
                        "Return JSON only."
                    )
                    ai_response = ai.vision(
                        image_b64=image_b64, media_type=media_type,
                        prompt=vision_prompt, org=org, purpose="inventory-vision",
                    ) or ""
                    pending = self.store.create_inventory_pending_from_ai(
                        org, f"[photo analysis] {media_type}", ai_response, warehouse_id
                    )
                    pending["aiDescription"] = ai_response[:2000]
                    self._json(HTTPStatus.CREATED, pending)
                    return
                if sub == "import-xlsx":
                    if not self._require_permission("projectManage"): return
                    content_length = int(self.headers.get("Content-Length","0"))
                    if content_length > 10_000_000:
                        self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "too_large", "Max 10 MB"); return
                    data = self.rfile.read(content_length)
                    pending = self.store.import_xlsx_inventory(org, data, self.current_role)
                    self._json(HTTPStatus.CREATED, pending); return
                if sub == "reservations":
                    if not self._require_permission("projectManage"): return
                    payload = self._read_json()
                    r = self.store.create_reservation(
                        org,
                        project_id=payload["projectId"],
                        warehouse_id=payload["warehouseId"],
                        sku_id=payload["skuId"],
                        quantity=float(payload["quantity"]),
                        note=payload.get("note",""),
                        reserved_by=payload.get("reservedBy", self.current_role),
                    )
                    self._json(HTTPStatus.CREATED, r); return
                if sub == "reservations" and len(parts) == 7 and parts[6] in ("release","consume"):
                    if not self._require_permission("projectManage"): return
                    reservation_id = parts[5]; action = parts[6]
                    payload = self._read_json()
                    actor = payload.get("actor", self.current_role)
                    if action == "release":
                        self.store.release_reservation(org, reservation_id, actor)
                        self._json(HTTPStatus.OK, {"released": True}); return
                    else:
                        qty = float(payload["quantity"])
                        result = self.store.consume_from_reservation(org, reservation_id, qty, actor)
                        self._json(HTTPStatus.OK, result); return
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err)); return
            except LookupError as err:
                self._error(HTTPStatus.NOT_FOUND, "not_found", str(err)); return
        # Budget: POST /api/v1/projects/:id/budget  /expenses  /expenses/:eid/delete
        if len(parts) == 6 and parts[3] == "projects" and parts[5] == "budget":
            if not self._require_permission("projectManage"): return
            try:
                payload = self._read_json()
                self.store.set_project_budget(self.organization_id, parts[4],
                    payload.get("amount"), str(payload.get("currency","USD")))
                self._json(HTTPStatus.OK, self.store.get_budget_summary(self.organization_id, parts[4]))
            except (LookupError, ValueError, json.JSONDecodeError) as err:
                status = HTTPStatus.NOT_FOUND if isinstance(err, LookupError) else HTTPStatus.BAD_REQUEST
                self._error(status, "invalid_request", str(err))
            return
        if len(parts) == 6 and parts[3] == "projects" and parts[5] == "expenses":
            if not self._require_permission("projectManage"): return
            try:
                expense = self.store.add_expense(self.organization_id, parts[4], self._read_json())
                self._json(HTTPStatus.CREATED, {"expense": expense})
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        if len(parts) == 8 and parts[3] == "projects" and parts[5] == "expenses" and parts[7] == "delete":
            if not self._require_permission("projectManage"): return
            try:
                self.store.delete_expense(self.organization_id, parts[6])
                self._json(HTTPStatus.OK, {"deleted": True})
            except LookupError as err:
                self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
            return
        # Comments: POST /api/v1/projects/:pid/work-items/:wid/comments  and  /comments/:cid/edit|delete
        if len(parts) >= 8 and parts[3] == "projects" and parts[5] == "work-items" and parts[7] == "comments":
            project_id = parts[4]; wi_id = parts[6]
            if len(parts) == 8:
                # Create comment
                if not self._require_permission("fieldProgress"): return
                try:
                    payload = self._read_json()
                    body_text = str(payload.get("body","")).strip()
                    author_name = str(payload.get("authorName", self.current_role))
                    comment = self.store.add_wi_comment(self.organization_id, wi_id, project_id,
                                                         body_text, None, author_name)
                    self._json(HTTPStatus.CREATED, {"comment": comment})
                except (ValueError, json.JSONDecodeError) as err:
                    self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
                return
            if len(parts) == 10 and parts[8] == "comments" and parts[9] in ("edit", "delete"):
                cid = parts[8]; action = parts[9]
                # Correct: parts[8] is comment_id, parts[9] is action
                cid = parts[8] if len(parts) == 10 else None
            # /projects/:pid/work-items/:wid/comments/:cid/edit|delete  → len=10
            if len(parts) == 10 and parts[7] == "comments" and parts[9] in ("edit", "delete"):
                cid = parts[8]; action = parts[9]
                if not self._require_permission("projectManage"): return
                if action == "delete":
                    try:
                        self.store.delete_wi_comment(self.organization_id, cid)
                        self._json(HTTPStatus.OK, {"deleted": True})
                    except LookupError as err:
                        self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
                    return
                if action == "edit":
                    try:
                        payload = self._read_json()
                        comment = self.store.edit_wi_comment(self.organization_id, cid, str(payload.get("body","")))
                        self._json(HTTPStatus.OK, {"comment": comment})
                    except (LookupError, ValueError, json.JSONDecodeError) as err:
                        status = HTTPStatus.NOT_FOUND if isinstance(err, LookupError) else HTTPStatus.BAD_REQUEST
                        self._error(status, "invalid_request", str(err))
                    return
        # Milestones: POST /api/v1/projects/:id/milestones  and  /:id/milestones/:mid/update|delete
        if len(parts) >= 6 and parts[3] == "projects" and parts[5] == "milestones":
            project_id = parts[4]
            if not self._require_permission("projectManage"): return
            if len(parts) == 6:
                # Create
                try:
                    ms = self.store.create_milestone(self.organization_id, project_id, self._read_json())
                    self._json(HTTPStatus.CREATED, {"milestone": ms})
                except (ValueError, json.JSONDecodeError) as err:
                    self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
                return
            if len(parts) == 8 and parts[7] in ("update", "delete"):
                mid = parts[6]
                action = parts[7]
                if action == "delete":
                    try:
                        self.store.delete_milestone(self.organization_id, mid)
                        self._json(HTTPStatus.OK, {"deleted": True})
                    except LookupError as err:
                        self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
                    return
                if action == "update":
                    try:
                        ms = self.store.update_milestone(self.organization_id, mid, self._read_json())
                        self._json(HTTPStatus.OK, {"milestone": ms})
                    except (LookupError, ValueError, json.JSONDecodeError) as err:
                        status = HTTPStatus.NOT_FOUND if isinstance(err, LookupError) else HTTPStatus.BAD_REQUEST
                        self._error(status, "invalid_request", str(err))
                    return
        # Scheduled reports: POST /api/v1/admin/scheduled-reports  and  /:id/delete  and  /:id/run
        if path == "/api/v1/admin/scheduled-reports":
            if not self._require_permission("adminRead"): return
            try:
                payload = self._read_json()
                report = self.store.create_scheduled_report(self.organization_id, payload)
                self._json(HTTPStatus.CREATED, {"report": report})
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        _sr_parts = path.split("/")
        if len(_sr_parts) == 7 and _sr_parts[4] == "scheduled-reports":
            _sr_id, _sr_action = _sr_parts[5], _sr_parts[6]
            if _sr_action == "delete":
                if not self._require_permission("adminRead"): return
                try:
                    self.store.delete_scheduled_report(self.organization_id, _sr_id)
                    self._json(HTTPStatus.OK, {"deleted": True})
                except LookupError as e:
                    self._error(HTTPStatus.NOT_FOUND, "not_found", str(e))
                return
            if _sr_action == "run":
                if not self._require_permission("adminRead"): return
                results = self.store.run_due_scheduled_reports(self.organization_id)
                self._json(HTTPStatus.OK, {"results": results})
                return
        # Templates: POST /api/v1/templates  and  /templates/:id/delete  and  /templates/:id/use
        if path == "/api/v1/templates":
            if not self._require_permission("projectManage"): return
            try:
                payload = self._read_json()
                ctx = self.session_context or {}
                tpl = self.store.create_template(self.organization_id, payload, ctx.get("userId"))
                self._json(HTTPStatus.CREATED, {"template": tpl})
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        if len(parts) == 5 and parts[3] == "templates" and parts[4] == "delete":
            if not self._require_permission("projectManage"): return
            # parts[3] is templates, but we need the ID before delete — route is /templates/:id/delete
            pass
        if len(parts) == 5 and parts[2] == "v1" and parts[3] == "templates":
            tpl_id, action = parts[3], parts[4]  # won't match — need proper parse below
            pass
        # Flat route: /api/v1/templates/:id/delete or /api/v1/templates/:id/use
        _tpl_parts = path.split("/")  # ['', 'api', 'v1', 'templates', ':id', action]
        if len(_tpl_parts) == 6 and _tpl_parts[3] == "templates":
            _tpl_id, _tpl_action = _tpl_parts[4], _tpl_parts[5]
            if _tpl_action == "delete":
                if not self._require_permission("projectManage"): return
                try:
                    self.store.delete_template(self.organization_id, _tpl_id)
                    self._json(HTTPStatus.OK, {"deleted": True})
                except LookupError as e:
                    self._error(HTTPStatus.NOT_FOUND, "not_found", str(e))
                return
            if _tpl_action == "use":
                if not self._require_permission("projectManage"): return
                try:
                    payload = self._read_json()
                    project = self.store.create_project_from_template(self.organization_id, _tpl_id, payload)
                    self._json(HTTPStatus.CREATED, {"project": project})
                except LookupError as e:
                    self._error(HTTPStatus.NOT_FOUND, "not_found", str(e))
                except (ValueError, json.JSONDecodeError) as err:
                    self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
                return
        # Notifications mark-read: POST /api/v1/notifications/read
        if path == "/api/v1/notifications/read":
            if not self._require_permission("projectRead"): return
            try:
                payload = self._read_json()
                user_id = self.session_context.get("userId") or self.session_context.get("user_id")
                ids = payload.get("ids") if isinstance(payload, dict) else None
                count = self.store.mark_notifications_read(self.organization_id, ids, user_id)
                self._json(HTTPStatus.OK, {"marked": count})
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        # Session revoke: POST /api/v1/admin/sessions/revoke
        if path == "/api/v1/admin/sessions/revoke":
            if not self._require_permission("adminPanel"): return
            try:
                payload = self._read_json()
                prefix = payload.get("tokenHashPrefix", "")
                if not isinstance(prefix, str) or len(prefix) < 4:
                    self._error(HTTPStatus.BAD_REQUEST, "invalid_request", "tokenHashPrefix ≥4 chars required")
                    return
                revoked = self.store.revoke_session(self.organization_id, prefix)
                self._json(HTTPStatus.OK, {"revoked": revoked})
            except (ValueError, json.JSONDecodeError) as e:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(e))
            return
        # Issues: POST /api/v1/issues/:id/transition  and  /issues/:id/assign
        _issue_parts = path.split("/")
        if len(_issue_parts) == 6 and _issue_parts[3] == "issues":
            _issue_id, _issue_action = _issue_parts[4], _issue_parts[5]
            if _issue_action == "transition":
                if not self._require_permission("projectManage"): return
                try:
                    payload = self._read_json()
                    new_status = payload.get("status")
                    if not new_status:
                        self._error(HTTPStatus.BAD_REQUEST, "invalid_request", "status required"); return
                    ctx = self.session_context or {}
                    updated = self.store.transition_issue(
                        self.organization_id, _issue_id, new_status,
                        payload.get("resolutionNote", ""),
                        ctx.get("userId"),
                    )
                    self._json(HTTPStatus.OK, {"issue": updated})
                except LookupError as e:
                    self._error(HTTPStatus.NOT_FOUND, "not_found", str(e))
                except InvalidTransition as e:
                    self._error(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_transition", str(e))
                except (ValueError, json.JSONDecodeError) as e:
                    self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(e))
                return
            if _issue_action == "assign":
                if not self._require_permission("projectManage"): return
                try:
                    payload = self._read_json()
                    updated = self.store.assign_issue(
                        self.organization_id, _issue_id, payload.get("assignedTo")
                    )
                    self._json(HTTPStatus.OK, {"issue": updated})
                except LookupError as e:
                    self._error(HTTPStatus.NOT_FOUND, "not_found", str(e))
                except (ValueError, json.JSONDecodeError) as e:
                    self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(e))
                return
        # Webhook flush: POST /api/v1/admin/webhooks/flush
        if path == "/api/v1/admin/webhooks/flush":
            if not self._require_permission("adminRead"): return
            result = self.store.flush_webhook_events()
            self._json(HTTPStatus.OK, result)
            return
        # Connectors: POST /api/v1/admin/connectors
        if path == "/api/v1/admin/connectors":
            if not self._require_permission("adminPanel"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                result = self.store.upsert_connector(
                    self.organization_id,
                    payload.get("connectorType", "custom"),
                    payload.get("name", ""),
                    payload.get("config", {}),
                    payload.get("enabled", True),
                )
                self._json(HTTPStatus.OK, {"connector": result})
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        # Submit compute job: POST /api/v1/admin/compute-jobs
        if path == "/api/v1/admin/compute-jobs":
            if not self._require_permission("adminPanel"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                user_id = self.session_context.get("user_id", "unknown")
                result = self.store.submit_compute_job(
                    self.organization_id, payload.get("jobType","custom"),
                    payload.get("payload",{}), int(payload.get("priority",5)), user_id,
                )
                self._json(HTTPStatus.CREATED, result)
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        # Compute job dispatch/complete: POST /api/v1/admin/compute-jobs/:id/dispatch|complete
        if path.startswith("/api/v1/admin/compute-jobs/") and parts[-1] in ("dispatch","complete"):
            if not self._require_permission("adminPanel"): return
            job_id = parts[-2]
            action = parts[-1]
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                if action == "dispatch":
                    result = self.store.dispatch_compute_job(self.organization_id, job_id, payload.get("nodeId",""))
                    self._json(HTTPStatus.OK, result)
                else:
                    self.store.complete_compute_job(self.organization_id, job_id, payload.get("result"), payload.get("error"))
                    self._json(HTTPStatus.OK, {"ok": True})
            except (LookupError, ValueError, json.JSONDecodeError) as err:
                status = HTTPStatus.NOT_FOUND if isinstance(err, LookupError) else HTTPStatus.BAD_REQUEST
                self._error(status, "invalid_request", str(err))
            return
        # Service monitors: POST /api/v1/admin/monitors
        if path == "/api/v1/admin/monitors":
            if not self._require_permission("adminPanel"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                result = self.store.create_monitor(self.organization_id, payload)
                self._json(HTTPStatus.CREATED, {"monitor": result})
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        # Monitor delete: POST /api/v1/admin/monitors/:id/delete
        if path.startswith("/api/v1/admin/monitors/") and parts[-1] == "delete":
            if not self._require_permission("adminPanel"): return
            try:
                self.store.delete_monitor(self.organization_id, parts[-2])
                self._json(HTTPStatus.OK, {"ok": True})
            except LookupError as err:
                self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
            return
        # Monitor event record: POST /api/v1/admin/monitors/:id/event
        if path.startswith("/api/v1/admin/monitors/") and parts[-1] == "event":
            if not self._require_permission("adminPanel"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                self.store.record_monitor_event(
                    self.organization_id, parts[-2],
                    payload.get("status","unknown"),
                    payload.get("latencyMs"), payload.get("error"),
                )
                self._json(HTTPStatus.CREATED, {"ok": True})
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        # AI approval queue
        if path == "/api/v1/admin/ai-approvals":
            if not self._require_permission("adminPanel"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                uid = (self.session_context or {}).get("userId", "agent")
                result = self.store.propose_ai_action(
                    self.organization_id, uid,
                    payload.get("actionType", ""),
                    payload.get("actionPayload", {}),
                    payload.get("evidence", {}),
                )
                self._json(HTTPStatus.CREATED, {"approval": result})
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        if path.startswith("/api/v1/admin/ai-approvals/") and parts[-1] in ("approve", "reject"):
            if not self._require_permission("adminPanel"): return
            approval_id = parts[-2]
            decision = "approved" if parts[-1] == "approve" else "rejected"
            try:
                payload = self._read_json()
                note = payload.get("note", "") if isinstance(payload, dict) else ""
                uid = (self.session_context or {}).get("userId", "")
                if not uid: self._error(HTTPStatus.UNAUTHORIZED, "auth_required", "Must be authenticated"); return
                result = self.store.review_ai_approval(self.organization_id, approval_id, uid, decision, note)
                self._json(HTTPStatus.OK, {"approval": result})
            except LookupError as err:
                self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        # Retrieval eval: POST /api/v1/admin/retrieval-eval/cases, /run, cases/:id/delete
        if path == "/api/v1/admin/retrieval-eval/cases":
            if not self._require_permission("adminPanel"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                uid = (self.session_context or {}).get("userId")
                case = self.store.create_eval_case(self.organization_id, payload, uid)
                self._json(HTTPStatus.CREATED, {"case": case})
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        if path == "/api/v1/admin/retrieval-eval/run":
            if not self._require_permission("adminPanel"): return
            try:
                payload = self._read_json()
                project_id = payload.get("projectId") if isinstance(payload, dict) else None
                uid = (self.session_context or {}).get("userId")
                result = self.store.run_retrieval_eval(self.organization_id, project_id, uid)
                self._json(HTTPStatus.OK, {"result": result})
            except LookupError as err:
                self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
            except (ValueError, json.JSONDecodeError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        if path.startswith("/api/v1/admin/retrieval-eval/cases/") and parts[-1] == "delete":
            if not self._require_permission("adminPanel"): return
            case_id = parts[-2]
            if self.store.delete_eval_case(self.organization_id, case_id):
                self._json(HTTPStatus.OK, {"ok": True})
            else:
                self._error(HTTPStatus.NOT_FOUND, "not_found", "Case not found")
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
        # Comment delete: POST /api/v1/projects/:pid/comments/:cid/delete
        if path.startswith("/api/v1/projects/") and len(parts) == 7 and parts[4] == "comments" and parts[6] == "delete":
            if not self._require_permission("fieldProgress"): return
            ctx = self.session_context or {}
            self.store.delete_comment(self.organization_id, parts[5], ctx.get("userId"))
            self._json(HTTPStatus.OK, {"ok": True})
            return
        # Object entity link: POST /api/v1/objects/:id/link
        if path.startswith("/api/v1/objects/") and parts[-1] == "link":
            if not self._require_permission("projectManage"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                entity_type = payload.get("entityType") or None
                entity_id = payload.get("entityId") or None
                result = self.store.link_object_to_entity(self.organization_id, parts[-2], entity_type, entity_id)
                self._json(HTTPStatus.OK, result)
            except (LookupError, ValueError, json.JSONDecodeError) as err:
                status = HTTPStatus.NOT_FOUND if isinstance(err, LookupError) else HTTPStatus.BAD_REQUEST
                self._error(status, "invalid_request", str(err))
            return
        # Object access policy: POST /api/v1/objects/:id/policy
        if path.startswith("/api/v1/objects/") and parts[-1] == "policy":
            if not self._require_permission("adminPanel"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                result = self.store.set_object_policy(self.organization_id, parts[-2], payload.get("policy","org"))
                self._json(HTTPStatus.OK, result)
            except (LookupError, ValueError, json.JSONDecodeError) as err:
                status = HTTPStatus.NOT_FOUND if isinstance(err, LookupError) else HTTPStatus.BAD_REQUEST
                self._error(status, "invalid_request", str(err))
            return
        # Technical agent: POST /api/v1/ai/agents/technical
        if path == "/api/v1/ai/agents/technical":
            if not self._require_permission("projectRead"): return
            try:
                body = json.loads(self.body)
                query = str(body.get("query", "")).strip()[:1000]
                project_id = body.get("project_id") or None
                if not query:
                    self._error(HTTPStatus.BAD_REQUEST, "missing_query", "query required"); return
                user_id = self.session_context.get("user_id", "unknown")
                result = self.store.technical_agent_query(
                    self.organization_id, query, user_id, project_id
                )
                self._json(HTTPStatus.OK, result)
            except RuntimeError as err:
                self._error(HTTPStatus.BAD_GATEWAY, "agent_error", str(err))
            return
        # Documentation agent: POST /api/v1/ai/agents/documentation
        if path == "/api/v1/ai/agents/documentation":
            if not self._require_permission("projectRead"): return
            try:
                body = json.loads(self.body)
                query = str(body.get("query", "")).strip()[:1000]
                project_id = body.get("project_id") or None
                if not query:
                    self._error(HTTPStatus.BAD_REQUEST, "missing_query", "query required"); return
                user_id = self.session_context.get("user_id", "unknown")
                allowed = self.store.get_user_allowed_projects(self.organization_id, user_id)
                result = self.store.documentation_agent_query(
                    self.organization_id, query, user_id, project_id, allowed
                )
                self._json(HTTPStatus.OK, result)
            except RuntimeError as err:
                self._error(HTTPStatus.BAD_GATEWAY, "agent_error", str(err))
            return
        # Analytics agent: POST /api/v1/ai/agents/analytics
        if path == "/api/v1/ai/agents/analytics":
            if not self._require_permission("projectRead"): return
            try:
                body = json.loads(self.body)
                project_id = str(body.get("project_id", "")).strip()
                if not project_id:
                    self._error(HTTPStatus.BAD_REQUEST, "missing_project_id", "project_id required"); return
                analytics = self.store.get_project_analytics(self.organization_id, project_id)
                ai = self.store.ai_gateway(self.organization_id)
                prompt = (
                    f"You are a project analytics assistant. Analyze this project data and give a 3-5 sentence "
                    f"summary of health, risks, and recommendations:\n{json.dumps(analytics, default=str)}"
                )
                narrative = ai.complete(prompt, max_tokens=256) if ai else (
                    f"Project is {analytics['pctDone']}% complete. Risk level: {analytics['riskLevel']}. "
                    f"Avg velocity: {analytics['avgEventsPerDay']} events/day."
                )
                self._json(HTTPStatus.OK, {
                    "projectId": project_id,
                    "analytics": analytics,
                    "narrative": narrative,
                })
            except (LookupError, RuntimeError) as err:
                status = HTTPStatus.NOT_FOUND if isinstance(err, LookupError) else HTTPStatus.BAD_GATEWAY
                self._error(status, "agent_error", str(err))
            return
        # Field note parse: POST /api/v1/ai/parse-note
        if path == "/api/v1/ai/parse-note":
            if not self._require_permission("fieldProgress"): return
            try:
                body = json.loads(self.body)
                raw_text = str(body.get("text", "")).strip()[:3000]
                project_id = str(body.get("project_id", ""))
                if not raw_text or not project_id:
                    self._error(HTTPStatus.BAD_REQUEST, "missing_fields", "text and project_id required"); return
                actor = self.session_context.get("user_id", "unknown")
                result = self.store.parse_field_note(self.organization_id, project_id, actor, raw_text)
                self._json(HTTPStatus.OK, result)
            except LookupError as err:
                self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
            except Exception as err:
                self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "parse_error", str(err))
            return
        # Field note apply: POST /api/v1/ai/notes/:id/apply
        if path.startswith("/api/v1/ai/notes/") and parts[-1] == "apply":
            if not self._require_permission("fieldProgress"): return
            draft_id = parts[-2]
            try:
                body = json.loads(self.body)
                approved = body.get("approved_changes", [])
                actor = self.session_context.get("user_id", "unknown")
                result = self.store.apply_field_note(self.organization_id, draft_id, actor, approved)
                self._json(HTTPStatus.OK, result)
            except (LookupError, ValueError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "apply_error", str(err))
            return
        # Field note reject: POST /api/v1/ai/notes/:id/reject
        if path.startswith("/api/v1/ai/notes/") and parts[-1] == "reject":
            if not self._require_permission("fieldProgress"): return
            draft_id = parts[-2]
            self.store.reject_field_note(self.organization_id, draft_id)
            self._json(HTTPStatus.OK, {"ok": True})
            return
        # Webhooks CRUD: POST /api/v1/webhooks
        if path == "/api/v1/webhooks":
            if not self._require_permission("adminPanel"): return
            try:
                body = json.loads(self.body)
                name = str(body.get("name", "")).strip()[:100]
                url = str(body.get("url", "")).strip()
                secret_key = str(body.get("secret_key", "")).strip()
                events = body.get("events", ["*"])
                if not name or not url:
                    self._error(HTTPStatus.BAD_REQUEST, "missing_fields", "name and url required"); return
                if not url.startswith(("http://", "https://")):
                    self._error(HTTPStatus.BAD_REQUEST, "invalid_url", "url must start with http(s)"); return
                if not secret_key:
                    secret_key = secrets.token_hex(32)
                actor = self.session_context.get("user_id", "system")
                result = self.store.create_webhook(self.organization_id, name, url, secret_key, events, actor)
                self._json(HTTPStatus.CREATED, result)
            except (ValueError, KeyError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_payload", str(err))
            return
        # Webhook delete: POST /api/v1/webhooks/:id/delete
        if path.startswith("/api/v1/webhooks/") and parts[-1] == "delete":
            if not self._require_permission("adminPanel"): return
            self.store.delete_webhook(self.organization_id, parts[-2])
            self._json(HTTPStatus.OK, {"ok": True})
            return
        # Webhook toggle: POST /api/v1/webhooks/:id/toggle
        if path.startswith("/api/v1/webhooks/") and parts[-1] == "toggle":
            if not self._require_permission("adminPanel"): return
            try:
                body = json.loads(self.body)
                self.store.toggle_webhook(self.organization_id, parts[-2], bool(body.get("enabled", True)))
                self._json(HTTPStatus.OK, {"ok": True})
            except Exception as err:
                self._error(HTTPStatus.BAD_REQUEST, "toggle_error", str(err))
            return
        # AI router config: POST /api/v1/ai/config
        if path == "/api/v1/ai/config":
            if not self._require_permission("adminPanel"): return
            try:
                config = json.loads(self.body)
                self.store.save_ai_router_config(self.organization_id, config)
                self._json(HTTPStatus.OK, {"ok": True})
            except (ValueError, KeyError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_config", str(err))
            return
        # AI classify: POST /api/v1/ai/classify (local, no LLM call)
        if path == "/api/v1/ai/classify":
            if not self._require_permission("projectRead"): return
            try:
                body = json.loads(self.body)
                text = str(body.get("text", ""))[:2000]
                result = ai_classify(text)
                self._json(HTTPStatus.OK, result)
            except Exception as err:
                self._error(HTTPStatus.BAD_REQUEST, "classify_error", str(err))
            return
        # AI invoke: POST /api/v1/ai/invoke
        if path == "/api/v1/ai/invoke":
            if not self._require_permission("adminPanel"): return
            try:
                body = json.loads(self.body)
                prompt = str(body.get("prompt", ""))[:4000]
                system = str(body.get("system", "You are a helpful field operations assistant."))[:1000]
                intent = str(body.get("intent", "invoke"))
                if not prompt:
                    self._error(HTTPStatus.BAD_REQUEST, "missing_prompt", "prompt required"); return
                router = self.store.get_ai_router(self.organization_id)
                if not router.available:
                    self._error(HTTPStatus.SERVICE_UNAVAILABLE, "router_unavailable",
                                f"Provider {router.provider!r}: set env var for key"); return
                t0 = time.monotonic()
                result = router.invoke(prompt, system=system)
                latency = int((time.monotonic() - t0) * 1000)
                user_id = self.session_context.get("user_id")
                self.store.log_ai_invocation(
                    self.organization_id, user_id, intent,
                    result.get("provider", router.provider),
                    result.get("model", router.model),
                    result.get("prompt_tokens", 0), result.get("completion_tokens", 0),
                    latency, None,
                )
                self._json(HTTPStatus.OK, result)
            except RuntimeError as err:
                user_id = self.session_context.get("user_id")
                self.store.log_ai_invocation(
                    self.organization_id, user_id, "invoke",
                    "unknown", "unknown", 0, 0, 0, str(err),
                )
                self._error(HTTPStatus.BAD_GATEWAY, "llm_error", str(err))
            return
        # Daily log note save: POST /api/v1/projects/:id/daily-log-note
        if path.startswith("/api/v1/projects/") and len(parts) == 5 and parts[4] == "daily-log-note":
            if not self._require_permission("projectRead"): return
            try:
                data = json.loads(self.body)
                work_date = data.get("date", utc_now()[:10])
                note = str(data.get("note", ""))[:5000]
                actor = self.session_context.get("user_id", "system")
                now = utc_now()
                with self.store._connect() as conn:
                    conn.execute(
                        """INSERT INTO daily_log_notes (id, organization_id, project_id, work_date, note, author_id, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                           ON CONFLICT (organization_id, project_id, work_date)
                           DO UPDATE SET note=excluded.note, author_id=excluded.author_id, updated_at=excluded.updated_at""",
                        (str(uuid.uuid4()), self.organization_id, parts[3], work_date, note, actor, now, now),
                    )
                self._json(HTTPStatus.OK, {"note": note, "updatedAt": now})
            except (ValueError, KeyError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_payload", str(err))
            return
        # Project import: POST /api/v1/projects/import
        if path == "/api/v1/projects/import":
            if not self._require_permission("projectManage"): return
            try:
                body = json.loads(self.body)
                actor = self.session_context.get("user_id", "system")
                result = self.store.import_project(self.organization_id, body, actor)
                self._json(HTTPStatus.OK, result)
            except (ValueError, KeyError) as err:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_payload", str(err))
            return
        # Knowledge index rebuild: POST /api/v1/knowledge/rebuild
        if path == "/api/v1/knowledge/rebuild":
            if not self._require_permission("adminPanel"): return
            result = self.store.rebuild_knowledge_index(self.organization_id)
            self._json(HTTPStatus.OK, result)
            return
        # Asset delete: POST /api/v1/assets/:id/delete
        if path.startswith("/api/v1/assets/") and parts[-1] == "delete":
            if not self._require_permission("projectManage"): return
            try:
                self.store.delete_asset(self.organization_id, parts[-2])
                self._json(HTTPStatus.OK, {"ok": True})
            except LookupError as err: self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
            return
        # Relationship delete: POST /api/v1/relationships/:id/delete
        if path.startswith("/api/v1/relationships/") and parts[-1] == "delete":
            if not self._require_permission("projectManage"): return
            try:
                self.store.delete_relationship(self.organization_id, parts[-2])
                self._json(HTTPStatus.OK, {"ok": True})
            except LookupError as err: self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
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
            permission = "fieldProgress" if (len(parts) == 5 and parts[4] in ("daily-updates", "comments")) else "projectManage"
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
                elif len(parts) != 5 or parts[4] not in {"buildings", "work-items", "locations", "daily-updates", "comments"}:
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
                elif parts[4] == "comments":
                    ctx = self.session_context or {}
                    comment = self.store.add_comment(
                        self.organization_id, parts[3],
                        ctx.get("userId"), ctx.get("name") or ctx.get("email") or "Пользователь",
                        payload.get("body", ""), payload.get("parentId"),
                    )
                    response = {"organizationId": self.organization_id, "comment": comment}
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
        team_route = len(parts) == 3 and parts[:2] == ["api", "v1"] and parts[2].startswith("team/") or (len(parts)==3 and parts[1]=="v1" and parts[0]=="api")
        asset_route = len(parts) == 4 and parts[:2] == ["api","v1"] and parts[2] == "assets"
        team_member_route = len(parts) == 4 and parts[:2] == ["api","v1"] and parts[2] == "team"
        if asset_route:
            if not self._require_permission("projectManage"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                asset = self.store.update_asset(self.organization_id, parts[3], payload)
                self._json(HTTPStatus.OK, {"asset": asset})
            except LookupError as err: self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
            except (ValueError, json.JSONDecodeError) as err: self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
        if team_member_route:
            if not self._require_permission("projectManage"): return
            try:
                payload = self._read_json()
                if not isinstance(payload, dict): raise ValueError("JSON object expected")
                member = self.store.update_team_member(self.organization_id, parts[3], payload)
                self._json(HTTPStatus.OK, {"member": member})
            except LookupError as err: self._error(HTTPStatus.NOT_FOUND, "not_found", str(err))
            except (ValueError, json.JSONDecodeError) as err: self._error(HTTPStatus.BAD_REQUEST, "invalid_request", str(err))
            return
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
                # Auto-unblock dependents when a work item completes
                if work_item.get("status") == "done":
                    try:
                        unblocked = self.store.sync_blocked_status(
                            self.organization_id, parts[3], parts[5]
                        )
                        if unblocked:
                            work_item["_unblocked"] = unblocked
                    except Exception:
                        pass
                    # Notification: push for unblocked items
                    if unblocked:
                        try:
                            for uid in unblocked:
                                self.store.push_notification(
                                    self.organization_id, "Задача разблокирована",
                                    f"{work_item.get('title','')} завершена — {len(unblocked)} задач готовы к работе",
                                    notif_type="work_item_unblocked",
                                    entity_type="work_item", entity_id=uid, project_id=parts[3],
                                )
                        except Exception:
                            pass
                    # Webhook: notify connectors about completion
                    try:
                        self.store.queue_webhook_event(
                            self.organization_id, None, "work_item.done",
                            {"workItemId": parts[5], "projectId": parts[3],
                             "title": work_item.get("title",""), "code": work_item.get("code","")},
                        )
                    except Exception:
                        pass
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
        # Rate-limit by real IP (X-Forwarded-For first, then socket peer)
        client_ip = self.headers.get("X-Forwarded-For", self.client_address[0]).split(",")[0].strip()
        if not _RATE_LIMITER.allow(client_ip):
            self.request_id = str(uuid.uuid4())
            self._error(HTTPStatus.TOO_MANY_REQUESTS, "rate_limited",
                        "Too many requests — please slow down")
            raise _RateLimited()
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
        ip = self.headers.get("X-Forwarded-For", self.client_address[0])
        ua = self.headers.get("User-Agent", "")
        result = self.store.login(email, password, ip_address=ip, user_agent=ua)
        if not result:
            self.store.audit(self.organization_id, None, None, "login", "session", None, "denied", ip)
            self._error(HTTPStatus.UNAUTHORIZED, "invalid_credentials", "Invalid email or password")
            return
        if result.get("mfaRequired"):
            self.store.audit(self.organization_id, result["user"]["id"], None, "login.mfa_required", "session", None, "ok", ip)
        else:
            self.store.audit(self.organization_id, result["user"]["id"], result.get("role"), "login", "session", None, "ok", ip)
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

    def _handle_mfa_verify(self) -> None:
        """Step 2 of login when MFA is enabled: verify TOTP/backup code."""
        try:
            body = self._read_json()
        except (json.JSONDecodeError, ValueError):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_json", "JSON required"); return
        challenge = str(body.get("challengeToken", "")).strip()
        code = str(body.get("code", "")).strip()
        if not challenge or not code:
            self._error(HTTPStatus.BAD_REQUEST, "missing_fields", "challengeToken and code required"); return
        result = self.store.verify_mfa_challenge(challenge, code)
        ip = self.headers.get("X-Forwarded-For", self.client_address[0])
        if not result:
            self.store.audit(self.organization_id, None, None, "mfa.verify", "session", None, "denied", ip)
            self._error(HTTPStatus.UNAUTHORIZED, "invalid_code", "Invalid MFA code or challenge expired"); return
        self.store.audit(self.organization_id, result["user"]["id"], result["role"], "mfa.verify", "session", None, "ok", ip)
        self._json(HTTPStatus.OK, result)

    def _handle_mfa_enroll_begin(self) -> None:
        """Start MFA enrollment: generate secret, return URI."""
        if not self.session_context:
            self._error(HTTPStatus.UNAUTHORIZED, "unauthenticated", "Login required"); return
        sess = self.session_context
        with self.store._connect() as conn:
            user = conn.execute("SELECT email FROM users WHERE id=?", (sess["userId"],)).fetchone()
        if not user:
            self._error(HTTPStatus.NOT_FOUND, "user_not_found", "User not found"); return
        result = self.store.mfa_begin_enrollment(sess["userId"], user["email"])
        self._json(HTTPStatus.OK, result)

    def _handle_mfa_confirm(self) -> None:
        """Complete MFA enrollment: verify first code, activate, return backup codes."""
        if not self.session_context:
            self._error(HTTPStatus.UNAUTHORIZED, "unauthenticated", "Login required"); return
        try:
            body = self._read_json()
        except (json.JSONDecodeError, ValueError):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_json", "JSON required"); return
        code = str(body.get("code", "")).strip()
        backup_codes = self.store.mfa_confirm_enrollment(self.session_context["userId"], code)
        if backup_codes is None:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_code", "TOTP code did not match — try again"); return
        ip = self.headers.get("X-Forwarded-For", self.client_address[0])
        self.store.audit(self.organization_id, self.session_context["userId"], self.session_context["role"], "mfa.enroll", "session", None, "ok", ip)
        self._json(HTTPStatus.OK, {"activated": True, "backupCodes": backup_codes})

    def _handle_mfa_disable(self) -> None:
        if not self.session_context:
            self._error(HTTPStatus.UNAUTHORIZED, "unauthenticated", "Login required"); return
        self.store.mfa_disable(self.session_context["userId"])
        ip = self.headers.get("X-Forwarded-For", self.client_address[0])
        self.store.audit(self.organization_id, self.session_context["userId"], self.session_context["role"], "mfa.disable", "session", None, "ok", ip)
        self._json(HTTPStatus.OK, {"disabled": True})

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
    def _webhook_flush_loop(s: WorkspaceStore) -> None:
        import time as _time
        while True:
            _time.sleep(300)
            try:
                s.flush_webhook_events()
            except Exception as _e:
                LOGGER.warning(json.dumps({"event": "webhook_flush_error", "error": str(_e)}))

    def _maintenance_loop(s: WorkspaceStore, srv: Any) -> None:
        import time as _time
        while True:
            _time.sleep(3600)  # hourly
            try:
                with s._connect() as _conn:
                    _orgs = [r["id"] for r in _conn.execute("SELECT id FROM organizations").fetchall()]
                _ai = getattr(srv, "ai_gateway", None)
                for _oid in _orgs:
                    s.sweep_overdue_items(_oid)
                    s.run_due_scheduled_reports(_oid)
                    s.poll_all_due_inboxes(_oid, _ai)
            except Exception as _e:
                LOGGER.warning(json.dumps({"event": "maintenance_loop_error", "error": str(_e)}))

    def _email_poll_loop(s: WorkspaceStore, srv: Any) -> None:
        """Shorter poll loop for email (every 5 min) — only if any inbox is configured."""
        import time as _time
        while True:
            _time.sleep(300)
            try:
                with s._connect() as _conn:
                    _orgs = [r["id"] for r in _conn.execute(
                        "SELECT DISTINCT organization_id as id FROM email_inbox_configs WHERE enabled=1"
                    ).fetchall()]
                _ai = getattr(srv, "ai_gateway", None)
                for _oid in _orgs:
                    s.poll_all_due_inboxes(_oid, _ai)
            except Exception as _e:
                LOGGER.warning(json.dumps({"event": "email_poll_error", "error": str(_e)}))

    threading.Thread(target=_webhook_flush_loop, args=(store,), daemon=True, name="webhook-flush").start()
    initial_password = store.ensure_initial_credentials()
    if initial_password:
        LOGGER.warning(json.dumps({"event": "initial_admin_password", "email": "admin@local.rackpilot", "password": initial_password, "note": "Change this at Admin → Security. Shown only once."}))
    # Ensure privacy defaults for all orgs
    try:
        with store._connect() as _conn:
            _orgs = [r["id"] for r in _conn.execute("SELECT id FROM organizations").fetchall()]
        for _oid in _orgs:
            store.ensure_privacy_defaults(_oid)
            store.run_retention_purge(_oid)
            store.expire_ai_approvals(_oid)
    except Exception as _e:
        LOGGER.warning(json.dumps({"event": "privacy_init_failed", "error": str(_e)}))
    # Write agent context snapshot for filesystem-based agents (Codex)
    try:
        _write_agent_context_file(_build_agent_context(store), Path(__file__).parent.parent)
        LOGGER.info(json.dumps({"event": "agent_context_written", "path": "docs/AGENT_CONTEXT.json"}))
    except Exception as _e:
        LOGGER.warning(json.dumps({"event": "agent_context_write_failed", "error": str(_e)}))
    # Start webhook delivery worker
    _webhook_worker = WebhookDeliveryWorker(store)
    _webhook_worker.start()

    server = FieldOSServer((args.host, args.port), store, agent_token)
    threading.Thread(target=_maintenance_loop, args=(store, server), daemon=True, name="maintenance").start()
    threading.Thread(target=_email_poll_loop, args=(store, server), daemon=True, name="email-poll").start()

    def stop(_signum: int, _frame: Any) -> None:
        _webhook_worker.stop()
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
