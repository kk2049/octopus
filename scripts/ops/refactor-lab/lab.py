#!/usr/bin/env python3
"""Run on the Docker host. Candidate source, dependencies and Head are isolated.

Commands operate only on containers carrying this lab's exact ownership label.
The bootstrap builder is provisioned separately; deployment never calls prod ops.
"""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import time


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout.strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["build", "seed", "deploy", "status", "stop"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--sha")
    parser.add_argument("--bundle", default="baseline.bundle")
    args = parser.parse_args()
    root = pathlib.Path(args.root).resolve()
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,31}", args.name):
        parser.error("invalid lab name")
    if not root.is_dir() or not (root / ".refactor-lab").is_file():
        parser.error("root must be an existing, explicitly marked refactor lab")
    marker = json.loads((root / ".refactor-lab").read_text())
    builder = f"octopus-refactor-{args.name}"
    head = f"{builder}-head"
    docker = ["docker"]

    def inspect(name, required=True):
        result = subprocess.run(docker + ["inspect", name], text=True, capture_output=True)
        if result.returncode and not required:
            return None
        result.check_returncode()
        obj = json.loads(result.stdout)[0]
        labels = obj["Config"].get("Labels", {})
        if labels.get("octopus.role") != "refactor-lab" or labels.get("octopus.lab") != args.name:
            raise RuntimeError(f"refusing container outside this lab: {name}")
        return obj

    def inside(command, directory="/lab"):
        return run(docker + ["exec", "-w", directory, builder] + command)

    deployment = root / "state" / "current-deployment.json"
    current = inspect(head, False)
    if args.command == "status":
        print(json.dumps({"lab": args.name, "running": bool(current and current["State"]["Running"]),
                          "sha": current["Config"].get("Labels", {}).get("octopus.candidate") if current else None}))
        return
    if args.command == "stop":
        deployment.unlink(missing_ok=True)
        if current and current["State"]["Running"]:
            run(docker + ["stop", "--time", "75", head])
        print(json.dumps({"lab": args.name, "stopped": True}))
        return
    if not args.sha or not re.fullmatch(r"[0-9a-f]{40}", args.sha):
        parser.error("deploy requires exact --sha")
    if pathlib.Path(args.bundle).name != args.bundle:
        parser.error("bundle must be a filename under this lab's artifacts directory")
    def build_candidate():
        build = inspect(builder)
        node = inside(["node", "-p", "process.execPath"])
        node_version = inside([node, "--version"])
        release = f"/lab/releases/{args.sha}"
        if not (root / "releases" / args.sha).exists():
            inside(["git", "clone", "--no-checkout", f"/lab/artifacts/{args.bundle}", release])
            inside(["git", "checkout", "--detach", args.sha], release)
        if inside(["git", "rev-parse", "HEAD"], release) != args.sha:
            raise RuntimeError("candidate checkout mismatch")
        if inside(["git", "status", "--porcelain", "--untracked-files=no"], release):
            raise RuntimeError("candidate tracked source is dirty")
        # Fixed shell program; no user input is interpolated as shell syntax.
        inside(["bash", "-lc", "pnpm install --frozen-lockfile --prefer-offline > /lab/artifacts/candidate-install.log 2>&1 && pnpm -r build > /lab/artifacts/candidate-build.log 2>&1"], release)
        if inside(["git", "status", "--porcelain", "--untracked-files=no"], release):
            raise RuntimeError("build modified candidate source")
        return build, node, node_version, release

    if args.command in ["build", "seed"]:
        _, node, node_version, release = build_candidate()
        if args.command == "seed":
            print(inside([node, "--import", "tsx", "scripts/ops/refactor-lab/seed.ts", "/lab"], release))
        print(json.dumps({"schema": "octopus-refactor-build/v1", "sha": args.sha, "nodeVersion": node_version, "built": True}))
        return
    config = json.loads((root / "private/config.json").read_text())
    if config.get("channels") or config.get("fleet", {}).get("enabled"):
        raise RuntimeError("lab refuses external channel/fleet consumers")
    if config.get("dashboard", {}).get("host") != "127.0.0.1" or config.get("runner", {}).get("host") != "127.0.0.1":
        raise RuntimeError("lab listeners must stay loopback-only")
    if config.get("dashboard", {}).get("public_url") != marker["origin"]:
        raise RuntimeError("lab origin does not match its marker")
    hosting = config.get("selfhosting", {})
    if hosting.get("run_dir") or hosting.get("gitlab_ci"):
        raise RuntimeError("lab refuses production deployment and forge workers")
    if hosting.get("enabled"):
        if hosting.get("repo_dir") != "/lab/ticket-repo" or hosting.get("worktrees_dir") != "/lab/ticket-worktrees":
            raise RuntimeError("lab tickets require their private repository and worktree roots")
        if run(["git", "-C", str(root / "ticket-repo"), "remote"]):
            raise RuntimeError("lab ticket repository must have no remotes")
    build, node, node_version, release = build_candidate()
    # Publish the same candidate through the normal bundle registry. Lab Runners
    # remain pinned (update_site=none), so this never auto-replaces a process.
    inside([node, "--import", "tsx", "packages/bot/src/runner/bundle-cli.ts", "activate",
            "packages/runner/dist/standalone.js", "--data-dir", "/lab/state", "--actor", f"refactor-lab:{args.name}"], release)
    health = f"/lab/state/health-{args.sha}"
    inside(["rm", "-f", health])
    deployment.unlink(missing_ok=True)
    if current:
        if current["State"]["Running"]:
            run(docker + ["stop", "--time", "75", head])
        # Remove only this owned stopped container; data and old release survive.
        run(docker + ["rm", head])
    run(docker + ["run", "-d", "--init", "--name", head,
        "--label", "octopus.role=refactor-lab", "--label", f"octopus.lab={args.name}",
        "--label", f"octopus.candidate={args.sha}", "--restart", "unless-stopped",
        "--cpus", "4", "--memory", "8g", "--pids-limit", "2048", "--network", "host",
        "--mount", f"type=bind,src={root},dst=/lab", "-w", release,
        "-e", "CONFIG_PATH=/lab/private/config.json", "-e", "DATA_DIR=/lab/state", "-e", f"HEALTH_FILE={health}",
        "--entrypoint", node, build["Config"]["Image"],
        "--import", "tsx", "packages/bot/src/bootstrap-v3.ts"])
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        value = inspect(head)
        if not value["State"]["Running"]:
            raise RuntimeError("candidate Head exited; inspect this lab's Docker logs")
        logs = run(docker + ["logs", head])
        if "v3 bootstrap ready" in logs and (root / "state" / f"health-{args.sha}").exists():
            status = run(["curl", "-sS", "--max-time", "5", "-o", "/dev/null", "-w", "%{http_code}", marker["origin"] + "/login"])
            if status == "200":
                break
        time.sleep(1)
    else:
        raise RuntimeError("candidate startup health timed out; retained for inspection")
    runtime_sha = run(docker + ["exec", head, "git", "rev-parse", "HEAD"])
    if runtime_sha != args.sha:
        raise RuntimeError("running Head SHA mismatch")
    receipt = {"schema": "octopus-refactor-lab-deploy/v1", "lab": args.name, "sha": args.sha,
        "container": head, "containerId": value["Id"], "image": value["Image"], "startedAt": value["State"]["StartedAt"],
        "runnerSha256": hashlib.sha256((root / "releases" / args.sha / "packages/runner/dist/standalone.js").read_bytes()).hexdigest(),
        "nodeVersion": node_version, "startupReady": True, "loginStatus": 200, "realAgentAcceptance": "pending"}
    output = root / "artifacts" / f"deployment-{args.sha}.json"
    output.write_text(json.dumps(receipt, indent=2) + "\n")
    temporary = deployment.with_suffix(".tmp")
    temporary.write_text(json.dumps(receipt, indent=2) + "\n")
    temporary.replace(deployment)
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
