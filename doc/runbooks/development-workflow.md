# Development branches and worktrees

## Local development and GitLab integration

The new workflow keeps native CLI execution in its local repository/worktree.
On 4090, the reference clone is `/home/ubuntu/lht/repos/octopus` and feature
trees live under `/home/ubuntu/lht/worktrees/octopus`. The application stays on
the separate Aliyun service device; local loopback is not the production site.

After the explicit authority activation, GitLab `v4` is the code authority;
local CLI and web ticket agents share its durable integration lease. Read
[GitLab development and cutover](gitlab-development.md) for commands, native
registration, emergency recovery, release publication and deployment pinning.
Development is complete at successful landing, with production debt visible.
Deployment follows `AGENTS.md` ("Deployment is explicit").

Before activation, use the existing Head landing adapter for the one bootstrap
landing. The following Head/workspace procedures describe that legacy mode and
the managed ticket adapter retained after cutover. They do not authorize a
second mainline writer. In GitLab mode, every mention of the authoritative Head
watermark below means its verified cache of GitLab, and its local merge mutex
is subordinate to the global fenced lease.

## Legacy Head mode and managed workspace adapter

The Head service owns the authoritative Git repository and landing lock at
`ssh octopus-service:/home/ubuntu/lht/octopus`. The `aws-env` copy at
`/home/ubuntu/lht/octopus` is a read-only reference mirror, kept at the exact
Head `v4` SHA by `/home/ubuntu/.local/bin/octopus-reference-sync`. Read-only
analysis uses that mirror after a successful sync; real edits always use a
feature worktree on the Head or the assigned Runner child workspace.

Every change starts from the Head watermark in its own worktree and returns
through one serialized fast-forward landing path. For a development request,
“done” normally means the verified branch has landed and the development
backend shows its trusted-code ticket as pending. Affected App releases go live
automatically once the deployed trusted code can serve them
(`doc/runbooks/app-release.md`); trusted-code production changes follow
`AGENTS.md` ("Deployment is explicit").

## Directory roles

| Path | Role | Allowed writers |
|---|---|---|
| Head `/home/ubuntu/lht/octopus` | Authoritative source and landing worktree, checked out on `v4` | Landing pipeline only |
| aws-env `/home/ubuntu/lht/octopus` | Read-only reference mirror of Head `v4` | `octopus-reference-sync` fast-forward only |
| `/home/ubuntu/lht/octopus-worktrees/<branch>` on Head | Human feature trees and Head-local ticket trees | Their assigned owner |
| Head ticket worktree for a managed Runner ticket | Verified candidate staging, retaining the ticket's Head branch | Pipeline candidate importer and landing |
| Registered Runner parent → `.octopus-development/<site/repository scope>/` | Per-Head source mirror and persistent child worktrees | Runner development manager; agent edits its own child tree |
| `/home/ubuntu/lht/octopus-worktrees/_base-*` | Fallback holder for watermarks without a primary worktree | Landing/CI pipeline |
| Head `/home/ubuntu/lht/octopus-run` | Detached deployed tree | Supervisor only |
| Head `/home/ubuntu/lht/octopus-dev` | Database, config, logs, bundles | Runtime services only |
| aws-env `/home/ubuntu/lht/octopus-run-backup-*` and `octopus-dev-backup-*` | Renamed historical copies; recovery evidence | Nobody during normal work |

The Head worktree is “read-only” to humans and agents: it must be clean, direct
commits are forbidden, and the landing pipeline is its only writer. The aws-env
mirror is also read-only; its sync job refuses tracked changes, unknown
untracked files, rewinds, or divergent history. A successful Head landing is
then copied to the mirror by an explicit fast-forward sync.

## Start human/CLI work on the Head

For read-only analysis in aws-env:

```bash
/home/ubuntu/.local/bin/octopus-reference-sync
git -C /home/ubuntu/lht/octopus rev-parse v4
```

The command fetches `v4` from `ssh://octopus-service/home/ubuntu/lht/octopus`
and fast-forwards only when the mirror is clean and its history is an ancestor
of the Head. It never pulls from public `origin`, rewinds, creates merge commits,
or pushes anything. A non-zero result means the analysis must stop and report
the mirror state.

For a human/CLI change, create the worktree on the Head service:

```bash
ssh octopus-service 'cd /home/ubuntu/lht/octopus && scripts/ops/worktree.sh dev/<owner>-<topic>'
```

