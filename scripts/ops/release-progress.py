"""Small atomic progress receipts, shared by installation and maintenance."""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time
import uuid


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


def resources():
    try:
        cgroup = next(row[3:] for row in Path('/proc/self/cgroup').read_text().splitlines() if row.startswith('0::'))
        root = Path('/sys/fs/cgroup')
        directory = (root / cgroup.lstrip('/')).resolve()
        if not directory.is_relative_to(root):
            return {}
        result = dict(cgroup=cgroup)
        for name in ('cpu.stat', 'cpu.max', 'io.stat', 'io.max', 'memory.current', 'memory.peak', 'memory.events'):
            file = directory / name
            if file.is_file():
                result[name] = file.read_text()[:4096].strip()
        for name in ('cpu.max', 'io.max', 'memory.current', 'memory.max', 'memory.events'):
            file = root / name
            if file.is_file():
                result['container.' + name] = file.read_text()[:4096].strip()
        return result
    except (OSError, StopIteration):
        return {}


def atomic(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temp = file.with_name(file.name + '.' + uuid.uuid4().hex + '.tmp')
    with open(temp, 'x') as out:
        os.chmod(temp, 0o600)
        json.dump(value, out, separators=(',', ':'))
        out.flush()
        os.fsync(out.fileno())
    os.replace(temp, file)
    fd = os.open(file.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class Progress:
    def __init__(self, file, sha, budget, action='install'):
        self.file, self.budget = Path(file), budget
        self.started = time.monotonic()
        self.last_write = 0
        self.current = None
        self.guard = None
        self.data = dict(version=1, sha=sha, action=action, state='running',
                         startedAt=stamp(), pid=os.getpid(), profile=budget.profile, phases=[])
        try:
            self.data['startTicks'] = Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19]
        except OSError:
            pass
        budget.observer = self.flush
        self.flush(force=True)

    def flush(self, force=False):
        now = time.monotonic()
        if not force and now - self.last_write < 2:
            return
        if self.guard:
            self.guard()
        if self.current:
            self.current['elapsedMs'] = round((now - self.phase_started) * 1000)
            self.current.update({k: v - self.phase_counters[k] for k, v in self.budget.counters().items()})
        self.data.update(updatedAt=stamp(), elapsedMs=round((now - self.started) * 1000),
                         counters=self.budget.counters(), resources=resources())
        atomic(self.file, self.data)
        self.last_write = now

    @contextmanager
    def phase(self, name, **details):
        self.phase_started = time.monotonic()
        self.phase_counters = self.budget.counters()
        row = dict(name=name, state='running', startedAt=stamp(), **details)
        self.data['phases'].append(row)
        self.current = row
        try:
            self.flush(force=True)
            yield row
        except BaseException as error:
            row.update(state='failed', error=str(error)[:500])
            self.data.update(state='failed', error=str(error)[:500])
            raise
        else:
            row['state'] = 'succeeded'
        finally:
            row['finishedAt'] = stamp()
            guard = self.guard
            if row['state'] == 'failed':
                self.guard = None  # A failed reserve check must still publish its receipt.
            try:
                self.flush(force=True)
            finally:
                self.current = None
                self.guard = guard

    def finish(self, **details):
        # A caller may finish with another terminal state (prune: 'deferred').
        self.data.update({'state': 'succeeded', 'finishedAt': stamp(), **details})
        self.flush(force=True)
