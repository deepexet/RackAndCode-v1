from __future__ import annotations

import tempfile
import unittest
from collections import deque
from pathlib import Path
import subprocess
from unittest.mock import patch

from coordinator.core import (
    AgentProbe,
    CoordinatorStore,
    JobCreate,
    build_agent_command,
    create_managed_worktree,
    inspect_worktree,
    integrate_job_worktree,
    remove_managed_worktree,
)
from coordinator.scheduler import CoordinatorScheduler


class CoordinatorStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = CoordinatorStore(Path(self.temp_dir.name) / "coordinator.db")

    def tearDown(self):
        self.temp_dir.cleanup()

    def payload(self, **overrides):
        values = {
            "title": "Implement scoped feature",
            "instructions": "Change only the assigned module and run tests.",
            "assigned_agent": "claude",
            "worktree_path": "/tmp/rackpilot-claude",
            "branch_name": "claude/feature",
            "created_by": "codex",
            "requires_review": True,
            "max_turns": 6,
        }
        values.update(overrides)
        return JobCreate(**values)

    def test_job_is_queued_and_audited(self):
        job = self.store.create_job(self.payload())
        self.assertEqual(job["status"], "queued")
        self.assertEqual(job["assignedAgent"], "claude")
        self.assertEqual(job["attempt"], 0)
        self.assertEqual(job["agentSessionId"], "")
        self.assertEqual(job["reviewFeedback"], "")
        self.assertFalse(job["managedWorktree"])
        self.assertEqual(job["scopePaths"], [])
        events = self.store.list_events(job["id"])
        self.assertEqual(events[0]["eventType"], "job.created")

    def test_autonomous_shift_settings_are_persistent_and_bounded(self):
        initial = self.store.get_autonomous_shift()
        self.assertFalse(initial["enabled"])
        shift = self.store.save_autonomous_shift(
            enabled=True,
            started_at="2026-06-30T08:00:00+00:00",
            ends_at="2026-06-30T18:00:00+00:00",
            retry_minutes=1,
            auto_approve=True,
        )
        self.assertTrue(shift["enabled"])
        self.assertEqual(shift["retryMinutes"], 5)
        reopened = CoordinatorStore(self.store.db_path).get_autonomous_shift()
        self.assertEqual(reopened["endsAt"], "2026-06-30T18:00:00+00:00")

    def test_job_keeps_kanban_source_and_can_be_filtered(self):
        linked = self.store.create_job(self.payload(
            source_organization_id="local-dev",
            source_project_id="rackpilot",
            source_work_item_id="wi-123",
        ))
        self.store.create_job(self.payload(branch_name="claude/unrelated"))

        self.assertEqual(linked["sourceWorkItemId"], "wi-123")
        filtered = self.store.list_jobs(source_work_item_id="wi-123")
        self.assertEqual([job["id"] for job in filtered], [linked["id"]])

    def test_integration_branch_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "integration branch"):
            self.store.create_job(self.payload(branch_name="main"))

    def test_invalid_transition_is_rejected(self):
        job = self.store.create_job(self.payload())
        with self.assertRaisesRegex(ValueError, "invalid transition"):
            self.store.transition_job(job["id"], "completed")

    def test_review_transition_records_result(self):
        job = self.store.create_job(self.payload())
        self.store.transition_job(job["id"], "running")
        reviewed = self.store.transition_job(job["id"], "review", result_summary="done", exit_code=0)
        self.assertEqual(reviewed["status"], "review")
        self.assertEqual(reviewed["resultSummary"], "done")

        approved = self.store.transition_job(job["id"], "completed", actor="owner")
        self.assertEqual(approved["status"], "completed")
        self.assertEqual(approved["resultSummary"], "done")
        self.assertEqual(approved["exitCode"], 0)
        self.assertIsNotNone(approved["completedAt"])

    def test_agent_commands_do_not_use_shell(self):
        claude_job = self.store.create_job(self.payload())
        claude_cmd = build_agent_command(claude_job, "/usr/local/bin/claude")
        self.assertEqual(claude_cmd[0], "/usr/local/bin/claude")
        self.assertIn("acceptEdits", claude_cmd)
        self.assertNotIn("bypassPermissions", claude_cmd)

        resumed = dict(claude_job, agentSessionId="session-123")
        resumed_cmd = build_agent_command(resumed, "/usr/local/bin/claude")
        self.assertIn("--resume", resumed_cmd)
        self.assertIn("session-123", resumed_cmd)
        self.assertIn("Do not repeat completed analysis", resumed_cmd[2])

        with_feedback = dict(resumed, reviewFeedback="Correct the stale endpoint matrix")
        feedback_cmd = build_agent_command(with_feedback, "/usr/local/bin/claude")
        self.assertIn("Correct the stale endpoint matrix", feedback_cmd[2])
        self.assertIn("--verbose", claude_cmd)

        codex_job = self.store.create_job(
            self.payload(assigned_agent="codex", branch_name="codex/feature")
        )
        codex_cmd = build_agent_command(codex_job, "/usr/local/bin/codex")
        self.assertEqual(codex_cmd[:3], ["/usr/local/bin/codex", "exec", "--json"])
        self.assertIn("workspace-write", codex_cmd)

        local_job = self.store.create_job(
            self.payload(assigned_agent="local", branch_name="local/summary")
        )
        local_cmd = build_agent_command(local_job, "/usr/bin/python3")
        self.assertEqual(local_cmd[0], "/usr/bin/python3")
        self.assertIn("local_worker.py", local_cmd[1])
        self.assertIn("--model", local_cmd)
        self.assertNotIn("workspace-write", local_cmd)

    def test_failed_job_can_be_requeued_for_retry(self):
        job = self.store.create_job(self.payload())
        self.store.transition_job(job["id"], "running")
        self.store.transition_job(job["id"], "failed", error="cli contract changed", exit_code=1)

        queued = self.store.transition_job(job["id"], "queued", actor="owner")

        self.assertEqual(queued["status"], "queued")
        self.assertIsNone(queued["startedAt"])
        self.assertIsNone(queued["completedAt"])
        self.assertEqual(queued["error"], "")

    def test_rate_limited_job_can_be_cancelled_for_agent_handoff(self):
        job = self.store.create_job(self.payload())
        self.store.transition_job(job["id"], "running")
        self.store.transition_job(job["id"], "rate_limited", error="usage limit")
        handed_off = self.store.transition_job(job["id"], "cancelled", actor="autonomous-utilization")
        self.assertEqual(handed_off["status"], "cancelled")

    def test_job_logs_are_ordered_and_incremental(self):
        job = self.store.create_job(self.payload())
        first = self.store.append_job_log(job["id"], "Agent session started", "system")
        second = self.store.append_job_log(job["id"], '{"type":"turn.started"}')

        self.assertEqual(
            [entry["message"] for entry in self.store.list_job_logs(job["id"])],
            ["Agent session started", '{"type":"turn.started"}'],
        )
        incremental = self.store.list_job_logs(job["id"], after_id=first["id"])
        self.assertEqual([entry["id"] for entry in incremental], [second["id"]])

    def test_retry_logs_are_scoped_to_the_latest_attempt(self):
        job = self.store.create_job(self.payload())
        first_run = self.store.transition_job(job["id"], "running")
        self.assertEqual(first_run["attempt"], 1)
        self.store.append_job_log(job["id"], "first attempt")
        self.store.transition_job(job["id"], "failed", error="retry me")
        self.store.transition_job(job["id"], "queued", actor="owner")
        second_run = self.store.transition_job(job["id"], "running", actor="owner")
        self.assertEqual(second_run["attempt"], 2)
        self.store.append_job_log(job["id"], "second attempt")

        latest = self.store.list_job_logs(job["id"], attempt=second_run["attempt"])
        self.assertEqual([entry["message"] for entry in latest], ["second attempt"])
        self.assertEqual(latest[0]["attempt"], 2)

    def test_execution_context_persists_session_and_turn_limit(self):
        job = self.store.create_job(self.payload())
        updated = self.store.update_execution_context(
            job["id"], agent_session_id="claude-session", max_turns=12
        )
        self.assertEqual(updated["agentSessionId"], "claude-session")
        self.assertEqual(updated["maxTurns"], 12)

        reviewed = self.store.update_execution_context(
            job["id"], review_feedback="Add verification evidence"
        )
        self.assertEqual(reviewed["reviewFeedback"], "Add verification evidence")

    def test_worktree_review_lists_changes_without_file_contents(self):
        root = Path(self.temp_dir.name) / "review-repo"
        root.mkdir()
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        (root / "changed.txt").write_text("private content", encoding="utf-8")

        review = inspect_worktree(str(root))

        self.assertTrue(review["dirty"])
        self.assertEqual(review["changeCount"], 1)
        self.assertEqual(review["changes"][0]["path"], "changed.txt")
        self.assertNotIn("private content", str(review))

    def test_runner_streams_output_before_review(self):
        from coordinator import app as coordinator_app

        job = self.store.create_job(self.payload(worktree_path=self.temp_dir.name))
        self.store.transition_job(job["id"], "running")
        previous_store = coordinator_app.store
        coordinator_app.store = self.store
        try:
            with (
                patch.object(
                    coordinator_app,
                    "probe_agent",
                    return_value=AgentProbe("claude", True, "/bin/sh", "test"),
                ),
                patch.object(
                    coordinator_app,
                    "build_agent_command",
                    return_value=["/bin/sh", "-c", "printf 'first\\nsecond\\n'"],
                ),
            ):
                coordinator_app._run_job(job["id"])
        finally:
            coordinator_app.store = previous_store

        messages = [entry["message"] for entry in self.store.list_job_logs(job["id"])]
        self.assertIn("first", messages)
        self.assertIn("second", messages)
        self.assertEqual(self.store.get_job(job["id"])["status"], "review")

    def test_allowed_claude_usage_warning_is_not_a_rate_limit(self):
        from coordinator.app import _concise_failure, _is_rate_limited_output

        allowed = deque([
            '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","utilization":0.83}}',
            '{"type":"result","subtype":"success","is_error":false,"result":"done"}',
        ])
        blocked = deque([
            '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","utilization":1.0}}',
        ])
        codex_blocked = deque([
            '{"type":"error","message":"You have hit your usage limit. Try again later."}',
        ])

        self.assertFalse(_is_rate_limited_output(allowed))
        self.assertTrue(_is_rate_limited_output(blocked))
        self.assertTrue(_is_rate_limited_output(codex_blocked))
        self.assertEqual(
            _concise_failure(codex_blocked, rate_limited=True),
            "You have hit your usage limit. Try again later.",
        )
        max_turns = deque([
            '{"type":"result","errors":["Reached maximum number of turns (10)"]}'
        ])
        self.assertEqual(
            _concise_failure(max_turns),
            "Reached maximum number of turns (10)",
        )


    def test_managed_worktree_create_and_safe_remove(self):
        repo = Path(self.temp_dir.name) / "source"
        managed_root = Path(self.temp_dir.name) / "managed"
        repo.mkdir()
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.email", "tests@rackpilot.local"], check=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.name", "RackPilot Tests"], check=True)
        (repo / "README.md").write_text("base", encoding="utf-8")
        subprocess.run(["git", "-C", str(repo), "add", "README.md"], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-qm", "base"], check=True)

        created = create_managed_worktree(
            repo, managed_root, agent="claude", title="Audit API parity", base_ref="HEAD"
        )
        self.assertTrue(Path(created["worktreePath"]).is_dir())
        self.assertTrue(created["branchName"].startswith("claude/rp-audit-api-parity-"))

        remove_managed_worktree(repo, created["worktreePath"])
        self.assertFalse(Path(created["worktreePath"]).exists())

    def test_scheduler_runs_one_job_per_agent_and_locks_worktrees(self):
        launched: list[str] = []
        scheduler = CoordinatorScheduler(
            self.store, launched.append, enabled=True, max_concurrent=2, max_per_agent=1
        )
        codex = self.store.create_job(
            self.payload(assigned_agent="codex", branch_name="codex/one", worktree_path="/tmp/codex-one")
        )
        claude = self.store.create_job(
            self.payload(branch_name="claude/one", worktree_path="/tmp/claude-one")
        )
        waiting = self.store.create_job(
            self.payload(assigned_agent="codex", branch_name="codex/two", worktree_path="/tmp/codex-two")
        )

        started = scheduler.tick()

        self.assertEqual(set(started), {codex["id"], claude["id"]})
        self.assertEqual(set(launched), set(started))
        self.assertEqual(self.store.get_job(waiting["id"])["status"], "queued")
        self.assertEqual(
            scheduler.snapshot()["runningByAgent"], {"claude": 1, "codex": 1, "local": 0}
        )

    def test_recovery_marks_orphaned_running_jobs_failed(self):
        job = self.store.create_job(self.payload())
        self.store.transition_job(job["id"], "running")

        recovered = self.store.recover_interrupted_jobs()

        self.assertEqual(len(recovered), 1)
        self.assertEqual(recovered[0]["status"], "failed")
        self.assertIn("Coordinator restarted", recovered[0]["error"])

    def test_stopped_job_can_be_handed_off_with_worktree_context_preserved(self):
        job = self.store.create_job(self.payload())
        self.store.transition_job(job["id"], "running")
        self.store.update_execution_context(job["id"], agent_session_id="claude-session")
        self.store.transition_job(job["id"], "rate_limited", error="usage limit")

        with patch("coordinator.core._changed_paths", return_value=["backend/app/routes/wiki.py"]):
            handed_off = self.store.reassign_job(job["id"], "codex")
        queued = self.store.transition_job(job["id"], "queued", actor="owner-handoff")

        self.assertEqual(handed_off["assignedAgent"], "codex")
        self.assertEqual(handed_off["worktreePath"], job["worktreePath"])
        self.assertEqual(handed_off["branchName"], job["branchName"])
        self.assertEqual(handed_off["agentSessionId"], "")
        self.assertIn("AGENT HANDOFF", handed_off["instructions"])
        self.assertIn("backend/app/routes/wiki.py", handed_off["scopePaths"])
        self.assertEqual(queued["status"], "queued")
        events = self.store.list_events(job["id"])
        self.assertTrue(any(event["eventType"] == "job.reassigned" for event in events))

    def test_scheduler_defers_overlapping_scopes_across_agents(self):
        launched: list[str] = []
        scheduler = CoordinatorScheduler(
            self.store, launched.append, enabled=True, max_concurrent=2, max_per_agent=1
        )
        first = self.store.create_job(
            self.payload(
                assigned_agent="codex",
                branch_name="codex/projects",
                worktree_path="/tmp/codex-projects",
                scope_paths=("frontend/src/modules/projects.js",),
            )
        )
        second = self.store.create_job(
            self.payload(
                branch_name="claude/projects",
                worktree_path="/tmp/claude-projects",
                scope_paths=("frontend/src/modules",),
            )
        )

        scheduler.tick()

        self.assertEqual(self.store.get_job(first["id"])["status"], "running")
        self.assertEqual(self.store.get_job(second["id"])["status"], "queued")


class IntegrationGateTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name) / "repo"
        self.root.mkdir()
        subprocess.run(["git", "init", "-b", "integration"], cwd=self.root, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=self.root, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=self.root, check=True)
        (self.root / "README.md").write_text("base\n", encoding="utf-8")
        subprocess.run(["git", "add", "README.md"], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "-m", "base"], cwd=self.root, check=True, capture_output=True)
        self.managed = create_managed_worktree(
            self.root, Path(self.temp_dir.name) / "worktrees",
            agent="claude", title="Architecture docs", base_ref="integration",
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def job(self, scope_paths=("docs",), created_by="owner"):
        return {
            "title": "Document architecture", "assignedAgent": "claude",
            "worktreePath": self.managed["worktreePath"], "branchName": self.managed["branchName"],
            "baseCommit": self.managed["baseCommit"], "scopePaths": list(scope_paths),
            "createdBy": created_by,
        }

    def test_scoped_changes_are_committed_and_cherry_picked(self):
        docs = Path(self.managed["worktreePath"]) / "docs"
        docs.mkdir()
        (docs / "adr.md").write_text("# Decision\n", encoding="utf-8")
        result = integrate_job_worktree(self.root, self.job())
        self.assertTrue((self.root / "docs" / "adr.md").exists())
        self.assertTrue(result["resultCommit"])
        self.assertTrue(result["integratedCommit"])
        self.assertIn("no syntax check", result["qualitySummary"])
        status = subprocess.run(["git", "status", "--porcelain"], cwd=self.root, capture_output=True, text=True, check=True)
        self.assertEqual(status.stdout, "")

    def test_out_of_scope_change_is_rejected_before_commit(self):
        (Path(self.managed["worktreePath"]) / "server.py").write_text("print('unsafe')\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "outside declared scope"):
            integrate_job_worktree(self.root, self.job())
        self.assertFalse((self.root / "server.py").exists())

    def test_handoff_review_without_corrections_is_successful(self):
        result = integrate_job_worktree(self.root, self.job(created_by="handoff-review:source-job"))
        self.assertEqual(result["resultCommit"], result["integratedCommit"])
        self.assertIn("approved without corrective changes", result["qualitySummary"])


if __name__ == "__main__":
    unittest.main()