The helper creates `/home/ubuntu/lht/octopus-worktrees/dev-<owner>-<topic>`
where it is invoked, from that checkout's `v4`, and normally runs frozen,
prefer-offline installation plus the required workspace builds. A source-only
or control setup can set `OCTOPUS_COMPUTE_ROLE=control OCTOPUS_SOURCE_ONLY=1`.
The worktree location is not implicitly 4090; execution and heavy build targets
come from the managed Runner binding described below. Never share another
tree's `node_modules` or `dist`.

## Managed Runner development tickets

When Runner development is composed, a new ticket without an existing session
or operation first prepares a source copy at an exact Head SHA. The authenticated
Head site and repository identity separate mirrors; each persistent development
identity gets its own Git worktree and registered child workspace under the
already authorized parent. The binding records owner, execution device, parent,
repository, development identity and child workspace. It is not inferred from an
agent-supplied path, and a later turn cannot silently replace it.

The child workspace is the native tool and attachment target. Model execution may
run on a different Runner; that placement does not change where shell/file tools
operate. Source preparation performs Git and workspace registration, not dependency
installation or tests. Install dependencies and run bounded checks on the designated
execution provider. Do not use agent SSH to edit the Head or share build outputs
between independent worktrees.

The agent receives `octopus_devpipe` through the Runner's private MCP configuration.
The normal devpipe tools operate on the server-owned ticket and current turn;
arguments cannot select another ticket, owner or credential. Each new turn receives
a renewed scope. Head restart invalidates old development scopes, while trusted
reattachment can issue fresh credentials for the same persisted operation and
binding. A lost response remains an unknown original operation, not permission to
send the input or submit again.

Different ticket worktrees can progress concurrently within `specConcurrency`.
Each development tree serializes its prepare/sync/export operations. All candidate
imports and landings still use the Head's existing Git lock, and `v4` has one
fast-forward writer. There is no per-Runner route around that lock.

Before context, CI synchronization or submission uses the Head candidate, the
pipeline imports the Runner's clean committed result. The Runner exports an immutable
candidate tied to the development identity, required base, exact HEAD and bundle
digest. The Head checks the receipt, chunk identity/length/EOF, whole digest, bundle
heads and base ancestry before updating its clean candidate tree. It neither edits
nor rebases the Runner's working tree.

If submit returns `base_moved`, keep the original tree and changes. Call
`devpipe_workspace_sync` to update `refs/remotes/octopus/head` in the Runner mirror;
this leaves the working tree untouched. In that same child workspace, run
`git rebase refs/remotes/octopus/head`, resolve any conflicts, review the intervening
changes and repeat the required checks before submitting. The Head rechecks the
required base and exact candidate; it never resolves stale-base conflicts by
rewriting the Runner's commits.

Tickets with an existing session or operation retain their old placement, SID,
worktree and history. They do not acquire a new development tree merely because
the service was upgraded. Existing managed tickets reuse their persisted child
workspace. An incompatible old binding is an explicit recovery issue; it must not
be repaired by silently moving the session, replacing the tree or replaying an
unknown input.

## Definition of done and the deployment trigger

The delivery owner carries one verified change through the normal development
lifecycle:

1. Commit it on its feature/ticket branch with the required tests and delivery
   records.
2. Land it through `devpipe_submit` or `scripts/ops/land.sh`; a CLI branch adds
   the one required `doc/cli-reports/` report first.
3. Confirm the generated/existing ticket is `landed/pending` and every App whose
   release inputs changed appears in `/tickets` as pending or already
   published (App-only changes go live automatically once staged).
4. Report the landing and the production work now waiting. Do not call an App
   live until its activation succeeded.
5. If anything is still owed to the requester — a half you decided not to build,
   an assumption you made for them, a "this should be its own ticket" — say so
   with `open_question` on `devpipe_submit`, or with `devpipe_ask` on a turn that
   lands nothing. Without it the board shows the ticket as finished (landed rows
   read as "waiting for deploy"), and the sentence stays inside a transcript the
   requester has no reason to reopen. Any message from the requester clears it.

This land-first default applies to ticket agents and work started directly from
a terminal/CLI. When deployment is authorized as defined in `AGENTS.md`
("Deployment is explicit"), the same owner continues without asking again:

1. Run `scripts/ops/deploy.sh` (or the one deploy button), require the startup
   health gate to succeed, and verify `/home/ubuntu/lht/octopus-run` is at the
   intended `v4` SHA.
