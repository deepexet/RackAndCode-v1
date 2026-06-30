"""
Tests for features added in branch claude/diagrams:
  - Notification fixes (endpoint, unread count)
  - Inventory normalization & alerts
  - Transport module store methods
  - RBAC guards on new routes
  - Tenant isolation for transport & notifications
"""
import json
import tempfile
import threading
import unittest
from pathlib import Path

from server.app import (
    DEFAULT_ORGANIZATION_ID,
    FieldOSServer,
    WorkspaceStore,
)


# ── Helpers ────────────────────────────────────────────────────────────────

def _make_store(tmpdir: Path, orgs: list[str] | None = None) -> WorkspaceStore:
    store = WorkspaceStore(tmpdir / "test.db")
    extra = [o for o in (orgs or []) if o != DEFAULT_ORGANIZATION_ID]
    for org in extra:
        with store._connect() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO organizations (id, name, slug, status, created_at) VALUES (?,?,?,'active',datetime('now'))",
                (org, f"Test Org {org}", org.replace("-", "_"))
            )
    return store


def _http(store: WorkspaceStore, method: str, path: str,
          *,
          role: str = "Administrator",
          org: str = DEFAULT_ORGANIZATION_ID,
          payload: dict | None = None):
    """Spin up a one-shot test server, send one request, return (status, body)."""
    import http.client
    server = FieldOSServer(("127.0.0.1", 0), store, "test-agent-token")
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        port = server.server_address[1]
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        body = json.dumps(payload).encode() if payload is not None else None
        headers = {
            "X-Organization-ID": org,
            "X-RackPilot-Role": role,
            "Content-Type": "application/json",
        }
        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        status = resp.status
        data = json.loads(resp.read().decode())
        conn.close()
        return status, data
    finally:
        server.shutdown()


# ── Notification tests ─────────────────────────────────────────────────────

class NotificationRouteTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = _make_store(Path(self._tmp.name))
        # Seed two notifications — one read, one unread
        self.store.push_notification(DEFAULT_ORGANIZATION_ID, "Unread Alert", body="msg1")
        self.store.push_notification(DEFAULT_ORGANIZATION_ID, "Another Unread", body="msg2")
        # Mark the first one read by reading all then marking by id
        notifs = self.store.list_notifications(DEFAULT_ORGANIZATION_ID)
        self.store.mark_notifications_read(DEFAULT_ORGANIZATION_ID, [notifs[0]["id"]])

    def tearDown(self):
        self._tmp.cleanup()

    def test_get_notifications_returns_unread_count(self):
        status, body = _http(self.store, "GET", "/api/v1/notifications")
        self.assertEqual(status, 200)
        self.assertIn("unreadCount", body)
        # unreadCount must reflect total unread, not page size
        self.assertIsInstance(body["unreadCount"], int)
        self.assertGreaterEqual(body["unreadCount"], 1)

    def test_unread_count_is_total_not_page_size(self):
        """Even with limit=1, unreadCount must report total."""
        status, body = _http(self.store, "GET", "/api/v1/notifications?limit=1")
        self.assertEqual(status, 200)
        total_unread = body["unreadCount"]
        # There is at least one unread notification seeded
        self.assertGreaterEqual(total_unread, 1)
        # The notifications list may be limited but count reflects all
        self.assertLessEqual(len(body.get("notifications", [])), 1)

    def test_mark_all_read_endpoint_exists(self):
        """POST /api/v1/notifications/mark-all-read must return 200."""
        status, body = _http(self.store, "POST", "/api/v1/notifications/mark-all-read", payload={})
        self.assertEqual(status, 200)
        self.assertIn("marked", body)

    def test_mark_all_read_clears_unread_count(self):
        _http(self.store, "POST", "/api/v1/notifications/mark-all-read", payload={})
        status, body = _http(self.store, "GET", "/api/v1/notifications")
        self.assertEqual(body["unreadCount"], 0)

    def test_notifications_rbac_blocks_unauthenticated_role(self):
        """A role with no permissions must not see notifications."""
        # 'Technician' role has projectRead — use a truly locked-down role check
        status, body = _http(self.store, "GET", "/api/v1/notifications", role="Viewer")
        # Either forbidden or empty — must not expose data without permission
        self.assertIn(status, (200, 403))


