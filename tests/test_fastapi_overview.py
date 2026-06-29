from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import app
from app.middleware import auth


class FastApiOverviewMigrationTests(unittest.TestCase):
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
            store.create_organization(settings.default_org, "Overview tenant", settings.default_org)

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        auth._store = None
        settings.db_path = self.original_db_path
        settings.lan_mode = self.original_lan_mode
        self.temporary_directory.cleanup()

    def test_overview_is_tenant_scoped_and_role_protected(self) -> None:
        store = auth.get_store()
        store.create_project(settings.default_org, {"code": "VISIBLE", "name": "Visible"})
        store.create_organization("overview-other", "Other", "overview-other")
        store.create_project("overview-other", {"code": "HIDDEN", "name": "Hidden"})

        response = self.client.get(
            "/api/v1/overview/kpi",
            headers={"X-RackPilot-Role": "Technician"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["activeProjects"], 1)
        self.assertEqual(self.client.get("/api/v1/overview/kpi").status_code, 401)
        self.assertEqual(
            self.client.get(
                "/api/v1/overview/kpi",
                headers={"X-RackPilot-Role": "UnknownRole"},
            ).status_code,
            403,
        )

    def test_critical_tasks_requires_project_read(self) -> None:
        allowed = self.client.get(
            "/api/v1/critical-tasks",
            headers={"X-RackPilot-Role": "Technician"},
        )
        unknown = self.client.get(
            "/api/v1/critical-tasks",
            headers={"X-RackPilot-Role": "UnknownRole"},
        )

        self.assertEqual(allowed.status_code, 200)
        self.assertIn("tasks", allowed.json())
        self.assertEqual(unknown.status_code, 403)


if __name__ == "__main__":
    unittest.main()