2. Let the automatic App drain publish the pending App releases that deployed
   checkout contains; verify each intended digest is installed and active.
3. Report the actual trusted-code and App outcomes, including any concrete gate
   that stopped the sequence.

The stages remain independently guarded; the explicit request changes how far
the owner proceeds, not what any gate permits. A scan or unrelated stale branch
is not authority to land it; audit that work separately.

## Develop and land from a Head worktree

```bash
cd /home/ubuntu/lht/octopus-worktrees/dev-<owner>-<topic>
git status --short --branch
# edit, run targeted tests, then commit
scripts/ops/land.sh
```

Before the final commit, add one bounded CLI delivery report under
`doc/cli-reports/`; its format and field meanings are in
`doc/cli-reports/README.md`. The final commit must introduce that file, so the
reported checks and acceptance criteria are anchored to the exact SHA being
landed. `land.sh` performs a cheap local check and the server repeats the
validation before its gate. A successful landing returns the generated ticket
id; the row starts at `landed/pending` and follows the same deploy, rollback and
production-acceptance states as managed tickets.

This report is only for the CLI/human lane. A ticket agent uses
`devpipe_submit`; its existing ticket is the durable report and the protected
path check refuses changes under `doc/cli-reports/`.

For human/CLI Head worktrees, landing owns the merge lock, rebases the feature
branch onto the newest local `v4`, and advances `v4` with `merge --ff-only`. If the primary reference tree
holds `v4`, the pipeline reuses it; otherwise it creates a branch-specific
`_base-v4-*` holder.

Historical Head-local ticket agents validate before taking that lock. If
`devpipe_submit` discovers that another ticket landed after the candidate was validated, it rebases the
feature branch, returns `base_changed_review` plus the landed-ticket summaries,
and does not advance `v4`. The same live agent turn keeps the merge lock while
it reviews the concurrent work, synchronizes the rebased HEAD to its isolated
CI workspace, recompiles and reruns related small tests, then submits again with
the same token. This prevents another landing from invalidating that review and
forcing repeated rebases. The hold is bounded by the turn: ending, cancelling,
or losing the turn releases the lock automatically, while conflicts and failed
gates retain their existing explicit release paths.

Before the fast-forward, both landing doors (web `/api/land` and
`devpipe_submit`) run the thin pre-land gate: `pnpm install --frozen-lockfile`
plus incremental `tsc --noEmit` for `packages/bot`, executed by the pipeline in
the `_land` staging worktree at the exact candidate sha (~30–60 s warm).
Typecheck only — no vitest; the batched post-submit CI remains the complete
verdict. A refusal moves no ref and returns the tsc/pnpm tail. Escape hatches:
`selfhosting.land_gate: false` disables it, `OPS_LAND_LOCAL=1` (the land.sh
fallback for broken deployed machinery) bypasses it by construction, and a
timeout (8 min) refuses rather than passes.

After the fast-forward, with the merge lock already released, the pipeline
warms the shared build cache for the landed sha in a second staging worktree,
`_warm` (`packages/bot/src/devpipe/build-warm.ts`). Nothing waits on it: it
exists so the next deployment restores build outputs instead of rebuilding
them while the requester watches. A failure only means that deploy builds
normally; `selfhosting.build_warm: false` turns it off.

The landing operation itself does not deploy. Stop at the landed watermark by
default. When deployment is authorized (`AGENTS.md`, "Deployment is explicit"),
continue immediately with `doc/runbooks/deployment.md` rather than handing off
and asking for another confirmation.

## Local versus remote authority

The Head service is the sole source of truth for `v4`, development rules,
landing, and deployment. The aws-env checkout is a read-only mirror so local
Codex turns can inspect the same code and `AGENTS.md` without treating a stale
or similarly named directory as the service. The mirror is maintained by
`scripts/ops/reference-sync.sh` and its aws-env wrapper
`/home/ubuntu/.local/bin/octopus-reference-sync`.

The sync procedure is deliberately one-way and fail-closed:

1. Take an exclusive lock and require branch `v4` with no staged or tracked
   changes. The only tolerated untracked paths are conversation attachment
   directories named `.octopus-attachment-*`.
2. Fetch only `refs/heads/v4` from `ssh://octopus-service/home/ubuntu/lht/octopus`
   into `refs/remotes/authoritative/v4`.
3. Return success when the SHAs match, fast-forward local `v4` when it is an
   ancestor of the authoritative ref, and refuse when the mirror is ahead,
   rewound, or divergent. Refusals preserve both histories for manual review.
