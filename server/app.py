#!/usr/bin/env python3
"""Dependency-free local API and static server for the FieldOS workspace."""

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
import sqlite3
import secrets
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import parse_qs, urlparse

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
TASK_PROGRESS = {"ideas": 0, "backlog": 0, "ready": 10, "progress": 50, "blocked": 25, "review": 75, "testing": 90, "done": 100}
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
    configured=os.getenv("FIELDOS_AGENT_TOKEN")
    if configured: return configured,None
    token_path=db_path.parent / "agent.token"
    if token_path.exists(): return token_path.read_text(encoding="utf-8").strip(),token_path
    token_path.parent.mkdir(parents=True,exist_ok=True)
    token_path.write_text(secrets.token_urlsafe(32),encoding="utf-8")
    token_path.chmod(0o600)
    return token_path.read_text(encoding="utf-8").strip(),token_path


class WorkspaceStore:
    """SQLite-backed tenant workspaces with optimistic concurrency."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.migration_result = MigrationRunner(db_path, MIGRATIONS_DIR).apply()
        self._seal_legacy_audit_events()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.db_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=5000")
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
        result = []
        for project in projects:
            project_id = project["id"]
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
            progress = round(sum(TASK_PROGRESS.get(status, 0) for status in task_states) / len(task_states)) if task_states else 0
            work_type_progress = []
            for work_type in work_types:
                typed_items = [item for item in project_items if item["work_type_id"] == work_type["id"]]
                typed_states = [item["effective_status"] for item in typed_items]
                latest_by_scope: dict[tuple[str, str], dict[str, Any]] = {}
                for update in project_updates:
                    if update["work_type_id"] == work_type["id"]:
                        latest_by_scope.setdefault((update["location_id"], update["action_id"]), update)
                field_values = [update["percent_complete"] for update in latest_by_scope.values()]
                typed_progress = round(sum(field_values) / len(field_values)) if field_values else (round(sum(TASK_PROGRESS.get(status, 0) for status in typed_states) / len(typed_states)) if typed_states else 0)
                work_type_progress.append({
                    "id": work_type["id"], "code": work_type["code"], "name": work_type["name"],
                    "color": work_type["color"], "taskCount": len(typed_items), "progress": typed_progress,
                    "done": sum(status == "done" for status in typed_states),
                    "blocked": sum(status == "blocked" for status in typed_states),
                    "fieldUpdateCount": len(latest_by_scope),
                })
            work_type_by_id = {value["id"]: value["name"] for value in work_types}
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
                } for value in work_types],
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
                connection.execute(
                    """INSERT INTO project_change_log
                       (organization_id, id, project_id, entity_type, entity_id, action, old_value, new_value, source, created_at)
                       VALUES (?, ?, ?, 'project', ?, 'created', '{}', ?, 'api', ?)""",
                    (organization_id, str(uuid.uuid4()), project_id, project_id, json.dumps({"code": code.strip().upper(), "name": name.strip()}), now),
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
    server_version = "Valeronix/0.23"

    @property
    def store(self) -> WorkspaceStore:
        return self.server.store  # type: ignore[attr-defined]

    def do_GET(self) -> None:
        self._start_request()
        path = urlparse(self.path).path
        if path in {"/api/health", "/api/v1/health"}:
            self._json(HTTPStatus.OK, {"status": "ok", "service": "fieldos-local", "apiVersion": "v1", "schemaVersion": self.store.migration_result.current_version, "time": utc_now()})
            return
        if path == "/api/v1/organizations":
            self._json(HTTPStatus.OK, {"organizations": self.store.list_organizations()})
            return
        if path == "/api/v1/audit/integrity":
            if not self._require_organization():
                return
            project_id = parse_qs(urlparse(self.path).query).get("projectId", [None])[0]
            self._json(HTTPStatus.OK, self.store.verify_audit_integrity(self.organization_id, project_id))
            return
        if path == "/api/v1/admin/compute-nodes":
            if not self._require_organization(): return
            self._json(HTTPStatus.OK,{"organizationId":self.organization_id,"nodes":self.store.list_compute_nodes(self.organization_id)})
            return
        if path == "/api/v1/admin/work-types":
            if not self._require_organization(): return
            self._json(HTTPStatus.OK,{"organizationId":self.organization_id,"workTypes":self.store.list_workflow_configuration(self.organization_id)})
            return
        if path == "/api/v1/admin/custom-fields":
            if not self._require_organization(): return
            self._json(HTTPStatus.OK,{"organizationId":self.organization_id,"customFields":self.store.list_custom_field_definitions(self.organization_id)})
            return
        if path == "/api/v1/development-agent/status":
            if not self._require_organization(): return
            self._json(HTTPStatus.OK,{"organizationId":self.organization_id,"agent":self.store.get_development_agent_status(self.organization_id)})
            return
        if path == "/api/v1/projects":
            if not self._require_organization():
                return
            self._json(HTTPStatus.OK, {"organizationId": self.organization_id, "projects": self.store.list_projects(self.organization_id)})
            return
        if path.startswith("/api/v1/projects/"):
            if not self._require_organization():
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
        if path in {"/api/workspace", "/api/v1/workspace"}:
            if not self._require_organization():
                return
            self._json(HTTPStatus.OK, self.store.get(self.organization_id))
            return
        if path == "/api/v1/openapi.yaml":
            self._serve_file(OPENAPI_PATH, "application/yaml; charset=utf-8")
            return
        self._serve_static(path)

    def do_PUT(self) -> None:
        self._start_request()
        if urlparse(self.path).path not in {"/api/workspace", "/api/v1/workspace"}:
            self._error(HTTPStatus.NOT_FOUND, "not_found", "Route not found")
            return
        if not self._require_organization():
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
        if path=="/api/v1/admin/work-types":
            if not self._require_organization(): return
            try:
                payload=self._read_json()
                if not isinstance(payload,dict): raise ValueError("JSON object expected")
                self._json(HTTPStatus.CREATED,{"organizationId":self.organization_id,"workType":self.store.save_workflow_configuration(self.organization_id,payload)})
            except (ValueError,json.JSONDecodeError) as error: self._error(HTTPStatus.BAD_REQUEST,"invalid_request",str(error))
            return
        if path=="/api/v1/admin/custom-fields":
            if not self._require_organization(): return
            try:
                payload=self._read_json()
                if not isinstance(payload,dict): raise ValueError("JSON object expected")
                self._json(HTTPStatus.CREATED,{"organizationId":self.organization_id,"customField":self.store.save_custom_field_definition(self.organization_id,payload)})
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
        if path != "/api/v1/projects" and not path.startswith("/api/v1/projects/"):
            self._error(HTTPStatus.NOT_FOUND, "not_found", "Route not found")
            return
        if not self._require_organization():
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
        if not self._require_organization():
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
        candidate = self.headers.get("X-Request-ID", "")
        self.request_id = candidate if 0 < len(candidate) <= 64 and all(character.isalnum() or character in "-_." for character in candidate) else str(uuid.uuid4())
        organization = self.headers.get("X-Organization-ID", DEFAULT_ORGANIZATION_ID)
        self.organization_id = organization if 0 < len(organization) <= 64 and all(character.isalnum() or character in "-_" for character in organization) else ""

    def _require_organization(self) -> bool:
        if not self.organization_id or not self.store.organization_exists(self.organization_id):
            self._error(HTTPStatus.NOT_FOUND, "organization_not_found", "Organization does not exist or is inactive")
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

    def _json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._security_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _error(self, status: HTTPStatus, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        self._json(status, {"error": {"code": code, "message": message, "details": details or {}}, "requestId": self.request_id})

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-API-Version", "1")
        self.send_header("X-Request-ID", getattr(self, "request_id", "static"))
        self.send_header("X-Organization-ID", getattr(self, "organization_id", DEFAULT_ORGANIZATION_ID))
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")

    def log_message(self, format: str, *args: Any) -> None:
        LOGGER.info(json.dumps({"event": "http_request", "client": self.client_address[0], "method": self.command, "path": self.path, "message": format % args}))


class FieldOSServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: WorkspaceStore, agent_token: str):
        super().__init__(address, FieldOSHandler)
        self.store = store
        self.agent_token = agent_token


def main() -> None:
    parser = argparse.ArgumentParser(description="FieldOS local development server")
    parser.add_argument("--host", default=os.getenv("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "4173")))
    parser.add_argument("--db", type=Path, default=Path(os.getenv("FIELDOS_DB", DEFAULT_DB)))
    args = parser.parse_args()

    agent_token,agent_token_path=ensure_agent_token(args.db)
    server = FieldOSServer((args.host, args.port), WorkspaceStore(args.db),agent_token)

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
    LOGGER.info(json.dumps({"event":"agent_enrollment","tokenPath":str(agent_token_path) if agent_token_path else "FIELDOS_AGENT_TOKEN"}))
    if args.host in {"0.0.0.0", "::"}:
        LOGGER.warning(json.dumps({"event": "security_notice", "message": "LAN mode has no authentication; use only on a trusted network"}))
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
        LOGGER.info(json.dumps({"event": "server_stopped"}))


if __name__ == "__main__":
    main()
