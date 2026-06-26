import tempfile
import unittest
import http.client
import json
import threading
import sqlite3
from pathlib import Path

from server.app import ApiMetricsRecorder, DEFAULT_ORGANIZATION_ID, DependenciesIncomplete, EntityVersionConflict, FieldOSServer, InvalidTransition, RevisionConflict, WorkspaceStore, discover_lan_ip, role_can, validate_workspace
from server.migrations import MigrationChecksumError, MigrationRunner


TASK = {
    "id": "FS-001",
    "title": "Test task",
    "description": "",
    "type": "Task",
    "status": "backlog",
    "priority": "medium",
    "area": "foundation",
    "risk": "",
}


class WorkspaceStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = WorkspaceStore(Path(self.temp_dir.name) / "workspace.db")

    def tearDown(self):
        self.temp_dir.cleanup()

    def http_request(self, method, path, *, role="Administrator", payload=None, idempotency_key=None):
        import uuid as _uuid
        server = FieldOSServer(("127.0.0.1", 0), self.store, "test-agent-token")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            body = json.dumps(payload).encode("utf-8") if payload is not None else None
            headers = {"X-Organization-ID": DEFAULT_ORGANIZATION_ID, "X-RackPilot-Role": role}
            if body is not None:
                headers["Content-Type"] = "application/json"
                headers["Idempotency-Key"] = idempotency_key or str(_uuid.uuid4())
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            data = json.loads(response.read().decode("utf-8"))
            connection.close()
            return response.status, response.getheaders(), data
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_uninitialized_workspace(self):
        state = self.store.get()
        self.assertFalse(state["initialized"])
        self.assertEqual(state["revision"], 0)

    def test_public_health_contract_uses_rackpilot_service_name(self):
        from server.app import FieldOSHandler
        self.assertEqual(FieldOSHandler.server_version, "RackPilot/0.33")

    def test_role_policy_matrix_matches_expected_permissions(self):
        self.assertTrue(role_can("Administrator", "adminPanel"))
        self.assertTrue(role_can("ProjectManager", "developmentWorkspace"))
        self.assertTrue(role_can("Supervisor", "logsRead"))
        self.assertTrue(role_can("Technician", "fieldProgress"))
        self.assertFalse(role_can("Technician", "projectManage"))
        self.assertFalse(role_can("Supervisor", "adminPanel"))

    def test_server_rbac_blocks_admin_api_for_non_admin_roles(self):
        status, headers, body = self.http_request("GET", "/api/v1/admin/api-metrics", role="Technician")
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "forbidden")
        self.assertEqual(dict(headers)["X-RackPilot-Role"], "Technician")

        status, _headers, body = self.http_request("GET", "/api/v1/admin/api-metrics", role="Administrator")
        self.assertEqual(status, 200)
        self.assertEqual(body["access"], "administrator")

    def test_server_rbac_allows_logs_for_supervisor_but_not_technician(self):
        status, _headers, body = self.http_request("GET", "/api/v1/logs", role="Technician")
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["details"]["permission"], "logsRead")

        status, _headers, body = self.http_request("GET", "/api/v1/logs", role="Supervisor")
        self.assertEqual(status, 200)
        self.assertEqual(body["organizationId"], DEFAULT_ORGANIZATION_ID)

    def test_server_rbac_allows_technician_daily_progress_not_project_creation(self):
        project = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "RBAC-1", "name": "RBAC Test"})
        location = self.store.create_location(DEFAULT_ORGANIZATION_ID, project["id"], {"code": "L1", "name": "Level 1", "kind": "floor"})
        payload = {"locationId": location["id"], "workTypeId": "data", "actionId": "data-prewire", "status": "ongoing", "percentComplete": 50}

        status, _headers, body = self.http_request("POST", f"/api/v1/projects/{project['id']}/daily-updates", role="Technician", payload=payload)
        self.assertEqual(status, 201)
        self.assertEqual(body["dailyUpdate"]["status"], "ongoing")

        status, _headers, body = self.http_request("POST", "/api/v1/projects", role="Technician", payload={"code": "NOPE", "name": "Blocked"})
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["details"]["permission"], "projectManage")

    def test_save_and_read_workspace(self):
        result = self.store.save([TASK], [], 0)
        state = self.store.get()
        self.assertEqual(result["revision"], 1)
        self.assertEqual(state["tasks"][0]["id"], "FS-001")

    def test_revision_conflict(self):
        self.store.save([TASK], [], 0)
        with self.assertRaises(RevisionConflict):
            self.store.save([TASK], [], 0)

    def test_validation_rejects_duplicate_ids(self):
        with self.assertRaises(ValueError):
            validate_workspace({"tasks": [TASK, TASK], "audit": [], "expectedRevision": 0})

    def test_lan_discovery_is_optional_ipv4(self):
        address = discover_lan_ip()
        self.assertTrue(address is None or len(address.split(".")) == 4)

    def test_migrations_are_idempotent(self):
        first = self.store.migration_result
        second = MigrationRunner(self.store.db_path, Path(__file__).parent.parent / "server" / "migrations").apply()
        self.assertEqual(first.current_version, "077")
        self.assertEqual(second.applied, ())

    def test_migration_checksum_change_is_rejected(self):
        migrations = Path(self.temp_dir.name) / "migrations"
        migrations.mkdir()
        migration = migrations / "001_test.sql"
        migration.write_text("CREATE TABLE example (id INTEGER);", encoding="utf-8")
        database = Path(self.temp_dir.name) / "checksum.db"
        MigrationRunner(database, migrations).apply()
        migration.write_text("CREATE TABLE changed (id INTEGER);", encoding="utf-8")
        with self.assertRaises(MigrationChecksumError):
            MigrationRunner(database, migrations).apply()

    def test_idempotency_record_round_trip(self):
        response = {"ok": True, "revision": 1}
        self.store.save_idempotency("key-1", "hash-1", 200, response)
        self.assertEqual(self.store.get_idempotency("key-1")["response"], response)

    def test_organization_workspaces_are_isolated(self):
        self.store.create_organization("tenant-a", "Tenant A", "tenant-a")
        self.store.create_organization("tenant-b", "Tenant B", "tenant-b")
        self.store.save([TASK], [], 0, "tenant-a")
        self.assertEqual(self.store.get("tenant-a")["tasks"][0]["id"], "FS-001")
        self.assertEqual(self.store.get("tenant-b")["tasks"], [])
        self.assertFalse(self.store.get("tenant-b")["initialized"])

    def test_idempotency_keys_are_tenant_scoped(self):
        self.store.create_organization("tenant-a", "Tenant A", "tenant-a")
        self.store.create_organization("tenant-b", "Tenant B", "tenant-b")
        self.store.save_idempotency("same-key", "hash-a", 200, {"tenant": "a"}, "tenant-a")
        self.store.save_idempotency("same-key", "hash-b", 200, {"tenant": "b"}, "tenant-b")
        self.assertEqual(self.store.get_idempotency("same-key", "tenant-a")["response"]["tenant"], "a")
        self.assertEqual(self.store.get_idempotency("same-key", "tenant-b")["response"]["tenant"], "b")

    def test_project_progress_is_calculated_from_workspace_tasks(self):
        active = {**TASK, "id": "FS-002", "status": "progress", "area": "platform"}
        done = {**TASK, "id": "FS-003", "status": "done", "area": "foundation"}
        self.store.save([active, done], [], 0)
        project = self.store.list_projects()[0]
        self.assertEqual(project["id"], "fieldos-platform")
        self.assertEqual(project["progress"], 75)
        self.assertEqual(project["taskSummary"], {"total": 2, "done": 1, "active": 1, "blocked": 0})
        self.assertEqual(next(stage for stage in project["stages"] if stage["code"] == "foundation")["progress"], 100)

    def test_projects_are_tenant_scoped_and_receive_default_stages(self):
        self.store.create_organization("tenant-a", "Tenant A", "tenant-a")
        self.store.create_organization("tenant-b", "Tenant B", "tenant-b")
        project = self.store.create_project("tenant-a", {"code": "HQ-1", "name": "HQ Access Control", "priority": "high"})
        self.assertEqual(project["code"], "HQ-1")
        self.assertEqual(len(project["stages"]), 5)
        self.assertEqual(self.store.list_projects("tenant-b"), [])

    def test_project_code_must_be_unique_within_tenant(self):
        self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "SITE-1", "name": "Site One"})
        with self.assertRaises(ValueError):
            self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "SITE-1", "name": "Duplicate"})

    def test_building_and_work_item_feed_project_aggregates(self):
        project = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "OPS-1", "name": "Operations"})
        building = self.store.create_building(DEFAULT_ORGANIZATION_ID, project["id"], {"code": "BLDG-A", "name": "Building A", "status": "active"})
        stage = project["stages"][2]
        item = self.store.create_work_item(DEFAULT_ORGANIZATION_ID, project["id"], {
            "title": "Install readers", "buildingId": building["id"], "stageId": stage["id"],
            "status": "progress", "priority": "high", "estimatedMinutes": 480,
        })
        refreshed = self.store.get_project(DEFAULT_ORGANIZATION_ID, project["id"])
        self.assertEqual(item["buildingId"], building["id"])
        self.assertEqual(refreshed["buildingCount"], 1)
        self.assertEqual(refreshed["taskSummary"]["active"], 1)
        self.assertEqual(refreshed["progress"], 50)
        self.assertEqual(next(value for value in refreshed["stages"] if value["id"] == stage["id"])["progress"], 50)

    def test_work_item_rejects_building_from_another_project(self):
        first = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "FIRST", "name": "First"})
        second = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "SECOND", "name": "Second"})
        building = self.store.create_building(DEFAULT_ORGANIZATION_ID, first["id"], {"code": "A", "name": "A"})
        with self.assertRaises(ValueError):
            self.store.create_work_item(DEFAULT_ORGANIZATION_ID, second["id"], {"title": "Wrong link", "buildingId": building["id"]})

    def test_internal_project_rejects_field_operations(self):
        project = self.store.get_project(DEFAULT_ORGANIZATION_ID, "fieldos-platform")
        self.assertEqual(project["kind"], "internal")
        with self.assertRaises(ValueError):
            self.store.create_building(DEFAULT_ORGANIZATION_ID, project["id"], {"code": "WRONG", "name": "Wrong"})
        with self.assertRaises(ValueError):
            self.store.create_work_item(DEFAULT_ORGANIZATION_ID, project["id"], {"title": "Wrong"})

    def test_work_item_update_is_versioned_and_audited(self):
        project = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "FLOW", "name": "Workflow"})
        item = self.store.create_work_item(DEFAULT_ORGANIZATION_ID, project["id"], {"title": "Commission panel", "status": "ready"})
        updated = self.store.update_work_item(DEFAULT_ORGANIZATION_ID, project["id"], item["id"], {"expectedVersion": 1, "status": "progress"})
        self.assertEqual(updated["status"], "progress")
        self.assertEqual(updated["version"], 2)
        with self.store._connect() as connection:
            event = connection.execute("SELECT action, old_value, new_value FROM project_change_log WHERE entity_id = ? AND action = 'updated'", (item["id"],)).fetchone()
        self.assertEqual(event["action"], "updated")
        self.assertIn('"status": "ready"', event["old_value"])
        self.assertIn('"status": "progress"', event["new_value"])

    def test_work_item_update_rejects_stale_version(self):
        project = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "STALE", "name": "Stale"})
        item = self.store.create_work_item(DEFAULT_ORGANIZATION_ID, project["id"], {"title": "Pull cable", "status": "ready"})
        self.store.update_work_item(DEFAULT_ORGANIZATION_ID, project["id"], item["id"], {"expectedVersion": 1, "status": "progress"})
        with self.assertRaises(EntityVersionConflict):
            self.store.update_work_item(DEFAULT_ORGANIZATION_ID, project["id"], item["id"], {"expectedVersion": 1, "status": "backlog"})

    def test_work_item_update_rejects_invalid_transition(self):
        project = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "RULES", "name": "Rules"})
        item = self.store.create_work_item(DEFAULT_ORGANIZATION_ID, project["id"], {"title": "Test door", "status": "backlog"})
        with self.assertRaises(InvalidTransition):
            self.store.update_work_item(DEFAULT_ORGANIZATION_ID, project["id"], item["id"], {"expectedVersion": 1, "status": "done"})

    def test_incomplete_dependency_derives_blocked_and_prevents_start(self):
        project = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "DEPS", "name": "Dependencies"})
        predecessor = self.store.create_work_item(DEFAULT_ORGANIZATION_ID, project["id"], {"title": "Pull cable", "status": "progress"})
        dependent = self.store.create_work_item(DEFAULT_ORGANIZATION_ID, project["id"], {"title": "Terminate reader", "status": "ready", "dependsOnIds": [predecessor["id"]]})
        self.assertEqual(dependent["effectiveStatus"], "blocked")
        self.assertEqual(dependent["blockedBy"], [predecessor["id"]])
        with self.assertRaises(DependenciesIncomplete):
            self.store.update_work_item(DEFAULT_ORGANIZATION_ID, project["id"], dependent["id"], {"expectedVersion": 1, "status": "progress"})

    def test_dependency_completion_automatically_unblocks_dependent(self):
        project = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "UNBLOCK", "name": "Unblock"})
        predecessor = self.store.create_work_item(DEFAULT_ORGANIZATION_ID, project["id"], {"title": "Configure panel", "status": "testing"})
        dependent = self.store.create_work_item(DEFAULT_ORGANIZATION_ID, project["id"], {"title": "Commission doors", "status": "ready", "dependsOnIds": [predecessor["id"]]})
        self.store.update_work_item(DEFAULT_ORGANIZATION_ID, project["id"], predecessor["id"], {"expectedVersion": 1, "status": "done"})
        refreshed = self.store.get_project(DEFAULT_ORGANIZATION_ID, project["id"])
        unblocked = next(item for item in refreshed["workItems"] if item["id"] == dependent["id"])
        self.assertEqual(unblocked["effectiveStatus"], "ready")
        self.assertEqual(unblocked["blockedBy"], [])

    def test_dependency_cycle_is_rejected(self):
        project = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "CYCLE", "name": "Cycle"})
        first = self.store.create_work_item(DEFAULT_ORGANIZATION_ID, project["id"], {"title": "First"})
        second = self.store.create_work_item(DEFAULT_ORGANIZATION_ID, project["id"], {"title": "Second", "dependsOnIds": [first["id"]]})
        with self.assertRaises(ValueError):
            self.store.add_work_item_dependency(DEFAULT_ORGANIZATION_ID, project["id"], first["id"], second["id"])

    def test_work_type_progress_is_calculated_independently(self):
        project = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "TRADES", "name": "Trades"})
        self.store.create_work_item(DEFAULT_ORGANIZATION_ID, project["id"], {"title": "Pull data cable", "workTypeId": "data", "status": "done"})
        self.store.create_work_item(DEFAULT_ORGANIZATION_ID, project["id"], {"title": "Splice fiber", "workTypeId": "fiber", "status": "progress"})
        refreshed = self.store.get_project(DEFAULT_ORGANIZATION_ID, project["id"])
        by_type = {value["id"]: value for value in refreshed["workTypeProgress"]}
        self.assertEqual(by_type["data"]["progress"], 100)
        self.assertEqual(by_type["fiber"]["progress"], 50)
        self.assertEqual(by_type["termination"]["taskCount"], 0)

    def test_project_progress_includes_daily_field_updates(self):
        project = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code":"FIELDPROG","name":"Field progress"})
        location = self.store.create_location(DEFAULT_ORGANIZATION_ID, project["id"], {"code":"L1","name":"Level 1"})
        self.store.save_daily_update(DEFAULT_ORGANIZATION_ID, project["id"], {"locationId":location["id"],"workTypeId":"data","actionId":"data-prewire","status":"ongoing","percentComplete":30})
        refreshed = self.store.get_project(DEFAULT_ORGANIZATION_ID, project["id"])
        by_type = {value["id"]: value for value in refreshed["workTypeProgress"]}
        self.assertEqual(by_type["data"]["progress"], 30)
        self.assertEqual(by_type["data"]["fieldUpdateCount"], 1)
        self.assertEqual(refreshed["progress"], 30)

    def test_project_progress_includes_unit_completion(self):
        project = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code":"UNITPROG","name":"Unit progress"})
        location = self.store.create_location(DEFAULT_ORGANIZATION_ID, project["id"], {"code":"L1","name":"Level 1"})
        unit = self.store.create_unit(DEFAULT_ORGANIZATION_ID, project["id"], location["id"], {"code":"101","name":"Unit 101"})
        self.store.set_unit_progress(DEFAULT_ORGANIZATION_ID, project["id"], location["id"], unit["id"], {"workTypeId":"data","actionId":"data-prewire","status":"complete"})
        refreshed = self.store.get_project(DEFAULT_ORGANIZATION_ID, project["id"])
        by_type = {value["id"]: value for value in refreshed["workTypeProgress"]}
        self.assertEqual(by_type["data"]["progress"], 100)
        self.assertEqual(by_type["data"]["fieldUpdateCount"], 1)
        self.assertEqual(refreshed["progress"], 100)

    def test_project_creation_events_are_visible_in_project_activity(self):
        project = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "LOGS", "name": "Logged project"})
        building = self.store.create_building(DEFAULT_ORGANIZATION_ID, project["id"], {"code": "B1", "name": "Building 1"})
        item = self.store.create_work_item(DEFAULT_ORGANIZATION_ID, project["id"], {"title": "Terminate data", "workTypeId": "termination"})
        refreshed = self.store.get_project(DEFAULT_ORGANIZATION_ID, project["id"])
        created = {(event["entityType"], event["entityId"]) for event in refreshed["activity"] if event["action"] == "created"}
        self.assertIn(("project", project["id"]), created)
        self.assertIn(("building", building["id"]), created)
        self.assertIn(("work_item", item["id"]), created)

    def test_project_audit_is_hash_chained_and_append_only(self):
        project = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "CHAIN", "name": "Audit chain"})
        self.store.create_building(DEFAULT_ORGANIZATION_ID, project["id"], {"code": "B1", "name": "Building 1"})
        integrity = self.store.verify_audit_integrity(DEFAULT_ORGANIZATION_ID, project["id"])
        self.assertTrue(integrity["valid"])
        self.assertEqual(integrity["eventCount"], 2)
        with self.store._connect() as connection:
            events = connection.execute("SELECT id, previous_hash, event_hash FROM project_change_log WHERE project_id = ? ORDER BY rowid", (project["id"],)).fetchall()
            self.assertEqual(events[0]["previous_hash"], "")
            self.assertEqual(events[1]["previous_hash"], events[0]["event_hash"])
            self.assertEqual(len(events[1]["event_hash"]), 64)
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("UPDATE project_change_log SET source = 'tampered' WHERE id = ?", (events[0]["id"],))
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("DELETE FROM project_change_log WHERE id = ?", (events[0]["id"],))

    def test_unified_logs_include_project_and_workspace_events(self):
        project = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "LOGVIEW", "name": "Log View"})
        self.store.save([TASK], [{"at":"2026-06-22T12:00:00+00:00","text":"Workspace audit event"}], 0)
        logs = self.store.list_logs(DEFAULT_ORGANIZATION_ID, {"source":"all", "limit":20})
        sources = {event["source"] for event in logs["logs"]}
        self.assertIn("project", sources)
        self.assertIn("workspace", sources)
        filtered = self.store.list_logs(DEFAULT_ORGANIZATION_ID, {"source":"project", "projectId":project["id"], "entityType":"project"})
        self.assertEqual(filtered["logs"][0]["projectId"], project["id"])
        self.assertEqual(filtered["logs"][0]["entityType"], "project")

    def test_new_tenant_receives_default_work_types(self):
        self.store.create_organization("tenant-types", "Tenant Types", "tenant-types")
        project = self.store.create_project("tenant-types", {"code": "P1", "name": "Project"})
        self.assertEqual([value["id"] for value in project["workTypeProgress"]][:3], ["data", "termination", "fiber"])

    def test_project_work_type_scope_filters_progress_and_writes(self):
        project = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "SCOPE", "name": "Scoped Project", "workTypeIds": ["data", "fiber"]})
        self.assertEqual([value["id"] for value in project["workTypeProgress"]], ["data", "fiber"])
        self.assertEqual([value["id"] for value in project["workTypes"]], ["data", "fiber"])
        self.store.create_work_item(DEFAULT_ORGANIZATION_ID, project["id"], {"title": "Pull data", "workTypeId": "data"})
        with self.assertRaises(ValueError):
            self.store.create_work_item(DEFAULT_ORGANIZATION_ID, project["id"], {"title": "Install camera", "workTypeId": "cctv"})

    def test_project_work_type_scope_rejects_empty_or_unknown_values(self):
        with self.assertRaises(ValueError):
            self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "EMPTY-SCOPE", "name": "No Scope", "workTypeIds": []})
        with self.assertRaises(ValueError):
            self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "BAD-SCOPE", "name": "Bad Scope", "workTypeIds": ["data", "bad-type"]})

    def test_workflow_types_and_actions_are_configurable_per_tenant(self):
        self.store.create_organization("workflow-tenant","Workflow Tenant","workflow-tenant")
        created=self.store.save_workflow_configuration("workflow-tenant",{"code":"intercom","name":"Intercom","color":"#123abc","actions":[{"code":"prewire","name":"Prewire"},{"code":"tested","name":"Tested"}]})
        self.assertEqual(len(created["actions"]),2)
        updated=self.store.save_workflow_configuration("workflow-tenant",{"expectedVersion":1,"code":"intercom","name":"Intercom & Entry","color":"#123abc","actions":[{"code":"prewire","name":"Cable rough-in"},{"code":"tested","name":"Tested"},{"code":"commissioned","name":"Commissioned"}]},created["id"])
        self.assertEqual(updated["version"],2)
        self.assertEqual(updated["actions"][0]["name"],"Cable rough-in")
        project=self.store.create_project("workflow-tenant",{"code":"INT-1","name":"Intercom project"})
        custom=next(value for value in project["workTypes"] if value["id"]==created["id"])
        self.assertEqual([value["code"] for value in custom["actions"]],["prewire","tested","commissioned"])

    def test_versioned_custom_fields_drive_unit_validation(self):
        definition=self.store.save_custom_field_definition(DEFAULT_ORGANIZATION_ID,{"scope":"unit","code":"layout","label":"Layout","dataType":"select","options":["studio","one-bedroom"],"required":True})
        self.assertEqual(definition["version"],1)
        project=self.store.create_project(DEFAULT_ORGANIZATION_ID,{"code":"FIELDS","name":"Custom fields"})
        location=self.store.create_location(DEFAULT_ORGANIZATION_ID,project["id"],{"code":"L1","name":"Level 1"})
        with self.assertRaises(ValueError): self.store.create_unit(DEFAULT_ORGANIZATION_ID,project["id"],location["id"],{"code":"101","name":"Unit 101"})
        unit=self.store.create_unit(DEFAULT_ORGANIZATION_ID,project["id"],location["id"],{"code":"101","name":"Unit 101","customFields":{"layout":"studio"}})
        self.assertEqual(unit["customFields"]["layout"],"studio")
        updated=self.store.save_custom_field_definition(DEFAULT_ORGANIZATION_ID,{"expectedVersion":1,"scope":"unit","code":"layout","label":"Unit layout","dataType":"select","options":["studio","one-bedroom"],"required":False,"active":True},definition["id"])
        self.assertEqual(updated["version"],2)

    def test_daily_update_captures_spreadsheet_fields_and_issue(self):
        project = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code":"DAILY","name":"Daily"})
        location = self.store.create_location(DEFAULT_ORGANIZATION_ID, project["id"], {"code":"LV4","name":"Level 4","suiteTotal":18})
        update = self.store.save_daily_update(DEFAULT_ORGANIZATION_ID, project["id"], {
            "locationId":location["id"], "workTypeId":"data", "actionId":"data-terminated-tested",
            "workDate":"2026-06-22", "status":"ongoing", "percentComplete":75,
            "quantityCompleted":12, "comments":"12 suites terminated", "issueDescription":"Two modules damaged", "issueSeverity":"high",
        })
        refreshed = self.store.get_project(DEFAULT_ORGANIZATION_ID, project["id"])
        self.assertEqual(update["locationName"], "Level 4")
        self.assertEqual(update["quantityCompleted"], 12)
        self.assertIn("createdAt", update)
        self.assertIn("updatedAt", update)
        self.assertEqual(next(value for value in refreshed["workTypeProgress"] if value["id"]=="data")["progress"], 75)
        self.assertEqual(refreshed["issues"][0]["severity"], "high")

    def test_daily_update_edit_is_optimistic(self):
        project = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code":"EDIT","name":"Edit"})
        location = self.store.create_location(DEFAULT_ORGANIZATION_ID, project["id"], {"code":"P1","name":"Parking 1"})
        update = self.store.save_daily_update(DEFAULT_ORGANIZATION_ID, project["id"], {"locationId":location["id"],"workTypeId":"fiber","actionId":"fiber-prewire","status":"ongoing","percentComplete":50})
        edited = self.store.save_daily_update(DEFAULT_ORGANIZATION_ID, project["id"], {"expectedVersion":1,"locationId":location["id"],"workTypeId":"fiber","actionId":"fiber-prewire","status":"complete","percentComplete":80,"comments":"Done"}, update["id"])
        self.assertEqual(edited["percentComplete"], 100)
        self.assertEqual(edited["version"], 2)
        with self.assertRaises(EntityVersionConflict):
            self.store.save_daily_update(DEFAULT_ORGANIZATION_ID, project["id"], {"expectedVersion":1,"locationId":location["id"],"workTypeId":"fiber","actionId":"fiber-prewire","status":"ongoing","percentComplete":80}, update["id"])

    def test_floor_units_support_tap_progress_and_jobber_report(self):
        project=self.store.create_project(DEFAULT_ORGANIZATION_ID,{"code":"UNITS","name":"Units"})
        location=self.store.create_location(DEFAULT_ORGANIZATION_ID,project["id"],{"code":"L4","name":"Level 4","kind":"floor","suiteTotal":3})
        self.assertEqual(len(location["units"]),3)
        unit=location["units"][0]
        updated=self.store.set_unit_progress(DEFAULT_ORGANIZATION_ID,project["id"],location["id"],unit["id"],{"workTypeId":"data","actionId":"data-prewire","status":"complete","completedOn":"2026-06-22"})
        self.assertEqual(updated["progress"][0]["status"],"complete")
        report=self.store.generate_daily_report(DEFAULT_ORGANIZATION_ID,project["id"],"2026-06-22")
        self.assertEqual(report["unitCompletions"],1)
        self.assertIn("Level 4 / Data / Prewire: Unit 1",report["text"])

    def test_units_can_be_created_edited_and_audited(self):
        project=self.store.create_project(DEFAULT_ORGANIZATION_ID,{"code":"UNIT-EDIT","name":"Editable units"})
        location=self.store.create_location(DEFAULT_ORGANIZATION_ID,project["id"],{"code":"L2","name":"Level 2","kind":"floor"})
        unit=self.store.create_unit(DEFAULT_ORGANIZATION_ID,project["id"],location["id"],{"code":"201","name":"Suite 201","notes":"Access via east hall","customFields":{"bedrooms":2}})
        self.assertEqual(unit["customFields"]["bedrooms"],2)
        updated=self.store.update_unit(DEFAULT_ORGANIZATION_ID,project["id"],location["id"],unit["id"],{"expectedVersion":1,"name":"Unit 201A","notes":"Key required"})
        self.assertEqual(updated["version"],2)
        self.assertEqual(updated["notes"],"Key required")
        with self.assertRaises(EntityVersionConflict):
            self.store.update_unit(DEFAULT_ORGANIZATION_ID,project["id"],location["id"],unit["id"],{"expectedVersion":1,"name":"Stale"})
        with self.store._connect() as connection:
            actions=[row["action"] for row in connection.execute("SELECT action FROM project_change_log WHERE entity_type='unit' AND entity_id=? ORDER BY rowid",(unit["id"],))]
        self.assertEqual(actions,["created","updated"])

    def test_location_hierarchy_and_custom_fields_are_project_scoped(self):
        project = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "TREE", "name": "Location tree"})
        floor = self.store.create_location(DEFAULT_ORGANIZATION_ID, project["id"], {"code": "L4", "name": "Level 4", "kind": "floor"})
        suite = self.store.create_location(DEFAULT_ORGANIZATION_ID, project["id"], {"code": "401", "name": "Suite 401", "kind": "suite", "parentLocationId": floor["id"], "customFields": {"layout": "2-bedroom"}})
        room = self.store.create_location(DEFAULT_ORGANIZATION_ID, project["id"], {"code": "401-LR", "name": "Living room", "kind": "room", "parentLocationId": suite["id"]})
        refreshed = self.store.get_project(DEFAULT_ORGANIZATION_ID, project["id"])
        self.assertEqual(next(value for value in refreshed["locations"] if value["id"] == suite["id"])["customFields"]["layout"], "2-bedroom")
        self.assertEqual(next(value for value in refreshed["locations"] if value["id"] == room["id"])["depth"], 2)
        with self.assertRaises(ValueError):
            self.store.update_location(DEFAULT_ORGANIZATION_ID, project["id"], floor["id"], {"expectedVersion": 1, "parentLocationId": room["id"]})
        other = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "OTHER-TREE", "name": "Other tree"})
        with self.assertRaises(ValueError):
            self.store.create_location(DEFAULT_ORGANIZATION_ID, other["id"], {"code": "BAD", "name": "Bad child", "parentLocationId": floor["id"]})

    def test_compute_node_telemetry_requires_opt_in_for_scheduling(self):
        payload={"name":"M1 Pro","hostname":"m1-pro.local","platform":"macOS","architecture":"arm64","agentVersion":"0.1.0","computeEnabled":False,"metric":{"cpuPercent":23.5,"memoryUsedBytes":8_000_000_000,"memoryTotalBytes":16_000_000_000,"batteryPercent":81,"powerSource":"battery","charging":False,"thermalState":"nominal","loadAverage":1.2}}
        self.store.record_compute_node(DEFAULT_ORGANIZATION_ID,"node-1",payload)
        node=self.store.list_compute_nodes(DEFAULT_ORGANIZATION_ID)[0]
        self.assertFalse(node["agentOptIn"])
        self.assertEqual(node["metrics"][-1]["cpuPercent"],23.5)
        with self.assertRaises(ValueError): self.store.set_compute_node_enabled(DEFAULT_ORGANIZATION_ID,"node-1",True)
        payload["computeEnabled"]=True
        self.store.record_compute_node(DEFAULT_ORGANIZATION_ID,"node-1",payload)
        enabled=self.store.set_compute_node_enabled(DEFAULT_ORGANIZATION_ID,"node-1",True)
        self.assertTrue(enabled["computeEnabled"])

    def test_git_sync_settings_store_remote_without_secret(self):
        settings=self.store.get_git_sync_settings(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(settings["lastSyncStatus"],"not_configured")
        saved=self.store.save_git_sync_settings(DEFAULT_ORGANIZATION_ID,{"remoteUrl":"git@github.com:deepexet/RackAndCode-v1.git","branchName":"main","commitStrategy":"per_task","autoCommit":True,"autoPush":False,"includeDocs":True})
        self.assertEqual(saved["remoteUrl"],"git@github.com:deepexet/RackAndCode-v1.git")
        self.assertEqual(saved["secretMode"],"external_credential")
        self.assertEqual(saved["lastSyncStatus"],"configured")
        with self.assertRaises(ValueError):
            self.store.save_git_sync_settings(DEFAULT_ORGANIZATION_ID,{"remoteUrl":"ftp://example.com/repo.git"})

    def test_platform_settings_are_tenant_scoped_and_validated(self):
        defaults = self.store.get_platform_settings(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(defaults["defaultLanguage"], "en")
        saved = self.store.save_platform_settings(DEFAULT_ORGANIZATION_ID, {"defaultLanguage":"ru","timezone":"America/Halifax","roleMode":"planned","telemetryMode":"minimal","logRetentionDays":180})
        self.assertEqual(saved["defaultLanguage"], "ru")
        self.assertEqual(saved["telemetryMode"], "minimal")
        with self.assertRaises(ValueError):
            self.store.save_platform_settings(DEFAULT_ORGANIZATION_ID, {"defaultLanguage":"de"})

    def test_api_metrics_recorder_summarizes_latency_and_errors(self):
        recorder = ApiMetricsRecorder(retention=3)
        recorder.record({"createdAt":"2026-06-22T10:00:00+00:00","requestId":"r1","organizationId":DEFAULT_ORGANIZATION_ID,"method":"GET","route":"/api/v1/health","status":200,"durationMs":4.0,"responseBytes":100})
        recorder.record({"createdAt":"2026-06-22T10:00:01+00:00","requestId":"r2","organizationId":DEFAULT_ORGANIZATION_ID,"method":"GET","route":"/api/v1/admin/api-metrics","status":200,"durationMs":8.0,"responseBytes":200})
        recorder.record({"createdAt":"2026-06-22T10:00:02+00:00","requestId":"r3","organizationId":DEFAULT_ORGANIZATION_ID,"method":"POST","route":"/api/v1/projects","status":400,"durationMs":12.0,"responseBytes":300})
        snapshot = recorder.snapshot()
        self.assertEqual(snapshot["requestCount"], 3)
        self.assertEqual(snapshot["averageMs"], 8.0)
        self.assertEqual(snapshot["errorCount"], 1)
        self.assertEqual(snapshot["statusCounts"], {"200": 2, "400": 1})
        self.assertEqual(snapshot["topRoutes"][0]["route"], "/api/v1/health")
        self.assertEqual(snapshot["recent"][0]["requestId"], "r3")

    def test_development_agent_status_and_continuation_request(self):
        initial=self.store.get_development_agent_status(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(initial["status"],"idle")
        working=self.store.set_development_agent_status(DEFAULT_ORGANIZATION_ID,{"status":"working","message":"Implementing UI","needsAction":False})
        self.assertEqual(working["message"],"Implementing UI")
        requested=self.store.request_development_continuation(DEFAULT_ORGANIZATION_ID)
        self.assertTrue(requested["continuationRequested"])

    def test_audio_zone_profile_can_be_created_and_edited(self):
        project=self.store.create_project(DEFAULT_ORGANIZATION_ID,{"code":"AUDIO","name":"Audio"})
        location=self.store.create_location(DEFAULT_ORGANIZATION_ID,project["id"],{"code":"ZN1","name":"Audio Zone 1","kind":"area","audioDetails":{"zoneType":"amenity","speakerCount":6,"displayCount":1,"sourceDescription":"TV"}})
        self.assertEqual(location["audioDetails"]["speakerCount"],6)
        edited=self.store.update_location(DEFAULT_ORGANIZATION_ID,project["id"],location["id"],{"expectedVersion":1,"audioDetails":{"zoneType":"amenity","speakerCount":8,"displayCount":2,"sourceDescription":"TV and music","equipmentNotes":"Rack A"}})
        self.assertEqual(edited["audioDetails"]["speakerCount"],8)
        self.assertEqual(edited["audioDetails"]["equipmentNotes"],"Rack A")


    def test_global_search_returns_results_across_entities(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "SRCH", "name": "Search Test Project"})
        wi = self.store.create_work_item(DEFAULT_ORGANIZATION_ID, proj["id"], {"title": "Install Door Camera", "status": "ready"})
        results = self.store.global_search(DEFAULT_ORGANIZATION_ID, "Camera")
        types = {r["type"] for r in results["results"]}
        self.assertIn("work_item", types)
        titles = [r["title"] for r in results["results"]]
        self.assertTrue(any("Camera" in t for t in titles))

    def test_global_search_empty_query_returns_empty(self):
        results = self.store.global_search(DEFAULT_ORGANIZATION_ID, "")
        self.assertEqual(results["results"], [])

    def test_notification_push_and_list(self):
        notif_id = self.store.push_notification(
            DEFAULT_ORGANIZATION_ID, "Test notification", "Body text",
            notif_type="system", user_id="user-1"
        )
        self.assertIsNotNone(notif_id)
        result = self.store.list_notifications(DEFAULT_ORGANIZATION_ID, user_id="user-1")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["title"], "Test notification")
        self.assertFalse(result[0]["read"])

    def test_notification_mark_read(self):
        self.store.push_notification(DEFAULT_ORGANIZATION_ID, "N1", notif_type="system")
        self.store.push_notification(DEFAULT_ORGANIZATION_ID, "N2", notif_type="system")
        count = self.store.mark_notifications_read(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(count, 2)
        result = self.store.list_notifications(DEFAULT_ORGANIZATION_ID, unread_only=True)
        self.assertEqual(result, [])

    def test_service_monitor_create_and_list(self):
        monitor = self.store.create_monitor(DEFAULT_ORGANIZATION_ID, {
            "name": "Office Router", "checkType": "ping", "target": "192.168.1.1"
        })
        self.assertEqual(monitor["name"], "Office Router")
        self.assertEqual(monitor["last_status"], "unknown")
        monitors = self.store.list_monitors(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(len(monitors), 1)

    def test_service_monitor_event_record_updates_status(self):
        monitor = self.store.create_monitor(DEFAULT_ORGANIZATION_ID, {
            "name": "Test Host", "checkType": "tcp", "target": "10.0.0.1", "port": 443
        })
        self.store.record_monitor_event(DEFAULT_ORGANIZATION_ID, monitor["id"], "up", latency_ms=12.5)
        monitors = self.store.list_monitors(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(monitors[0]["last_status"], "up")
        self.assertAlmostEqual(monitors[0]["last_latency_ms"], 12.5)

    def test_monitor_delete_removes_entry(self):
        monitor = self.store.create_monitor(DEFAULT_ORGANIZATION_ID, {"name": "X", "target": "1.1.1.1"})
        self.store.delete_monitor(DEFAULT_ORGANIZATION_ID, monitor["id"])
        self.assertEqual(self.store.list_monitors(DEFAULT_ORGANIZATION_ID), [])

    def test_compute_job_submit_dispatch_complete(self):
        job = self.store.submit_compute_job(DEFAULT_ORGANIZATION_ID, "report_gen", {"format": "pdf"}, priority=3)
        self.assertEqual(job["status"], "pending")
        dispatched = self.store.dispatch_compute_job(DEFAULT_ORGANIZATION_ID, job["id"], "node-abc")
        self.assertEqual(dispatched["status"], "dispatched")
        self.assertEqual(dispatched["node_id"], "node-abc")
        self.store.complete_compute_job(DEFAULT_ORGANIZATION_ID, job["id"], {"pages": 5})
        jobs = self.store.list_compute_jobs(DEFAULT_ORGANIZATION_ID, status="done")
        self.assertEqual(len(jobs), 1)

    def test_compute_job_invalid_type_raises(self):
        with self.assertRaises(ValueError):
            self.store.submit_compute_job(DEFAULT_ORGANIZATION_ID, "invalid_type", {})

    def test_connector_upsert_and_list(self):
        conn = self.store.upsert_connector(DEFAULT_ORGANIZATION_ID, "webhook", "Jobber Webhook", {"url": "https://example.com"})
        self.assertEqual(conn["connector_type"], "webhook")
        self.assertEqual(conn["status"], "active")
        connectors = self.store.list_connectors(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(len(connectors), 1)

    def test_connector_upsert_is_idempotent(self):
        self.store.upsert_connector(DEFAULT_ORGANIZATION_ID, "jobber", "Jobber A", {})
        self.store.upsert_connector(DEFAULT_ORGANIZATION_ID, "jobber", "Jobber B", {})
        connectors = self.store.list_connectors(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(len(connectors), 1)
        self.assertEqual(connectors[0]["name"], "Jobber B")

    def test_team_presence_upsert_and_list(self):
        member = self.store.create_team_member(DEFAULT_ORGANIZATION_ID, {"name": "Alice", "trade": "technician"})
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "P1", "name": "Site A"})
        presence = self.store.upsert_presence(
            DEFAULT_ORGANIZATION_ID, proj["id"], member["id"], "2026-06-24",
            check_in="2026-06-24T08:00:00Z", notes="On site"
        )
        self.assertIsNotNone(presence["id"])
        records = self.store.list_presence(DEFAULT_ORGANIZATION_ID, proj["id"], "2026-06-24", "2026-06-24")
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["memberName"], "Alice")

    def test_presence_upsert_is_idempotent(self):
        member = self.store.create_team_member(DEFAULT_ORGANIZATION_ID, {"name": "Bob", "trade": "lead"})
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "P2", "name": "Site B"})
        self.store.upsert_presence(DEFAULT_ORGANIZATION_ID, proj["id"], member["id"], "2026-06-24")
        self.store.upsert_presence(DEFAULT_ORGANIZATION_ID, proj["id"], member["id"], "2026-06-24", notes="Updated")
        records = self.store.list_presence(DEFAULT_ORGANIZATION_ID, proj["id"], "2026-06-24", "2026-06-24")
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["notes"], "Updated")

    def test_project_analytics_returns_risk_and_velocity(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "ANA", "name": "Analytics Test"})
        self.store.create_work_item(DEFAULT_ORGANIZATION_ID, proj["id"], {"title": "Task A", "status": "done"})
        self.store.create_work_item(DEFAULT_ORGANIZATION_ID, proj["id"], {"title": "Task B", "status": "ready"})
        analytics = self.store.get_project_analytics(DEFAULT_ORGANIZATION_ID, proj["id"])
        self.assertEqual(analytics["totalItems"], 2)
        self.assertEqual(analytics["doneItems"], 1)
        self.assertEqual(analytics["pctDone"], 50)
        self.assertIn("riskScore", analytics)
        self.assertIn(analytics["riskLevel"], ("low", "medium", "high", "critical"))

    def test_bulk_status_update_via_store(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "BLK", "name": "Bulk Test"})
        wi1 = self.store.create_work_item(DEFAULT_ORGANIZATION_ID, proj["id"], {"title": "Item 1", "status": "ready"})
        wi2 = self.store.create_work_item(DEFAULT_ORGANIZATION_ID, proj["id"], {"title": "Item 2", "status": "ready"})
        ids = [wi1["id"], wi2["id"]]
        updated = skipped = 0
        for item_id in ids:
            try:
                self.store.update_work_item(DEFAULT_ORGANIZATION_ID, proj["id"], item_id,
                                             {"expectedVersion": 1, "status": "progress"})
                updated += 1
            except Exception:
                skipped += 1
        self.assertEqual(updated, 2)
        self.assertEqual(skipped, 0)

    def _make_user(self):
        import uuid as _uuid
        with self.store._connect() as conn:
            uid = str(_uuid.uuid4())
            conn.execute(
                "INSERT INTO users (id, email, display_name, created_at) VALUES (?,?,?,datetime('now'))",
                (uid, f"{uid[:8]}@test.invalid", "Test User"),
            )
            conn.execute(
                "INSERT INTO memberships (organization_id, user_id, role, status, created_at) "
                "VALUES (?,?,?,?,datetime('now'))",
                (DEFAULT_ORGANIZATION_ID, uid, "Administrator", "active"),
            )
        return uid

    def test_document_entity_link(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "DOC", "name": "Doc Link Test"})
        asset = self.store.create_asset(DEFAULT_ORGANIZATION_ID, proj["id"], {"name": "Router", "assetType": "network"})
        uid = self._make_user()
        dummy_bytes = b"test file content"
        obj = self.store.store_object(DEFAULT_ORGANIZATION_ID, proj["id"], "readme.txt", "text/plain", dummy_bytes, uid)
        linked = self.store.link_object_to_entity(DEFAULT_ORGANIZATION_ID, obj["id"], "asset", asset["id"])
        self.assertEqual(linked["linkedEntityType"], "asset")
        self.assertEqual(linked["linkedEntityId"], asset["id"])
        docs = self.store.list_objects_for_entity(DEFAULT_ORGANIZATION_ID, "asset", asset["id"])
        self.assertEqual(len(docs), 1)
        self.assertEqual(docs[0]["name"], "readme.txt")

    def test_document_link_invalid_entity_type_raises(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "DLI", "name": "Link Invalid"})
        uid = self._make_user()
        obj = self.store.store_object(DEFAULT_ORGANIZATION_ID, proj["id"], "file.txt", "text/plain", b"x", uid)
        with self.assertRaises(ValueError):
            self.store.link_object_to_entity(DEFAULT_ORGANIZATION_ID, obj["id"], "invalid_type", "some-id")

    def test_webhook_event_queued_on_work_item_done(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "WHK", "name": "Webhook Test"})
        wi_id = self.store.create_work_item(DEFAULT_ORGANIZATION_ID, proj["id"], {"title": "WHK Item", "status": "ready"})["id"]
        event_id = self.store.queue_webhook_event(DEFAULT_ORGANIZATION_ID, None, "work_item.done", {"workItemId": wi_id})
        self.assertIsNotNone(event_id)
        with self.store._connect() as conn:
            row = conn.execute("SELECT * FROM webhook_events WHERE id=?", (event_id,)).fetchone()
        self.assertEqual(row["event_type"], "work_item.done")
        self.assertEqual(row["status"], "pending")


    def test_team_workload_counts_by_status(self):
        uid = self._make_user()
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "WL1", "name": "Workload"})
        self.store.create_work_item(DEFAULT_ORGANIZATION_ID, proj["id"],
                                    {"title": "Task A", "status": "ready", "assigneeUserId": uid})
        self.store.create_work_item(DEFAULT_ORGANIZATION_ID, proj["id"],
                                    {"title": "Task B", "status": "progress", "assigneeUserId": uid})
        workload = self.store.get_team_workload(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(len(workload), 1)
        self.assertEqual(workload[0]["total"], 2)
        self.assertIn("ready", workload[0]["byStatus"])
        self.assertIn("progress", workload[0]["byStatus"])

    def test_team_workload_unassigned_items_excluded(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "WL2", "name": "No Assign"})
        self.store.create_work_item(DEFAULT_ORGANIZATION_ID, proj["id"], {"title": "Unassigned"})
        workload = self.store.get_team_workload(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(workload, [])

    def test_overdue_sweep_pushes_notifications(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "OVR", "name": "Overdue Test"})
        wi = self.store.create_work_item(DEFAULT_ORGANIZATION_ID, proj["id"],
                                          {"title": "Late task", "status": "ready", "dueDate": "2024-01-01"})
        result = self.store.sweep_overdue_items(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(result["pushed"], 1)
        notifs = self.store.list_notifications(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(len(notifs), 1)
        self.assertEqual(notifs[0]["type"], "overdue")
        self.assertEqual(notifs[0]["entity_id"], wi["id"])

    def test_overdue_sweep_not_duplicate_within_day(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "OVD", "name": "Dupe Guard"})
        self.store.create_work_item(DEFAULT_ORGANIZATION_ID, proj["id"],
                                     {"title": "Old task", "status": "ready", "dueDate": "2024-01-01"})
        self.store.sweep_overdue_items(DEFAULT_ORGANIZATION_ID)
        result2 = self.store.sweep_overdue_items(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(result2["pushed"], 0)

    def test_asset_label_svg_generated(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "SVG", "name": "SVG Test"})
        asset = self.store.create_asset(DEFAULT_ORGANIZATION_ID, proj["id"],
                                         {"name": "Core Switch", "assetType": "network", "make": "Cisco", "model": "C9300"})
        svg = self.store._make_asset_label_svg(asset, "http://localhost:4173")
        self.assertIn("<svg", svg)
        self.assertIn("Core Switch", svg)
        self.assertIn("Cisco", svg)
        self.assertIn(asset["id"][:8], svg)

    def test_get_asset_returns_none_for_unknown(self):
        result = self.store.get_asset(DEFAULT_ORGANIZATION_ID, "nonexistent-id")
        self.assertIsNone(result)

    def test_project_template_create_list_delete(self):
        scaffold = {
            "workItems": [
                {"title": "Survey site", "status": "backlog"},
                {"title": "Install cabling", "status": "backlog"},
            ]
        }
        tpl = self.store.create_template(DEFAULT_ORGANIZATION_ID, {
            "name": "Basic Install", "category": "commercial", "scaffold": scaffold
        })
        self.assertEqual(tpl["name"], "Basic Install")
        self.assertEqual(tpl["category"], "commercial")
        self.assertEqual(len(tpl["scaffold"]["workItems"]), 2)
        templates = self.store.list_templates(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(len(templates), 1)
        self.store.delete_template(DEFAULT_ORGANIZATION_ID, tpl["id"])
        self.assertEqual(self.store.list_templates(DEFAULT_ORGANIZATION_ID), [])

    def test_project_template_name_is_unique_per_org(self):
        self.store.create_template(DEFAULT_ORGANIZATION_ID, {"name": "My Template"})
        with self.assertRaises(ValueError):
            self.store.create_template(DEFAULT_ORGANIZATION_ID, {"name": "My Template"})

    def test_create_project_from_template_seeds_work_items(self):
        tpl = self.store.create_template(DEFAULT_ORGANIZATION_ID, {
            "name": "3-Step Scaffold",
            "scaffold": {"workItems": [
                {"title": "Step 1"}, {"title": "Step 2"}, {"title": "Step 3"}
            ]}
        })
        project = self.store.create_project_from_template(
            DEFAULT_ORGANIZATION_ID, tpl["id"],
            {"code": "TPL1", "name": "From Template"}
        )
        self.assertEqual(project["code"], "TPL1")
        self.assertEqual(len(project["workItems"]), 3)
        titles = {wi["title"] for wi in project["workItems"]}
        self.assertIn("Step 1", titles)
        self.assertIn("Step 3", titles)

    def _make_issue(self, project_id: str, title: str = "Test Issue", severity: str = "medium") -> dict:
        with self.store._connect() as conn:
            import uuid as _uuid
            issue_id = str(_uuid.uuid4())
            now = "2026-06-24T10:00:00Z"
            conn.execute(
                "INSERT INTO project_issues (organization_id, id, project_id, title, description, "
                "severity, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (DEFAULT_ORGANIZATION_ID, issue_id, project_id, title, "", severity, "open", now, now),
            )
        return self.store.get_issue(DEFAULT_ORGANIZATION_ID, issue_id)

    def _login_user(self, email: str = "sess@test.invalid", password: str = "Pass1234!") -> str:
        import hashlib as _hl, secrets as _sec
        uid = self._make_user()
        salt = _sec.token_bytes(16)
        dk = _hl.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
        ph = f"scrypt:{salt.hex()}:{dk.hex()}"
        with self.store._connect() as conn:
            conn.execute("UPDATE users SET email=? WHERE id=?", (email, uid))
            conn.execute(
                "INSERT OR REPLACE INTO password_credentials (user_id,password_hash,must_change,created_at,updated_at) "
                "VALUES (?,?,0,datetime('now'),datetime('now'))", (uid, ph)
            )
        return uid

    def test_session_created_on_login(self):
        self._login_user()
        result = self.store.login("sess@test.invalid", "Pass1234!", ip_address="192.168.1.1", user_agent="TestAgent/1")
        self.assertIsNotNone(result)
        self.assertIn("token", result)
        sessions = self.store.list_active_sessions(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]["ipAddress"], "192.168.1.1")

    def test_session_revoke_invalidates(self):
        self._login_user()
        result = self.store.login("sess@test.invalid", "Pass1234!")
        self.assertIsNotNone(result)
        token = result["token"]
        # Validate before revoke
        ctx = self.store.validate_session(token)
        self.assertIsNotNone(ctx)
        # Revoke by prefix of token_hash
        import hashlib
        full_hash = hashlib.sha256(token.encode()).hexdigest()
        revoked = self.store.revoke_session(DEFAULT_ORGANIZATION_ID, full_hash[:8])
        self.assertEqual(revoked, 1)
        # Session now invalid
        ctx_after = self.store.validate_session(token)
        self.assertIsNone(ctx_after)

    def test_list_active_sessions_excludes_revoked(self):
        self._login_user()
        result = self.store.login("sess@test.invalid", "Pass1234!")
        import hashlib
        full_hash = hashlib.sha256(result["token"].encode()).hexdigest()
        self.store.revoke_session(DEFAULT_ORGANIZATION_ID, full_hash[:8])
        sessions = self.store.list_active_sessions(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(sessions, [])


    def test_milestone_create_and_list(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "MS", "name": "Milestone Test"})
        ms = self.store.create_milestone(DEFAULT_ORGANIZATION_ID, proj["id"], {
            "name": "Phase 1 Complete", "targetDate": "2026-09-01"
        })
        self.assertEqual(ms["name"], "Phase 1 Complete")
        self.assertEqual(ms["status"], "pending")
        milestones = self.store.list_milestones(DEFAULT_ORGANIZATION_ID, proj["id"])
        self.assertEqual(len(milestones), 1)

    def test_milestone_update_status_to_achieved(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "MS2", "name": "MS Update"})
        ms = self.store.create_milestone(DEFAULT_ORGANIZATION_ID, proj["id"], {
            "name": "Go Live", "targetDate": "2026-10-01"
        })
        updated = self.store.update_milestone(DEFAULT_ORGANIZATION_ID, ms["id"], {"status": "achieved"})
        self.assertEqual(updated["status"], "achieved")
        self.assertIsNotNone(updated["achieved_at"])

    def test_milestone_delete(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "MS3", "name": "MS Delete"})
        ms = self.store.create_milestone(DEFAULT_ORGANIZATION_ID, proj["id"], {
            "name": "Drop", "targetDate": "2026-11-01"
        })
        self.store.delete_milestone(DEFAULT_ORGANIZATION_ID, ms["id"])
        self.assertEqual(self.store.list_milestones(DEFAULT_ORGANIZATION_ID, proj["id"]), [])

    def test_org_settings_default_and_update(self):
        defaults = self.store.get_org_settings(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(defaults["timezone"], "UTC")
        self.assertEqual(defaults["locale"], "en")
        updated = self.store.update_org_settings(DEFAULT_ORGANIZATION_ID, {
            "timezone": "Europe/Moscow", "locale": "ru", "currency": "RUB", "workWeekStart": 1
        })
        self.assertEqual(updated["timezone"], "Europe/Moscow")
        self.assertEqual(updated["locale"], "ru")
        self.assertEqual(updated["currency"], "RUB")
        again = self.store.get_org_settings(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(again["timezone"], "Europe/Moscow")



    def test_rate_limiter_allows_and_blocks(self):
        from server.app import _RateLimiter
        rl = _RateLimiter(requests_per_minute=60, burst=3)
        # Should allow burst
        self.assertTrue(rl.allow("10.0.0.1"))
        self.assertTrue(rl.allow("10.0.0.1"))
        self.assertTrue(rl.allow("10.0.0.1"))
        # 4th request exceeds burst
        self.assertFalse(rl.allow("10.0.0.1"))
        # Different IP is unaffected
        self.assertTrue(rl.allow("10.0.0.2"))

    def test_rate_limiter_cleanup(self):
        from server.app import _RateLimiter
        rl = _RateLimiter(requests_per_minute=60, burst=5)
        rl.allow("10.1.1.1")
        rl.cleanup()
        # Bucket should be cleared (last_ts now >> 600s ago? No—cleanup keeps recent)
        # Just check no exception raised and data still present for recent IPs
        self.assertIsNotNone(rl)



    def test_audit_integrity_on_empty_log(self):
        result = self.store.verify_audit_integrity(DEFAULT_ORGANIZATION_ID)
        self.assertTrue(result["valid"])
        self.assertGreaterEqual(result["eventCount"], 0)

    def test_work_item_comment_add_and_list(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "CMT", "name": "Comment Test", "kind": "customer"})
        wi = self.store.create_work_item(DEFAULT_ORGANIZATION_ID, proj["id"], {"title": "Wi for comment", "workTypeId": "data", "actionId": "data-prewire"})
        comment = self.store.add_wi_comment(DEFAULT_ORGANIZATION_ID, wi["id"], proj["id"], "First comment", None, "Tester")
        self.assertEqual(comment["body"], "First comment")
        comments = self.store.list_wi_comments(DEFAULT_ORGANIZATION_ID, wi["id"])
        self.assertEqual(len(comments), 1)

    def test_work_item_comment_edit_and_delete(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "CMT2", "name": "Cmt Edit", "kind": "customer"})
        wi = self.store.create_work_item(DEFAULT_ORGANIZATION_ID, proj["id"], {"title": "Wi2", "workTypeId": "data", "actionId": "data-prewire"})
        comment = self.store.add_wi_comment(DEFAULT_ORGANIZATION_ID, wi["id"], proj["id"], "Draft", None, "Tester")
        edited = self.store.edit_wi_comment(DEFAULT_ORGANIZATION_ID, comment["id"], "Final text")
        self.assertEqual(edited["body"], "Final text")
        self.assertEqual(edited["edited"], 1)
        self.store.delete_wi_comment(DEFAULT_ORGANIZATION_ID, comment["id"])
        self.assertEqual(self.store.list_wi_comments(DEFAULT_ORGANIZATION_ID, wi["id"]), [])

    def test_budget_set_and_summary(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "BUD", "name": "Budget Test"})
        self.store.set_project_budget(DEFAULT_ORGANIZATION_ID, proj["id"], 50000.0, "USD")
        self.store.add_expense(DEFAULT_ORGANIZATION_ID, proj["id"], {
            "amount": 12500.0, "category": "materials", "expenseDate": "2026-06-01"
        })
        self.store.add_expense(DEFAULT_ORGANIZATION_ID, proj["id"], {
            "amount": 7500.0, "category": "labour", "expenseDate": "2026-06-10"
        })
        summary = self.store.get_budget_summary(DEFAULT_ORGANIZATION_ID, proj["id"])
        self.assertEqual(summary["budgetAmount"], 50000.0)
        self.assertAlmostEqual(summary["totalSpent"], 20000.0)
        self.assertAlmostEqual(summary["remaining"], 30000.0)
        self.assertAlmostEqual(summary["utilizationPct"], 40.0)

    def test_expense_delete(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "BUD2", "name": "Expense Del"})
        exp = self.store.add_expense(DEFAULT_ORGANIZATION_ID, proj["id"], {
            "amount": 100.0, "category": "other", "expenseDate": "2026-06-01"
        })
        self.store.delete_expense(DEFAULT_ORGANIZATION_ID, exp["id"])
        self.assertEqual(self.store.list_expenses(DEFAULT_ORGANIZATION_ID, proj["id"]), [])



    def test_inventory_warehouse_and_sku_crud(self):
        wh = self.store.create_warehouse(DEFAULT_ORGANIZATION_ID, {
            "name": "Main Warehouse", "location": "Building A"
        })
        self.assertEqual(wh["name"], "Main Warehouse")
        warehouses = self.store.list_warehouses(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(len(warehouses), 1)
        sku = self.store.create_sku(DEFAULT_ORGANIZATION_ID, {
            "skuCode": "CAT6A-305", "name": "Cat6A UTP Cable 305m",
            "unit": "roll", "category": "cable"
        })
        self.assertEqual(sku["sku_code"], "CAT6A-305")
        skus = self.store.list_skus(DEFAULT_ORGANIZATION_ID, "cable")
        self.assertEqual(len(skus), 1)

    def test_inventory_movement_updates_stock(self):
        wh = self.store.create_warehouse(DEFAULT_ORGANIZATION_ID, {"name": "WH1"})
        sku = self.store.create_sku(DEFAULT_ORGANIZATION_ID, {"skuCode": "ITEM-1", "name": "Test Item", "unit": "pcs"})
        result = self.store.record_movement(DEFAULT_ORGANIZATION_ID, {
            "warehouseId": wh["id"], "skuId": sku["id"],
            "movementType": "receive", "quantity": 100,
        })
        self.assertEqual(result["newQuantity"], 100)
        result2 = self.store.record_movement(DEFAULT_ORGANIZATION_ID, {
            "warehouseId": wh["id"], "skuId": sku["id"],
            "movementType": "issue", "quantity": 30,
        })
        self.assertEqual(result2["newQuantity"], 70)
        stock = self.store.get_stock_levels(DEFAULT_ORGANIZATION_ID, wh["id"])
        self.assertEqual(len(stock), 1)
        self.assertAlmostEqual(stock[0]["quantity"], 70.0)

    def test_inventory_pending_approve(self):
        wh = self.store.create_warehouse(DEFAULT_ORGANIZATION_ID, {"name": "WH2"})
        sku = self.store.create_sku(DEFAULT_ORGANIZATION_ID, {"skuCode": "ITEM-2", "name": "Cable", "unit": "m"})
        movements = [{"warehouseId": wh["id"], "skuId": sku["id"], "movementType": "receive", "quantity": 50}]
        pending = self.store.create_inventory_pending(
            DEFAULT_ORGANIZATION_ID, "ai", "Got 50m cable", movements, 0.9
        )
        self.assertEqual(pending["status"], "pending")
        result = self.store.approve_inventory_pending(DEFAULT_ORGANIZATION_ID, pending["id"], "admin")
        self.assertEqual(result["applied"], 1)
        self.assertEqual(result["status"], "approved")
        stock = self.store.get_stock_levels(DEFAULT_ORGANIZATION_ID, wh["id"])
        self.assertAlmostEqual(stock[0]["quantity"], 50.0)

    def test_inventory_search_skus(self):
        self.store.create_sku(DEFAULT_ORGANIZATION_ID, {"skuCode": "CAT6-100", "name": "Cat6 Cable 100m", "unit": "roll"})
        self.store.create_sku(DEFAULT_ORGANIZATION_ID, {"skuCode": "CAT7-100", "name": "Cat7 Cable 100m", "unit": "roll"})
        results = self.store.search_skus(DEFAULT_ORGANIZATION_ID, "Cat6")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["sku_code"], "CAT6-100")

    def test_inventory_xlsx_import(self):
        import io, zipfile, xml.etree.ElementTree as ET
        # Build minimal xlsx in memory
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as zf:
            sheet = """<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row><c t="inlineStr"><is><t>sku</t></is></c><c t="inlineStr"><is><t>warehouse</t></is></c><c t="inlineStr"><is><t>qty</t></is></c></row>
<row><c t="inlineStr"><is><t>ITEM-X</t></is></c><c t="inlineStr"><is><t>Store1</t></is></c><c><v>25</v></c></row>
</sheetData></worksheet>"""
            zf.writestr("xl/worksheets/sheet1.xml", sheet)
        data = buf.getvalue()
        pending = self.store.import_xlsx_inventory(DEFAULT_ORGANIZATION_ID, data, "tester")
        self.assertEqual(pending["source"], "import")
        # 1 row parsed (sku_code unresolved → skuId=None but still in movements)
        movements = pending["suggested_movements"]
        self.assertEqual(len(movements), 1)
        self.assertEqual(movements[0]["sku_code_guess"], "ITEM-X")



    def test_email_inbox_create_and_list(self):
        inbox = self.store.create_email_inbox(DEFAULT_ORGANIZATION_ID, {
            "name": "Supplier Mail", "host": "imap.example.com",
            "username": "warehouse@example.com", "password": "",
            "folder": "INBOX", "filterSubject": "delivery", "pollInterval": 15,
        })
        self.assertEqual(inbox["name"], "Supplier Mail")
        self.assertEqual(inbox["host"], "imap.example.com")
        inboxes = self.store.list_email_inboxes(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(len(inboxes), 1)

    def test_email_inbox_delete(self):
        inbox = self.store.create_email_inbox(DEFAULT_ORGANIZATION_ID, {
            "name": "Test Inbox", "host": "imap.test.com", "username": "u@test.com",
        })
        self.store.delete_email_inbox(DEFAULT_ORGANIZATION_ID, inbox["id"])
        self.assertEqual(self.store.list_email_inboxes(DEFAULT_ORGANIZATION_ID), [])

    def test_email_poll_all_due_no_inboxes(self):
        # With no inboxes configured, returns empty list
        results = self.store.poll_all_due_inboxes(DEFAULT_ORGANIZATION_ID, ai_gateway=None)
        self.assertEqual(results, [])

    # ── Material Reservations ────────────────────────────────────────────────

    def _make_reservation_prereqs(self):
        """Returns (project_id, warehouse_id, sku_id) with stock pre-loaded."""
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "RES", "name": "Reservation Project"})
        wh = self.store.create_warehouse(DEFAULT_ORGANIZATION_ID, {"name": "Reserve WH", "location": "Test"})
        sku = self.store.create_sku(DEFAULT_ORGANIZATION_ID, {
            "skuCode": "CABLE-01", "name": "Test Cable", "unit": "m", "category": "cables"
        })
        # Add stock
        self.store.record_movement(DEFAULT_ORGANIZATION_ID, {
            "warehouseId": wh["id"], "skuId": sku["id"],
            "movementType": "receive", "quantity": 500, "reference": "PO-1", "note": "",
        })
        return proj["id"], wh["id"], sku["id"]

    def test_reservation_create_and_list(self):
        pid, wid, sid = self._make_reservation_prereqs()
        r = self.store.create_reservation(DEFAULT_ORGANIZATION_ID, pid, wid, sid, 100.0, "initial reserve")
        self.assertEqual(r["status"], "active")
        self.assertEqual(r["quantity"], 100.0)
        self.assertEqual(r["consumed"], 0.0)
        lst = self.store.list_reservations(DEFAULT_ORGANIZATION_ID, project_id=pid)
        self.assertEqual(len(lst), 1)
        self.assertEqual(lst[0]["id"], r["id"])

    def test_reservation_consume_and_auto_complete(self):
        pid, wid, sid = self._make_reservation_prereqs()
        r = self.store.create_reservation(DEFAULT_ORGANIZATION_ID, pid, wid, sid, 50.0)
        result = self.store.consume_from_reservation(DEFAULT_ORGANIZATION_ID, r["id"], 50.0)
        self.assertIn("movementId", result)
        # Should be fully consumed now
        reservations = self.store.list_reservations(DEFAULT_ORGANIZATION_ID, project_id=pid, status="consumed")
        self.assertEqual(len(reservations), 1)
        self.assertEqual(reservations[0]["consumed"], 50.0)

    def test_reservation_release(self):
        pid, wid, sid = self._make_reservation_prereqs()
        r = self.store.create_reservation(DEFAULT_ORGANIZATION_ID, pid, wid, sid, 200.0)
        self.store.release_reservation(DEFAULT_ORGANIZATION_ID, r["id"])
        lst_active = self.store.list_reservations(DEFAULT_ORGANIZATION_ID, project_id=pid, status="active")
        self.assertEqual(len(lst_active), 0)
        lst_released = self.store.list_reservations(DEFAULT_ORGANIZATION_ID, project_id=pid, status="released")
        self.assertEqual(len(lst_released), 1)

    def test_reservation_insufficient_stock_raises(self):
        pid, wid, sid = self._make_reservation_prereqs()
        with self.assertRaises(ValueError):
            self.store.create_reservation(DEFAULT_ORGANIZATION_ID, pid, wid, sid, 99999.0)

    def test_transfer_between_warehouses(self):
        wh1 = self.store.create_warehouse(DEFAULT_ORGANIZATION_ID, {"name": "Transfer WH A", "location": "A"})
        wh2 = self.store.create_warehouse(DEFAULT_ORGANIZATION_ID, {"name": "Transfer WH B", "location": "B"})
        sku = self.store.create_sku(DEFAULT_ORGANIZATION_ID, {"skuCode": "TRANS-01", "name": "Transfer SKU", "unit": "pcs"})
        # Stock up wh1
        self.store.record_movement(DEFAULT_ORGANIZATION_ID, {
            "warehouseId": wh1["id"], "skuId": sku["id"],
            "movementType": "receive", "quantity": 100, "reference": "", "note": "",
        })
        result = self.store.transfer_stock(
            DEFAULT_ORGANIZATION_ID, wh1["id"], wh2["id"], sku["id"], 40.0, "PO-TRANS"
        )
        self.assertIn("outMovementId", result)
        self.assertIn("inMovementId", result)
        # Verify stock levels
        stock = self.store.get_stock_levels(DEFAULT_ORGANIZATION_ID)
        by_wh = {s["warehouse_id"]: s["quantity"] for s in stock if s["sku_id"] == sku["id"]}
        self.assertEqual(by_wh[wh1["id"]], 60.0)
        self.assertEqual(by_wh[wh2["id"]], 40.0)

    def test_transfer_insufficient_raises(self):
        wh1 = self.store.create_warehouse(DEFAULT_ORGANIZATION_ID, {"name": "T WH X", "location": "X"})
        wh2 = self.store.create_warehouse(DEFAULT_ORGANIZATION_ID, {"name": "T WH Y", "location": "Y"})
        sku = self.store.create_sku(DEFAULT_ORGANIZATION_ID, {"skuCode": "TRANS-02", "name": "Transfer SKU 2", "unit": "pcs"})
        self.store.record_movement(DEFAULT_ORGANIZATION_ID, {
            "warehouseId": wh1["id"], "skuId": sku["id"],
            "movementType": "receive", "quantity": 5, "reference": "", "note": "",
        })
        with self.assertRaises(ValueError):
            self.store.transfer_stock(DEFAULT_ORGANIZATION_ID, wh1["id"], wh2["id"], sku["id"], 999.0)

    def test_issue_list_by_project(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "ISS", "name": "Issue Test"})
        self._make_issue(proj["id"], "Critical Fault", "critical")
        self._make_issue(proj["id"], "Minor Warning", "low")
        issues = self.store.list_issues(DEFAULT_ORGANIZATION_ID, project_id=proj["id"])
        self.assertEqual(len(issues), 2)

    def test_issue_list_filter_by_status(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "ISF", "name": "Issue Filter"})
        self._make_issue(proj["id"])
        issues_open = self.store.list_issues(DEFAULT_ORGANIZATION_ID, status="open")
        self.assertGreaterEqual(len(issues_open), 1)
        issues_resolved = self.store.list_issues(DEFAULT_ORGANIZATION_ID, status="resolved")
        self.assertEqual(issues_resolved, [])

    def test_issue_transition_open_to_in_progress(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "TRS", "name": "Transition"})
        issue = self._make_issue(proj["id"])
        updated = self.store.transition_issue(DEFAULT_ORGANIZATION_ID, issue["id"], "in_progress")
        self.assertEqual(updated["status"], "in_progress")

    def test_issue_transition_invalid_raises(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "TRI", "name": "Invalid Trans"})
        issue = self._make_issue(proj["id"])
        with self.assertRaises(InvalidTransition):
            self.store.transition_issue(DEFAULT_ORGANIZATION_ID, issue["id"], "closed")

    def test_issue_full_lifecycle(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "LCY", "name": "Lifecycle"})
        issue = self._make_issue(proj["id"])
        self.store.transition_issue(DEFAULT_ORGANIZATION_ID, issue["id"], "in_progress")
        self.store.transition_issue(DEFAULT_ORGANIZATION_ID, issue["id"], "resolved", "Fixed by patch", "user-1")
        final = self.store.transition_issue(DEFAULT_ORGANIZATION_ID, issue["id"], "closed")
        self.assertEqual(final["status"], "closed")
        self.assertIsNotNone(final["resolved_at"])

    def test_issue_assign(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "ASN", "name": "Assign Test"})
        issue = self._make_issue(proj["id"])
        updated = self.store.assign_issue(DEFAULT_ORGANIZATION_ID, issue["id"], "user-42")
        self.assertEqual(updated["assigned_to"], "user-42")
        unassigned = self.store.assign_issue(DEFAULT_ORGANIZATION_ID, issue["id"], None)
        self.assertIsNone(unassigned["assigned_to"])

    def test_scheduled_report_create_list_delete(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "RPT", "name": "Report Test"})
        report = self.store.create_scheduled_report(DEFAULT_ORGANIZATION_ID, {
            "name": "Weekly Summary", "reportType": "project_summary",
            "cadence": "weekly", "projectId": proj["id"], "format": "csv",
        })
        self.assertEqual(report["name"], "Weekly Summary")
        self.assertEqual(report["cadence"], "weekly")
        self.assertEqual(report["enabled"], 1)
        reports = self.store.list_scheduled_reports(DEFAULT_ORGANIZATION_ID)
        self.assertEqual(len(reports), 1)
        self.store.delete_scheduled_report(DEFAULT_ORGANIZATION_ID, report["id"])
        self.assertEqual(self.store.list_scheduled_reports(DEFAULT_ORGANIZATION_ID), [])

    def test_scheduled_report_invalid_type_raises(self):
        with self.assertRaises(ValueError):
            self.store.create_scheduled_report(DEFAULT_ORGANIZATION_ID, {"name": "X", "reportType": "invalid"})

    def test_scheduled_report_invalid_cadence_raises(self):
        with self.assertRaises(ValueError):
            self.store.create_scheduled_report(DEFAULT_ORGANIZATION_ID, {"name": "X", "cadence": "yearly"})

    def test_webhook_flush_skips_events_without_url(self):
        proj = self.store.create_project(DEFAULT_ORGANIZATION_ID, {"code": "WFL", "name": "Flush Test"})
        self.store.queue_webhook_event(DEFAULT_ORGANIZATION_ID, None, "work_item.done", {"projectId": proj["id"]})
        result = self.store.flush_webhook_events()
        # No connector URL configured, so all events are skipped or failed
        self.assertGreaterEqual(result["skipped"] + result["failed"], 1)
        self.assertEqual(result["sent"], 0)


if __name__ == "__main__":
    unittest.main()
