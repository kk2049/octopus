"""Real archive/checkout tests; no production data, network, or package install."""
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import time
import unittest

OPS = Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location(name, OPS / (name + '.py'))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def clean_readonly(function, filename, error):
    os.chmod(Path(filename).parent, 0o700)
    if not os.path.islink(filename):
        os.chmod(filename, 0o700)
    function(filename)


class Releases(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='release-layer-test-'))
        self.repo = self.root / 'repo'
        self.artifacts = self.root / 'artifacts'
        self.trees = self.root / 'releases/trees'
        self.cache = self.trees.parent / 'dependencies'
        self.payload = self.root / 'payload'
        self.repo.mkdir()
        for p in (self.artifacts / 'manifests', self.artifacts / 'objects', self.trees):
            p.mkdir(parents=True)
        self.git('init', '-q')
        (self.repo / 'pnpm-lock.yaml').write_text('lock\n')
        (self.repo / 'packages/library').mkdir(parents=True)
        self.runtime = json.loads(subprocess.check_output(['node', '-p', 'JSON.stringify({node:process.version,nodeAbi:process.versions.modules,arch:process.arch,platform:process.platform})']))
        self.pkg = 'node_modules/.pnpm/pkg/node_modules/pkg'
        (self.payload / self.pkg).mkdir(parents=True)
        (self.payload / self.pkg / 'index.js').write_text("module.exports=require('lib')\n")
        (self.payload / 'node_modules/pkg').symlink_to('.pnpm/pkg/node_modules/pkg')
        (self.payload / 'node_modules/.pnpm/pkg/node_modules/lib').symlink_to('../../../../packages/library')
        (self.payload / 'packages/consumer/node_modules').mkdir(parents=True)
        (self.payload / 'packages/consumer/node_modules/lib').symlink_to('../../library')
        self.deps = self.archive('dependencies', ['node_modules', 'packages/consumer/node_modules'])

    def tearDown(self):
        shutil.rmtree(self.root, onerror=clean_readonly)

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], text=True, stderr=subprocess.DEVNULL).strip()

    def archive(self, kind, paths):
        out = io.BytesIO()
        with tarfile.open(fileobj=out, mode='w:gz', dereference=False) as tar:
            for p in paths:
                tar.add(self.payload / p, arcname=p)
        data = out.getvalue()
        digest = hashlib.sha256(data).hexdigest()
        (self.artifacts / 'objects' / (digest + '.tar.gz')).write_bytes(data)
        return dict(name=kind, file=kind + '.tar.gz', bytes=len(data), sha256=digest)

    def release(self, value, indexed=False):
        (self.repo / 'packages/library/index.js').write_text('module.exports=' + json.dumps(value))
        self.git('add', '.')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', value)
        sha = self.git('rev-parse', 'HEAD')
        outputs = ['packages/dashboard-web/dist', 'packages/runner/dist', 'plugins/sessions/dist']
        descriptor = None
        if indexed:
            name = 'packages/bot/dist/release-dependency-index.jsonl'
            descriptor = module('release-index').build(self.artifacts / 'objects' / (self.deps['sha256'] + '.tar.gz'),
                                                       self.payload / name)
            descriptor.update(file=name, archiveSha256=self.deps['sha256'])
            outputs.append('packages/bot/dist')
        for output in outputs:
            (self.payload / output).mkdir(parents=True, exist_ok=True)
            (self.payload / output / 'output.txt').write_text(value)
        m = dict(version=1, repoSha=sha, lockSha256=hashlib.sha256(b'lock\n').hexdigest(),
                 **self.runtime, parts=[self.deps, self.archive('outputs', outputs)], outputs=outputs)
        if descriptor:
            m['dependencyIndex'] = descriptor
        file = self.artifacts / 'manifests' / (sha + '.json')
        file.write_text(json.dumps(m))
        return m, file, self.trees / sha

    def install(self, release, success=True):
        m, file, tree = release
        result = subprocess.run(['python3', str(OPS / 'release-install.py'), str(file), str(self.repo), str(tree)],
                                text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode == 0, success, result.stderr)
        return json.loads((self.artifacts / 'preparations' / (m['repoSha'] + '.install.json')).read_text())

    def test_reuses_readonly_files_but_resolves_workspace_links_inside_each_release(self):
        first = self.release('first')
        a = self.install(first)
        second = self.release('second')
        b = self.install(second)
        self.assertFalse(a['dependencyCacheHit'])
        self.assertNotIn('dependencies_link', [p['name'] for p in a['phases']], 'fresh files were read a second time')
        self.assertTrue(b['dependencyCacheHit'])
        self.assertNotIn('dependencies_extract', [p['name'] for p in b['phases']])
        f1, f2 = [r[2] / self.pkg / 'index.js' for r in (first, second)]
        self.assertEqual(f1.stat().st_ino, f2.stat().st_ino)
        self.assertEqual(f1.stat().st_mode & 0o222, 0)
        self.assertNotEqual(f1.parent.stat().st_ino, f2.parent.stat().st_ino)
        for r, expected in ((first, 'first'), (second, 'second')):
            value = subprocess.check_output(['node', '-e', 'console.log(require(process.argv[1]))', str(r[2] / 'node_modules/pkg')], text=True).strip()
            self.assertEqual(value, expected)
            self.assertEqual((r[2] / 'packages/consumer/node_modules/lib/index.js').read_text(), 'module.exports=' + json.dumps(expected))
            self.assertEqual((r[2] / 'packages/runner/dist/output.txt').read_text(), expected)
        before = (self.artifacts / 'preparations' / (second[0]['repoSha'] + '.install.json')).read_bytes()
        self.install(second)
        self.assertEqual(before, (self.artifacts / 'preparations' / (second[0]['repoSha'] + '.install.json')).read_bytes())

    def test_ci_inventory_cold_link_warm_reuse_and_private_workspace_resolution(self):
        first = self.release('ci-first', indexed=True)
        cold = self.install(first)
        phase = next(p for p in cold['phases'] if p['name'] == 'dependencies_extract')
        self.assertEqual(phase['inventorySource'], 'ci')
        self.assertTrue(phase['assembledDuringExtraction'])
        self.assertNotIn('dependencies_link', [p['name'] for p in cold['phases']])
        layer = module('release-layer')
        cached = self.cache / layer.key_for(first[0])
        receipt = json.loads((cached / 'verified.json').read_text())
        self.assertEqual(receipt['inventorySource'], 'ci')
        self.assertEqual(receipt['inventorySha256'], first[0]['dependencyIndex']['sha256'])
        self.assertEqual((cached / 'files.jsonl').read_bytes(), (first[2] / first[0]['dependencyIndex']['file']).read_bytes())
        second = self.release('ci-second', indexed=True)
        warm = self.install(second)
        self.assertTrue(warm['dependencyCacheHit'])
        self.assertEqual((first[2] / self.pkg / 'index.js').stat().st_ino, (second[2] / self.pkg / 'index.js').stat().st_ino)
        for release, expected in ((first, 'ci-first'), (second, 'ci-second')):
            self.assertEqual(subprocess.check_output(['node', '-e', 'console.log(require(process.argv[1]))',
                             str(release[2] / 'node_modules/pkg')], text=True).strip(), expected)

    def test_inconsistent_ci_inventory_cannot_seal_a_layer_or_publish_readiness(self):
        release = self.release('bad-index', indexed=True)
        m, manifest, tree = release
        index = self.payload / m['dependencyIndex']['file']
        lines = [json.loads(line) for line in index.read_text().splitlines()]
        next(row for row in lines if row['type'] == 'file')['sha256'] = '0' * 64
        data = ''.join(json.dumps(row, separators=(',', ':')) + '\n' for row in lines).encode()
        index.write_bytes(data)
        m['dependencyIndex'].update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        m['parts'][1] = self.archive('outputs', m['outputs'])
        manifest.write_text(json.dumps(m))
        report = self.install(release, success=False)
        self.assertIn('differs from CI inventory', report['error'])
        self.assertFalse((tree / '.octopus-release.json').exists())
        self.assertFalse((self.cache / module('release-layer').key_for(m)).exists())

    def test_bad_inventory_digest_is_rejected_before_dependencies_are_installed(self):
        release = self.release('bad-digest', indexed=True)
        m, manifest, tree = release
        m['dependencyIndex']['sha256'] = '0' * 64
        manifest.write_text(json.dumps(m))
        report = self.install(release, success=False)
        self.assertIn('inventory size or digest mismatch', report['error'])
        self.assertFalse((tree / 'node_modules').exists())

    def test_resume_cold_partial_replaces_only_private_links_and_reuses_warm_validation(self):
        first = self.release('resume', indexed=True)
        self.install(first)
        # Model interruption after sealing a layer but before publishing the tree.
        (first[2] / '.octopus-release.json').unlink()
        claim = first[2].parent / (first[2].name + '.installing.json')
        claim.write_text(json.dumps(first[0]))
        inode = (first[2] / self.pkg / 'index.js').stat().st_ino
        report = self.install(first)
        self.assertTrue(report['dependencyCacheHit'])
        self.assertEqual((first[2] / self.pkg / 'index.js').stat().st_ino, inode)

    def test_detects_same_size_cache_corruption_before_publishing_readiness(self):
        first = self.release('first')
        self.install(first)
        file = next(self.cache.glob('*/payload/' + self.pkg + '/index.js'))
        data = file.read_bytes()
        file.chmod(0o644)
        file.write_bytes(b'x' * len(data))
        file.chmod(0o444)
        second = self.release('second')
        report = self.install(second, success=False)
        self.assertIn('verified dependency file changed', report['error'])
        self.assertFalse((second[2] / '.octopus-release.json').exists())

    def test_same_sha_waiters_preserve_the_actual_installation_receipt(self):
        release = self.release('concurrent')
        _, manifest, tree = release
        command = ['python3', str(OPS / 'release-install.py'), str(manifest), str(self.repo), str(tree)]
        receipt = self.artifacts / 'preparations' / (release[0]['repoSha'] + '.install.json')
        with open(self.trees / '.release-maintenance.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            children = [subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
            try:
                time.sleep(0.15)
                self.assertFalse(receipt.exists(), 'a waiter overwrote preparation evidence')
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
                for child in children:
                    _, error = child.communicate(timeout=15)
                    self.assertEqual(child.returncode, 0, error)
        report = json.loads(receipt.read_text())
        self.assertFalse(report['dependencyCacheHit'])
        self.assertIn('dependencies_extract', [p['name'] for p in report['phases']])

    def test_explicit_private_extraction_does_not_use_or_repair_a_corrupt_layer(self):
        first = self.release('first')
        self.install(first)
        file = next(self.cache.glob('*/payload/' + self.pkg + '/index.js'))
        file.chmod(0o644)
        file.write_text('corrupt')
        file.chmod(0o444)
        second = self.release('second')
        subprocess.run(['python3', str(OPS / 'release-install.py'), str(second[1]), str(self.repo), str(second[2])],
                       env={**os.environ, 'OCTOPUS_RELEASE_DEPENDENCY_CACHE': '0'}, check=True, capture_output=True, timeout=15)
        self.assertEqual(file.read_text(), 'corrupt')
        self.assertNotEqual(file.stat().st_ino, (second[2] / self.pkg / 'index.js').stat().st_ino)
        self.assertFalse((second[2] / '.octopus-dependency-layer.json').exists())
        self.assertTrue((second[2] / '.octopus-release.json').is_file())

    def test_reserve_failure_still_writes_a_failed_phase(self):
        progress, b = module('release-progress'), module('release-budget')
        file = self.root / 'failed-progress.json'
        report = progress.Progress(file, 'a' * 40, b.Budget())
        def refuse():
            raise RuntimeError('fixture reserve exhausted')
        report.guard = refuse
        with self.assertRaisesRegex(RuntimeError, 'reserve exhausted'):
            with report.phase('dependencies_extract'):
                self.fail('work started despite exhausted reserve')
        state = json.loads(file.read_text())
        self.assertEqual(state['state'], 'failed')
        self.assertEqual(state['phases'][0]['state'], 'failed')

    def test_finish_records_a_deferred_state(self):
        progress, b = module('release-progress'), module('release-budget')
        file = self.root / 'deferred-progress.json'
        report = progress.Progress(file, 'a' * 40, b.Budget(), 'prune')
        report.finish(state='deferred', reason='cleanup deferred to foreground installation')
        state = json.loads(file.read_text())
        self.assertEqual(state['state'], 'deferred')
        self.assertEqual(state['reason'], 'cleanup deferred to foreground installation')
        self.assertIn('finishedAt', state)

    def test_collector_keeps_a_referenced_layer_and_removes_only_a_known_unused_one(self):
        first = self.release('first')
        self.install(first)
        self.git('branch', 'v4', first[0]['repoSha'])
        layer = module('release-layer')
        budget = module('release-budget').Budget(profile='staging')
        progress = module('release-progress')
        # A distinct identity with identical fixture payload is an obsolete cache entry.
        old = dict(first[0], lockSha256='f' * 64)
        obsolete = layer.build(self.cache, old, self.artifacts / 'objects' / (self.deps['sha256'] + '.tar.gz'), budget, progress.atomic)
        unknown = self.cache / ('c' * 64)
        unknown.mkdir()
        (unknown / 'verified.json').write_text('{"identity":{}}')
        db = self.root / 'data/bot.db'
        db.parent.mkdir()
        with sqlite3.connect(db) as conn:
            conn.execute('create table deploy_intents(id integer,target_sha text,status text)')
        subprocess.run(['python3', str(OPS / 'release-prune.py'), str(self.repo), str(self.trees), str(self.artifacts),
                        str(db), str(first[2]), str(first[2]), '2'], check=True, capture_output=True, timeout=15)
        self.assertFalse(obsolete.exists())
        self.assertTrue(unknown.exists())
        self.assertTrue((self.cache / layer.key_for(first[0]) / 'verified.json').is_file())
        self.assertEqual(subprocess.check_output(['node', '-e', 'console.log(require(process.argv[1]))', str(first[2] / 'node_modules/pkg')], text=True).strip(), 'first')

    def test_refuses_changed_inventory(self):
        self.install(self.release('first'))
        index = next(self.cache.glob('*/files.jsonl'))
        index.chmod(0o644)
        index.write_text('{}\n')
        second = self.release('second')
        report = self.install(second, success=False)
        self.assertIn('inventory mismatch', report['error'])
        self.assertFalse((second[2] / '.octopus-release.json').exists())

    def test_rejects_archive_escape_and_symlink_parent(self):
        layer, budget = module('release-layer'), module('release-budget')
        for entries in ([('../outside', None)], [('node_modules/link', 'real'), ('node_modules/link/file', None)]):
            archive = self.root / 'unsafe.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                for name, link in entries:
                    entry = tarfile.TarInfo(name)
                    if link:
                        entry.type = tarfile.SYMTYPE; entry.linkname = link
                        tar.addfile(entry)
                    else:
                        entry.size = 1; tar.addfile(entry, io.BytesIO(b'x'))
            target = self.root / ('unsafe-' + str(len(entries)))
            target.mkdir()
            with self.assertRaises(ValueError):
                layer.extract(archive, target, 'dependencies', budget.Budget(profile='staging'))
        self.assertFalse((self.root / 'outside').exists())

    def test_collector_yields_to_installation_without_losing_retirement_identity(self):
        prune, b = module('release-prune'), module('release-budget')
        tree = self.trees / ('a' * 40)
        tree.mkdir()
        (tree / '.octopus-release.json').write_text('{}')
        (tree / '.octopus-verified').write_text('verified')
        for i in range(100):
            (tree / str(i)).write_text('owned fixture')
        with open(self.trees / '.release-maintenance.lock', 'a') as lock:
            budget = b.Budget(profile='staging')
            budget.observer = lambda: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(prune.ForegroundBusy):
                prune.remove_tree(tree, budget, self.trees)
            self.assertTrue((tree / '.octopus-pruning').exists())
            self.assertTrue((tree / '.octopus-release.json').exists())
            self.assertTrue((tree / '99').exists())
            fcntl.flock(lock, fcntl.LOCK_UN)
        prune.remove_tree(tree, b.Budget(profile='staging'), self.trees)
        self.assertFalse((tree / '99').exists())
        self.assertTrue((tree / '.octopus-release.json').exists())


if __name__ == '__main__':
    unittest.main()
