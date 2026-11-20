# Release preparation: measurements, cache and resource budgets

Deploy latency is the sum of CI/build, transfer/installation, switching and
acceptance/reporting. A completed ticket is not necessarily an already built
release. Use the fixed SHA and manifest of one deployment when comparing times;
do not compare whichever mainline happens to be newest at each observation.

## Observed baseline, 2026-10-09

The following measurements are from the D366 and D367 worker timestamps and
their terminal deployment records, not estimates from an agent's wall time.

| Stage | D366 | D367 |
| --- | --- | --- |
| Observed wait for CI | 08:28:45–08:39:47, 11m02s | release already becoming available |
| Prepare through deploy request | 08:39:49–09:18:24, 38m35s | approximately 13:11:27–13:36:30, 25m03s |
| Deploy request accepted through success | 09:19:00–09:22:27, 3m27s | 13:37:06–13:40:41, 3m35s |

D367's next model observation was around 13:49; Runner and final acceptance
finished around 13:53. The 15-minute self-wake interval can therefore add
visible reporting latency after the application is already live. It does not
explain the time spent preparing the release itself.

The releases `72bf0e2`, `eb0340b` and `77a0169` all reference the **same**
332,499,364-byte dependency archive,
`bd02aacffc24a99d81eb146cebc5891319f9becc0175e4a12d777a48641520f6`,
with lock digest
`f9277b8a0a4336035e923dd966e2f185cb194c4a3aa195f7cc6b255a8d4b7a67`.
The changed outputs archive is approximately 21.6 MB. The old installer nevertheless
materialized a complete dependency tree for every release.

The old work was deliberately paced: `release-budget.py` limited logical I/O to
4 MiB/s, entries to 100/s and CPU to 0.25 core; `release-job.sh` additionally
used a 25% CPU quota and cloud-disk IOPS/bandwidth limits. At inspection the
Aliyun filesystem was approximately 95% full. These limits protect the running
application on a shared cloud volume. They also make repeated decompression,
hashing and creation of many dependency files expensive. Compressed archive
size alone cannot predict elapsed installation time.

## Implemented preparation path

The installer reuses a verified immutable dependency layer keyed by the archive,
lock and exact runtime. Warm installs verify every reused file and link it into
private release directories; pnpm/workspace symlinks remain relative to that
release. Dist outputs remain separate. A corrupt layer fails closed; explicit
`OCTOPUS_RELEASE_DEPENDENCY_CACHE=0` requests private extraction, not silent
recovery from a failed integrity check.

The release-only GitLab job now runs on the [4090 builder](release-4090.md);
full-suite CI remains on lht-val15. CI packages the complete dependencies and
constructs their digest inventory from the final archive. Cold installation
compares that inventory while extracting and assembling the private tree, so it
does not reread freshly written files in a separate linking pass. Old cached
layers still receive full content verification. At startup and every 30 seconds
while idle, the application discovers complete releases and starts preparation
without a manual Check Updates. This does not authorize deployment or replace
the exact SHA/manifest already frozen in a deployment intent.

Normal preparation starts installation immediately. One bounded collector runs
in a later idle window, yields its maintenance lock in batches, and never holds
that lock while sleeping. Only insufficient disk headroom puts cleanup on the
foreground path. Complete current/rollback/mainline/staged identities remain
protected; incomplete or unknown directories are retained for explicit recovery.

Both Python and Node pacing now subtract actual work time and cap idle credit
at 100 ms. The old archive has 66,124 entries (53,507 regular files), with
1,176,829,972 bytes of payload. The old per-entry sleep calculation alone added
899.146 seconds, plus about 79.274 seconds for hashing the compressed archive,
before real work. The D366/D367 installers consumed only about 32 CPU-seconds
each while taking 24 minutes of wall time. Increasing CPU alone was insufficient.

Preparation persists separate receive/hash/checkout/extract/link/validate/publish
phase receipts, bytes/entries, explicit pacing time, and child/container cgroup
counters. The Deploy card expands these timings without creating another
check/deployment request. A same-SHA supervisor fast check preserves original
measurements. Stopped preparation does not keep displaying a stale running phase
as active work. Background cleanup has its own receipt and status.

## Parent and child resource limits

On 2026-10-10 the actual Aliyun service-container parent was found to have a
shared 24 MB/s read, 8 MB/s write, 700 read IOPS and 350 write IOPS cap. Docker's
HostConfig showed no block limits because the host start wrapper applied them
with `systemctl set-property` on the Docker scope. This outer limit includes the
foreground application and every transient installation service. Inspecting only
`release-job.sh` or Docker HostConfig therefore missed a decisive constraint.

Initial load trials were stopped when foreground latency increased. A larger
child budget cannot bypass a smaller parent and can consume its entire write
allowance. The revised layout reserves capacity at both levels: the parent
is bounded independently, and staging is capped below it. `release-job.sh` checks
the visible parent `io.max`; if it cannot reserve at least another staging
job's capacity for foreground work, it selects the maintenance profile.
Resource values, rollback knobs and recovery are in [remote release](remote-release.md).

Do not interpret `/api/deploy` latency as pure local I/O latency: that endpoint
also awaits public ingress probes. Use the authenticated lightweight
`/api/deploy/active` for foreground responsiveness, separately preserve full
SHA/manifest status, and observe physical disk await/queue/utilisation plus
parent/child memory and throttling counters. A short live comparison is evidence
for that workload, not a general p95/SLA promise.

## Historical stage breakdown

| Measured stage | D366 | D367 |
| --- | --- | --- |
| Observed receiving before cleanup | about 2m00s | 2m04s |
| Foreground cleanup | 11m57s | 2.510s |
| Installer system service | 23m52s | 24m13s |
| Ready to worker's deploy request | 46s | 47s |

The old D367 “25m03s” figure started at 13:11:27, after reception had already
started at 13:09:23; total observed receiving-through-request was about 27m07s.
It was never evidence that downloading 332 MB took 25 minutes: the dependency
archive was already cached and only approximately 21.6 MB of outputs transferred.

Preparation still does not include the separate snapshot/drain/startup/health
and App activation path. The 15-minute model wake interval affects when an agent
reports a result; it does not explain installer work. CI post-submit batching,
artifact pruning to a smaller production closure, and a new generic terminal
notification protocol are separate changes, not outcomes of this optimization.

Real GUI acceptance uses the existing isolated [browser environment](browser-acceptance.md).
Cold/warm measured results and rollout status belong in the accompanying
[delivery record](../deliveries/2026-10-10-release-preparation-performance.md).