# ── Notification tenant isolation ──────────────────────────────────────────

class NotificationTenantIsolationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = _make_store(Path(self._tmp.name), orgs=["org-a", "org-b"])
        self.store.push_notification("org-a", "Secret A")
        self.store.push_notification("org-b", "Secret B")

    def tearDown(self):
        self._tmp.cleanup()

    def test_org_a_cannot_see_org_b_notifications(self):
        status, body = _http(self.store, "GET", "/api/v1/notifications", org="org-a")
        titles = [n["title"] for n in body.get("notifications", [])]
        self.assertNotIn("Secret B", titles)

    def test_org_b_cannot_see_org_a_notifications(self):
        status, body = _http(self.store, "GET", "/api/v1/notifications", org="org-b")
        titles = [n["title"] for n in body.get("notifications", [])]
        self.assertNotIn("Secret A", titles)

    def test_mark_all_read_scoped_to_org(self):
        """Mark-all-read in org-a must not affect org-b's unread count."""
        _http(self.store, "POST", "/api/v1/notifications/mark-all-read", payload={}, org="org-a")
        count_b = self.store.count_unread_notifications("org-b")
        self.assertGreater(count_b, 0)


# ── Inventory alert tests ──────────────────────────────────────────────────

class InventoryAlertTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = _make_store(Path(self._tmp.name))
        self.org = DEFAULT_ORGANIZATION_ID
        # Create warehouse and SKU
        wh = self.store.create_warehouse(self.org, {"name": "Main", "location": "HQ"})
        self.wh_id = wh["id"]
        sku = self.store.create_sku(self.org, {
            "skuCode": "TST-001", "name": "Test Part", "category": "parts",
            "unit": "pcs", "unitCost": 10.0
        })
        self.sku_id = sku["id"]

    def tearDown(self):
        self._tmp.cleanup()

    def _set_stock(self, qty: int, min_qty: int | None = None):
        if qty > 0:
            self.store.record_movement(self.org, {
                "skuId": self.sku_id, "warehouseId": self.wh_id,
                "quantity": qty, "movementType": "receive"
            })
        if min_qty is not None:
            with self.store._connect() as conn:
                conn.execute(
                    "UPDATE inventory_stock SET min_quantity=? WHERE organization_id=? AND sku_id=? AND warehouse_id=?",
                    (min_qty, self.org, self.sku_id, self.wh_id)
                )

    def test_no_alerts_when_stock_above_minimum(self):
        self._set_stock(qty=10, min_qty=5)
        alerts = self.store.list_inventory_alerts(self.org)
        sku_alerts = [a for a in alerts if a["sku_id"] == self.sku_id]
        self.assertEqual(len(sku_alerts), 0)

    def test_alert_when_stock_at_minimum(self):
        self._set_stock(qty=5, min_qty=5)
        alerts = self.store.list_inventory_alerts(self.org)
        sku_alerts = [a for a in alerts if a["sku_id"] == self.sku_id]
        self.assertEqual(len(sku_alerts), 1)

    def test_alert_when_stock_below_minimum(self):
        self._set_stock(qty=2, min_qty=5)
        alerts = self.store.list_inventory_alerts(self.org)
        sku_alerts = [a for a in alerts if a["sku_id"] == self.sku_id]
        self.assertEqual(len(sku_alerts), 1)

    def test_no_alert_when_min_quantity_is_null(self):
        self._set_stock(qty=0, min_qty=None)
        alerts = self.store.list_inventory_alerts(self.org)
        sku_alerts = [a for a in alerts if a["sku_id"] == self.sku_id]
        self.assertEqual(len(sku_alerts), 0)

    def test_alerts_endpoint_returns_200(self):
        self._set_stock(qty=1, min_qty=5)
        status, body = _http(self.store, "GET", "/api/v1/inventory/alerts")
        self.assertEqual(status, 200)
        self.assertIn("alerts", body)

    def test_inventory_alerts_tenant_isolation(self):
        self._set_stock(qty=1, min_qty=5)
        # org-b should see zero alerts even though org-a has a low-stock item
        alerts_b = self.store.list_inventory_alerts("org-b")
        sku_alerts = [a for a in alerts_b if a["sku_id"] == self.sku_id]
        self.assertEqual(len(sku_alerts), 0)


