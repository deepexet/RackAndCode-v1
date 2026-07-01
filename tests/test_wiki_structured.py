import json
import io
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from server.app import DEFAULT_ORGANIZATION_ID, WorkspaceStore, role_can, validate_generated_diagram
from server.migrations import MigrationRunner

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

try:
    from fastapi.testclient import TestClient
    from app.core.config import settings
    from app.main import app
    from app.middleware import auth
    from app.routes.wiki import _validate_generated_diagram
    FASTAPI_AVAILABLE = True
except ModuleNotFoundError:
    FASTAPI_AVAILABLE = False


class StructuredWikiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = WorkspaceStore(Path(self.temp_dir.name) / "workspace.db")
        self.org = DEFAULT_ORGANIZATION_ID
        self.store.get(self.org)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_pinned_structured_page_and_diagram_link_round_trip(self):
        diagram = self.store.create_wiki_page(
            self.org, {"title": "Door wiring", "pageType": "schema"}, actor="manager"
        )
        page = self.store.create_wiki_page(
            self.org,
            {
                "title": "Rack A",
                "isPinned": True,
                "structuredData": {"rack": "A", "units": 42},
                "diagramPageId": diagram["id"],
            },
            actor="manager",
        )

        self.assertEqual(page["is_pinned"], 1)
        self.assertEqual(json.loads(page["structured_data"]), {"rack": "A", "units": 42})
        self.assertEqual(page["diagram_page_id"], diagram["id"])
        self.assertEqual(self.store.list_wiki_pages(self.org)[0]["id"], page["id"])

    def test_structured_wiki_migration_is_idempotent(self):
        result = MigrationRunner(
            self.store.db_path, Path(__file__).resolve().parents[1] / "server" / "migrations"
        ).apply()
        self.assertEqual(result.current_version, "106")
        self.assertEqual(result.applied, ())

    def test_ensure_column_repairs_missing_column_and_accepts_existing_column(self):
        migrations = Path(self.temp_dir.name) / "repair-migrations"
        migrations.mkdir()
        (migrations / "001_base.sql").write_text(
            "CREATE TABLE IF NOT EXISTS sample (id TEXT PRIMARY KEY);\n", encoding="utf-8"
        )
        (migrations / "002_repair.sql").write_text(
            "-- ensure-column sample value TEXT NOT NULL DEFAULT ''\n",
            encoding="utf-8",
        )

        missing_db = Path(self.temp_dir.name) / "missing-column.db"
        MigrationRunner(missing_db, migrations).apply()
        with sqlite3.connect(missing_db) as conn:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(sample)")}
        self.assertIn("value", columns)

        existing_db = Path(self.temp_dir.name) / "existing-column.db"
        with sqlite3.connect(existing_db) as conn:
            conn.execute("CREATE TABLE sample (id TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')")
        result = MigrationRunner(existing_db, migrations).apply()
        self.assertEqual(result.current_version, "002")

    def test_diagram_link_cannot_cross_tenant(self):
        diagram = self.store.create_wiki_page(
            self.org, {"title": "Tenant A diagram", "pageType": "schema"}
        )
        other_org = "other-org"
        self.store.get(other_org)
        with self.assertRaisesRegex(ValueError, "this organization"):
            self.store.create_wiki_page(
                other_org, {"title": "Bad link", "diagramPageId": diagram["id"]}
            )

    def test_project_link_cannot_cross_tenant(self):
        project = self.store.create_project(self.org, {"code": "A-1", "name": "Tenant A"})
        other_org = "other-org"
        self.store.get(other_org)
        with self.assertRaisesRegex(ValueError, "this organization"):
            self.store.create_wiki_page(
                other_org, {"title": "Bad project", "projectId": project["id"]}
            )

    def test_wiki_writes_have_dedicated_permission(self):
        self.assertFalse(role_can("Technician", "wikiManage"))
        self.assertTrue(role_can("Supervisor", "wikiManage"))
        self.assertTrue(role_can("ProjectManager", "wikiManage"))

    def test_structured_data_validation_rolls_back(self):
        with self.assertRaisesRegex(ValueError, "object or array"):
            self.store.create_wiki_page(
                self.org, {"title": "Invalid", "structuredData": "secret"}
            )
        self.assertEqual(self.store.list_wiki_pages(self.org), [])

    def test_attachment_rejects_non_http_sources(self):
        with self.assertRaisesRegex(ValueError, "public HTTP"):
            self.store.download_wiki_attachment(
                self.org, None, "file:///etc/passwd", "passwd", actor="manager"
            )

    def test_org_attachment_is_audited_after_storage(self):
        response = io.BytesIO(b"manual")
        response.headers = {"Content-Length": "6"}
        with (
            patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))]),
            patch("urllib.request.OpenerDirector.open", return_value=response),
            patch("pathlib.Path.write_bytes", return_value=6),
        ):
            attachment = self.store.download_wiki_attachment(
                self.org, None, "https://example.com/manual.pdf", "manual.pdf", actor="manager"
            )

        with self.store._connect() as conn:
            audit = conn.execute(
                "SELECT action, target_id FROM audit_log WHERE organization_id=? AND target_id=?",
                (self.org, attachment["id"]),
            ).fetchone()
        self.assertIsNotNone(audit)
        self.assertEqual(audit["action"], "wiki.attach")

    @unittest.skipUnless(FASTAPI_AVAILABLE, "FastAPI test dependencies are not installed")
    def test_generated_diagram_validation_rejects_dangling_wire(self):
        with self.assertRaisesRegex(ValueError, "endpoints"):
            _validate_generated_diagram(
                {
                    "name": "Door",
                    "components": [{"id": "c1", "type": "ict_wx", "x": 100, "y": 100}],
                    "wires": [{
                        "id": "w1", "color": "#e53935",
                        "from": {"compId": "c1", "termId": "pwr_v"},
                        "to": {"compId": "missing", "termId": "v12"},
                    }],
                    "labels": [],
                }
            )

    def test_legacy_diagram_validation_rejects_dangling_wire(self):
        with self.assertRaisesRegex(ValueError, "endpoints"):
            validate_generated_diagram(
                {
                    "name": "Door",
                    "components": [{"id": "c1", "type": "ict_wx", "x": 100, "y": 100}],
                    "wires": [{
                        "id": "w1", "color": "#e53935",
                        "from": {"compId": "c1", "termId": "pwr_v"},
                        "to": {"compId": "missing", "termId": "v12"},
                    }],
                    "labels": [],
                }
            )

    def test_generated_diagram_rejects_svg_attribute_injection(self):
        diagram = {
            "name": "Door",
            "components": [{"id": 'c1\" onload=\"alert(1)', "type": "ict_wx", "x": 100, "y": 100}],
            "wires": [],
            "labels": [],
        }
        with self.assertRaisesRegex(ValueError, "safe identifiers"):
            validate_generated_diagram(diagram)

    def test_generated_diagram_rejects_unsafe_label_attributes(self):
        diagram = {
            "name": "Door",
            "components": [],
            "wires": [],
            "labels": [{
                "id": "label1", "text": "note", "x": 100, "y": 100,
                "size": 13, "color": '#fff\" onload=\"alert(1)',
            }],
        }
        with self.assertRaisesRegex(ValueError, "label color"):
            validate_generated_diagram(diagram)

    def test_generated_diagram_rejects_unsafe_terminal_identifier(self):
        diagram = {
            "name": "Door",
            "components": [
                {"id": "c1", "type": "ict_wx", "x": 100, "y": 100},
                {"id": "c2", "type": "reader_wiegand", "x": 300, "y": 100},
            ],
            "wires": [{
                "id": "w1", "color": "#1565c0",
                "from": {"compId": "c1", "termId": 'd0\" onload=\"alert(1)'},
                "to": {"compId": "c2", "termId": "d0"},
            }],
            "labels": [],
        }
        with self.assertRaisesRegex(ValueError, "safe terminal IDs"):
            validate_generated_diagram(diagram)

    def test_generated_diagram_rejects_cross_kind_id_collision(self):
        diagram = {
            "name": "Door",
            "components": [{"id": "shared", "type": "ict_wx", "x": 100, "y": 100}],
            "wires": [{
                "id": "shared", "color": "#1565c0",
                "from": {"compId": "shared", "termId": "r1_d0"},
                "to": {"compId": "shared", "termId": "r1_d1"},
            }],
            "labels": [],
        }
        with self.assertRaisesRegex(ValueError, "wire IDs"):
            validate_generated_diagram(diagram)


