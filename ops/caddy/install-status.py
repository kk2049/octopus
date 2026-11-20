"""Install the independent observer and existing edge fallback from a landed checkout."""
import argparse
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import time


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def install(repo, apply=False, root=Path("/var/lib/octopus-startup"),
            service=Path("/etc/systemd/system/octopus-deploy-status.service"), username="ubuntu"):
    revision = run("git", "-c", "safe.directory=" + str(repo), "-C", str(repo), "rev-parse", "HEAD")
    if apply:
        run("git", "-c", "safe.directory=" + str(repo), "-C", str(repo), "merge-base", "--is-ancestor", revision, "v4")
    if run("git", "-c", "safe.directory=" + str(repo), "-C", str(repo), "status", "--porcelain",
           "--", "ops/caddy", "packages/dashboard-web/public/startup"):
        raise RuntimeError("commit the ingress sources before installation")
    print(run(str(repo / "scripts/ops/startup-page.sh"), "--check"))
    assets = root / revision
    # The production runtime user already reads this database. Caddy only reads
    # the small public projection, never the DB, config, failure log or secrets.
    command = (f"/usr/bin/python3 {assets}/status-monitor.py "
               f"--database /home/ubuntu/lht/octopus-dev/data/bot.db "
               f"--checkout /home/ubuntu/lht/octopus-run --assets {assets} "
               f"--destination {root}/status")
    unit = ("[Unit]\nDescription=Octopus deployment status observer\nAfter=local-fs.target\n"
            f"[Service]\nType=simple\nUser={username}\nGroup={username}\n"
            f"ExecStart={command}\nRestart=on-failure\nRestartSec=2\n"
            "NoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\n"
            f"ProtectHome=read-only\nReadWritePaths={root}/status\n"
            "[Install]\nWantedBy=multi-user.target\n")
    if not apply:
        print(unit)
        return
    if os.geteuid() != 0:
        raise RuntimeError("--apply requires root")
    previous = service.read_bytes() if service.exists() else None
    previously_active = subprocess.run(["systemctl", "is-active", "--quiet", service.name]).returncode == 0
    previously_enabled = subprocess.run(["systemctl", "is-enabled", "--quiet", service.name], stdout=subprocess.DEVNULL).returncode == 0
    assets.mkdir(parents=True, exist_ok=True)
    (root / "status").mkdir(exist_ok=True)
    user = pwd.getpwnam(username)
    os.chown(root / "status", user.pw_uid, user.pw_gid)
    for name in ("index.html", "loading.js", "loading.css"):
        shutil.copyfile(repo / "packages/dashboard-web/public/startup" / name, assets / name)
    for name in ("startup.caddy", "status-monitor.py"):
        shutil.copyfile(repo / "ops/caddy" / name, assets / name)
    try:
        service.write_text(unit)
        run("systemctl", "daemon-reload")
        run("systemctl", "enable", "--now", service.name)
        restarted_at = time.time() * 1000
        run("systemctl", "restart", service.name)
        for _ in range(30):
            try:
                state = json.loads((root / "status/status.json").read_text())
                if restarted_at <= state["observed_at"] <= time.time() * 1000 and state["status"] != "unknown":
                    run("systemctl", "is-active", service.name)
                    break
            except (OSError, ValueError, KeyError):
                pass
            time.sleep(.2)
        else:
            raise RuntimeError("observer did not publish fresh status")
        print(run(str(repo / "scripts/ops/startup-page.sh"), "--apply"))
    except Exception:
        run("systemctl", "stop", service.name)
        if not previously_enabled:
            subprocess.run(["systemctl", "disable", service.name], capture_output=True)
        if previous is None:
            service.unlink(missing_ok=True)
        else:
            service.write_bytes(previous)
        run("systemctl", "daemon-reload")
        if previously_active:
            run("systemctl", "start", service.name)
        raise
    print("Observer and ingress installed: " + revision)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    install(Path(__file__).resolve().parents[2], args.apply)