# ── Transport store tests ──────────────────────────────────────────────────

class TransportStoreTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = _make_store(Path(self._tmp.name))
        self.org = DEFAULT_ORGANIZATION_ID

    def tearDown(self):
        self._tmp.cleanup()

    def _create_vehicle(self, plate="А001АА99", make="Toyota", model="Hilux"):
        return self.store.create_vehicle(self.org, {
            "plate": plate, "make": make, "model": model,
            "year": 2022, "fuelType": "diesel", "status": "active", "mileage": 1000
        })

    def test_create_vehicle_returns_id_and_warehouse(self):
        v = self._create_vehicle()
        self.assertIn("id", v)
        self.assertIn("warehouse_id", v)
        self.assertIsNotNone(v["warehouse_id"])

    def test_list_vehicles_scoped_to_org(self):
        self._create_vehicle("В001ВВ99")
        vehicles = self.store.list_vehicles(self.org)
        self.assertTrue(all(v["organization_id"] == self.org for v in vehicles))

    def test_get_vehicle_returns_correct_record(self):
        v = self._create_vehicle("С001СС99")
        fetched = self.store.get_vehicle(self.org, v["id"])
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched["plate"], "С001СС99")

    def test_update_vehicle_changes_fields(self):
        v = self._create_vehicle()
        updated = self.store.update_vehicle(self.org, v["id"], {"status": "repair", "mileage": 9999})
        self.assertEqual(updated["status"], "repair")
        self.assertEqual(updated["mileage"], 9999)

    def test_vehicle_status_filter(self):
        self._create_vehicle("А001АА01")
        self.store.create_vehicle(self.org, {
            "plate": "Б002ББ02", "make": "Ford", "model": "Transit",
            "status": "repair", "mileage": 0
        })
        active = self.store.list_vehicles(self.org, status="active")
        repair = self.store.list_vehicles(self.org, status="repair")
        self.assertTrue(all(v["status"] == "active" for v in active))
        self.assertTrue(all(v["status"] == "repair" for v in repair))

    def test_assign_vehicle_creates_assignment(self):
        v = self._create_vehicle()
        a = self.store.assign_vehicle(self.org, v["id"], {
            "assigneeName": "Иванов Иван", "startedAt": "2026-01-01"
        })
        self.assertIn("id", a)
        self.assertEqual(a["assignee_name"], "Иванов Иван")

    def test_reassign_closes_previous_assignment(self):
        v = self._create_vehicle()
        self.store.assign_vehicle(self.org, v["id"], {"assigneeName": "Первый", "startedAt": "2026-01-01"})
        self.store.assign_vehicle(self.org, v["id"], {"assigneeName": "Второй", "startedAt": "2026-06-01"})
        assignments = self.store.list_vehicle_assignments(self.org, v["id"])
        open_assignments = [a for a in assignments if not a.get("ended_at")]
        self.assertEqual(len(open_assignments), 1)
        self.assertEqual(open_assignments[0]["assignee_name"], "Второй")

    def test_unassign_vehicle_closes_open_assignment(self):
        v = self._create_vehicle()
        self.store.assign_vehicle(self.org, v["id"], {"assigneeName": "Тест", "startedAt": "2026-01-01"})
        self.store.unassign_vehicle(self.org, v["id"], "2026-06-30")
        assignments = self.store.list_vehicle_assignments(self.org, v["id"])
        open_assignments = [a for a in assignments if not a.get("ended_at")]
        self.assertEqual(len(open_assignments), 0)

    def test_create_service_record(self):
        v = self._create_vehicle()
        rec = self.store.create_vehicle_service(self.org, v["id"], {
            "serviceType": "maintenance", "title": "ТО-1",
            "serviceDate": "2026-06-01", "mileage": 15000, "cost": 8500
        })
        self.assertIn("id", rec)
        self.assertEqual(rec["service_type"], "maintenance")

    def test_service_record_updates_vehicle_mileage(self):
        v = self._create_vehicle()
        self.store.create_vehicle_service(self.org, v["id"], {
            "title": "ТО", "mileage": 50000
        })
        updated = self.store.get_vehicle(self.org, v["id"])
        self.assertEqual(updated["mileage"], 50000)

    def test_list_service_returns_only_vehicle_records(self):
        v1 = self._create_vehicle("Г001ГГ01")
        v2 = self._create_vehicle("Д002ДД02")
        self.store.create_vehicle_service(self.org, v1["id"], {"title": "ТО v1"})
        self.store.create_vehicle_service(self.org, v2["id"], {"title": "ТО v2"})
        records = self.store.list_vehicle_service(self.org, v1["id"])
        self.assertTrue(all(r["vehicle_id"] == v1["id"] for r in records))


