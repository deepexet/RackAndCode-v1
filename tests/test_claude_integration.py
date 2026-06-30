from __future__ import annotations

import sys
import tempfile
import unittest
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import app
from app.middleware import auth


class ClaudeBatchIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.original_db_path = settings.db_path
        self.original_lan_mode = settings.lan_mode
        settings.db_path = Path(self.temporary_directory.name) / "rackpilot.db"
        settings.lan_mode = True
        auth._store = None
        self.client_context = TestClient(app)
        self.client = self.client_context.__enter__()
        self.store = auth.get_store()
        if not any(org["id"] == settings.default_org for org in self.store.list_organizations()):
            self.store.create_organization(settings.default_org, "Integration tenant", settings.default_org)

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        auth._store = None
        settings.db_path = self.original_db_path
        settings.lan_mode = self.original_lan_mode
        self.temporary_directory.cleanup()

    def test_notifications_use_authenticated_tenant_aware_router(self) -> None:
        self.store.push_notification(settings.default_org, "Integration alert")

        self.assertEqual(self.client.get("/api/v1/notifications").status_code, 401)
        self.assertEqual(
            self.client.get(
                "/api/v1/notifications", headers={"X-RackPilot-Role": "Viewer"}
            ).status_code,
            403,
        )
        response = self.client.get(
            "/api/v1/notifications?limit=1",
            headers={"X-RackPilot-Role": "Technician"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["unreadCount"], 1)

        marked = self.client.post(
            "/api/v1/notifications/mark-all-read",
            headers={"X-RackPilot-Role": "Technician"},
        )
        self.assertEqual(marked.status_code, 200)
        self.assertEqual(marked.json()["marked"], 1)

    def test_work_order_routes_enforce_read_and_manage_permissions(self) -> None:
        work_order = self.store.create_work_order(
            settings.default_org, {"title": "Secure integration work order"}
        )
        technician = {"X-RackPilot-Role": "Technician"}
        supervisor = {"X-RackPilot-Role": "Supervisor"}

        self.assertEqual(
            self.client.get(f"/api/v1/work-orders/{work_order['id']}", headers=technician).status_code,
            200,
        )
        self.assertEqual(
            self.client.post(
                f"/api/v1/work-orders/{work_order['id']}/tasks",
                headers=technician,
                json={"title": "Forbidden task"},
            ).status_code,
            403,
        )
        created = self.client.post(
            f"/api/v1/work-orders/{work_order['id']}/tasks",
            headers=supervisor,
            json={"title": "Allowed task"},
        )
        self.assertEqual(created.status_code, 200)
        self.assertEqual(created.json()["task"]["title"], "Allowed task")

    def test_work_order_children_cannot_cross_tenant_boundary(self) -> None:
        other_org = "other-integration-tenant"
        self.store.create_organization(other_org, "Other integration tenant", other_org)
        work_order = self.store.create_work_order(
            settings.default_org, {"title": "Tenant-owned work order"}
        )

        with self.assertRaises(LookupError):
            self.store.create_wo_task(other_org, work_order["id"], {"title": "Cross tenant"})
        with self.assertRaises(LookupError):
            self.store.add_wo_comment(other_org, work_order["id"], {"body": "Cross tenant"})

        now = "2026-06-30T00:00:00+00:00"
        with self.store._connect() as connection:
            connection.execute(
                "INSERT INTO work_order_tasks(id,organization_id,work_order_id,title,completed,sort_order,created_at,updated_at) "
                "VALUES(?,?,?,?,0,0,?,?)",
                (str(uuid.uuid4()), other_org, work_order["id"], "Injected child", now, now),
            )
        detail = self.store.get_work_order(settings.default_org, work_order["id"])
        self.assertNotIn("Injected child", [task["title"] for task in detail["tasks"]])

    def test_transport_routes_enforce_permissions_and_tenant_boundary(self) -> None:
        supervisor = {"X-RackPilot-Role": "Supervisor"}
        technician = {"X-RackPilot-Role": "Technician"}
        created = self.client.post(
            "/api/v1/transport/vehicles",
            headers=supervisor,
            json={"plate": "RP-001", "make": "Ford", "model": "Transit"},
        )
        self.assertEqual(created.status_code, 200)
        vehicle_id = created.json()["vehicle"]["id"]
        self.assertEqual(
            self.client.post(
                f"/api/v1/transport/vehicles/{vehicle_id}/service",
                headers=technician,
                json={"title": "Forbidden service"},
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                "/api/v1/transport/vehicles/not-in-this-tenant/assign",
                headers=supervisor,
                json={"assigneeName": "Alex"},
            ).status_code,
            404,
        )

    def test_work_order_materials_are_persisted_and_tenant_scoped(self) -> None:
        supervisor = {"X-RackPilot-Role": "Supervisor"}
        technician = {"X-RackPilot-Role": "Technician"}
        work_order = self.store.create_work_order(settings.default_org, {"title": "Install readers"})
        sku = self.store.create_sku(
            settings.default_org,
            {"skuCode": "ACC-RDR-01", "name": "Door reader", "category": "access", "unit": "ea"},
        )
        self.assertEqual(
            self.client.post(
                f"/api/v1/work-orders/{work_order['id']}/materials",
                headers=technician,
                json={"skuId": sku["id"], "quantity": 2},
            ).status_code,
            403,
        )
        added = self.client.post(
            f"/api/v1/work-orders/{work_order['id']}/materials",
            headers=supervisor,
            json={"skuCode": "ACC-RDR-01", "quantity": 2},
        )
        self.assertEqual(added.status_code, 200)
        detail = self.client.get(
            f"/api/v1/work-orders/{work_order['id']}", headers=technician
        ).json()["workOrder"]
        self.assertEqual(len(detail["materials"]), 1)
        self.assertEqual(detail["materials"][0]["quantity"], 2)


if __name__ == "__main__":
    unittest.main()
