#!/usr/bin/env python3
"""Add a reviewed ACC A–E work hierarchy. Default: dry-run, no App mutation.

Only creates nodes, with folder membership referencing existing assets. Never
updates research content, bindings, file versions, edges, reviews or documents.
"""
import argparse
import copy
import hashlib
import http.cookiejar
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

INSTANCE = "asi_51e0080bd7704fe9ac48d723b8c6fe45"
MIGRATION = "acc-ae-20260922"
SOURCE_PREFIX = "source:"
SEED_PREFIX = "seed:"
WORK_KINDS = {"analysis", "design", "writing", "development", "testing"}


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def private_json(path, value):
    """Exclusive creation prevents accidentally replacing an earlier receipt."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def require_instance(instance):
    if instance != INSTANCE:
        raise ValueError("This migration is restricted to the explicitly named ACC instance")


def validate_manifest(manifest):
    require_instance(manifest.get("instance"))
    if manifest.get("schema") != 1 or manifest.get("migration") != MIGRATION:
        raise ValueError("Unsupported ACC migration manifest")
    if {row["key"] for row in manifest["directions"]} != set("ABCDE"):
        raise ValueError("The reviewed plan must contain all five directions")
    keys = [row["key"] for row in manifest["items"]]
    if len(keys) != len(set(keys)) or set(keys) != {"A0", "A1", "B0", "B1", "C0", "C1", "D0", "E0", "E1", "E2", "E3", "E4"}:
        raise ValueError("The reviewed plan must contain the twelve concrete work items")
    for item in manifest["items"]:
        if item["direction"] not in "ABCDE" or not item["reviews"] or not item["tasks"]:
            raise ValueError("Each work item needs concrete tasks and review criteria")
        if any(task["workKind"] not in WORK_KINDS for task in item["tasks"]):
            raise ValueError("Unknown task work kind")
    if len(manifest["source"]["text"]) > 20000:
        raise ValueError("Source plan exceeds the native note text limit")


def active_nodes(graph):
    return [node for node in graph["nodes"] if not node.get("archived")]


def index_graph(graph, manifest):
    nodes = active_nodes(graph)
    sources, seeds = {}, {}
    for node in graph["nodes"]:
        meta = node.get("data", {}).get("meta", {})
        if meta.get("migration") == MIGRATION:
            key = meta.get("seedKey")
            if not key or key in seeds or node.get("archived"):
                raise ValueError("Ambiguous or archived migration seed; manual review required")
            if meta.get("manifestSha256") != digest(manifest):
                raise ValueError("Existing migration uses a different manifest; do not overwrite it")
            seeds[key] = node
    for node in nodes:
        source = node.get("data", {}).get("meta", {}).get("source_id")
        if source:
            if source in sources:
                raise ValueError("Ambiguous source identity: " + source)
            sources[source] = node
    required = {source for item in manifest["items"] for source in item["sourceIds"]}
    missing = sorted(required - sources.keys())
    if missing:
        raise ValueError("Missing existing ACC sources: " + ", ".join(missing))
    if len([node for node in nodes if node["type"] == "goal"]) != 1:
        raise ValueError("Expected one existing ACC GOAL; inspect the instance before importing")
    return nodes, sources, seeds


def build_plan(graph, manifest, instance):
    require_instance(instance)
    validate_manifest(manifest)
    nodes, sources, seeds = index_graph(graph, manifest)
    manifest_sha = digest(manifest)
    source = manifest["source"]
    specs = []
    common = {
        "migration": MIGRATION, "manifestSha256": manifest_sha,
        "progressSource": "用户计划（进度陈述，未经本轮验收）",
        "sourceThread": source["thread"], "sourceAt": source["at"],
        "acceptanceStatus": "pending",
    }

    def add(key, kind, title, summary, data, *, slot=0, meta=None):
        specs.append({"key": key, "node": {
            "type": kind, "title": title, "summary": summary, "phase": "future" if kind == "task" else "present",
            "x": (slot % 3) * 340, "y": (slot // 3) * 250,
            "data": {**data, "meta": {**common, "seedKey": key, **(meta or {})}},
        }})
        return SEED_PREFIX + key

    source_ref = add("source-plan", "note", "ACC · 9 月 22 日完整计划原文", "A–E 最新计划与用户进度陈述；来源会话和时间均保留。", {"text": source["text"]})
    policy_ref = add("evidence-boundary", "note", "现状、证据与审查边界", "用户计划、历史材料、当前工作状态和审查结论分别记录。", {"text":
        "本工作区按 A–E → 具体事项 → 必要工作/材料/独立审查组织。\n\n"
        "进度陈述来自 2026-09-22 用户原文；任务的待办状态表示本轮整理出的下一步。旧报告和源码快照只证明对应版本的材料存在。所有新审查保持待审，需读到确切版本后人工决定。\n\n"
        "特别核验：B1 的 wr-only 最新批次和 C 的实现提交尚未绑定；E1 报告中 STORM-Full 是历史 OCC 标签，STORM-WW 不含 Saga；E2 保留 WB4 notify3 负结果；E3 的 R15 是历史批次，需确认与最新题集关系。\n\n"
        "原有 45 个文件、两位历史 Agent、正文、关系和审查均保留。目录可引用同一材料。没有派发研究任务、启动实验或代替用户批准结果。"}, slot=1)

    item_refs = {}
    for item in manifest["items"]:
        key = item["key"]
        refs = []
        task_refs = []
        for slot, task in enumerate(item["tasks"]):
            task_ref = add(key + "/task/" + task["workKind"], "task", task["title"], task["text"],
                {"text": task["text"] + "\n\n现有材料与缺口：" + item["evidenceNote"] + "\n\n来源进度（用户陈述）：" + item["claimedProgress"]},
                slot=slot, meta={"workKind": task["workKind"], "status": "todo", "workItem": key,
                                 "claimedProgress": item["claimedProgress"], "evidenceNote": item["evidenceNote"]})
            refs.append(task_ref)
            task_refs.append(task_ref)
        evidence_refs = [SOURCE_PREFIX + ident for ident in item["sourceIds"]]
        refs.append(add(key + "/materials", "folder", "材料与当前证据", item["evidenceNote"],
            {"description": item["evidenceNote"], "members": evidence_refs}, slot=len(refs), meta={"workItem": key}))
        for at, review in enumerate(item["reviews"]):
            # Pin the exact semantic versions at first creation. A later rerun
            # never refreshes targets or erases a human review decision.
            # A resumed run may reuse a task edited after the interruption.
            # New reviews pin that current version; already-created reviews
            # remain untouched by apply_plan's seed check.
            targets = {
                ref: seeds[ref[len(SEED_PREFIX):]]["version"]
                if ref[len(SEED_PREFIX):] in seeds else 1
                for ref in task_refs
            }
            targets.update({SOURCE_PREFIX + ident: sources[ident]["version"] for ident in item["sourceIds"]})
            refs.append(add(key + "/review/" + str(at), "review", review["title"], review["criteria"],
                {"targets": targets}, slot=len(refs), meta={"workItem": key, "criteria": review["criteria"]}))
        direction_slot = len([other for other in item_refs if other.startswith(item["direction"])])
        item_refs[key] = add(key, "folder", key.replace("D0", "D") + " · " + item["title"], item["claimedProgress"],
            {"description": item["evidenceNote"], "members": refs}, slot=direction_slot,
            meta={"workItem": key, "claimedProgress": item["claimedProgress"], "evidenceNote": item["evidenceNote"]})

    for at, direction in enumerate(manifest["directions"]):
        add("direction/" + direction["key"], "folder", direction["title"], direction["summary"],
            {"description": direction["summary"], "members": [item_refs[item["key"]] for item in manifest["items"] if item["direction"] == direction["key"]]}, slot=at)

    # Only old roots go in the library, so pre-existing folder structure and
    # shared memberships survive. No title-based fuzzy reassignment.
    originals = [node for node in nodes if node.get("data", {}).get("meta", {}).get("migration") != MIGRATION]
    contained = {member for node in originals if node["type"] == "folder" for member in node.get("data", {}).get("members", [])}
    old_roots = [node["id"] for node in originals if node["id"] not in contained and node["type"] != "goal"]
    # Seed is immutable after creation, so later unrelated additions remain
    # visible instead of being silently pulled into the historical library.
    add("library", "folder", "资料馆 · 原文与历史工作", "完整计划、原有材料、历史 Agent 与旧审查；所有原始内容和绑定保留。",
        {"description": "历史目录按原样保留；最新工作入口为 A–E。阅读历史 Agent 不代表已续跑。", "members": [source_ref, policy_ref, *old_roots]}, slot=5)

    keys = [row["key"] for row in specs]
    if len(keys) != len(set(keys)):
        raise ValueError("Duplicate task/seed key in curated plan")
    result = {"schema": 1, "migration": MIGRATION, "instance": instance, "manifestSha256": manifest_sha,
        "before": {"nodes": len(graph["nodes"]), "edges": len(graph["edges"]), "cursor": graph.get("cursor")},
        "originalIds": [node["id"] for node in originals], "specs": specs,
        "createKeys": [row["key"] for row in specs if row["key"] not in seeds], "existingKeys": sorted(seeds),
        "writes": "node_add only; no content/binding/edge/review updates", "warnings": [item["key"] + ": " + item["evidenceNote"] for item in manifest["items"]]}
    return result


def resolve_node(spec, source_ids, seed_ids):
    result = copy.deepcopy(spec)

    def resolve(ref):
        if ref.startswith(SOURCE_PREFIX):
            return source_ids[ref[len(SOURCE_PREFIX):]]
        if ref.startswith(SEED_PREFIX):
            return seed_ids[ref[len(SEED_PREFIX):]]
        return ref

    if result["type"] == "folder":
        result["data"]["members"] = [resolve(ref) for ref in result["data"]["members"]]
    if result["type"] == "review":
        result["data"]["targets"] = {resolve(ref): version for ref, version in result["data"]["targets"].items()}
    return result


def preview_graph(graph, plan, manifest):
    _, sources, seeds = index_graph(graph, manifest)
    seed_ids = {key: node["id"] for key, node in seeds.items()}
    seed_ids.update({row["key"]: "preview:" + row["key"] for row in plan["specs"] if row["key"] not in seeds})
    source_ids = {key: node["id"] for key, node in sources.items()}
    result = copy.deepcopy(graph)
    for row in plan["specs"]:
        if row["key"] in seeds:
            continue
        result["nodes"].append({**resolve_node(row["node"], source_ids, seed_ids), "id": seed_ids[row["key"]], "version": 1, "schema": 1, "archived": False})
    return result


def verify_preservation(before, after):
    """Research content and existing semantic records must remain byte-equivalent."""
    for kind in ("nodes", "edges", "subscriptions", "proposals"):
        current = {row["id"]: row for row in after.get(kind, [])}
        for prior in before.get(kind, []):
            if current.get(prior["id"]) != prior:
                raise RuntimeError("Existing " + kind + " changed concurrently; inspect backup and do not overwrite: " + prior["id"])


def apply_plan(client, graph, manifest, plan, backup_dir):
    require_instance(plan["instance"])
    # Re-read immediately before mutation. Concurrent changes invalidate the
    # reviewable dry-run, even though this is an additive migration.
    fresh = client.read_graph()
    if digest(fresh) != digest(graph):
        raise RuntimeError("Graph changed since planning; generate a fresh dry-run")
    _, sources, seeds = index_graph(graph, manifest)
    source_ids = {key: node["id"] for key, node in sources.items()}
    seed_ids = {key: node["id"] for key, node in seeds.items()}
    backup_dir = Path(backup_dir)
    backup_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(backup_dir, 0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup = backup_dir / (stamp + "-before.json")
    bindings = {node["id"]: client.act("resource_read", {"node": node["id"]}).get("binding") for node in graph["nodes"] if node["type"] == "agent" and not node.get("archived")}
    private_json(backup, {"instance": INSTANCE, "at": stamp, "graph": graph, "agentBindings": bindings, "plan": plan})
    journal = backup_dir / (stamp + "-journal.jsonl")
    with os.fdopen(os.open(journal, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        for row in plan["specs"]:
            key = row["key"]
            if key in seed_ids:
                continue
            request = MIGRATION + "-" + hashlib.sha256(key.encode()).hexdigest()[:24]
            body = resolve_node(row["node"], source_ids, seed_ids)
            stream.write(encoded({"key": key, "request": request, "state": "sending"}) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
            # No automatic retry after uncertain transport outcome. Rerun reads
            # seed identities and uses the same idempotency request if needed.
            result = client.act("node_add", {"request": request, "data": encoded(body)})
            node = result.get("node")
            if not node or node.get("data", {}).get("meta", {}).get("seedKey") != key:
                raise RuntimeError("Expected an additive node receipt; inspect journal before retrying")
            seed_ids[key] = node["id"]
            stream.write(encoded({"key": key, "request": request, "state": "created", "node": node["id"]}) + "\n")
            stream.flush()
    after = client.read_graph()
    verify_preservation(graph, after)
    for node_id, binding in bindings.items():
        if client.act("resource_read", {"node": node_id}).get("binding") != binding:
            raise RuntimeError("Existing Agent binding changed concurrently; inspect backup")
    next_plan = build_plan(after, manifest, INSTANCE)
    if next_plan["createKeys"]:
        raise RuntimeError("Migration incomplete; inspect journal and re-read before continuing")
    receipt = {"instance": INSTANCE, "migration": MIGRATION, "created": len(plan["createKeys"]),
        "nodes": len(after["nodes"]), "edges": len(after["edges"]), "originalRecordsPreserved": True,
        "agentBindingsPreserved": True, "pendingReviews": len([row for row in plan["specs"] if row["node"]["type"] == "review"]),
        "backup": str(backup.resolve()), "journal": str(journal.resolve()), "rerunCreates": 0}
    private_json(backup_dir / (stamp + "-after.json"), {"receipt": receipt, "graph": after})
    return receipt


class SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, origin):
        self.origin = origin

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        if parsed.scheme + "://" + parsed.netloc != self.origin:
            raise RuntimeError("Refusing an authentication redirect to another origin")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class AppClient:
    def __init__(self, base, token_file, instance, ca_file=None, insecure_tls=False):
        require_instance(instance)
        parsed = urllib.parse.urlsplit(base)
        if parsed.scheme != "https" or not parsed.netloc or parsed.path not in ("", "/") or parsed.username or parsed.query or parsed.fragment:
            raise ValueError("Use the exact HTTPS Octopus origin")
        self.base = base.rstrip("/")
        self.instance = instance
        self.jar = http.cookiejar.CookieJar()
        context = ssl._create_unverified_context() if insecure_tls else ssl.create_default_context(cafile=ca_file)
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), urllib.request.HTTPSHandler(context=context), SameOriginRedirect(self.base))
        token_path = Path(token_file)
        if token_path.stat().st_mode & 0o077:
            raise ValueError("Token file must not be group/world accessible")
        token = token_path.read_text().strip()
        self.http("POST", "/login", {"token": token})
        self.csrf = next((cookie.value for cookie in self.jar if "csrf" in cookie.name), None)
        if not self.csrf:
            raise RuntimeError("Dedicated acceptance login did not return a browser session")
        html = self.http("GET", "/apps/research-v2/open?instance=" + instance)
        match = re.search(r'id="octopus-app-instance">"([0-9a-f]+)"', html)
        if not match:
            raise RuntimeError("App handle unavailable for this account and instance")
        self.handle = match.group(1)

    def http(self, method, path, body=None, headers=None):
        merged = {"Origin": self.base, "Referer": self.base + "/"}
        if headers:
            merged.update(headers)
        data = None
        if body is not None:
            data = encoded(body).encode()
            merged["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=data, headers=merged, method=method)
        try:
            with self.opener.open(request, timeout=60) as response:
                raw = response.read().decode()
        except urllib.error.HTTPError as error:
            # Never include request headers, login body, or server echo in logs.
            raise RuntimeError(method + " " + path.split("?")[0] + " returned HTTP " + str(error.code)) from None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw

    def act(self, action, params):
        result = self.http("POST", "/api/app-view/act?app=research-v2", {"action": action, "params": params},
            {"x-csrf-token": self.csrf, "x-app-instance": self.handle,
             "Referer": self.base + "/apps/research-v2/open?instance=" + self.instance})
        if not isinstance(result, dict) or not result.get("ok"):
            raise RuntimeError("App action refused: " + action + "; inspect authorized App feedback")
        return result["result"]

    def read_graph(self):
        result = {"nodes": [], "edges": [], "subscriptions": [], "proposals": [], "runs": []}
        seen_cursors = set()
        after = None
        for _ in range(200):
            page = self.act("canvas_read", {} if after is None else {"after": after})
            if page.get("viewer") != "codex_acceptance" or page.get("role") not in {"owner", "editor"}:
                raise RuntimeError("Only dedicated codex_acceptance with existing edit access is allowed")
            for kind in result:
                result[kind].extend(page.get(kind, []))
            cursor = page.get("next")
            if not cursor:
                for kind in result:
                    result[kind] = list({row["id"]: row for row in result[kind]}.values())
                result.update({key: page.get(key) for key in ("project", "title", "role", "viewer", "cursor")})
                return result
            if cursor in seen_cursors:
                raise RuntimeError("Canvas pagination failed to advance")
            seen_cursors.add(cursor)
            after = cursor
        raise RuntimeError("Canvas pagination exceeded the bounded read budget")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--instance", required=True, help="Exact existing ACC shared instance; no all-project mode")
    parser.add_argument("--manifest", type=Path, default=Path(__file__).resolve().parents[2] / "doc/research/acc-ae-plan-20260922.json")
    parser.add_argument("--graph", type=Path, help="Offline graph snapshot for dry-run only")
    parser.add_argument("--base", default="https://203.0.113.21:444")
    parser.add_argument("--token-file", type=Path, default=Path("/home/ubuntu/.config/octopus/codex-acceptance.token"))
    parser.add_argument("--ca-file")
    parser.add_argument("--insecure-tls", action="store_true", help="Explicitly accept a known private/self-signed deployment certificate")
    parser.add_argument("--out", required=True, type=Path, help="New private dry-run or receipt JSON")
    parser.add_argument("--preview-out", type=Path, help="Offline graph preview for frontend inspection")
    parser.add_argument("--apply", action="store_true", help="Create the reviewed nodes through the dedicated account's App action channel")
    parser.add_argument("--backup-dir", type=Path, help="Required existing writable private location for apply preimage/journal/after receipts")
    args = parser.parse_args()
    require_instance(args.instance)
    if args.apply and (args.graph or not args.backup_dir):
        parser.error("--apply requires live reads and --backup-dir; --graph is dry-run only")
    if args.out.exists() or (args.preview_out and args.preview_out.exists()):
        parser.error("Output exists; choose a fresh receipt path")
    manifest = json.loads(args.manifest.read_text())
    client = None if args.graph else AppClient(args.base, args.token_file, args.instance, args.ca_file, args.insecure_tls)
    graph = json.loads(args.graph.read_text()) if args.graph else client.read_graph()
    plan = build_plan(graph, manifest, args.instance)
    if args.preview_out:
        private_json(args.preview_out, preview_graph(graph, plan, manifest))
    if args.apply:
        result = apply_plan(client, graph, manifest, plan, args.backup_dir)
    else:
        result = plan
    private_json(args.out, result)
    print(encoded({"mode": "apply" if args.apply else "dry-run", "instance": args.instance,
        "createCount": len(plan["createKeys"]), "existingSeedCount": len(plan["existingKeys"]), "out": str(args.out.resolve())}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, KeyError) as error:
        print("ACC hierarchy migration stopped: " + str(error), file=sys.stderr)
        raise SystemExit(1)