@unittest.skipUnless(FASTAPI_AVAILABLE, "FastAPI test dependencies are not installed")
class StructuredWikiRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = settings.db_path
        self.original_lan_mode = settings.lan_mode
        settings.db_path = Path(self.temp_dir.name) / "wiki-routes.db"
        settings.lan_mode = True
        auth._store = None
        self.client_context = TestClient(app)
        self.client = self.client_context.__enter__()
        store = auth.get_store()
        store.create_organization(settings.default_org, "Wiki tenant", settings.default_org)

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        auth._store = None
        settings.db_path = self.original_db_path
        settings.lan_mode = self.original_lan_mode
        self.temp_dir.cleanup()

    def test_wiki_routes_enforce_read_and_manage_permissions(self):
        self.assertEqual(self.client.get("/api/v1/wiki").status_code, 401)
        technician = {"X-RackPilot-Role": "Technician"}
        supervisor = {"X-RackPilot-Role": "Supervisor"}
        self.assertEqual(self.client.get("/api/v1/wiki", headers=technician).status_code, 200)
        self.assertEqual(
            self.client.post("/api/v1/wiki", headers=technician, json={"title": "Denied"}).status_code,
            403,
        )
        response = self.client.post(
            "/api/v1/wiki",
            headers=supervisor,
            json={"title": "Pinned", "isPinned": True, "structuredData": {"rack": "A"}},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["page"]["is_pinned"], 1)

    def test_invalid_cross_tenant_diagram_link_returns_400(self):
        store = auth.get_store()
        store.create_organization("other-wiki-org", "Other wiki tenant", "other-wiki-org")
        diagram = store.create_wiki_page(
            "other-wiki-org", {"title": "Private diagram", "pageType": "schema"}
        )
        response = self.client.post(
            "/api/v1/wiki",
            headers={"X-RackPilot-Role": "Supervisor"},
            json={"title": "Bad link", "diagramPageId": diagram["id"]},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"]["code"], "invalid_request")


if __name__ == "__main__":
    unittest.main()
