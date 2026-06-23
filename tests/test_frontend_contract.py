import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


class FrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.css = (ROOT / "web" / "styles.css").read_text(encoding="utf-8")
        cls.app = (ROOT / "web" / "app.js").read_text(encoding="utf-8")
        cls.html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")

    def test_mobile_typography_prevents_ios_zoom(self):
        self.assertIn(".search input,.filters select{font-size:16px}", self.css)
        self.assertIn("dialog input,dialog textarea,dialog select{min-height:44px;font-size:16px}", self.css)

    def test_mobile_panels_have_readable_typography(self):
        for contract in (
            ".architecture-flow span { padding:13px 12px; font-size:14px; }",
            ".principles span { padding:8px 10px; font-size:12px; }",
            ".audit-list strong { font-size:14px; line-height:1.45; }",
            ".audit-list span { margin-top:6px; font-size:12px; line-height:1.4; }",
        ):
            self.assertIn(contract, self.css)

    def test_desktop_typography_and_tabs_are_stable(self):
        self.assertIn("@media (min-width:681px)",self.css)
        self.assertIn(".primary-nav { position:absolute",self.css)
        self.assertIn(".project-card>p { font-size:15px; line-height:1.6; }",self.css)
        self.assertIn(".task-card p { font-size:13px; line-height:1.55; }",self.css)
        self.assertIn(".workflow-admin-list strong { font-size:15px; }",self.css)
        self.assertIn("dialog input,dialog textarea,dialog select { min-height:44px; font-size:16px; }",self.css)

    def test_header_exposes_development_agent_status(self):
        self.assertIn('id="agentIndicator"',self.html)
        self.assertIn('id="requestContinueButton"',self.html)
        self.assertIn("hydrateAgentStatus",self.app)
        self.assertIn("/api/v1/development-agent/continue",self.app)
        self.assertIn(".agent-indicator.working",self.css)

    def test_sync_uses_explicit_tenant_and_dirty_rebase(self):
        self.assertIn("'X-Organization-ID': ORGANIZATION_ID", self.app)
        self.assertIn("dirtyTaskIds", self.app)
        self.assertIn("deletedTaskIds", self.app)
        self.assertIn("rebasePendingState", self.app)

    def test_project_portfolio_has_mobile_readability_contract(self):
        self.assertIn("/api/v1/projects", self.app)
        self.assertIn("renderProjects", self.app)
        self.assertIn(".project-card>p { font-size:14px; }", self.css)
        self.assertIn(".project-stages span,.project-stages b,.project-stages small { font-size:12px; }", self.css)
        self.assertIn("project.buildingCount", self.app)
        self.assertIn(".project-operations span,.project-operations small { font-size:12px; }", self.css)

    def test_project_operations_are_available_from_portfolio(self):
        for contract in ("projectDialog", "buildingDialog", "workItemDialog", "newProjectButton"):
            self.assertIn(f'id="{contract}"', self.html)
        self.assertIn("createIdempotencyKey", self.app)
        self.assertIn("'Idempotency-Key': createIdempotencyKey()", self.app)
        self.assertIn("data-add-building", self.app)
        self.assertIn("data-add-work-item", self.app)

    def test_mobile_project_actions_meet_touch_target_contract(self):
        self.assertIn(".project-actions .button { min-height:44px; font-size:13px; }", self.css)
        self.assertIn(".work-item-row select { width:100%; min-height:44px; font-size:16px; }", self.css)

    def test_work_item_quick_status_uses_optimistic_version(self):
        self.assertIn("WORK_ITEM_TRANSITIONS", self.app)
        self.assertIn("expectedVersion: Number(select.dataset.version)", self.app)
        self.assertIn("data-work-item-status", self.app)
        self.assertIn("method: 'PATCH'", self.app)

    def test_dependency_ui_exposes_automatic_blocking(self):
        self.assertIn('id="workItemDependency"', self.html)
        self.assertIn("dependsOnIds", self.app)
        self.assertIn("item.blockedBy", self.app)
        self.assertIn("'auto-blocked'", self.app)
        self.assertIn(".work-item-row.auto-blocked", self.css)

    def test_projects_are_a_separate_routed_view(self):
        self.assertIn('data-route-link="projects"', self.html)
        self.assertIn('data-view="projects"', self.html)
        self.assertIn('data-view="overview"', self.html)
        self.assertIn("function renderRoute()", self.app)
        self.assertIn("body[data-route=\"projects\"] .top-actions", self.css)

    def test_work_type_progress_and_project_activity_are_rendered(self):
        self.assertIn('id="workItemType"', self.html)
        self.assertIn("project.workTypeProgress", self.app)
        self.assertIn("project.activity", self.app)
        self.assertIn("ПРОГРЕСС ПО ВИДАМ РАБОТ", self.app)

    def test_project_detail_supports_technician_daily_flow(self):
        for contract in ('id="projectDetailView"','id="dailyUpdateDialog"','id="locationDialog"','id="dailyHasIssue"'):
            self.assertIn(contract, self.html)
        self.assertIn("function renderProjectDetail()", self.app)
        self.assertIn("Что сделано сегодня?", self.app)
        self.assertIn("issueDescription", self.app)
        self.assertIn("data-edit-daily", self.app)
        self.assertIn("function projectDailyLogEntries(project)", self.app)
        self.assertIn("DAILY LOG · AUTO", self.app)
        self.assertIn("Из журнала изменений", self.app)

    def test_location_detail_has_mobile_unit_grid_and_jobber_report(self):
        for contract in ('id="audioZoneDialog"','id="jobberReportDialog"','id="copyJobberReport"'):
            self.assertIn(contract,self.html)
        self.assertIn("function renderLocationDetail()",self.app)
        self.assertIn("toggleUnit",self.app)
        self.assertIn("Сформировать отчет Jobber",self.app)
        self.assertIn(".unit-grid { grid-template-columns:1fr 1fr; }",self.css)

    def test_project_locations_support_a_configurable_hierarchy(self):
        self.assertIn('id="locationParent"', self.html)
        self.assertIn("parentLocationId", self.app)
        self.assertIn("location.depth", self.app)
        self.assertIn("--location-depth", self.css)

    def test_admin_compute_monitor_is_realtime_and_opt_in(self):
        self.assertIn('data-route-link="admin"',self.html)
        self.assertIn('id="computeNodes"',self.html)
        self.assertIn("hydrateComputeNodes",self.app)
        self.assertIn("data-compute-node",self.app)
        self.assertIn("5000",self.app)
        self.assertIn(".compute-grid",self.css)

    def test_admin_git_sync_settings_are_configurable_without_secrets(self):
        self.assertIn('id="gitSyncForm"',self.html)
        self.assertIn('id="gitRemoteUrl"',self.html)
        self.assertIn("hydrateGitSyncSettings",self.app)
        self.assertIn("submitGitSyncSettings",self.app)
        self.assertIn("/api/v1/admin/git-sync",self.app)
        self.assertIn(".git-sync-status",self.css)
        self.assertIn("Credentials are not stored in Valeronix",self.html)

    def test_admin_can_configure_work_types_and_actions(self):
        self.assertIn('id="workTypeDialog"',self.html)
        self.assertIn('id="workflowAdminList"',self.html)
        self.assertIn("hydrateWorkflowConfiguration",self.app)
        self.assertIn("submitWorkType",self.app)
        self.assertIn("/api/v1/admin/work-types",self.app)
        self.assertIn(".workflow-admin-list",self.css)

    def test_custom_field_schema_drives_location_and_unit_forms(self):
        self.assertIn('id="customFieldDialog"',self.html)
        self.assertIn('id="locationCustomFields"',self.html)
        self.assertIn('id="unitCustomFields"',self.html)
        self.assertIn("hydrateCustomFieldDefinitions",self.app)
        self.assertIn("renderDynamicFields",self.app)
        self.assertIn("collectDynamicFields",self.app)

    def test_unit_taps_are_optimistic_and_preserve_selected_scope(self):
        self.assertIn("unitScopeByLocation",self.app)
        self.assertIn("pending:true",self.app)
        self.assertIn("UNIT_OUTBOX_KEY",self.app)
        self.assertIn("queueUnitMutation",self.app)
        self.assertIn("flushUnitOutbox",self.app)
        self.assertIn("applyUnitOutbox",self.app)
        self.assertIn("selected",self.app)
        self.assertIn(".unit-grid button.pending",self.css)
        self.assertIn(".unit-grid button.pending-offline",self.css)

    def test_unit_cards_bulk_selection_and_history_are_stable(self):
        self.assertIn('id="toggleAllUnits"',self.app)
        self.assertIn("function setAllUnits",self.app)
        self.assertIn("toggle.indeterminate",self.app)
        self.assertIn("height:104px; min-height:104px",self.css)
        self.assertIn(".unit-grid button.complete:not(.pending)::after",self.css)
        self.assertIn("Последние изменения этажа",self.app)

    def test_units_have_separate_editing_without_breaking_quick_taps(self):
        self.assertIn('id="unitDialog"',self.html)
        self.assertIn("function openUnitDialog",self.app)
        self.assertIn("function submitUnit",self.app)
        self.assertIn("data-edit-unit",self.app)
        self.assertIn(".unit-grid .unit-edit",self.css)


if __name__ == "__main__":
    unittest.main()
