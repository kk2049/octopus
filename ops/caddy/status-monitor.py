"""Read supervisor facts without Bot; publish only the public deployment projection."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time
import urllib.request

ASSETS = ("index.html", "loading.js", "loading.css", "startup.caddy")
STATUSES = {"requested", "claimed", "building", "restarting", "health_gate",
            "confirm_wait", "succeeded", "rolled_back", "failed"}


def projection(database, checkout, now):
    # Reopen each time: supervisor database restore/replacement must not strand
    # this observer on an old inode. No immutable=1: live WAL must be observed.
    with sqlite3.connect(Path(database).as_uri() + "?mode=ro", uri=True, timeout=.2) as db:
        db.execute("PRAGMA query_only=ON")
        row = db.execute("SELECT id,status,created_at,updated_at,target_sha,base_sha "
                         "FROM deploy_intents ORDER BY id DESC LIMIT 1").fetchone()
    result = {"id": None, "status": "idle", "observed_at": now}
    if row:
        identity, status, created, updated, target, base = row
        status = status if status in STATUSES else "unknown"
        if status == "health_gate" and base and base != target:
            # The supervisor restores the previous checkout only AFTER stopping
            # the failed child. This is evidence of rollback, not a timer guess.
            current = subprocess.run(["git", "-C", checkout, "rev-parse", "HEAD"],
                                     capture_output=True, text=True, timeout=2, check=True).stdout.strip()
            if current == base:
                status = "rolling_back"
        result.update(id=identity, status=status, created_at=created, updated_at=updated)
    return result


def publish(database, checkout, assets, destination, upstream):
    now = int(time.time() * 1000)
    try:
        state = projection(database, checkout, now)
    except Exception:
        # Never publish a previous success as fresh after a database/read error.
        state = {"id": None, "status": "unknown", "observed_at": now}
    try:
        with urllib.request.urlopen(upstream + "/login", timeout=1) as response:
            state["http_ready"] = response.status == 200
    except Exception:
        state["http_ready"] = False
    state["assets"] = {name: hashlib.sha256((Path(assets) / name).read_bytes()).hexdigest()
                       for name in ASSETS}
    directory = Path(destination)
    directory.mkdir(parents=True, exist_ok=True)
    temporary = directory / "status.json.tmp"
    temporary.write_text(json.dumps(state, separators=(",", ":")))
    temporary.chmod(0o644)
    os.replace(temporary, directory / "status.json")
    return state


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("database", "checkout", "assets", "destination"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--upstream", default="http://127.0.0.1:9820")
    args = parser.parse_args()
    if not args.upstream.startswith("http://127.0.0.1:"):
        parser.error("upstream must be loopback")
    while True:
        publish(**vars(args))
        time.sleep(1)
