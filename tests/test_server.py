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

    def http_request(self, method, path, *, role="Administrator", payload=None):
        server = FieldOSServer(("127.0.0.1", 0), self.store, "test-agent-token")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            body = json.dumps(payload).encode("utf-8") if payload is not None else None
            headers = {"X-Organization-ID": DEFAULT_ORGANIZATION_ID, "X-RackPilot-Role": role}
            if body is not None:
                headers["Content-Type"] = "application/json"
                headers["Idempotency-Key"] = f"test-{method}-{path}-{role}"
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
        self.assertEqual(first.current_version, "032")
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


if __name__ == "__main__":
    unittest.main()
