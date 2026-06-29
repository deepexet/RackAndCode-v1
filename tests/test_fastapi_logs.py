from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import app
from app.middleware import auth


class FastApiLogMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.original_db_path = settings.db_path
        self.original_lan_mode = settings.lan_mode
        settings.db_path = Path(self.temporary_directory.name) / "rackpilot.db"
        settings.lan_mode = True
        auth._store = None
        self.client_context = TestClient(app)
        self.client = self.client_context.__enter__()
        store = auth.get_store()
        if not any(org["id"] == settings.default_org for org in store.list_organizations()):
            store.create_organization(settings.default_org, "FastAPI test tenant", settings.default_org)

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        auth._store = None
        settings.db_path = self.original_db_path
        settings.lan_mode = self.original_lan_mode
        self.temporary_directory.cleanup()

    def test_unified_logs_apply_filters_and_tenant_scope(self) -> None:
        store = auth.get_store()
        project = store.create_project(
            settings.default_org,
            {"code": "FASTLOG", "name": "FastAPI log migration"},
        )
        store.create_organization("other-log-tenant", "Other", "other-log-tenant")
        store.create_project(
            "other-log-tenant",
            {"code": "HIDDEN", "name": "Other tenant project"},
        )

        response = self.client.get(
            "/api/v1/logs",
            params={
                "source": "project",
                "projectId": project["id"],
                "entityType": "project",
                "q": "fastapi log migration",
                "limit": 20,
            },
            headers={"X-RackPilot-Role": "Supervisor"},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["organizationId"], settings.default_org)
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["logs"][0]["projectId"], project["id"])
        self.assertNotIn("HIDDEN", str(payload))

    def test_log_routes_enforce_shared_role_permissions(self) -> None:
        technician = {"X-RackPilot-Role": "Technician"}
        supervisor = {"X-RackPilot-Role": "Supervisor"}
        administrator = {"X-RackPilot-Role": "Administrator"}

        self.assertEqual(self.client.get("/api/v1/logs", headers=technician).status_code, 403)
        self.assertEqual(self.client.get("/api/v1/logs", headers=supervisor).status_code, 200)
        self.assertEqual(
            self.client.get("/api/v1/admin/audit-log", headers=supervisor).status_code,
            403,
        )
        self.assertEqual(
            self.client.get("/api/v1/admin/audit-log", headers=administrator).status_code,
            200,
        )
        self.assertEqual(self.client.get("/api/v1/logs").status_code, 401)
        self.assertEqual(
            self.client.get("/api/v1/logs", headers={"X-RackPilot-Role": "UnknownRole"}).status_code,
            403,
        )

    def test_integrity_and_security_audit_preserve_contract_limits(self) -> None:
        store = auth.get_store()
        project = store.create_project(
            settings.default_org,
            {"code": "CHAINAPI", "name": "FastAPI audit chain"},
        )
        for index in range(3):
            store.audit(
                settings.default_org,
                f"actor-{index}",
                "Administrator",
                "test.audit",
            )

        integrity = self.client.get(
            "/api/v1/audit/integrity",
            params={"projectId": project["id"]},
            headers={"X-RackPilot-Role": "Supervisor"},
        )
        with patch.object(store, "list_audit_log", wraps=store.list_audit_log) as list_audit_log:
            audit_log = self.client.get(
                "/api/v1/admin/audit-log",
                params={"limit": 999},
                headers={"X-RackPilot-Role": "Administrator"},
            )

        self.assertEqual(integrity.status_code, 200)
        self.assertTrue(integrity.json()["valid"])
        self.assertEqual(integrity.json()["projectId"], project["id"])
        self.assertEqual(integrity.json()["eventCount"], 1)
        self.assertEqual(audit_log.status_code, 200)
        self.assertEqual(len(audit_log.json()["entries"]), 3)
        list_audit_log.assert_called_once_with(settings.default_org, 500)


if __name__ == "__main__":
    unittest.main()