4. Record the outcome in `/home/ubuntu/.cache/octopus-reference-sync/sync.log`.

A user systemd timer runs this check every two minutes on aws-env. It is a
convenience for freshness, not a write path to Head. If the timer reports an
error, use the Head over SSH for authoritative inspection and repair the
mirror before analysis resumes. Never run `git pull`, merge public `origin`,
or reset the mirror as an automatic recovery.

Runner placement is separate from source authority. In the current service
configuration, the `lht` managed-ticket tool target is `aws-workbench`, while
post-submit CI is bound to `octopus-ali-4090-ci`; deployment builds
use `gpu-box`, and knowledge indexing uses `octopus-ali-4090-knowledge`.
Check the ticket's actual tool/workspace binding before editing. Heavy manual
checks use the authorized 4090 workspace; the CI target does not automatically
relocate a CLI shell or source worktree.
The `worktree.sh` helper itself always creates the tree on the checkout where
it runs and has no default 4090 placement.

For visibility into a public backup mirror, fetch it explicitly and compare
only; it is not a source of authority:

```bash
git -C /home/ubuntu/lht/octopus fetch origin
git -C /home/ubuntu/lht/octopus rev-list --left-right --count v4...origin/v4
```

The expected aws-env invariant is branch `v4`, a clean tracked worktree, and a
HEAD equal to `refs/remotes/authoritative/v4`. Attachment directories may remain
untracked and must be preserved.

## Reference mirror installation and consistency

Only enroll the aws-env reference checkout, never the authoritative Head:

```bash
git -C /home/ubuntu/lht/octopus config --local octopus.referenceMirror true
git -C /home/ubuntu/lht/octopus config --local octopus.referenceSource ssh://octopus-service/home/ubuntu/lht/octopus
```

The wrapper executes the tracked `scripts/ops/reference-sync.sh` from that
checkout. The user unit `octopus-reference-sync.service` runs it with a
120-second timeout; `octopus-reference-sync.timer` uses `OnBootSec=30s`,
`OnUnitActiveSec=2min`, and `AccuracySec=1s`. Inspect them with
`systemctl --user cat octopus-reference-sync.service octopus-reference-sync.timer`.
Check freshness using the command's exit code and
`/home/ubuntu/.cache/octopus-reference-sync/last-success`; failures are in
`/home/ubuntu/.cache/octopus-reference-sync/sync.log` and the user journal.
Disable the timer with `systemctl --user disable --now octopus-reference-sync.timer`.

A two-minute timer provides eventual freshness, not a zero-lag snapshot.
Run the sync before each analysis task and re-read the updated `AGENTS.md` and
relevant module rules. Existing sessions do not hot-reload those rules. Record
the SHA used for conclusions; for a long analysis that needs a consistent
snapshot, read with `git show <recorded-sha>:<path>` or verify the SHA did not
change before reporting.

One-time migration of a divergent old aws-env checkout must preserve its old
`v4` as a backup branch before switching to a new `v4` at Head. Do not discard
tracked edits or untracked attachments. The recurring sync never performs this
migration. Historical feature worktrees remain recoverable and are not new
development bases.

## Retire a feature worktree

The commands below are for human/CLI Head worktrees. A managed Runner child
workspace is part of the ticket's persisted placement; do not manually delete or
recreate it to recover a failed turn.

Only remove a human feature worktree after its branch is an ancestor of `v4`
and the tree is clean:

```bash
git -C /home/ubuntu/lht/octopus merge-base --is-ancestor <branch> v4
git -C /home/ubuntu/lht/octopus-worktrees/<branch> status --short
git -C /home/ubuntu/lht/octopus worktree remove \
  /home/ubuntu/lht/octopus-worktrees/<branch>
git -C /home/ubuntu/lht/octopus branch -d <branch>
```

Do not delete unmerged or dirty worktrees. A cancelled ticket may still contain
recoverable work and must be audited separately.

## Primary worktree invariant

For the Head service, check it with:

```bash
git -C /home/ubuntu/lht/octopus branch --show-current
git -C /home/ubuntu/lht/octopus status --short
git -C /home/ubuntu/lht/octopus rev-parse HEAD
git -C /home/ubuntu/lht/octopus rev-parse v4
```

Expected: branch `v4`, empty status, and identical SHAs. If it is dirty, stop;
the pipeline will also refuse to move `v4` until the changes are recovered into
a feature branch or deliberately removed by their owner.
