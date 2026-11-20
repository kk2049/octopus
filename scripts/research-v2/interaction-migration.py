#!/usr/bin/env python3
"""Add non-destructive hierarchy/goal/review projections to research-v2 instances."""
import json, re, sys, urllib.error, urllib.request
from pathlib import Path

INSTANCES = {
    "ACC": "asi_51e0080bd7704fe9ac48d723b8c6fe45",
    "ArchTown": "asi_0f436a7613784144a48530656491e712",
    "CXL-ZCOT": "asi_b43b535f37df4165b5ce0f8264a0d244",
    "Octo知识库": "asi_98d4067be41e4b29b5615215746f41fb",
}
ENV_PATH = Path("/tmp/acc-session.env")

def read_env():
    return dict(line.split("=", 1) for line in ENV_PATH.read_text().splitlines() if "=" in line)

E = read_env()
BASE, ORIGIN = E["BASE"], E["ORIGIN"]
COOKIE = f'{E["SN"]}={E["SV"]}; {E["CN"]}={E["CV"]}'

def http(method, path, body=None, headers=None):
    h = {"Cookie": COOKIE, "x-csrf-token": E["CV"], "Origin": ORIGIN, "Referer": ORIGIN + "/"}
    if headers: h.update(headers)
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode()
        h["Content-Type"] = "application/json"
    try:
        with urllib.request.urlopen(urllib.request.Request(BASE + path, data=data, headers=h, method=method), timeout=180) as response:
            raw = response.read()
            try:
                return response.status, json.loads(raw)
            except Exception:
                return response.status, raw.decode(errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:500]
        raise RuntimeError(f"{method} {path} {exc.code}: {detail}") from exc

def handle(instance):
    _, html = http("GET", "/apps/research-v2/open?instance=" + instance)
    match = re.search(r'id="octopus-app-instance">"([0-9a-f]+)"', html)
    if not match:
        raise RuntimeError(f"{instance}: app handle missing")
    return match.group(1)

def act(h, instance, action, params):
    headers = {
        "x-app-instance": h,
        "Referer": ORIGIN + "/apps/research-v2/open?instance=" + instance,
        "Content-Type": "application/json",
    }
    _, result = http("POST", "/api/app-view/act?app=research-v2",
                     {"action": action, "params": {k: str(v) for k, v in params.items()}}, headers)
    if not result.get("ok"):
        raise RuntimeError(f"{instance} {action}: {result}")
    return result["result"]

def read_graph(h, instance):
    nodes, edges, after = [], [], None
    for _ in range(100):
        page = act(h, instance, "canvas_read", {} if after is None else {"after": after})
        nodes.extend(page.get("nodes", []))
        edges.extend(page.get("edges", []))
        nxt = page.get("next")
        if not nxt:
            return nodes, edges
        if nxt == after:
            raise RuntimeError(f"{instance}: cursor did not advance")
        after = nxt
    raise RuntimeError(f"{instance}: pagination limit")

def create_projection(name, instance):
    h = handle(instance)
    nodes, edges = read_graph(h, instance)
    by_title = {n["title"]: n for n in nodes if not n.get("archived")}
    made = []
    candidates = [
        n for n in nodes
        if not n.get("archived")
        and n.get("type") in {"file", "note", "task", "finding", "collection"}
        and not (isinstance(n.get("data"), dict)
                 and isinstance(n["data"].get("meta"), dict)
                 and n["data"]["meta"].get("read_only") is False)
    ]
    members = [n["id"] for n in candidates]
    prefix = f"{name} · "
    folder_title = prefix + "待审查材料"
    goal_title = prefix + "GOAL"
    review_title = prefix + "审查结论"
    if folder_title not in by_title and members:
        folder = act(h, instance, "node_add", {"request": f"projection-folder-{instance}", "data": json.dumps({
            "type": "folder",
            "title": folder_title,
            "summary": f"{len(members)} 个历史材料已收纳，可展开逐项审查。",
            "x": -220,
            "y": 140,
            "data": {"description": "待审查材料的可折叠收纳节点", "members": members},
        }, ensure_ascii=False)})
        by_title[folder_title] = folder["node"]
        made.append(folder["node"]["id"])
    if goal_title not in by_title:
        goal_text = {
            "ACC": "把 ACC recycle 的论文 A/B/C、ToolSmith 和并发测试推进到可验证、可审查的理论与实验闭环。",
            "ArchTown": "把 ArchTown 的历史 Agent、设计材料和后续实验组织成可追溯的研究推进图。",
            "CXL-ZCOT": "把 CXL-ZCOT 的论文、系统实现和测试证据组织成可审查的研究闭环。",
            "Octo知识库": "把 Octo 知识库中的来源、迭代、Agent 和验收结果组织成可交互的研究图谱。",
        }.get(name, f"推进 {name} 的研究闭环")
        goal = act(h, instance, "node_add", {"request": f"projection-goal-{instance}", "data": json.dumps({
            "type": "goal",
            "title": goal_title,
            "summary": goal_text,
            "x": -220,
            "y": -180,
            "data": {"text": goal_text},
        }, ensure_ascii=False)})
        by_title[goal_title] = goal["node"]
        made.append(goal["node"]["id"])
    target_nodes = candidates[:24]
    if review_title not in by_title and target_nodes:
        targets = {n["id"]: n.get("version", 1) for n in target_nodes}
        review = act(h, instance, "node_add", {"request": f"projection-review-{instance}", "data": json.dumps({
            "type": "review",
            "title": review_title,
            "summary": "逐项核对材料正文与当前节点版本后，再用按钮记录审查结论。",
            "x": 240,
            "y": 140,
            "data": {"targets": targets},
        }, ensure_ascii=False)})
        by_title[review_title] = review["node"]
        made.append(review["node"]["id"])
    edge_pairs = {(e.get("source"), e.get("target"), e.get("label")) for e in edges if not e.get("archived")}
    folder = by_title.get(folder_title)
    goal = by_title.get(goal_title)
    review = by_title.get(review_title)
    for source, target, label, key in [
        (goal, review, "审查", "goal-review"),
        (folder, review, "待审", "folder-review"),
    ]:
        if source and target and (source["id"], target["id"], label) not in edge_pairs:
            result = act(h, instance, "edge_add", {
                "request": f"projection-edge-{key}-{instance}",
                "source": source["id"],
                "target": target["id"],
                "label": label,
            })
            edge_pairs.add((source["id"], target["id"], label))
            made.append(result["edge"]["id"])
    return {
        "instance": instance,
        "before_nodes": len(nodes),
        "before_edges": len(edges),
        "members": len(members),
        "created": made,
    }

def main():
    selected = sys.argv[1:] or list(INSTANCES)
    out = []
    for name in selected:
        try:
            out.append({"name": name, "ok": True, **create_projection(name, INSTANCES[name])})
        except Exception as exc:
            out.append({"name": name, "ok": False, "error": str(exc)})
    print(json.dumps(out, ensure_ascii=False, indent=2))
    if any(not row["ok"] for row in out):
        raise SystemExit(1)

if __name__ == "__main__":
    main()
