#!/usr/bin/env python3
"""Retain complete rollback trees and their content-addressed artifacts; no database mutation."""
import json
import hashlib
import os
import fcntl
import importlib.util
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
from contextlib import closing, contextmanager

spec = importlib.util.spec_from_file_location('release_budget', Path(__file__).with_name('release-budget.py'))
budget_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(budget_module)
spec = importlib.util.spec_from_file_location('release_layer', Path(__file__).with_name('release-layer.py'))
layer_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layer_module)
spec = importlib.util.spec_from_file_location('release_progress', Path(__file__).with_name('release-progress.py'))
progress_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(progress_module)
foreground_database = None


class ForegroundBusy(Exception):
    pass


@contextmanager
def maintenance_lock(trees):
    # A collector yields after each small batch, including when an installer
    # was already waiting. No long sleep or recursive deletion holds this lock.
    with open(trees / '.release-maintenance.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ForegroundBusy('cleanup deferred to foreground installation')
        if foreground_database:
            with closing(sqlite3.connect('file:' + str(foreground_database) + '?mode=ro', uri=True)) as db:
                if db.execute("SELECT 1 FROM deploy_intents WHERE status IN ('claimed','building','restarting','health_gate') LIMIT 1").fetchone():
                    raise ForegroundBusy('cleanup deferred to deployment')
        yield


def remove_batch(entries, budget, trees):
    budget.step(entries=len(entries))
    with maintenance_lock(trees):
        for entry, directory in entries:
            if directory and not entry.is_symlink():
                entry.rmdir()
            else:
                entry.unlink()


def remove_tree(tree, budget, trees, readonly=False):
    # Keep the identity markers until the last step so an interrupted retirement
    # remains attributable and resumable. Installers refuse its pruning marker.
    markers = {'.git', '.octopus-release.json', '.octopus-verified', '.octopus-pruning'}
    with maintenance_lock(trees):
        if readonly:
            tree.chmod(0o700)
        (tree / '.octopus-pruning').touch(exist_ok=True)
    pending = []
    if readonly:
        # Only retired cache layers use read-only directories. Links in release
        # trees retain private writable directories and read-only regular files.
        for root, dirs, files in os.walk(tree, followlinks=False):
            budget.step(entries=1)
            with maintenance_lock(trees):
                Path(root).chmod(0o700)
    for root, dirs, files in os.walk(tree, topdown=False, followlinks=False):
        root = Path(root)
        for name in files:
            if root == tree and name in markers:
                continue
            pending.append((root / name, False))
            if len(pending) >= 64:
                remove_batch(pending, budget, trees)
                pending.clear()
        for name in dirs:
            pending.append((root / name, True))
            if len(pending) >= 64:
                remove_batch(pending, budget, trees)
                pending.clear()
    if pending:
        remove_batch(pending, budget, trees)
    # Identity survives any yield/crash until the final git removal (or final
    # retired-layer rmdir), which happens in one short locked transaction.


def prune(repository, trees_dir, artifacts_dir, database, current, previous, keep, budget=None):
    global foreground_database
    foreground_database = Path(database).resolve()
    budget = budget or budget_module.Budget(entries_per_second=250)
    trees, artifacts = Path(trees_dir).resolve(), Path(artifacts_dir).resolve()
    protected = {Path(current).resolve(), Path(previous).resolve()}
    latest = subprocess.check_output(['git', '-C', repository, 'rev-parse', 'v4'], text=True).strip()
    protected.add(trees / latest)
    db = sqlite3.connect('file:' + str(Path(database).resolve()) + '?mode=ro', uri=True)
    try:
        active = db.execute("SELECT id, target_sha FROM deploy_intents WHERE status IN ('requested','claimed','building','restarting','health_gate')").fetchall()
    finally:
        db.close()
    for intent, sha in active:
        if re.fullmatch('[0-9a-f]{40}', sha): protected.add(trees / sha)
        pointer = artifacts / 'intents' / (str(intent) + '.previous')
        if pointer.exists(): protected.add(Path(pointer.read_text().strip()).resolve())
    candidates = sorted((p for p in trees.iterdir() if not p.is_symlink() and p.is_dir()
                         and (p / '.octopus-release.json').is_file() and (p / '.octopus-verified').is_file()),
                        key=lambda p: (p / '.octopus-verified').stat().st_mtime, reverse=True)
    retained = set(candidates[:max(2, int(keep))]) | protected
    for tree in candidates:
        if tree in retained: continue
        # Git owns this checkout. It must still match its recorded source before pruning it.
        sha = json.loads((tree / '.octopus-release.json').read_text())['repoSha']
        if tree.name != sha: continue
        if subprocess.check_output(['git', '-C', str(tree), 'rev-parse', 'HEAD'], text=True).strip() != sha: continue
        remove_tree(tree, budget, trees)
        with maintenance_lock(trees):
            subprocess.run(['git', '-C', repository, 'worktree', 'remove', '--force', str(tree)], check=True)
        print('pruned complete release', sha)
    # Keep objects for every still-present tree and every active target, including partial installs.
    required, layers = set(), set()
    live = {p.name for p in trees.iterdir() if p.is_dir()} | {sha for _, sha in active}
    for manifest in (artifacts / 'manifests').glob('*.json'):
        # A prepared next release can precede its durable deployment intent.
        if manifest.stem in live or time.time() - manifest.stat().st_mtime < 86400:
            m = json.loads(manifest.read_text())
            required.update(p['sha256'] for p in m['parts'])
            layers.add(layer_module.key_for(m))
        else:
            budget.step(entries=1)
            with maintenance_lock(trees):
                if not (trees / manifest.stem).exists() and time.time() - manifest.stat().st_mtime >= 86400:
                    manifest.unlink()
    def fresh_references():
        digests, layer_keys = set(), set()
        count, bytes_read = 0, 0
        def metadata(file):
            nonlocal count, bytes_read
            size = file.stat().st_size
            count += 1
            bytes_read += size
            if count > 4096 or size > 256 * 1024 or bytes_read > 16 * 1024 ** 2:
                raise ForegroundBusy('cleanup reference check exceeds bounded metadata budget')
            return json.loads(file.read_text())
        for manifest in (artifacts / 'manifests').glob('*.json'):
            m = metadata(manifest)
            digests.update(p['sha256'] for p in m['parts'])
            layer_keys.add(layer_module.key_for(m))
        for preparation in (artifacts / 'preparations').glob('*.json'):
            if '.install.' in preparation.name or preparation.stat().st_size > 256 * 1024:
                continue
            p = metadata(preparation)
            if p.get('state') in ('building', 'receiving', 'staging') and time.time() - preparation.stat().st_mtime < 3600:
                digests.update(p.get('objectDigests', []))
        return digests, layer_keys
    for obj in (artifacts / 'objects').glob('*.tar.gz'):
        digest = obj.name[:-7]
        if re.fullmatch('[0-9a-f]{64}', digest) and digest not in required and time.time() - obj.stat().st_mtime >= 86400:
            budget.step(entries=1)
            with maintenance_lock(trees):
                if digest in fresh_references()[0]:
                    continue
                obj.unlink()
            print('pruned unused artifact', digest)
    # Previous behavior retained five bot snapshots. Keep that policy, but
    # perform its deletes here instead of between backup and restart.
    backups = Path(database).resolve().parent.parent / 'backups'
    snapshots = sorted((p for p in backups.glob('bot-*.db')
                        if re.fullmatch(r'bot-\d{8}T\d{6}\.db', p.name) and not p.is_symlink()), reverse=True)
    for snapshot in snapshots[5:]:
        budget.step(entries=1)
        with maintenance_lock(trees):
            snapshot.unlink()
    # Install holds the maintenance lock through reference publication. Retire
    # only complete known layers, atomically, and never discover arbitrary dirs
    # recursively. Partial/unknown layers remain for explicit recovery.
    cache = trees.parent / 'dependencies'
    if cache.is_dir():
        for layer in cache.iterdir():
            if re.fullmatch('[0-9a-f]{64}\\.retired', layer.name) and not layer.is_symlink() \
                    and ((layer / '.octopus-pruning').exists() or (layer / 'verified.json').is_file()):
                remove_tree(layer, budget, trees, readonly=True)
                with maintenance_lock(trees):
                    (layer / '.octopus-pruning').unlink(missing_ok=True)
                    layer.rmdir()
                continue
            if not re.fullmatch('[0-9a-f]{64}', layer.name) or layer.is_symlink() \
                    or layer.name in layers or not (layer / 'verified.json').is_file():
                continue
            receipt = json.loads((layer / 'verified.json').read_text())
            if hashlib.sha256(json.dumps(receipt.get('identity'), sort_keys=True, separators=(',', ':')).encode()).hexdigest() != layer.name:
                continue  # Unknown directories do not become collector-owned by name alone.
            with maintenance_lock(trees):
                # Refresh references under the same lock used by the installer;
                # a new prepared release may have arrived during tree retirement.
                references = list(trees.glob('*/.octopus-dependency-layer.json'))
                if layer.name in fresh_references()[1] or any(json.loads(p.read_text()).get('key') == layer.name for p in references):
                    continue
                retired = cache / (layer.name + '.retired')
                if retired.exists():
                    continue
                layer.rename(retired)
            remove_tree(retired, budget, trees, readonly=True)
            with maintenance_lock(trees):
                (retired / '.octopus-pruning').unlink(missing_ok=True)
                retired.rmdir()
            print('pruned unused dependency layer', layer.name)


if __name__ == '__main__':
    trees = Path(sys.argv[2])
    trees.mkdir(parents=True, exist_ok=True)
    with open(trees / '.release-prune.lock', 'a') as lock:
        report = None
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            budget = budget_module.Budget(entries_per_second=250)
            report = progress_module.Progress(Path(sys.argv[3]) / 'maintenance.json', Path(sys.argv[5]).name, budget, 'prune')
            with maintenance_lock(trees):
                pass
            with report.phase('cleanup'):
                prune(*sys.argv[1:], budget=budget)
            report.finish()
        except (BlockingIOError, ForegroundBusy) as error:
            if report:
                report.finish(state='deferred', reason=str(error))
            print('cleanup deferred: foreground installation or another collector owns the slot')
