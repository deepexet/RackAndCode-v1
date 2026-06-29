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


class FastApiPreviewTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
