# Native development, GitLab mainline and immutable releases

Native CLI work happens in a local dedicated worktree. Octopus observes and
coordinates optional ticket interaction; it does not relay local model/tool
execution. GitLab remains usable while the application is offline.

## Authority and layout

Activation is explicit. Until the coordinator branch is created after draining
the old writer, Head owns mainline. Merely installing this source does not
activate GitLab authority. Never run Head mirroring and GitLab writers together.

For 4090: reference clone `/home/ubuntu/lht/repos/octopus`, worktree parent
`/home/ubuntu/lht/worktrees/octopus`. Long-lived operations notes belong in
`/home/ubuntu/lht/ops/octopus`; temporary evidence in a task directory under
`/home/ubuntu/lht/temp`. The Aliyun service paths remain a separate device:
source/cache `/home/ubuntu/lht/octopus`, deployed tree `/home/ubuntu/lht/octopus-run`,
state `/home/ubuntu/lht/octopus-dev`. Keep credentials outside Git, mode 0600.

```bash
cd /home/ubuntu/lht/repos/octopus
git config octopus.worktreesDir /home/ubuntu/lht/worktrees/octopus
scripts/ops/worktree.sh dev/lht-example
cd /home/ubuntu/lht/worktrees/octopus/dev-lht-example
codex
```

The helper fetches the exact GitLab base, installs frozen isolated dependencies
and builds test prerequisites. An explicit third base argument permits offline
feature work. It never moves another worktree or shares its `node_modules`.

## Integrate and land

Develop/test before acquiring the lease. Acquire before rebase/conflict repair,
review semantic conflicts, run focused gates, then publish:

```bash
scripts/ops/development.sh acquire --owner lht
# The response fixes the base SHA; rebase to that SHA, inspect and repair.
git rebase <lease-base-sha>
# Commit the implementation. Optional reading list for the changed paths:
corepack pnpm knowledge:context -- <changed-paths>
# Add the v3 report in a separate final commit (doc/cli-reports/README.md).
scripts/ops/land.sh
# If abandoning integration:
scripts/ops/development.sh release
```

One lease covers repair and publication; ordinary development/full asynchronous
CI/release building do not hold it. A local I/O guardian renews every 30 seconds
with no model wake, until the hold deadline: 60 minutes from `acquire`/`takeover`
by default, `--hold-minutes` selects 1–480. `land` never extends a hold; another
explicit `acquire` starts a new one. Renewal also stops as soon as the
acquiring process is gone: the nearest agent CLI (Claude Code, Codex, omp) or
interactive/script shell that ran the command, identified by pid + start time.
The remote lease then expires within its two-minute TTL. Expired ownership
cannot publish. Reacquire and rebase after expiry; do not refresh a stale report
against a moving base blindly.
Exit 4 means queued. Inspect status or retry acquisition when ready; no agent
poll loop is required. FIFO reservations expire after 120 seconds if abandoned.

State belongs to the worktree's actual Git dir under `octopus-development/`;
identity, native binding, coordination target and last publication survive CLI
commands/restart. Status uses GitLab directly, without an Octopus credential.
A failed local gate leaves the lease for repair until release/deadline/expiry.

`land` requires a clean feature branch and a v3 report written at the lease
base. Specifications and retrieval receipts are optional records; when present,
declared `verified_by` tests run along with current architectural constraint
evidence and the existing frozen-install/typecheck/changed-test gate in an
isolated tree. Offline evidence cannot upgrade claims using private server-only
human sources; use accurate Agent attribution or the authenticated service
landing adapter.

Mainline and append-only coordination updates are one atomic Git push with
exact expected ref values. A new epoch fences an earlier holder. Lost ACKs are
reconciled from the durable receipt; no mutation is blindly replayed. GitLab
branch protection forbids force pushes but cannot compel a trusted maintainer
to follow the coupled-ref protocol. Every supported writer must use it.

Web tickets retain their assigned Runner workspace and `devpipe_submit` UI;
the Head adapter acquires the same lease, holds it during in-turn repair, and
only then advances GitLab. Head fast-forwards its clean cache and reconciles
CLI reports into landed/pending tickets, even after an application outage.

## Native CLI ticket registration

