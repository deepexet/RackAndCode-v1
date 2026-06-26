import tempfile
import unittest
from pathlib import Path

from scripts.backup import create_backup, inspect_database, prune_backups, restore_backup, verify_backup
from server.app import WorkspaceStore


TASK = {"id": "FS-TEST", "title": "Backup test", "type": "Task", "status": "backlog", "priority": "medium", "area": "foundation"}


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.database = self.root / "fieldos.db"
        self.store = WorkspaceStore(self.database)
        self.store.save([TASK], [], 0)

    def tearDown(self):
        self.temp.cleanup()

    def test_backup_verify_restore_round_trip(self):
        backup = create_backup(self.database, self.root / "backups", keep=5)
        verification = verify_backup(backup)
        self.assertTrue(verification["verified"])
        self.assertEqual(verification["schemaVersion"], "077")
        restored = restore_backup(backup, self.root / "restored.db")
        restored_store = WorkspaceStore(restored)
        self.assertEqual(restored_store.get()["tasks"][0]["id"], "FS-TEST")

    def test_restore_refuses_existing_target(self):
        backup = create_backup(self.database, self.root / "backups", keep=5)
        target = self.root / "existing.db"
        target.touch()
        with self.assertRaises(FileExistsError):
            restore_backup(backup, target)

    def test_checksum_detects_tampering(self):
        backup = create_backup(self.database, self.root / "backups", keep=5)
        with backup.open("ab") as stream:
            stream.write(b"tampered")
        with self.assertRaises(RuntimeError):
            verify_backup(backup)

    def test_retention_removes_oldest_backup_and_manifest(self):
        output = self.root / "backups"
        for _ in range(3):
            create_backup(self.database, output, keep=10)
        removed = prune_backups(output, keep=2)
        self.assertEqual(len(removed), 1)
        self.assertFalse(removed[0].exists())
        self.assertEqual(len(list(output.glob("rackpilot-*.db"))), 2)

    def test_live_database_remains_valid(self):
        create_backup(self.database, self.root / "backups", keep=5)
        self.assertEqual(inspect_database(self.database)["integrity"], "ok")


if __name__ == "__main__":
    unittest.main()
