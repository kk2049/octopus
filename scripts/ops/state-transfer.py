#!/usr/bin/env python3
"""Encrypted Octopus data snapshots and explicit, reversible replacement.

Provider homes and processes stay on their Runners. Configuration is included
for disaster recovery but never applied over the destination's site settings.
See doc/runbooks/mirror-migration.md. Requires Python 3.11+, gpg, ssh and rsync.
"""
import argparse
from contextlib import contextmanager
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import socket
import sqlite3
import subprocess
import tarfile
import tempfile
import uuid


def sha256(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def run(argv):
    return subprocess.run(argv, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout


def check_key(file):
    file = Path(file).resolve(strict=True)
    if not file.is_file() or file.stat().st_mode & 0o077:
        raise ValueError("Passphrase file must be private (mode 0600)")
    return file


def assert_stopped(pid_file=None, container=None):
    if container:
        if run(["docker", "inspect", "--format", "{{.State.Running}}", container]).strip() != "false":
            raise ValueError("Target container must be stopped before snapshot/replacement")
    elif pid_file:
        file = Path(pid_file)
        if not file.is_file():
            raise ValueError("A recorded PID file is required; absence is not proof of shutdown")
        pid = int(file.read_text().strip())
        if pid < 2:
            raise ValueError("Invalid recorded PID")
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        raise ValueError("Recorded process is still alive; use the normal drain/shutdown workflow first")
    else:
        raise ValueError("Supply a stopped container or recorded dead PID; never infer shutdown from an idle database")


def snapshot(data, output, key, *, quiesced=False, config=None):
    data = Path(data).resolve(strict=True)
    output = Path(output).absolute()
    key = check_key(key)
    if not (data / "bot.db").is_file():
        raise ValueError("Source is not an Octopus data directory (bot.db is missing)")
    if output.exists() or data == output or data in output.parents:
        raise ValueError("Snapshot output must be new and outside the source data directory")
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix=".octopus-snapshot-", dir=output.parent) as temp:
        root = Path(temp)
        payload = root / "payload"
        payload.mkdir(mode=0o700)
        captured = payload / "data"
        captured.mkdir(mode=0o700)
        databases = []
        omitted_provider_links = []
        # Capture pointers before enumerating immutable release/event files.
        # Enumerating files first could miss an event committed while a later
        # database backup advances its index. Final cutover still requires a
        # write freeze; this ordering only improves live-mirror consistency.
        for source in sorted(data.rglob("*")):
            if not source.is_file() or source.is_symlink() or source.suffix not in (".db", ".sqlite", ".sqlite3"):
                continue
            relative = source.relative_to(data)
            dest = captured / relative
            dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            src = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=30)
            dst = sqlite3.connect(dest)
            try:
                src.backup(dst)
                if dst.execute("pragma quick_check").fetchall() != [("ok",)]:
                    raise ValueError("SQLite integrity failure: " + str(relative))
            finally:
                dst.close()
                src.close()
            dest.chmod(0o600)
            databases.append(str(relative))
        for source in sorted(data.rglob("*")):
            relative = source.relative_to(data)
            if source.is_symlink():
                if len(relative.parts) == 4 and relative.parts[0] == "users" and relative.parts[2] in ("claude-sessions", "codex-sessions") and relative.parts[3] in (".credentials.json", "auth.json"):
                    omitted_provider_links.append(str(relative))
                    continue
                raise ValueError("Data snapshots do not follow or restore symlinks: " + str(relative))
            dest = captured / relative
            if source.is_dir():
                dest.mkdir(exist_ok=True, mode=0o700)
            elif source.name.endswith(("-wal", "-shm")):
                continue
            elif source.is_file():
                dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                if source.suffix in (".db", ".sqlite", ".sqlite3"):
                    if not dest.is_file():
                        raise ValueError("Database roster changed during live snapshot; retry after writers settle")
                else:
                    shutil.copy2(source, dest)
                dest.chmod(0o600)
        if config:
            shutil.copyfile(config, payload / "config.yaml")
            (payload / "config.yaml").chmod(0o600)
        files = {str(p.relative_to(payload)): {"bytes": p.stat().st_size, "sha256": sha256(p)} for p in sorted(payload.rglob("*")) if p.is_file()}
        manifest = {"format": "octopus-state/v1", "source_host": socket.gethostname(), "captured_at": dt.datetime.now(dt.timezone.utc).isoformat(), "quiesced": quiesced, "databases": databases, "files": files, "omitted_provider_links": omitted_provider_links}
        (payload / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        tar_path = root / "snapshot.tar.gz"
        with tarfile.open(tar_path, "w:gz", compresslevel=3) as archive:
            for item in sorted(payload.iterdir()):
                archive.add(item, arcname=item.name, recursive=True)
        encrypted = root / "snapshot.gpg"
        run(["gpg", "--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-file", str(key), "--symmetric", "--cipher-algo", "AES256", "--output", str(encrypted), str(tar_path)])
        encrypted.chmod(0o600)
        # No replace semantics: even concurrent operators cannot overwrite an older backup.
        os.link(encrypted, output)
    digest = sha256(output)
    output.with_name(output.name + ".sha256").write_text(digest + "  " + output.name + "\n")
    return {"archive": str(output), "sha256": digest, "quiesced": quiesced, "databases": len(databases), "files": len(files)}


@contextmanager
def unpack(archive, key, parent=None):
    key = check_key(key)
    with tempfile.TemporaryDirectory(prefix=".octopus-verify-", dir=parent) as temp:
        root = Path(temp)
        compressed = root / "snapshot.tar.gz"
        run(["gpg", "--batch", "--pinentry-mode", "loopback", "--passphrase-file", str(key), "--output", str(compressed), "--decrypt", str(Path(archive).resolve(strict=True))])
        payload = root / "payload"
        payload.mkdir(mode=0o700)
        seen = set()
        with tarfile.open(compressed, "r:gz") as source:
            for member in source:
                name = PurePosixPath(member.name)
                if name.is_absolute() or ".." in name.parts or not name.parts or name.parts[0] not in ("data", "config.yaml", "manifest.json") or member.name in seen:
                    raise ValueError("Unsafe or duplicate archive member")
                seen.add(member.name)
                dest = payload.joinpath(*name.parts)
                if member.isdir():
                    dest.mkdir(parents=True, exist_ok=True, mode=0o700)
                elif member.isfile():
                    dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    with source.extractfile(member) as incoming, dest.open("xb") as outgoing:
                        shutil.copyfileobj(incoming, outgoing)
                    dest.chmod(0o600)
                else:
                    raise ValueError("Links, devices and sockets are unsupported in state archives")
        manifest = json.loads((payload / "manifest.json").read_text())
        if manifest.get("format") != "octopus-state/v1" or not isinstance(manifest.get("quiesced"), bool):
            raise ValueError("Unsupported snapshot format")
        actual = {str(p.relative_to(payload)) for p in payload.rglob("*") if p.is_file()} - {"manifest.json"}
        if actual != set(manifest["files"]):
            raise ValueError("Snapshot file roster differs from its manifest")
        for relative, entry in manifest["files"].items():
            file = payload / relative
            if file.stat().st_size != entry["bytes"] or sha256(file) != entry["sha256"]:
                raise ValueError("Snapshot checksum mismatch")
        for relative in manifest["databases"]:
            name = PurePosixPath(relative)
            if name.is_absolute() or ".." in name.parts or str(PurePosixPath("data") / name) not in actual:
                raise ValueError("Invalid database manifest entry")
            connection = sqlite3.connect((payload / "data" / relative).as_uri() + "?mode=ro", uri=True)
            try:
                if connection.execute("pragma quick_check").fetchall() != [("ok",)]:
                    raise ValueError("Restored SQLite integrity failure")
            finally:
                connection.close()
        if not (payload / "data" / "bot.db").is_file():
            raise ValueError("Snapshot lacks bot.db")
        compressed.unlink()
        yield payload, manifest


def replicate(archive, host, directory):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.@-]*", host):
        raise ValueError("Use a configured SSH host alias")
    if not PurePosixPath(directory).is_absolute() or ".." in PurePosixPath(directory).parts:
        raise ValueError("Remote backup directory must be absolute")
    archive = Path(archive).resolve(strict=True)
    remote = str(PurePosixPath(directory) / archive.name)
    digest = sha256(archive)
    ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host]
    q = shlex.quote
    run(ssh + [f"umask 077; mkdir -p -- {q(directory)}; if test -e {q(remote)}; then test \"$(sha256sum -- {q(remote)} | cut -d ' ' -f 1)\" = {q(digest)}; fi"])
    run(["rsync", "-a", "--protect-args", "--chmod=F600,D700", "-e", "ssh -o BatchMode=yes -o ConnectTimeout=15", str(archive), f"{host}:{remote}"])
    verified = run(ssh + [f"sha256sum -- {q(remote)}"]).split()[0]
    if verified != digest:
        raise ValueError("Remote backup checksum mismatch; destination must not be overwritten")
    return {"host": host, "archive": remote, "sha256": verified}


