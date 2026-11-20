# 4090 immutable release builder

The release pipeline builds and publishes a complete package on 4090. The
application discovers that package automatically and prepares its private runtime
tree on Aliyun. Deploy selects an exact ready SHA/manifest and performs only the
remaining backup, drain, switch, startup-health and App/Runner activation work.
Preparation and publication never authorize that switch.

## Execution placement

- `full_suite` retains tags `octopus,lht-val15` and Runner 229. Its API scheduling,
  contributor lane and full regression verdict are unchanged.
- `release` uses tags `octopus,lht-4090-release`, project-only Runner 236,
  protected refs only, no untagged work, one concurrent job, 45-minute timeout.
- Host: `gpu-host`; container: `octopus-gitlab-release-4090`. This is a
  GitLab Runner, distinct from Octopus's `octopus-ali-4090-ci` workspace provider
  and the personal `gpu-box-b` Runner. Do not reuse their tokens or jobs.
- All source, home, cache, temp, config and the Runner binary are under host
  `/srv/research/octopus-release-ci` on the research data volume. The Docker root
  was nearly full during provisioning; no new large base image was pulled there.

The container reuses the installed runtime image
`sha256:f2e3d6dec19fc757987675821a869174c6118da2b49c5f866525c93bc3c0c753`:
Node `22.23.2`, pnpm `9.15.0`, Python `3.12.3` and native build prerequisites.
CI asserts the execution device and exact Node version before use. It does not
apt-install a system or download Node on every commit. GitLab Runner is pinned
to `19.4.1`, binary SHA256
`5a159b36c5ff54fda9248e00bb0cdfb62c1112ab3741f5282c04a41e94da1306`, checked
against the upstream versioned checksum file before installation.

## Resource and credential boundary

The [host launcher](../../ops/gitlab-runner/release-4090.sh) uses 4 CPUs, 8 GiB
memory without swap, 512 PIDs, 64/32 MB/s read/write and 4000/2000 IOPS on the
research NVMe device. Root is read-only, capabilities are dropped, privilege
escalation is disabled and logs are capped at two 10 MiB files. It reuses the
existing CI network namespace/DNS policy and publishes no ports.

The shell executor runs as UID 1000 **inside this dedicated project container**.
It is suitable here for trusted protected-mainline code; it is not a sandbox
between mutually hostile jobs. It mounts neither the host Docker socket nor
personal homes nor the older workspace Runner's files. Do not attach other
projects or untrusted contributor jobs. See the
[GitLab shell-executor boundary](https://docs.gitlab.com/runner/executors/shell/#security).

The new project-scoped Runner authentication token is in host
`/srv/research/octopus-release-ci/config/config.toml`, mode 0600. The personal
GitLab administration key is not mounted into the job. Builds publish with their
own GitLab job token. Create/reconcile Runner registration once; an uncertain
POST must be inspected by its exact project/description, not repeated blindly.

## Package and readiness contract

4090 compiles all outputs, packs repository Apps, probes the native SQLite
dependency and packages the complete relative dependency layout. The new
`release-index.py` constructs a bounded digest inventory from the final
dependency archive itself. Its file is embedded in outputs, and the manifest
binds both its hash and its dependency archive identity. Existing two-part
packages and older installers remain compatible.

Aliyun verifies the archive/runtime/lock identity, then checks each cold file
while extracting and links it into the current private release immediately.
It copies the CI index rather than constructing it again, and does not reread
fresh files in a second materialization pass. An old cached layer is still
fully validated before reuse. Native runtime and dashboard assets must pass
before the ready marker is written. Relative workspace links remain private to
each version; another version's source/dist must never satisfy their resolution.

The application checks GitLab at startup and every 30 seconds when idle.
Only the newest complete mainline ancestor is selected. In-progress preparation
is serial; after it finishes, the next check picks the newest available release
instead of queuing every intermediate push. A manual Check joins the same
discovery/prepare primitives. Preparing does not create a deployment intent,
and discovery finishing after shutdown or after a deployment starts cannot
launch another preparation. A submitted deployment keeps its original exact pin.

## Operations and rollback

Reach the host through `ssh octo`, then `ssh backup-4090`; verify its hostname
before running the installed launcher
`/srv/research/octopus-release-ci/release-4090.sh`. It refuses to replace an
existing container. For changes, first pause Runner 236 in GitLab, allow its
current exact job to finish, preserve private config/state, then explicitly
replace the stopped container using the reviewed launcher. A network namespace
replacement also requires recreating this container against the new namespace.

To roll back placement, restore only the release job's old `lht-val15` tags,
Playwright image and shared Node setup through a normal landing; pause the
new runner after its current job finishes. The full-suite runner needs no
change. Keep already published releases immutable. Old packages without a CI
index continue to install, and existing ready/current/rollback directories
remain usable. Fixed ring0 installer copies need the updated layer/install
helpers during a separately authorized application rollout; do not overwrite
running or unrelated installation jobs.