Run this command in the feature worktree from your existing native Codex or
Claude Code agent. The CLI may have originally started elsewhere (for example in
your home):

```bash
scripts/ops/development.sh register --owner lht --title 'Octopus development'
# The provider and session come from CODEX_THREAD_ID or CLAUDE_CODE_SESSION_ID.
# --source codex|claude --session <UUID> names them when neither or both are exported.
# --ticket <id> explicitly attaches your own existing unbound CLI report.
```

The helper declares the current Git root through the private local socket;
it does not change the session's cwd, permissions, tools or execution owner.
Choose the worktree before registration: a session binds to one project tree.
Registration exposes the existing full conversation to authorized ticket viewers;
use a fresh development session when its earlier history should remain private.
The local Runner proves the live session itself — for Codex the loaded daemon
thread and trusted account, for Claude Code the exact process incarnation its
lifecycle hooks reported — plus the Git origin, branch and registered workspace. The caller cannot supply its
own proof. Registration is idempotent for owner/device/session and cannot move
that binding to another workspace. The returned `native_ticket_id` goes into
the final v3 report so reconciliation updates the original conversation.
An unregistered CLI omits that field and gets an ordinary delivery report.
That report is an immutable delivery record, not a new or unbound running agent.
An explicit `--ticket` backfill preserves the report's title, body, commit and
deployment verdict. It refuses foreign owners, managed tickets and an existing
session binding; no history is inferred or attached automatically. The session
has one canonical ticket, even when older deliveries were separate reports.

The ticket reads the normal full transcript. Owner/admin input and interruption
target only that existing native CLI: the Codex daemon, or the Claude Code TUI's
exact tmux pane (text paste; Esc only while a turn is working). The protocol refuses older Runners,
missing native sessions, new managed attachments, takeover, account fallback,
permission/model changes and uncertain retries. Operation IDs/receipts survive
reconnect; missing/uncertain receipts remain explicit and are queried, never
resent automatically. Closing the CLI therefore disables webpage input without
resuming it elsewhere. Native tickets never enter the managed concurrency queue.
The webpage distinguishes a fresh idle/working native observation from unavailable
control, and expires old Codex daemon observations instead of treating input receipts
as liveness. A Claude Code TUI is re-proven by process identity on every read.
Unavailable does not mean completed. **End tracking** closes webpage tracking and
control without signalling the CLI or deleting history/uncertain receipts. It uses
the existing `chat_paused` bit for native tracking, completes only unlanded tickets,
and preserves landed/deployment status. Explicit local re-registration of the same
session/worktree restores tracking; it never automatically resumes an agent.
Codex and Claude Code sessions are supported; personal QQ hooks and managed
tickets are unaffected.

## Independent release and deployment

A GitLab `v4` push starts `octopus-release`, independent of the application.
The CI job builds the complete Node 22.23.2 Linux runtime and dependencies,
checks hashes, and uploads generic package `octopus-release/<full-sha>`.
Filenames contain SHA256; Release tag is `octopus-v4-<full-sha>`. Its
`release.json@<sha256>` asset is created only after both archives are complete.
An existing different manifest is refused. A retry must retain identical bytes;
it must not overwrite an existing version with a fresh build timestamp.

The application checks for complete GitLab releases automatically at startup and
every 30 seconds while idle, with one preparation at a time. A CI completion is
discovered even if mainline has not advanced since its build started. This never
creates a deployment intent. A failed preparation (for example a full disk) is
retried for the same SHA and manifest by the first poll or Check at least 10
minutes later, and at once by an explicit SSH `gitlab-release.sh prepare`; the
installer resumes its own partial target. An unknown preparation keeps its
original receipt and is never replayed.

The webpage has Check Updates and Deploy. Check also reads GitLab mainline, selects
the newest complete ancestor release by commit order, persists its SHA+manifest
hash, then downloads/stages it. Mainline, the newest CI release, the newest fully
staged release, and live SHA are separate. The deploy button uses the newest
fully staged ancestor, including one retained across restart; newer downloads,
staging and preparation failures do not disable it. Its activation skips the
background preparation queue. Deploy freezes the reviewed SHA+hash; later checks
or pushes cannot replace or invalidate it while its verified staging remains
available and the commit belongs to the checked mainline.
Incomplete staging fails before the old process is drained. App/Runner release
debt, independent supervisor, startup health and rollback remain in force.
A newer mainline commit absent from the chosen release remains pending.