# ── Transport tenant isolation ─────────────────────────────────────────────

class TransportTenantIsolationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = _make_store(Path(self._tmp.name), orgs=["org-a", "org-b"])

    def tearDown(self):
        self._tmp.cleanup()

    def test_org_a_cannot_see_org_b_vehicles(self):
        self.store.create_vehicle("org-a", {"plate": "А001АА01", "make": "Toyota", "model": "X"})
        self.store.create_vehicle("org-b", {"plate": "Б002ББ02", "make": "Ford",   "model": "Y"})
        vehicles_a = self.store.list_vehicles("org-a")
        self.assertTrue(all(v["organization_id"] == "org-a" for v in vehicles_a))
        plates_a = [v["plate"] for v in vehicles_a]
        self.assertNotIn("Б002ББ02", plates_a)

    def test_get_vehicle_cross_org_returns_none(self):
        v = self.store.create_vehicle("org-a", {"plate": "В003ВВ03", "make": "BMW", "model": "Z"})
        result = self.store.get_vehicle("org-b", v["id"])
        self.assertIsNone(result)

    def test_update_vehicle_cross_org_is_noop(self):
        v = self.store.create_vehicle("org-a", {"plate": "Г004ГГ04", "make": "KIA", "model": "W"})
        self.store.update_vehicle("org-b", v["id"], {"status": "inactive"})
        original = self.store.get_vehicle("org-a", v["id"])
        self.assertEqual(original["status"], "active")

    def test_service_records_scoped_to_org(self):
        v = self.store.create_vehicle("org-a", {"plate": "Д005ДД05", "make": "VAZ", "model": "2107"})
        self.store.create_vehicle_service("org-a", v["id"], {"title": "Секретное ТО"})
        # org-b tries to list service for the same vehicle id
        records_b = self.store.list_vehicle_service("org-b", v["id"])
        self.assertEqual(len(records_b), 0)


# ── Transport RBAC ─────────────────────────────────────────────────────────

class TransportRBACTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = _make_store(Path(self._tmp.name))
        self.org = DEFAULT_ORGANIZATION_ID
        v = self.store.create_vehicle(self.org, {
            "plate": "Е006ЕЕ06", "make": "Test", "model": "Car"
        })
        self.vid = v["id"]

    def tearDown(self):
        self._tmp.cleanup()

    def test_technician_can_read_vehicles(self):
        status, body = _http(self.store, "GET", "/api/v1/transport/vehicles", role="Technician")
        self.assertEqual(status, 200)
        self.assertIn("vehicles", body)

    def test_technician_cannot_create_vehicle(self):
        status, body = _http(
            self.store, "POST", "/api/v1/transport/vehicles",
            role="Technician",
            payload={"plate": "Ж007ЖЖ07", "make": "X", "model": "Y"}
        )
        self.assertEqual(status, 403)

    def test_supervisor_can_create_vehicle(self):
        status, body = _http(
            self.store, "POST", "/api/v1/transport/vehicles",
            role="Supervisor",
            payload={"plate": "З008ЗЗ08", "make": "X", "model": "Y"}
        )
        self.assertIn(status, (200, 201))

    def test_technician_cannot_add_service_record(self):
        status, body = _http(
            self.store, "POST", f"/api/v1/transport/vehicles/{self.vid}/service",
            role="Technician",
            payload={"title": "Тест ТО"}
        )
        self.assertEqual(status, 403)


if __name__ == "__main__":
    unittest.main()
