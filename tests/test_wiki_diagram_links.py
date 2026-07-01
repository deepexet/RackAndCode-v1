import tempfile
import unittest
import sqlite3
from pathlib import Path

from server.app import DEFAULT_ORGANIZATION_ID, WorkspaceStore


class WikiDiagramLinkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = WorkspaceStore(Path(self.tmp.name) / "test.db")
        self.org = DEFAULT_ORGANIZATION_ID
        with self.store._connect() as conn:
            # Migration 091 documents these as manually-added legacy columns.
            # Production databases already have them; isolated clean DBs do not.
            for ddl in (
                "ALTER TABLE wiki_pages ADD COLUMN page_type TEXT NOT NULL DEFAULT 'general'",
                "ALTER TABLE wiki_pages ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE wiki_pages ADD COLUMN helpful_count INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE wiki_pages ADD COLUMN not_helpful_count INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE wiki_pages ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'",
            ):
                try:
                    conn.execute(ddl)
                except Exception as exc:
                    if "duplicate column" not in str(exc).lower():
                        raise
            conn.execute(
                "INSERT OR IGNORE INTO organizations(id,name,slug,status,created_at) VALUES(?,?,?,?,datetime('now'))",
                ("other-org", "Other", "other", "active"),
            )
        self.page = self.store.create_wiki_page(self.org, {"title": "Runbook"}, actor="owner")
        self.diagram = self.store.create_wiki_page(
            self.org,
            {"title": "Panel wiring", "pageType": "schema", "metadata": {"diagramJson": "{\"components\":[]}"}},
            actor="owner",
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_link_lists_on_page_and_as_backlink(self):
        link = self.store.link_wiki_diagram(self.org, self.page["id"], self.diagram["id"], actor="owner")
        second = self.store.create_wiki_page(self.org, {"title": "Network", "pageType": "schema"})
        self.store.link_wiki_diagram(self.org, self.page["id"], second["id"], actor="owner")
        self.assertIsNotNone(link)
        self.assertEqual(link["state"], "active")
        links = self.store.list_wiki_page_diagram_links(self.org, self.page["id"])
        self.assertEqual({item["title"] for item in links}, {"Panel wiring", "Network"})
        backlinks = self.store.list_diagram_wiki_backlinks(self.org, self.diagram["id"])
        self.assertEqual(backlinks[0]["wiki_page_id"], self.page["id"])

    def test_cross_tenant_link_is_rejected(self):
        foreign = self.store.create_wiki_page("other-org", {"title": "Foreign", "pageType": "schema"})
        self.assertIsNone(self.store.link_wiki_diagram(self.org, self.page["id"], foreign["id"]))
        self.assertEqual(self.store.list_wiki_page_diagram_links(self.org, self.page["id"]), [])

    def test_database_rejects_cross_tenant_relation(self):
        foreign = self.store.create_wiki_page("other-org", {"title": "Foreign", "pageType": "schema"})
        with self.assertRaises(sqlite3.IntegrityError):
            with self.store._connect() as conn:
                conn.execute(
                    """INSERT INTO wiki_diagram_links
                       (id,organization_id,wiki_page_id,diagram_id,created_at,updated_at)
                       VALUES(?,?,?,?,datetime('now'),datetime('now'))""",
                    ("invalid-cross-tenant", self.org, self.page["id"], foreign["id"]),
                )

    def test_non_diagram_and_self_links_are_rejected(self):
        other_page = self.store.create_wiki_page(self.org, {"title": "Not a diagram"})
        self.assertIsNone(self.store.link_wiki_diagram(self.org, self.page["id"], other_page["id"]))
        self.assertIsNone(self.store.link_wiki_diagram(self.org, self.diagram["id"], self.diagram["id"]))

    def test_deleted_diagram_retains_snapshot_and_history(self):
        self.store.link_wiki_diagram(self.org, self.page["id"], self.diagram["id"], actor="owner")
        self.store.delete_wiki_page(self.org, self.diagram["id"], actor="owner")
        links = self.store.list_wiki_page_diagram_links(self.org, self.page["id"])
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0]["state"], "deleted")
        self.assertEqual(links[0]["title"], "Panel wiring")
        self.assertIn("diagramJson", links[0]["metadata"])
        actions = [event["action"] for event in self.store.list_wiki_diagram_history(self.org, self.page["id"])]
        self.assertEqual(actions[:2], ["diagram_deleted", "linked"])

    def test_unlink_is_audited_and_removes_current_relation(self):
        self.store.link_wiki_diagram(self.org, self.page["id"], self.diagram["id"], actor="owner")
        self.assertTrue(self.store.unlink_wiki_diagram(self.org, self.page["id"], self.diagram["id"], actor="owner"))
        self.assertEqual(self.store.list_wiki_page_diagram_links(self.org, self.page["id"]), [])
        history = self.store.list_wiki_diagram_history(self.org, self.page["id"])
        self.assertEqual(history[0]["action"], "unlinked")
        with self.store._connect() as conn:
            audit = conn.execute(
                "SELECT action FROM audit_log WHERE organization_id=? ORDER BY created_at DESC",
                (self.org,),
            ).fetchall()
        self.assertIn("wiki.diagram_unlinked", [row["action"] for row in audit])

    def test_replayed_link_is_idempotent(self):
        self.store.link_wiki_diagram(self.org, self.page["id"], self.diagram["id"], actor="owner")
        self.store.link_wiki_diagram(self.org, self.page["id"], self.diagram["id"], actor="owner")
        history = self.store.list_wiki_diagram_history(self.org, self.page["id"])
        self.assertEqual([event["action"] for event in history], ["linked"])

    def test_deleted_reference_requires_explicit_restore(self):
        diagram_id = self.diagram["id"]
        self.store.link_wiki_diagram(self.org, self.page["id"], diagram_id, actor="owner")
        self.store.delete_wiki_page(self.org, diagram_id, actor="owner")
        recreated = self.store.create_wiki_page(
            self.org, {"id": diagram_id, "title": "Recovered wiring", "pageType": "schema"}, actor="owner"
        )

        link = self.store.list_wiki_page_diagram_links(self.org, self.page["id"])[0]
        self.assertEqual(link["state"], "deleted")
        self.assertEqual(link["title"], "Panel wiring")
        self.assertEqual(recreated["id"], diagram_id)
        self.assertEqual(self.store.list_diagram_wiki_backlinks(self.org, diagram_id), [])
        diagram = next(d for d in self.store.list_wiki_diagrams(self.org) if d["id"] == diagram_id)
        self.assertEqual(diagram["backlink_count"], 0)

        restored = self.store.link_wiki_diagram(self.org, self.page["id"], diagram_id, actor="owner")
        self.assertEqual(restored["state"], "active")
        self.assertEqual(restored["title"], "Recovered wiring")
        self.assertEqual(self.store.list_wiki_diagram_history(self.org, self.page["id"])[0]["action"], "restored")


if __name__ == "__main__":
    unittest.main()
