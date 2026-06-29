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


if __name__ == "__main__":
    unittest.main()
