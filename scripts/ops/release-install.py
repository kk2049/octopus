#!/usr/bin/env python3
"""Install a complete, exact-source Runner release in a new checkout. Never runs a build/install hook."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('release_budget', Path(__file__).with_name('release-budget.py'))
budget_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(budget_module)
budget = budget_module.Budget(profile=os.environ.get('OCTOPUS_RELEASE_PROFILE', 'staging'))
spec = importlib.util.spec_from_file_location('release_layer', Path(__file__).with_name('release-layer.py'))
layer_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layer_module)
spec = importlib.util.spec_from_file_location('release_progress', Path(__file__).with_name('release-progress.py'))
progress_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(progress_module)


def sha256(file):
    return layer_module.digest(file, budget)


def install(manifest_file, repository, destination, progress):
    mf = Path(manifest_file).resolve()
    m = json.loads(mf.read_text())
    sha = m['repoSha']
    if m['version'] != 1 or not re.fullmatch('[0-9a-f]{40}', sha):
        raise ValueError('invalid release identity')
    runtime = json.loads(subprocess.check_output(['node', '-p', 'JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,nodeAbi:process.versions.modules})']))
    if any(m.get(k) != v for k, v in runtime.items()):
        raise ValueError('release does not match production Node/platform/ABI')
    parts = m['parts']
    if len(parts) != 2 or {p['name'] for p in parts} != {'dependencies', 'outputs'}:
        raise ValueError('release requires both dependency and build artifacts')
    destination = Path(destination).absolute()
    if destination.is_symlink():
        raise ValueError('release destination must not be a symlink')
    marker = destination / '.octopus-release.json'
    if (destination / '.octopus-pruning').exists():
        raise ValueError('release is being retired; prepare a fresh target')
    if marker.exists():
        if json.loads(marker.read_text()) != m:
            raise ValueError('existing release identity differs')
        if progress:
            progress.finish(cached=True)
        print(destination)
        return
    claim = destination.parent / (destination.name + '.installing.json')
    if destination.exists() and (not claim.exists() or json.loads(claim.read_text()) != m):
        raise ValueError('unowned or differently bound incomplete release directory')
    objects = mf.parent.parent / 'objects'
    cache = destination.parent.parent / 'dependencies'
    use_cache = os.environ.get('OCTOPUS_RELEASE_DEPENDENCY_CACHE', '1') != '0'
    with progress.phase('dependency_cache') as phase:
        layer = layer_module.load(cache, m, budget) if use_cache else None
        phase['cacheHit'] = layer is not None
    archives = {}
    for part in parts:
        with progress.phase('verify_' + part['name']) as phase:
            if not re.fullmatch('[0-9a-f]{64}', part['sha256']):
                raise ValueError('invalid artifact digest')
            archive = objects / (part['sha256'] + '.tar.gz')
            # The reused layer is independently checked file-by-file below.
            if part['name'] == 'dependencies' and layer:
                phase['cacheHit'] = True
            elif archive.stat().st_size != part['bytes'] or sha256(archive) != part['sha256']:
                raise ValueError('release artifact size or digest mismatch')
            archives[part['name']] = archive
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not claim.exists():
        with open(claim, 'x') as f:
            json.dump(m, f)
            f.flush()
            os.fsync(f.fileno())
    with progress.phase('checkout'):
        if not destination.exists():
            subprocess.run(['git', '-C', repository, 'worktree', 'add', '--detach', str(destination), sha], check=True, stdout=sys.stderr)
        elif subprocess.check_output(['git', '-C', str(destination), 'rev-parse', 'HEAD'], text=True).strip() != sha:
            raise ValueError('interrupted release source identity changed')
        if sha256(destination / 'pnpm-lock.yaml') != m['lockSha256']:
            raise ValueError('release lockfile mismatch')
    cache_hit = layer is not None
    # The CI-generated dependency inventory travels in outputs. Stage these
    # first so cold extraction can check and link each file in one pass.
    with progress.phase('outputs_extract'):
        output_bytes = layer_module.extract(archives['outputs'], destination, 'outputs', budget)['bytes']
        inventory = layer_module.prepared_index(m, destination, budget)
    remaining_bytes = 8 * 1024 ** 3 - output_bytes
    if use_cache:
        if not layer:
            with progress.phase('dependencies_extract', inventorySource='ci' if inventory else 'installer', assembledDuringExtraction=True) as phase:
                layer = layer_module.build(cache, m, archives['dependencies'], budget, progress_module.atomic,
                                           destination=destination, inventory=inventory, max_bytes=remaining_bytes)
                counts = json.loads((layer / 'verified.json').read_text())
                dependency_bytes = counts['bytes']
                phase.update(filesReused=counts['files'], bytesReused=dependency_bytes)
        else:
            # Existing cached files could have changed since their last use.
            # They retain the full validation path; only fresh extraction skips it.
            with progress.phase('dependencies_link', cacheHit=True) as phase:
                dependency_counts = layer_module.materialize(layer, destination, budget)
                phase.update(dependency_counts)
                dependency_bytes = dependency_counts['bytesReused']
        progress_module.atomic(destination / '.octopus-dependency-layer.json',
                               dict(version=1, key=layer.name, identity=layer_module.identity(m)))
    else:
        with progress.phase('dependencies_extract', cacheHit=False):
            dependency_bytes = layer_module.extract(archives['dependencies'], destination, 'dependencies', budget,
                                                    max_bytes=remaining_bytes)['bytes']
        (destination / '.octopus-dependency-layer.json').unlink(missing_ok=True)
    if dependency_bytes > remaining_bytes:
        raise ValueError('release exceeds total unpacked size budget')
    with progress.phase('validate'):
        validate(destination)
    with progress.phase('publish'):
        progress_module.atomic(marker, m)
        claim.unlink()
    progress.finish(dependencyCacheHit=cache_hit, layerKey=layer.name if layer else None)
    print(destination)


def validate(destination):
    for output in ['packages/dashboard-web/dist', 'packages/runner/dist', 'plugins/sessions/dist']:
        if not (destination / output).is_dir():
            raise ValueError('release is missing required outputs')
    # Native compatibility is checked before stopping the old process, without any install hook.
    # Synthetic supervisor fixtures deliberately have no bot package.
    if (destination / 'packages/bot/package.json').is_file():
        dashboard = destination / 'packages/dashboard-web/dist'
        assets = json.loads((dashboard / '.vite/manifest.json').read_text())
        if not any(entry.get('isEntry') for entry in assets.values()):
            raise ValueError('dashboard manifest has no entry')
        for entry in assets.values():
            for name in [entry['file'], *entry.get('css', [])]:
                target = dashboard / name
                if not target.resolve().is_relative_to(dashboard.resolve()) or not target.is_file():
                    raise ValueError('dashboard manifest references missing or unsafe asset')
        subprocess.run(['node', '--input-type=module', '-e',
                        "import{createRequire}from'node:module';const r=createRequire(process.cwd()+'/packages/bot/package.json');const D=r('better-sqlite3');const d=new D(':memory:');d.prepare('select 1').get();d.close()"],
                       cwd=destination, check=True)


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit('usage: release-install.py MANIFEST REPOSITORY DESTINATION')
    parent = Path(sys.argv[3]).absolute().parent
    parent.mkdir(parents=True, exist_ok=True)
    manifest = Path(sys.argv[1]).resolve()
    sha = json.loads(manifest.read_text())['repoSha']
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise ValueError('invalid release identity')
    # Supervisor fast-path checks must not overwrite the original preparation
    # timings with a tiny second receipt.
    if (Path(sys.argv[3]) / '.octopus-release.json').is_file():
        install(*sys.argv[1:], None)
        sys.exit(0)
    def space_guard():
        if shutil.disk_usage(parent).free < 2 * 1024 ** 3:
            raise RuntimeError('release installation reached the 2 GiB free-space reserve')
    with open(parent / '.release-maintenance.lock', 'a') as lock:
        waiting_at, waiting_started = progress_module.stamp(), time.monotonic()
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                budget.step()
                time.sleep(0.1)
        # A second same-SHA caller must not overwrite the installer's evidence.
        if (Path(sys.argv[3]) / '.octopus-release.json').is_file():
            install(*sys.argv[1:], None)
            sys.exit(0)
        report = progress_module.Progress(manifest.parent.parent / 'preparations' / (sha + '.install.json'), sha, budget)
        report.data['phases'].append(dict(name='waiting_install_lock', state='succeeded',
                                         startedAt=waiting_at, finishedAt=progress_module.stamp(),
                                         elapsedMs=round((time.monotonic() - waiting_started) * 1000)))
        report.guard = space_guard
        try:
            install(*sys.argv[1:], report)
        except BaseException as error:
            report.guard = None
            report.data.update(state='failed', finishedAt=progress_module.stamp(), error=str(error)[:500])
            report.flush(force=True)
            raise
