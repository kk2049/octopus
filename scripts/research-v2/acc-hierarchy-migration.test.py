"""Offline safety/contract checks; no research experiments or network needed."""
import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("migration", Path(__file__).with_name("acc-hierarchy-migration.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
MANIFEST = Path(__file__).resolve().parents[2] / "doc/research/acc-ae-plan-20260922.json"


def fixture(manifest):
    sources = sorted({source for item in manifest["items"] for source in item["sourceIds"]})
    nodes = [{"id": "source-" + source, "type": "file", "title": source, "version": 3, "archived": False,
              "data": {"meta": {"source_id": source, "read_only": True}}} for source in sources]
    nodes += [{"id": "goal", "type": "goal", "version": 1, "data": {"text": "Original goal"}},
              {"id": "old-agent", "type": "agent", "version": 1, "data": {"instructions": "Preserve me"}},
              {"id": "old-folder", "type": "folder", "version": 2, "data": {"members": [nodes[0]["id"]]}},
              {"id": "old-review", "type": "review", "version": 4, "data": {"targets": {nodes[0]["id"]: 3}, "decision": {"status": "approved"}}}]
    return {"nodes": nodes, "edges": [{"id": "old-edge", "source": "goal", "target": "old-agent"}], "proposals": [], "subscriptions": [], "runs": [], "cursor": 1}


class FakeApp:
    def __init__(self, graph):
        self.graph = copy.deepcopy(graph)
        self.calls = []

    def read_graph(self):
        return copy.deepcopy(self.graph)

    def act(self, action, params):
        self.calls.append((action, copy.deepcopy(params)))
        if action == "resource_read":
            return {"binding": {"node": params["node"], "resource": "original-session", "version": 1}}
        if action != "node_add":
            raise AssertionError("Unexpected write: " + action)
        node = json.loads(params["data"])
        node.update({"id": "created-" + str(len(self.graph["nodes"])), "version": 1, "archived": False})
        existing = {item["id"] for item in self.graph["nodes"]}
        allowed = {"task": {"text", "meta"}, "note": {"text", "meta"}, "folder": {"description", "members", "meta"}, "review": {"targets", "meta"}}
        assert set(node["data"]) <= allowed[node["type"]]
        assert all(value is None or isinstance(value, (str, int, float, bool)) for value in node["data"]["meta"].values())
        if node["type"] == "folder":
            assert len(node["data"]["members"]) == len(set(node["data"]["members"]))
            assert set(node["data"]["members"]) <= existing
        if node["type"] == "review":
            assert set(node["data"]["targets"]) <= existing
            assert "decision" not in node["data"]
        self.graph["nodes"].append(node)
        self.graph["cursor"] += 1
        return {"node": node}


class MigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads(MANIFEST.read_text())

    def setUp(self):
        self.graph = fixture(self.manifest)

    def plan(self):
        return m.build_plan(self.graph, self.manifest, m.INSTANCE)

    def test_explicit_instance_and_complete_source_mapping(self):
        with self.assertRaisesRegex(ValueError, "explicitly named"):
            m.build_plan(self.graph, self.manifest, "another-project")
        self.graph["nodes"] = self.graph["nodes"][1:]
        with self.assertRaisesRegex(ValueError, "Missing existing ACC sources"):
            self.plan()

    def test_preview_is_additive_and_all_original_assets_remain_reachable(self):
        before = copy.deepcopy(self.graph)
        plan = self.plan()
        preview = m.preview_graph(self.graph, plan, self.manifest)
        self.assertEqual(before, self.graph)
        m.verify_preservation(before, preview)
        nodes = {node["id"]: node for node in preview["nodes"]}
        members = {child for node in nodes.values() if node["type"] == "folder" for child in node["data"]["members"]}
        roots = [node for node in nodes.values() if node["id"] not in members]
        self.assertEqual({node["title"] for node in roots if node["type"] == "folder"},
                         {row["title"] for row in self.manifest["directions"]} | {"资料馆 · 原文与历史工作"})
        def visit(ident, trail):
            self.assertNotIn(ident, trail)
            if nodes[ident]["type"] == "folder":
                for child in nodes[ident]["data"]["members"]:
                    visit(child, trail | {ident})
        for root in roots:
            visit(root["id"], set())
        for node in preview["nodes"]:
            if node["type"] == "task":
                self.assertEqual(node["data"]["meta"]["status"], "todo")
                self.assertEqual(node["data"]["meta"]["acceptanceStatus"], "pending")
                self.assertIn("现有材料与缺口", node["data"]["text"])

    def test_apply_preserves_content_bindings_and_review_then_rerun_is_noop(self):
        app = FakeApp(self.graph)
        plan = self.plan()
        with tempfile.TemporaryDirectory() as directory:
            receipt = m.apply_plan(app, self.graph, self.manifest, plan, directory)
            self.assertTrue(receipt["originalRecordsPreserved"])
            self.assertEqual(receipt["edges"], 1)
            backup = json.loads(Path(receipt["backup"]).read_text())
            self.assertEqual(backup["graph"], self.graph)
            self.assertEqual(Path(receipt["backup"]).stat().st_mode & 0o777, 0o600)
            self.assertEqual(Path(directory).stat().st_mode & 0o777, 0o700)
            after = app.read_graph()
            # Human changes since the migration must never be overwritten.
            task = next(node for node in after["nodes"] if node["type"] == "task")
            task["data"]["meta"]["status"] = "in_progress"
            task["title"] = "Human-edited title"
            task["version"] = 2
            review = next(node for node in after["nodes"] if node["type"] == "review" and node["id"] != "old-review")
            review["data"]["decision"] = {"status": "changes_requested"}
            app.graph = copy.deepcopy(after)
            rerun = m.build_plan(after, self.manifest, m.INSTANCE)
            self.assertEqual(rerun["createKeys"], [])
            count = len([call for call in app.calls if call[0] == "node_add"])
            m.apply_plan(app, after, self.manifest, rerun, directory)
            self.assertEqual(len([call for call in app.calls if call[0] == "node_add"]), count)
            self.assertEqual(app.graph, after)

    def test_partial_run_recovers_without_duplicates(self):
        app = FakeApp(self.graph)
        full = self.plan()
        subset = copy.deepcopy(full)
        subset["specs"] = subset["specs"][:10]
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                m.apply_plan(app, self.graph, self.manifest, subset, directory)
            partial = app.read_graph()
            resume = m.build_plan(partial, self.manifest, m.INSTANCE)
            self.assertEqual(len(resume["createKeys"]), len(full["createKeys"]) - 10)
            m.apply_plan(app, partial, self.manifest, resume, directory)
            keys = [node["data"]["meta"]["seedKey"] for node in app.graph["nodes"] if node["data"].get("meta", {}).get("migration") == m.MIGRATION]
            self.assertEqual(len(keys), len(set(keys)))

    def test_resume_pins_new_reviews_to_current_reused_task_versions(self):
        app = FakeApp(self.graph)
        full = self.plan()
        first_review = next(index for index, row in enumerate(full["specs"])
                            if row["node"]["type"] == "review")
        subset = copy.deepcopy(full)
        subset["specs"] = subset["specs"][:first_review]
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                m.apply_plan(app, self.graph, self.manifest, subset, directory)
            # A human edits a reused task while the import is interrupted,
            # before any review of that task has been created.
            edited = next(node for node in app.graph["nodes"] if node["type"] == "task")
            edited["version"] = 2
            edited["title"] = "Human edit after interruption"
            partial = app.read_graph()
            resume = m.build_plan(partial, self.manifest, m.INSTANCE)
            m.apply_plan(app, partial, self.manifest, resume, directory)
            reviews = [node for node in app.graph["nodes"] if node["type"] == "review"
                       and edited["id"] in node["data"]["targets"]]
            self.assertTrue(reviews)
            self.assertTrue(all(node["data"]["targets"][edited["id"]] == 2 for node in reviews))
            self.assertEqual(next(node for node in app.graph["nodes"] if node["id"] == edited["id"]),
                             edited)
            # Once those reviews exist, later task changes never repin them.
            edited["version"] = 3
            after = app.read_graph()
            rerun = m.build_plan(after, self.manifest, m.INSTANCE)
            self.assertEqual(rerun["createKeys"], [])
            m.apply_plan(app, after, self.manifest, rerun, directory)
            self.assertTrue(all(node["data"]["targets"][edited["id"]] == 2 for node in reviews))

    def test_concurrent_edit_and_ambiguous_seed_fail_closed(self):
        app = FakeApp(self.graph)
        app.graph["nodes"][0]["version"] += 1
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "changed since planning"):
                m.apply_plan(app, self.graph, self.manifest, self.plan(), directory)
            self.assertEqual(app.calls, [])
        preview = m.preview_graph(self.graph, self.plan(), self.manifest)
        seed = next(node for node in preview["nodes"] if node["data"].get("meta", {}).get("migration") == m.MIGRATION)
        preview["nodes"].append(copy.deepcopy(seed))
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            m.build_plan(preview, self.manifest, m.INSTANCE)

    def test_review_targets_are_pinned_not_refreshed_on_rerun(self):
        preview = m.preview_graph(self.graph, self.plan(), self.manifest)
        existing_review = next(node for node in preview["nodes"] if node["type"] == "review" and node["id"] != "old-review")
        old_targets = copy.deepcopy(existing_review["data"]["targets"])
        preview["nodes"][0]["version"] += 1
        rerun = m.build_plan(preview, self.manifest, m.INSTANCE)
        next_preview = m.preview_graph(preview, rerun, self.manifest)
        actual = next(node for node in next_preview["nodes"] if node["id"] == existing_review["id"])
        self.assertEqual(actual["data"]["targets"], old_targets)


if __name__ == "__main__":
    unittest.main()
