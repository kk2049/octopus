"""Elapsed-time pacing with at most 100 ms of credit, plus a hard deadline.

Real I/O/CPU time pays for work instead of being followed by another full sleep.
Idle time never buys an unbounded burst. The production cgroup covers children
and physical I/O as well as these portable logical byte/metadata budgets.
"""
import os
from pathlib import Path
import time

PROFILES = {
    'maintenance': (4 * 1024 * 1024, 250, 0.25),
    'staging': (16 * 1024 * 1024, 500, 1.25),
}


def staging_parent_has_headroom(root=Path('/sys/fs/cgroup')):
    """A child limit must leave capacity for the bot under the container limit.

    The new system service is placed below the container's root, not below the
    invoking bot's user service. A missing/unlimited I/O controller imposes no
    tighter parent cap. Reserve at least another staging job's worth for the
    foreground on every constrained device (staging is about half the
    current 32/16 MB/s, 1400/1000 IOPS container budget).
    """
    file = Path(root) / 'io.max'
    if not file.exists():
        return True
    needed = dict(rbps=32000000, wbps=16000000, riops=1400, wiops=1000)
    for line in file.read_text().splitlines():
        for field in line.split()[1:]:
            name, value = field.split('=', 1)
            if name in needed and value != 'max' and int(value) < needed[name]:
                return False
    return True


class Budget:
    def __init__(self, bytes_per_second=None, entries_per_second=None,
                 seconds=2400, clock=time.monotonic, sleep=time.sleep,
                 cpu_clock=time.process_time, cpu_cores=None, burst_seconds=0.1,
                 profile=None):
        self.profile = profile or os.environ.get('OCTOPUS_RELEASE_PROFILE', 'maintenance')
        rates = PROFILES[self.profile]
        self.clock, self.sleep = clock, sleep
        self.cpu_clock = cpu_clock
        self.started = self.next_io = self.next_entry = self.next_cpu = clock()
        self.deadline = self.started + seconds
        self.rate = rates[0] if bytes_per_second is None else bytes_per_second
        self.entries = rates[1] if entries_per_second is None else entries_per_second
        self.cores = rates[2] if cpu_cores is None else cpu_cores
        if min(self.rate, self.entries, self.cores) <= 0 or not 0 <= burst_seconds <= 0.1:
            raise ValueError('invalid release resource budget')
        self.burst = burst_seconds
        self.cpu_start = self.cpu_last = cpu_clock()
        self.bytes = self.count = 0
        self.slept = 0.0
        self.observer = None

    def step(self, size=0, entries=0):
        now = self.clock()
        if now > self.deadline:
            raise TimeoutError('release maintenance exceeded its time budget')
        if size < 0 or entries < 0:
            raise ValueError('negative work')
        self.bytes += size
        self.count += entries
        self.next_io = max(now - self.burst, self.next_io) + size / self.rate
        self.next_entry = max(now - self.burst, self.next_entry) + entries / self.entries
        cpu = self.cpu_clock()
        self.next_cpu = max(now - self.burst, self.next_cpu) + (cpu - self.cpu_last) / self.cores
        self.cpu_last = cpu
        wait = max(self.next_io, self.next_entry, self.next_cpu) - now
        if now + wait > self.deadline:
            raise TimeoutError('release operation exceeds the remaining time budget')
        if wait > 0:
            self.sleep(wait)
            self.slept += wait
        if self.observer:
            self.observer()

    def counters(self):
        return dict(bytes=self.bytes, entries=self.count,
                    cpuMs=round((self.cpu_clock() - self.cpu_start) * 1000),
                    pacedMs=round(self.slept * 1000))


def discard_cache(file):
    # Content was already verified. Do not let bulk release bytes evict the bot/SSH working set.
    if hasattr(os, 'posix_fadvise'):
        os.posix_fadvise(file.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