def restore(archive, target, key, backup_dir, remote_host, remote_dir, **options):
    target = Path(target).absolute()
    if target.name != "data" or target.is_symlink() or target.parent.resolve() != target.parent:
        raise ValueError("Destination must be a real, explicitly named data directory")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (target.parent / ".state-transfer.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another state transfer owns this destination") from None
        return _restore_locked(archive, target, key, backup_dir, remote_host, remote_dir, **options)


def _restore_locked(archive, target, key, backup_dir, remote_host, remote_dir, *, allow_live_mirror=False, new_target=False, pid_file=None, container=None):
    target = Path(target).absolute()
    if target.name != "data" or target.is_symlink() or target.parent.resolve() != target.parent:
        raise ValueError("Destination must be a real, explicitly named data directory")
    if new_target and target.exists():
        raise ValueError("--new-target refuses an existing directory")
    if not new_target:
        assert_stopped(pid_file, container)
    # Validate source before collecting a target backup; all verification is read-only.
    with unpack(archive, key) as (_, manifest):
        if not manifest["quiesced"] and not allow_live_mirror:
            raise ValueError("Final replacement requires a quiesced source; live snapshots are only for explicit mirrors")
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    evidence = {"source": str(Path(archive).absolute()), "source_sha256": sha256(archive)}
    if target.exists():
        before = Path(backup_dir) / ("before-replace-" + stamp + ".tar.gz.gpg")
        config = target.parent / "config.yaml"
        evidence["local_backup"] = snapshot(target, before, key, quiesced=True, config=config if config.is_file() else None)
        with unpack(before, key):
            pass
        evidence["remote_backup"] = replicate(before, remote_host, remote_dir)
        assert_stopped(pid_file, container)
    elif not new_target:
        raise ValueError("Destination is absent; use --new-target explicitly")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    owner = (target if target.exists() else target.parent).stat()
    with unpack(archive, key, target.parent) as (payload, _):
        incoming = payload / "data"
        for file in [incoming, *incoming.rglob("*")]:
            if file.stat().st_uid != owner.st_uid or file.stat().st_gid != owner.st_gid:
                os.chown(file, owner.st_uid, owner.st_gid)
        previous = target.with_name("data.before-" + stamp)
        existed = target.exists()
        if existed:
            os.rename(target, previous)
        try:
            os.rename(incoming, target)
        except BaseException:
            if existed:
                os.rename(previous, target)
            raise
    evidence["retained_directory"] = str(previous) if existed else None
    evidence["applied_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    receipt = target.parent / ("state-transfer-" + stamp + ".json")
    receipt.write_text(json.dumps(evidence, indent=2) + "\n")
    receipt.chmod(0o600)
    return evidence


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("snapshot")
    export.add_argument("--data", required=True)
    export.add_argument("--output", required=True)
    export.add_argument("--config")
    export.add_argument("--key-file", required=True)
    export.add_argument("--stopped-pid-file")
    export.add_argument("--stopped-container")
    verify = commands.add_parser("verify")
    verify.add_argument("--archive", required=True)
    verify.add_argument("--key-file", required=True)
    copy = commands.add_parser("replicate")
    copy.add_argument("--archive", required=True)
    copy.add_argument("--remote-host", required=True)
    copy.add_argument("--remote-dir", required=True)
    apply = commands.add_parser("restore")
    for name in ("archive", "target-data", "key-file", "backup-dir", "remote-host", "remote-dir"):
        apply.add_argument("--" + name, required=True)
    apply.add_argument("--allow-live-mirror", action="store_true")
    apply.add_argument("--new-target", action="store_true")
    apply.add_argument("--stopped-pid-file")
    apply.add_argument("--stopped-container")
    args = parser.parse_args()
    if args.command == "snapshot":
        stopped = bool(args.stopped_pid_file or args.stopped_container)
        if stopped:
            assert_stopped(args.stopped_pid_file, args.stopped_container)
        result = snapshot(args.data, args.output, args.key_file, quiesced=stopped, config=args.config)
    elif args.command == "verify":
        with unpack(args.archive, args.key_file) as (_, manifest):
            result = {"sha256": sha256(args.archive), "quiesced": manifest["quiesced"], "files": len(manifest["files"]), "databases": len(manifest["databases"])}
    elif args.command == "replicate":
        result = replicate(args.archive, args.remote_host, args.remote_dir)
    else:
        result = restore(args.archive, args.target_data, args.key_file, args.backup_dir, args.remote_host, args.remote_dir, allow_live_mirror=args.allow_live_mirror, new_target=args.new_target, pid_file=args.stopped_pid_file, container=args.stopped_container)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
