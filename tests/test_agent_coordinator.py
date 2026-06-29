from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from coordinator.core import CoordinatorStore, JobCreate, build_agent_command


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
        events = self.store.list_events(job["id"])
        self.assertEqual(events[0]["eventType"], "job.created")

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
        self.assertIsNotNone(approved["completedAt"])

    def test_agent_commands_do_not_use_shell(self):
        claude_job = self.store.create_job(self.payload())
        claude_cmd = build_agent_command(claude_job, "/usr/local/bin/claude")
        self.assertEqual(claude_cmd[0], "/usr/local/bin/claude")
        self.assertIn("dontAsk", claude_cmd)
        self.assertIn("--verbose", claude_cmd)

        codex_job = self.store.create_job(
            self.payload(assigned_agent="codex", branch_name="codex/feature")
        )
        codex_cmd = build_agent_command(codex_job, "/usr/local/bin/codex")
        self.assertEqual(codex_cmd[:3], ["/usr/local/bin/codex", "exec", "--json"])
        self.assertIn("workspace-write", codex_cmd)

    def test_failed_job_can_be_requeued_for_retry(self):
        job = self.store.create_job(self.payload())
        self.store.transition_job(job["id"], "running")
        self.store.transition_job(job["id"], "failed", error="cli contract changed", exit_code=1)

        queued = self.store.transition_job(job["id"], "queued", actor="owner")

        self.assertEqual(queued["status"], "queued")
        self.assertIsNone(queued["startedAt"])
        self.assertIsNone(queued["completedAt"])
        self.assertEqual(queued["error"], "")


if __name__ == "__main__":
    unittest.main()
