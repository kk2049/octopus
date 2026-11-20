import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

it("finishes a consistent WAL snapshot despite commits between every paced chunk", () => {
  const script = String.raw`
import importlib.util, pathlib, sqlite3, sys, tempfile
spec = importlib.util.spec_from_file_location('backup', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as root:
    source = pathlib.Path(root)/'live.db'; target = pathlib.Path(root)/'snapshot.db'
    with sqlite3.connect(source, timeout=0.2) as writer:
        writer.execute('pragma journal_mode=WAL')
        writer.execute('create table counter(value integer, payload blob)')
        writer.execute('insert into counter values(0, zeroblob(2097152))'); writer.commit()
        calls = []
        class ConcurrentWrites:
            def __init__(self, **kwargs): pass
            def step(self, *args):
                calls.append(1)
                assert len(calls) < 20, 'backup restarted instead of advancing its snapshot'
                writer.execute('update counter set value=value+1'); writer.commit()
        m.module.Budget = ConcurrentWrites
        m.backup(source, target)
        assert len(calls) > 2
        assert writer.execute('select value from counter').fetchone()[0] == len(calls)
    with sqlite3.connect(target) as snapshot:
        assert snapshot.execute('pragma integrity_check').fetchone()[0] == 'ok'
        assert snapshot.execute('select value, length(payload) from counter').fetchone() == (0, 2097152)
    assert target.stat().st_mode & 0o777 == 0o600
print('concurrent snapshot verified')
`;
  expect(execFileSync("python3", ["-c", script, path.join(process.cwd(), "scripts/ops/release-backup.py")], { encoding: "utf8", timeout: 10_000 })).toContain("concurrent snapshot verified");
});

it("paces both byte and metadata work without accumulating an idle burst, and refuses work beyond its deadline", () => {
  const script = String.raw`
import importlib.util, sys
spec = importlib.util.spec_from_file_location('budget', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
now = [0.0]
sleeps = []
def sleep(delay):
    sleeps.append(delay); now[0] += delay
budget = m.Budget(bytes_per_second=100, entries_per_second=10, seconds=10,
                  clock=lambda: now[0], sleep=sleep, cpu_clock=lambda: 0)
budget.step(size=100)
assert now[0] >= 1
now[0] = 5
budget.step(entries=10)
assert now[0] >= 5.9  # idle credit is bounded to 100 ms, not an unlimited burst
before = len(sleeps)
for i in range(10):
    now[0] += 0.1  # real processing time already paid the next entry's budget
    budget.step(entries=1)
assert len(sleeps) == before, 'actual work was followed by a redundant sleep'
try:
    budget.step(size=10000)
    raise AssertionError('unbounded operation accepted')
except TimeoutError:
    pass
assert max(sleeps) < 2
print('paced')
`;
  expect(execFileSync("python3", ["-c", script, path.join(process.cwd(), "scripts/ops/release-budget.py")], { encoding: "utf8" })).toContain("paced");
});

it("reserves foreground I/O below the actual container cap instead of trusting a larger child quota", () => {
  const script = String.raw`
import importlib.util, pathlib, sys, tempfile
spec = importlib.util.spec_from_file_location('budget', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    assert m.staging_parent_has_headroom(root)
    (root/'io.max').write_text('253:0 rbps=24000000 wbps=8000000 riops=700 wiops=350\n')
    assert not m.staging_parent_has_headroom(root)
    (root/'io.max').write_text('253:0 rbps=32000000 wbps=16000000 riops=1200 wiops=800\n')
    assert not m.staging_parent_has_headroom(root)  # staging is 700/500 IOPS now
    (root/'io.max').write_text('253:0 rbps=32000000 wbps=16000000 riops=1400 wiops=1000\n')
    assert m.staging_parent_has_headroom(root)
    assert m.PROFILES['staging'][2] == 1.25  # half of the container's 2.5 CPUs
    (root/'io.max').write_text('253:0 rbps=max wbps=max riops=max wiops=max\n')
    assert m.staging_parent_has_headroom(root)
print('foreground reserve verified')
`;
  expect(execFileSync("python3", ["-c", script, path.join(process.cwd(), "scripts/ops/release-budget.py")], { encoding: "utf8" })).toContain("foreground reserve verified");
});

it("keeps current, rollback, watermark and active release trees while resuming a bounded retirement", () => {
  const script = String.raw`
import importlib.util, json, os, pathlib, sqlite3, subprocess, sys, tempfile
ops = pathlib.Path(sys.argv[1])
with tempfile.TemporaryDirectory() as root:
    root = pathlib.Path(root); repo = root/'repo'; trees = root/'trees'; artifacts = root/'artifacts'
    trees.mkdir(); (artifacts/'manifests').mkdir(parents=True); (artifacts/'objects').mkdir()
    def git(*args):
        return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()
    subprocess.run(['git', 'init', '-q', str(repo)], check=True)
    shas=[]
    for i in range(7):
        git('-c', 'user.name=test', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', str(i))
        sha=git('rev-parse','HEAD'); shas.append(sha)
        tree=trees/sha
        git('worktree','add','--detach',str(tree),sha)
        (tree/'.octopus-release.json').write_text(json.dumps({'repoSha':sha}))
        (tree/'.octopus-verified').write_text(sha); os.utime(tree/'.octopus-verified',(100+i,100+i))
        (tree/'payload').write_text('only obsolete release may disappear')
    git('branch','v4',shas[2])
    (trees/shas[4]/'.octopus-pruning').touch()
    unknown=trees/'unknown'; unknown.mkdir(); (unknown/'valuable').write_text('keep')
    db=root/'data'/'bot.db'; db.parent.mkdir()
    with sqlite3.connect(db) as conn:
        conn.execute('create table deploy_intents(id integer, target_sha text, status text)')
        conn.execute('insert into deploy_intents values(1, ?, ?)',(shas[3],'requested'))
    subprocess.run(['python3',str(ops/'release-prune.py'),str(repo),str(trees),str(artifacts),str(db),str(trees/shas[0]),str(trees/shas[1]),'2'],check=True)
    assert not (trees/shas[4]).exists()
    for i in [0,1,2,3,5,6]: assert (trees/shas[i]/'payload').is_file()
    assert (unknown/'valuable').read_text()=='keep'
    snapshot=root/'backups'/'snapshot.db'
    subprocess.run(['python3',str(ops/'release-backup.py'),str(db),str(snapshot)],check=True)
    with sqlite3.connect(snapshot) as conn:
        assert conn.execute('pragma integrity_check').fetchone()[0]=='ok'
        assert conn.execute('select target_sha from deploy_intents').fetchone()[0]==shas[3]
    assert snapshot.stat().st_mode & 0o777 == 0o600
print('retention and backup verified')
`;
  expect(execFileSync("python3", ["-c", script, path.join(process.cwd(), "scripts/ops")], { encoding: "utf8" })).toContain("retention and backup verified");
});