The release job uses the isolated [4090 builder](release-4090.md); full-suite CI
stays on lht-val15. Dependencies, native builds and a digest-bound file inventory
travel in the package. The service verifies and assembles the complete directory
before readiness; it never resolves dependencies or builds after Deploy is clicked.

Service configuration after cutover:

```yaml
selfhosting:
  mainline:
    authority: gitlab
    remote: origin
    control_branch: octopus-coordination
  deployment_build:
    mode: gitlab
    gitlab:
      api_url: https://gitlab.example.com:1312/api/v4
      project: '6361'
      token_file: /home/ubuntu/.config/octopus/gitlab-api.token
```

These fields extend existing `repo_dir`, `run_dir`, workspace, permission and
supervisor configuration; do not replace the whole service config with this
fragment. The token path is device-local, not implicitly copied from 4090.
The API origin must match the CI-published Release asset origin. The SSH hostname
alias `gitlab.example.com` remains valid for Git but is not the Release API
origin; keep the catalog's cross-origin rejection intact.

If the application is down, SSH to the service device and run its checked source:

```bash
scripts/ops/gitlab-release.sh check --config <absolute-config> --data-dir <absolute-state>
scripts/ops/gitlab-release.sh prepare --config <absolute-config> --data-dir <absolute-state> --sha <sha> --digest <sha256>
scripts/ops/gitlab-release.sh request-deploy --config <absolute-config> --data-dir <absolute-state> --sha <sha> --digest <sha256> --actor lht --reason 'repair application'
scripts/ops/gitlab-release.sh status --config <absolute-config> --data-dir <absolute-state> --id <intent>
```

This uses the same DB, exact pin, deploy permission, knowledge/ingress gates and
artifact installer. The independent artifact-mode supervisor must be running.
It neither starts an agent nor builds on the service host. Read intent/health
status through success or rollback; a submitted request is not a live release.

## Cutover and rollback checklist

1. Finish the normal Head bootstrap landing and verify Head/GitLab exact equality.
   Use `OCTOPUS_MAINLINE_AUTHORITY=head scripts/ops/land.sh <branch>` only before
   activation. Produce and verify the immutable bootstrap release independently.
2. Record live/source/ready SHAs; back up config, DB and supervisor launcher.
   Protect `v4` and `octopus-coordination` against force/deletion, use fast-forward
   GitLab merging, inspect namespace generic-package duplicate policy, and protect release tags.
   Do not widen the change to unrelated repositories in a personal namespace;
   content-addressed hashes and the create-once publisher remain mandatory.
   Set GitLab default branch `v4`; `main` is historical. Validate the CI job token
   can upload packages/create releases and the service token can read/range them.
3. Drain old integration writers and disable their scheduling/mirroring. Ensure
   no legacy agent/API fallback can still move Head. Compare exact SHAs again.
4. Run `development.sh activate --expected-sha <compared-sha> --old-writer-drained`.
   Configure GitLab authority/release catalog and use the authorized deployment
   to start the new app/supervisor. Upgrade the local Runner through normal bundle
   activation; enable the existing owner-scoped local bridge/workspace grants.
5. Verify two writers contend, native registration/transcript/input, checked
   pin, staging, live health/watermark and App/Runner debt. Do not treat a source
   checkout or a successful release upload as authority activation or deployment.

If the coordinator fails, use `takeover --reason ...` to fence it, or
`land --no-lock --expected-sha ... --reason ...` after review if the coordinator
cannot be repaired. Emergency publication still validates all gates and atomically
adds an emergency receipt; it retains linear optimistic Git ref concurrency but
cannot promise exclusive integration while bypassing a broken lock.

Rollback to an old application must keep its mainline writer disabled. Never
delete coordination state to make an old helper run. Restoring Head authority
requires another explicit drain/compare/reconfiguration; source rollback alone
is insufficient. DB migrations are additive and native input must not be handed
to an older Runner that ignores its ownership contract.
