# Registered workspace jobs

`selfhosting.ci_machine.workspace_id` opts the configured owner/device into
`workspace-jobs/v1`. Without it the existing CI machine contract remains.
The configured id is an opaque id returned by the existing Runner workspace
registry, not a path supplied by a ticket. Only that requester receives the job
lane. The capability rechecks owner registration on every call; each Runner RPC
resolves the registered workspace again. Device paths stay on the device.

## Composition

Use a dedicated Linux execution-only Runner/container with persistent home and
workspace volumes, git, bash, coreutils `timeout`, Node and the repository's
pinned pnpm. Enable `RUNNER_WORKSPACE_JOBS=1`, `RUNNER_ALLOW_MACHINE_OPS=1` and
`RUNNER_EXECUTION_ONLY=1`; set `RUNNER_WORKSPACE_INPUT_ORIGIN` to the service's
HTTPS origin. The control site alone advertises and dispatches these jobs.
The daemon needs the new bundle before the service binding is enabled. The
inventory must report exactly `workspace-jobs/v1`, concurrency 1 and log chunks
65536 bytes. A known workspace provider without that protocol is unavailable.
Concurrency 1 is per managed checkout: jobs of different tickets (and the
service's own `knowledge-graph`/release keys) run in parallel, and a second job
in the same checkout returns `workspace_busy`.

The service binding needs its existing Runner gateway/capabilities and public
HTTPS bundle URL. `workspace_id` implies a required remote gate; `gate: false`
is rejected. `remote_required: true` can also forbid local gate fallback for a
legacy remote gate, but it does not give that legacy protocol durable jobs.
The container's limits bound the aggregate load of concurrent jobs; the 4090
CI container runs with 16 CPU / 24 GiB / 4096 pids (it was 4 CPU / 8 GiB / 512
while the Runner allowed one job at a time). Ticket commands keep choosing their
own test worker count. Registration,
container changes, owner grants, production config and deployment belong to the
delivery operator. Worktrees and commands are trusted owner execution, not a
security sandbox for mutually untrusted users.

## Ticket interface

`devpipe_ci_sync` prepares the ticket's exact committed HEAD and waits for a
frozen install and required test-ready builds. It uses a stable
`prepare-<40hex SHA>` request key. `devpipe_ci_job` accepts `start`, `status`,
`log`, or `cancel` and a stable `request_key` (1–80 alphanumeric, `_`, `-`).
The server adds `ticket:<id>:` and fixes the owner, device, registered workspace,
managed `ticket-<id>` checkout and source SHA. Start requires a clean tracked
source tree. Use `prepare: true` to send a source bundle for a new task; command
and timeout are immutable once the key is claimed. Callers cannot choose a
remote path, owner, device or workspace id.

A start returns promptly with a receipt. Read status/log with the same key after
a tool, transport or control-service restart. Logs have byte offsets and a
maximum chunk of 64 KiB (the command log itself is bounded to 16 MiB). Worker
execution lasts at most 45 minutes. A coreutils timeout process bounds each
child even if the worker dies. Ticket cancellation first saves cancellation
intent for all its jobs; recovery retries only cancellation/status on the
original target every 10 seconds. A cancelled ticket cannot start new work.

A completed failed task remains failed on the same key. An explicitly chosen
new key with `prepare: true` can retry after a known terminal failure; the
original `ci_sync` key still reports its original result. Fixing/committing the
source naturally yields a new sync key. Never choose a new key merely because
a response is missing.

## Receipts and recovery

| Result | Meaning and action |
|---|---|
| `accepted` / `running` | Read/attach the original job; submitting the same identity only queries it. |
| `succeeded` / `failed` / `cancelled` / `timed_out` | Durable task verdict; exit status is not an availability signal. |
| `not_started` + `workspace_busy` | This request did not claim a job; an explicit retry of its same key is safe after the active job settles. |
| Provider offline/unregistered/protocol unavailable | Availability refusal; any previously dispatched task may continue. Query the original target when it returns. |
| `unknown`, or missing receipt after dispatch | Execution cannot be established. No start replay, new target or local fallback is authorized by this state. |

The service saves immutable job intent in `data/dev-workspace-jobs/`. The Runner
saves request, worker/child PID + Linux start ticks, output, cancellation and
terminal receipt below `<runner-home>/.octopus/workspace-jobs/<site+workspace
hash>/<job-id>/`. HTTPS one-use input URLs are not persisted in request records.
Each managed checkout's execution lock is
`<runner-home>/.octopus/workspace-job-locks/<sha256 of checkout path>/job-id`; its
JSON binds job directory, workspace id/key, exact SHA and input fingerprint.
There is no stale-age unlock. A terminal receipt is fsynced before the worker
releases that matching lock. A legacy Runner-wide lock at
`<runner-home>/.octopus/workspace-jobs-active/job-id` (written before 2026-10-20)
still blocks every new job until its worker releases it.
Managed checkouts live under the registered root's `.octopus-ci/workspaces/`.

For a stuck lock, first save the lock and original job records as private
operational evidence, record the original target/source/key, and query status
and logs. Compare both worker and last child PID start ticks before inspecting
process state; PID existence alone is insufficient. If execution is still
alive, request cancellation and wait for its terminal receipt. If the worker
is gone, wait for the command's independent deadline, inspect remaining process
groups and side effects, and retain the unknown receipt. An operator may then
archive an orphaned lock only after proving no active process can mutate the
workspace and recording an explicit disposition for that exact job/source.
Never delete/rewrite its intent to turn an unknown into a fresh task. A new
explicit attempt must use a new key and cite the disposition. No automatic
recovery API fabricates a terminal success or unlocks an unknown task.

Gate run identities are saved in `data/dev-workspace-gates/`, bound to target
and source. An interrupted check reuses its prepare and step identities. A new
explicit check after a known terminal verdict allocates a new run. Preparation
failure maps to `deps_build`, task deadline to `timeout`, availability to
`remote_unavailable`, and uncertain execution to `remote_unknown`; existing
land/ticket failure handling retains these messages. Required gates execute no
local fallback. The existing local `_land` merge serialization is unchanged.

## Full post-submit CI

Workspace jobs execute ticket tests and landing gates. GitLab remains the full,
asynchronous, batched post-submit suite and the authority for `v4-stable`.
Register a separate project GitLab Runner with tags `octopus` and
`octopus-ali-4090`, run-untagged disabled, protected-ref policy matching `v4`,
concurrency 1 and a Docker job executor limited to 4 CPU / 8 GiB. Give its jobs
independent checkout/node_modules/cache directories; never share the Octopus
Runner's managed workspaces or `/work` mount. Change only the machine tag in
`.gitlab-ci.yml` after registration and verification; retain schedules, batching,
full red roster, reports and stable-watermark behavior. API credentials and the
GitLab Runner authentication token belong in private operator-managed files.
