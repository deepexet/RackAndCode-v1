from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import app
from app.middleware import auth
from app.routes.admin import _extract_task_proposals


class FastApiPreviewTests(unittest.TestCase):
    def test_chat_proposals_keep_top_level_tasks_and_route_read_only_checks_locally(self) -> None:
        answer = """Next Actions:
1. Проверить статус очереди агентов
   - Цель: убедиться, что очередь работает
   - Действие: посмотреть последние задания
2. Исправить API monitor
   - Добавить тесты
"""
        proposals = _extract_task_proposals(answer, "Что делать дальше?")
        self.assertEqual([row["title"] for row in proposals], [
            "Проверить статус очереди агентов", "Исправить API monitor",
        ])
        self.assertEqual(proposals[0]["assignedAgent"], "local")
        self.assertEqual(proposals[1]["assignedAgent"], "codex")
        self.assertIn("coordinator", proposals[0]["scopePaths"])
        self.assertIn("tests", proposals[1]["scopePaths"])

    def test_dev_login_creates_an_authenticated_admin_session(self) -> None:
        original_db_path = settings.db_path
        original_lan_mode = settings.lan_mode
        with tempfile.TemporaryDirectory() as temporary_directory:
            settings.db_path = Path(temporary_directory) / "rackpilot.db"
            settings.lan_mode = True
            auth._store = None
            try:
                with TestClient(app) as client:
                    login = client.post("/api/v1/auth/dev-login")
                    self.assertEqual(login.status_code, 200)
                    self.assertEqual(login.json()["role"], "Administrator")

                    session = client.get("/api/v1/auth/me")
                    self.assertEqual(session.status_code, 200)
                    self.assertEqual(session.json()["userId"], "local-admin")
                    self.assertEqual(session.json()["org"], "local-dev")
                    self.assertEqual(auth.get_store().resolve_organization_id("default"), "local-dev")
            finally:
                auth._store = None
                settings.db_path = original_db_path
                settings.lan_mode = original_lan_mode

    def test_ai_action_requires_human_approval_and_keeps_coordinator_link(self) -> None:
        original_db_path = settings.db_path
        original_lan_mode = settings.lan_mode
        with tempfile.TemporaryDirectory() as temporary_directory:
            settings.db_path = Path(temporary_directory) / "rackpilot.db"
            settings.lan_mode = True
            auth._store = None
            try:
                with TestClient(app) as client:
                    login = client.post("/api/v1/auth/dev-login")
                    self.assertEqual(login.status_code, 200)
                    proposed = client.post("/api/v1/ai/approvals", json={
                        "actionType": "task.update",
                        "actionPayload": {"taskId": "task-1", "status": "done"},
                        "coordinatorJobId": "job-1",
                    })
                    self.assertEqual(proposed.status_code, 201, proposed.text)
                    approval = proposed.json()["approval"]
                    self.assertEqual(approval["status"], "pending")
                    self.assertEqual(approval["coordinator_job_id"], "job-1")

                    reviewed = client.post(
                        f"/api/v1/ai/approvals/{approval['id']}/review",
                        json={"decision": "approved", "note": "Verified"},
                    )
                    self.assertEqual(reviewed.status_code, 200, reviewed.text)
                    self.assertEqual(reviewed.json()["approval"]["status"], "approved")
            finally:
                auth._store = None
                settings.db_path = original_db_path
                settings.lan_mode = original_lan_mode

    def test_admin_can_control_coordinator_without_exposing_its_token(self) -> None:
        original_db_path = settings.db_path
        original_lan_mode = settings.lan_mode
        with tempfile.TemporaryDirectory() as temporary_directory:
            settings.db_path = Path(temporary_directory) / "rackpilot.db"
            settings.lan_mode = True
            auth._store = None
            try:
                with TestClient(app) as client:
                    self.assertEqual(client.post("/api/v1/auth/dev-login").status_code, 200)
                    response_payload = {"job": {"id": "job-1", "status": "running"}}
                    with patch(
                        "app.routes.admin._coordinator",
                        new=AsyncMock(return_value=response_payload),
                    ) as coordinator:
                        response = client.post("/api/v1/admin/coordinator/jobs/job-1/start", json={})

                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json(), response_payload)
                    coordinator.assert_awaited_once_with(
                        "/api/v1/jobs/job-1/start",
                        method="POST",
                        body={},
                    )
                    audit = auth.get_store().list_audit_log("local-dev", limit=10)
                    self.assertTrue(any(row["action"] == "coordinator.job.start" for row in audit))
            finally:
                auth._store = None
                settings.db_path = original_db_path
                settings.lan_mode = original_lan_mode

    def test_admin_can_read_incremental_agent_activity(self) -> None:
        original_db_path = settings.db_path
        original_lan_mode = settings.lan_mode
        with tempfile.TemporaryDirectory() as temporary_directory:
            settings.db_path = Path(temporary_directory) / "rackpilot.db"
            settings.lan_mode = True
            auth._store = None
            try:
                with TestClient(app) as client:
                    self.assertEqual(client.post("/api/v1/auth/dev-login").status_code, 200)
                    responses = [
                        {"job": {"id": "job-1", "status": "running"}},
                        {"logs": [{"id": 8, "message": "working"}]},
                        {"events": [{"eventType": "job.status_changed"}]},
                        {"review": {"dirty": True, "changeCount": 1}},
                    ]
                    with patch(
                        "app.routes.admin._coordinator",
                        new=AsyncMock(side_effect=responses),
                    ) as coordinator:
                        response = client.get("/api/v1/admin/coordinator/jobs/job-1?after=7")

                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json()["logs"][0]["id"], 8)
                    requested_paths = {call.args[0] for call in coordinator.await_args_list}
                    self.assertIn("/api/v1/jobs/job-1/logs?after=7&limit=500", requested_paths)
                    self.assertIn("/api/v1/events?jobId=job-1&limit=100", requested_paths)
            finally:
                auth._store = None
                settings.db_path = original_db_path
                settings.lan_mode = original_lan_mode

    def test_admin_can_delegate_real_kanban_item_to_recommended_agent(self) -> None:
        original_db_path = settings.db_path
        original_lan_mode = settings.lan_mode
        with tempfile.TemporaryDirectory() as temporary_directory:
            settings.db_path = Path(temporary_directory) / "rackpilot.db"
            settings.lan_mode = True
            auth._store = None
            try:
                with TestClient(app) as client:
                    self.assertEqual(client.post("/api/v1/auth/dev-login").status_code, 200)
                    store = auth.get_store()
                    project = store.create_project("local-dev", {"code": "DEV", "name": "Development"})
                    work_item = store.create_work_item("local-dev", project["id"], {
                        "title": "Design secure Wiki vault architecture",
                        "description": "Create an ADR and threat model.",
                        "status": "ready",
                        "priority": "critical",
                    })
                    coordinator_job = {
                        "id": "job-linked",
                        "status": "queued",
                        "assignedAgent": "claude",
                        "sourceOrganizationId": "local-dev",
                        "sourceProjectId": project["id"],
                        "sourceWorkItemId": work_item["id"],
                    }
                    with patch(
                        "app.routes.admin._coordinator",
                        new=AsyncMock(side_effect=[{"jobs": []}, {"job": coordinator_job}]),
                    ) as coordinator:
                        response = client.post(
                            f"/api/v1/admin/coordinator/work-items/{project['id']}/{work_item['id']}/delegate",
                            json={},
                        )

                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json()["job"]["assignedAgent"], "claude")
                    self.assertEqual(response.json()["workItem"]["status"], "progress")
                    create_payload = coordinator.await_args_list[1].kwargs["body"]
                    self.assertEqual(create_payload["sourceWorkItemId"], work_item["id"])
                    self.assertTrue(create_payload["autoWorktree"])
                    self.assertIn("docs", create_payload["scopePaths"])
            finally:
                auth._store = None
                settings.db_path = original_db_path
                settings.lan_mode = original_lan_mode

    def test_autonomous_shift_queues_ready_work_and_starts_limit_recovery(self) -> None:
        original_db_path = settings.db_path
        original_lan_mode = settings.lan_mode
        with tempfile.TemporaryDirectory() as temporary_directory:
            settings.db_path = Path(temporary_directory) / "rackpilot.db"
            settings.lan_mode = True
            auth._store = None
            try:
                with TestClient(app) as client:
                    self.assertEqual(client.post("/api/v1/auth/dev-login").status_code, 200)
                    store = auth.get_store()
                    project = store.create_project("local-dev", {"code": "AUTO", "name": "Autonomous"})
                    item = store.create_work_item("local-dev", project["id"], {
                        "title": "Implement FastAPI health endpoint", "status": "ready", "priority": "high",
                    })
                    linked_job = {
                        "id": "job-auto", "status": "queued", "assignedAgent": "codex",
                        "sourceOrganizationId": "local-dev", "sourceProjectId": project["id"],
                        "sourceWorkItemId": item["id"],
                    }
                    responses = [
                        {"shift": {"enabled": True}}, {"jobs": []}, {"job": linked_job},
                    ]
                    with patch("app.routes.admin._coordinator", new=AsyncMock(side_effect=responses)) as coordinator:
                        response = client.post("/api/v1/admin/coordinator/autonomous-shift/start", json={
                            "durationHours": 10, "maxTasks": 4, "retryMinutes": 30,
                        })
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json()["delegated"][0]["workItemId"], item["id"])
                    self.assertEqual(coordinator.await_args_list[0].args[0], "/api/v1/autonomous-shift/start")
                    refreshed = store.get_project("local-dev", project["id"])
                    updated = next(row for row in refreshed["workItems"] if row["id"] == item["id"])
                    self.assertEqual(updated["status"], "progress")
            finally:
                auth._store = None
                settings.db_path = original_db_path
                settings.lan_mode = original_lan_mode

    def test_coordinator_chat_history_is_persisted_for_the_signed_in_user(self) -> None:
        original_db_path = settings.db_path
        original_lan_mode = settings.lan_mode
        with tempfile.TemporaryDirectory() as temporary_directory:
            settings.db_path = Path(temporary_directory) / "rackpilot.db"
            settings.lan_mode = True
            auth._store = None
            try:
                with TestClient(app) as client:
                    self.assertEqual(client.post("/api/v1/auth/dev-login").status_code, 200)
                    with patch("app.routes.admin._coordinator", new=AsyncMock(return_value={
                        "answer": "Codex is waiting; Claude is available.", "context": {},
                    })) as coordinator:
                        sent = client.post("/api/v1/admin/coordinator/chat", json={"message": "What is the status?"})
                        history = client.get("/api/v1/admin/coordinator/chat")
                    self.assertEqual(sent.status_code, 200, sent.text)
                    self.assertIn(
                        "/start 10", [row["command"] for row in sent.json()["suggestedActions"]]
                    )
                    local_payload = coordinator.await_args_list[0].kwargs["body"]
                    self.assertIn("machineContext", local_payload)
                    self.assertIn("cpu", local_payload["machineContext"])
                    self.assertEqual(history.status_code, 200)
                    self.assertEqual(
                        [(row["role"], row["content"]) for row in history.json()["messages"]],
                        [("user", "What is the status?"), ("assistant", "Codex is waiting; Claude is available.")],
                    )
            finally:
                auth._store = None
                settings.db_path = original_db_path
                settings.lan_mode = original_lan_mode

    def test_coordinator_chat_delegates_to_paid_agents_only_on_explicit_command(self) -> None:
        original_db_path = settings.db_path
        original_lan_mode = settings.lan_mode
        with tempfile.TemporaryDirectory() as temporary_directory:
            settings.db_path = Path(temporary_directory) / "rackpilot.db"
            settings.lan_mode = True
            auth._store = None
            try:
                with TestClient(app) as client:
                    self.assertEqual(client.post("/api/v1/auth/dev-login").status_code, 200)
                    job = {"id": "chat-job", "status": "queued", "assignedAgent": "claude"}
                    with patch("app.routes.admin._coordinator", new=AsyncMock(return_value={"job": job})) as coordinator:
                        response = client.post(
                            "/api/v1/admin/coordinator/chat",
                            json={"message": "/claude Review the FastAPI migration strategy"},
                        )
                    self.assertEqual(response.status_code, 200, response.text)
                    payload = coordinator.await_args.kwargs["body"]
                    self.assertEqual(payload["assignedAgent"], "claude")
                    self.assertTrue(payload["createdBy"].startswith("chat:local-dev:local-admin:"))
                    self.assertIn("response will appear", response.json()["answer"])
            finally:
                auth._store = None
                settings.db_path = original_db_path
                settings.lan_mode = original_lan_mode

    def test_coordinator_chat_executes_explicit_natural_language_delegation(self) -> None:
        original_db_path = settings.db_path
        original_lan_mode = settings.lan_mode
        with tempfile.TemporaryDirectory() as temporary_directory:
            settings.db_path = Path(temporary_directory) / "rackpilot.db"
            settings.lan_mode = True
            auth._store = None
            try:
                with TestClient(app) as client:
                    self.assertEqual(client.post("/api/v1/auth/dev-login").status_code, 200)
                    job = {"id": "natural-job", "status": "queued", "assignedAgent": "codex"}
                    with patch("app.routes.admin._coordinator", new=AsyncMock(return_value={"job": job})) as coordinator:
                        response = client.post("/api/v1/admin/coordinator/chat", json={
                            "message": "Делегируй Codex проверку API monitor и начни выполнение",
                        })
                    self.assertEqual(response.status_code, 200, response.text)
                    payload = coordinator.await_args.kwargs["body"]
                    self.assertEqual(payload["assignedAgent"], "codex")
                    self.assertTrue(payload["requiresReview"])
                    self.assertIn("actually queued", response.json()["answer"])
            finally:
                auth._store = None
                settings.db_path = original_db_path
                settings.lan_mode = original_lan_mode

    def test_coordinator_chat_proposals_can_be_queued_from_widgets(self) -> None:
        original_db_path = settings.db_path
        original_lan_mode = settings.lan_mode
        with tempfile.TemporaryDirectory() as temporary_directory:
            settings.db_path = Path(temporary_directory) / "rackpilot.db"
            settings.lan_mode = True
            auth._store = None
            try:
                with TestClient(app) as client:
                    self.assertEqual(client.post("/api/v1/auth/dev-login").status_code, 200)
                    answer = "Next Actions:\n1. Fix API monitor route\n2. Add focused API tests"
                    with patch("app.routes.admin._coordinator", new=AsyncMock(return_value={
                        "answer": answer, "context": {"shift": {"enabled": True}, "report": {"counts": {}}},
                    })):
                        proposed = client.post("/api/v1/admin/coordinator/chat", json={"message": "What should we do next?"})
                    self.assertEqual(proposed.status_code, 200, proposed.text)
                    proposals = proposed.json()["proposals"]
                    self.assertEqual(len(proposals), 2)
                    job = {"id": "proposal-job", "status": "queued", "assignedAgent": proposals[0]["assignedAgent"]}
                    with patch("app.routes.admin._coordinator", new=AsyncMock(return_value={"job": job})):
                        queued = client.post(
                            f"/api/v1/admin/coordinator/chat/proposals/{proposals[0]['id']}/queue", json={}
                        )
                    self.assertEqual(queued.status_code, 200, queued.text)
                    self.assertEqual(queued.json()["proposal"]["jobId"], "proposal-job")
                    history = auth.get_store().list_coordinator_chat_proposals("local-dev", "local-admin")
                    persisted = next(row for row in history if row["id"] == proposals[0]["id"])
                    self.assertEqual(persisted["status"], "queued")
                    second_job = {
                        "id": "proposal-job-2", "status": "queued",
                        "assignedAgent": proposals[1]["assignedAgent"],
                    }
                    with patch("app.routes.admin._coordinator", new=AsyncMock(return_value={"job": second_job})):
                        queued_all = client.post(
                            "/api/v1/admin/coordinator/chat/proposals/queue-all",
                            json={"messageId": proposed.json()["messageId"]},
                        )
                    self.assertEqual(queued_all.status_code, 200, queued_all.text)
                    self.assertEqual(len(queued_all.json()["queued"]), 1)
                    persisted = auth.get_store().list_coordinator_chat_proposals("local-dev", "local-admin")
                    self.assertTrue(all(row["status"] == "queued" for row in persisted))
            finally:
                auth._store = None
                settings.db_path = original_db_path
                settings.lan_mode = original_lan_mode


if __name__ == "__main__":
    unittest.main()
