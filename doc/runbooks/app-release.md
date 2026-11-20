# Agentic App releases: pack → install → activate

## The one sentence

**A landed App release goes live by itself as soon as the running trusted code
can serve it** (owner decision #61). Trusted (platform) code is still deployed
only by an explicit operator action, and an App reaches users only after
`activate` succeeds.

## When a landed App release goes live

Both development lanes record every affected App release as debt when they
land: `devpipe_submit` and `scripts/ops/land.sh` compute it from `releasePaths`
and `/tickets` shows it beside pending trusted-code tickets.

The deploy service drains that debt automatically whenever no deployment is in
flight (`autoPublishPendingAppReleases`): right after a deployment's startup
health gate passed, and on its 30-second idle poll. Each owed release is
published from the first compatible source:

1. a **complete staged release** — the CI-built Release of a v4 commit, staged
   under `releases/trees/<sha>` (GitLab/remote deployment) — that contains the
   owed commit and whose every change over the deployed commit is an App/View
   release input or neutral evidence (`isAppOnlyPath` in `devpipe/delivery.ts`).
   Its CI-built App artifact is installed and activated without restarting the
   bot;
2. the **deployed run tree**, once it contains the owed commit.

Publication from a source ahead of the deployed commit (a staged release, or
an App-only ticket worktree on the explicit retry) first passes the same
tier-3 knowledge review a deployment does (#522): a computed verdict keeps the
App pending, noted on its ticket, until the conflict is reviewed on
`/knowledge`; a review that cannot run because the knowledge Runner is
unavailable is noted as a warning and does not block. The deployed tree itself
passed its deployment's review and is not reviewed again.

When the owed commit sits on trusted changes that are not deployed yet —
including another landing beneath it — no source qualifies and the App waits
for the next full deployment, whose post-health drain publishes it. No drain
runs during a deployment, so a rollback cannot leave Apps on packages built for
the platform that failed its health gate.

Each drain writes one note per ticket (published Apps, failures and settled
App-only tickets together). Inputs that did not change (deployed commit, staged
releases, owed revisions, knowledge reviews) are not retried; a new release,
landing, deployment, review or restart is. A reviewed repository App that this host does not serve yet is
declared on its first publication; a disabled declaration is never re-enabled.
`app_releases` tickets become `app_live` once every App in their set is live.

"已合入" is still not "已上线": report an App as live only after its activation
succeeded (the ticket note or `/apps` shows the active digest).

## Explicit doors

- **Administrator retry** — `/tickets` → **热发布 App（不重启）**
  (`POST /api/apps/publish-pending`, `Administer`) runs the same drain now.
  Without staged releases it may also pack a submit-verified App-only ticket's
  own built worktree (targeted View build) when nothing between the deployed
  commit and that worktree is trusted code. Ordinary and CLI debt never packs
  from an ahead worktree.
- **CLI agent / operator** — `pnpm app:release` (optionally `-- --app <id>`)
  packs from a chosen tree and installs/activates through the admin API.
- **Manual** — install, activate or roll back on `/apps`. A manual rollback
  stays rolled back: only debt recorded by a reviewed landing is published.
- **Agent approval request** — agents do not need to request publication. If a
  ticket agent still calls `devpipe_app_hotswap` or `devpipe_app_release`, it
  packs and installs an exact digest, writes `app_hotswap_approvals` and stops
  at `approval_required`; a worktree candidate that sits on undeployed trusted
  code is deferred instead. The exact-digest approval expires after 48 hours.
  Approve/reject on `/apps` requires `Administer` and a live browser session;
  approval revalidates the ticket closure, base ancestry, installed candidate,
  active predecessor, contract digest and coexistence verdict before calling
  the ordinary `HostedApp.activate()` sequence.

An `activate` that the platform refuses is the same shape of answer: the
release needs trusted code this process does not have, so it stays pending and
is retried when its inputs change.

## Why it is separate (and not a bug)

An App View is not code the bot imports. It is an immutable release addressed
by a package digest, and the running host serves whichever release the registry
pointer says is **active** (`AppReleaseHost.start()` reads that pointer;
nothing seeds it from the checkout — a host with nothing installed logs
"install one on /apps" and serves the panel without the App).

So the two halves of one merge reach production by different routes:

| What changed | How it reaches users |
|---|---|
| `packages/bot`, `packages/dashboard-web` and other trusted code | `scripts/ops/deploy.sh` |
| Anything under `SESSION_PLUS_VIEW_SOURCE` (the App View bundle) | pack → install → activate |

"Whoever may run a build" and "whoever may change what this host serves" are
deliberately different permissions. That is also why an unrecorded App pointer
stays alone: rolling the trusted process forward may publish only release debt
created by a reviewed landing, not an arbitrary checkout or a previous manual
rollback. A changed permission contract still requires each user to agree again.

## Process budget and hosted-App ceiling

`session_plus.max_hosted_apps` is the process-wide supervisor ceiling. It
defaults to **12**, accepts integers from 1 through 64, and includes the
compiled-in Session Plus App itself. The limit counts registered Apps whether
or not they currently have an active release, because an inactive App still
owns a State child and durable state directory.

An active App normally reaches three child processes after its first backend
call:

| Child | Lifetime | Count per active App |
|---|---|---:|
| App State | App lifetime; survives release changes | 1 |
| App Runtime service | Active release lifetime | 1 |
| SES sandbox | Lazily started and owned by that Runtime | 1 |

Each retained Runtime version may add another Runtime service plus sandbox (2
children). The defaults retain at most one version per App and four across the
whole bot process. Preparing an activation may transiently add one more Runtime
plus sandbox before the pointer moves. Thus a conservative upper estimate is
`3 × max_hosted_apps + 2 × max_retained_runtimes_global + 2` child processes;
with the defaults that is 46. Apps without an active release and sandboxes not
yet invoked consume less. App-agent adapter processes are a separate budget,
bounded by `app_agents.max_concurrent_turns`.

When the hosted-App ceiling is full, the registry chooses a bounded refusal
(`app_backend_capacity`) instead of LRU-parking an active App: silently reaping
an App would invalidate live handles and make an ordinary declaration an
availability action against another App. A runtime declaration is still
recorded durably, but composition stops before adding it to the live release
host or spawning children. Disable another declaration or raise
`max_hosted_apps`, then restart so startup can compose the pending row.

## What happens without anybody asking

| Event | What the pipeline does about App releases |
|---|---|
| Any ticket lands having changed an App's release inputs | Records the debt and names the pending App in the submit answer. |
| A CLI/human branch lands having changed App release inputs | Records the same debt against its generated CLI ticket. |
| A newer Release finishes staging (GitLab/remote deployment) | The next idle poll publishes every owed App that release can serve on the deployed trusted code, without a restart. |
| A **deployment** passes its health gate, or the bot restarts | The automatic drain publishes debt the deployed tree contains and notes the result once per ticket. |
| An administrator chooses **热发布 App（不重启）** | Runs the same drain immediately. A successful App-only ticket becomes `app_live`, not falsely `verified`. |
| A ticket agent calls `devpipe_app_hotswap` or `devpipe_app_release` | Packs and installs the exact candidate(s), creates one idempotent pending approval per App, then ends the turn with `approval_required`. |
| An operator **rolls back** on `/apps` | Nothing. The debt table is empty unless a landing put something in it, so no drain undoes a human's rollback. |

"Release inputs" is a wider question than the app-ticket path allowlist and is
answered by `releasePaths` in `devpipe/app-scopes.ts`: an ordinary ticket may
legitimately edit a shared module package that is compiled into the bundle, and
that is exactly the case ticket #61 was filed about.

## "Iterate the version forward" — what that actually means here

There is **no semantic version to bump**. A release's identity is its
`packageDigest` over the named assets, so it moves by itself the moment any
covered byte moves — you cannot forget to increment it, and you cannot fake it.

What has to move forward is the **installed + activated release pointer**.
Two related versions are NOT that, and must not be bumped for an ordinary
change:

- `octopus:session-plus-release-v7` (the build recipe) moves only when the
  build FORMAT changes — a different builder emitting a different inventory
  from the same tree.
- The permission contract id (`view/permissions.json`) moves only when the
  release asks for something different. When it does, every existing user grant
  stops covering it and each user is asked again — that is the mechanism
  working, not a migration to smooth over.

## Does my change need a republish?

Yes if the diff touches any root or file in
`packages/session-plus-view/src/paths.ts` → `SESSION_PLUS_VIEW_SOURCE`. Today
that is fifteen source trees plus their package manifests and the lockfile
(fourteen bundled, plus the `agent-view-build` recipe):

```
session-plus-view · agent-sessions-view · agent-sessions-contract
agent-workspace-files-view · agent-text-view · agent-editor-view · agent-crdt-view
workspace-files-contract · crdt-doc-contract · typed-port-kit
resource-stream-contract · agent-module-contract · agent-view-react · web-trust
agent-view-build
```

A quick check against the base branch:

```bash
git diff --name-only v4... | grep -E 'packages/(session-plus-view|agent-sessions-view|agent-sessions-contract|agent-workspace-files-view|agent-text-view|agent-editor-view|agent-crdt-view|workspace-files-contract|crdt-doc-contract|typed-port-kit|resource-stream-contract|agent-module-contract|agent-view-react|web-trust|agent-view-build)/'
```

Chess has its own exact closure in `packages/chess-view/src/paths.ts` →
`CHESS_VIEW_SOURCE`:

```
chess-view · agent-data-view · agent-board-view · agent-module-contract
agent-view-react · web-trust · agent-view-build · pnpm-lock.yaml
```

`agent-data-view` is shared with Showcase, while `agent-view-react`,
`agent-module-contract`, `web-trust`, `agent-view-build` and the lockfile are
shared more broadly. A change to one of those shared inputs can therefore owe
multiple App releases; `releasePaths` records that independently for each App.
Publish Chess after landing and deploying with:

```bash
pnpm app:release -- --app chess
```

Daily Brief and Report Space follow the same generic declared-App path. Their
exact closures live in `packages/daily-brief-view/src/paths.ts` and
`packages/report-space-view/src/paths.ts`; both include `agent-data-view`,
`agent-module-contract`, `agent-view-react`, `web-trust`, `agent-view-build`
and the lockfile. Publish them independently:

```bash
pnpm app:release -- --app daily-brief
pnpm app:release -- --app report-space
```

Meeting Room and Expense Intake also use that path. Their exact closures add
the reusable `agent-schedule-view` and `agent-intake-view` packages respectively:

```bash
pnpm app:release -- --app meeting-room
pnpm app:release -- --app expense-intake
```

## The procedure, by hand

Only needed when the two entry points above cannot run (a host with no dev
pipeline, a release built somewhere else, or an operator who wants to inspect
the bundle before it is served).

1. **Deploy first.** The release you publish should be built from the tree that
   is running, or the frame and the process disagree about what the code is.

   ```bash
   git -C /home/ubuntu/lht/octopus-run log --oneline -1   # is the target commit live?
   ```

2. **Pack** in that checkout. The packer recomputes the View source digest and
   **refuses a stale `dist/`**, so it must run in a tree that has been built at
   this commit — which the deploy already did.

   ```bash
   cd /home/ubuntu/lht/octopus-run
   pnpm run app:pack -- --out /tmp/session-plus-$(git rev-parse --short HEAD).json
   ```

   Packing writes bytes and nothing else: no database row, no server contacted,
   nothing republished.

3. **Install and activate** — two decisions, both admin-only:

   - Panel: `/apps` → upload the bundle → 安装 → 激活.
   - Or in one command with an admin `dt_` key:

     ```bash
     pnpm run app:pack -- --out /tmp/session-plus.json \
       --publish https://bot.example.org --token dt_xxx --activate
     ```

   Installing adds an immutable release and changes nothing about what is
   served. Activating moves the pointer, after the host re-derives every digest
   from the bytes and runs inspect → prepare → origin → runtime-health.

4. **Verify.** On `/apps` the line "本机 checkout 会构建出 `<digest>`…" must say
   **已安装**, and that digest must be the active row. Then open
   `/sessions-plus`: current ESM Apps request `view/entry.json` and assets under
   `/ui/apps/<packageDigest>/`; inspect that digest and the mounted App surface.
   Installed legacy IIFE releases still use a digest-derived frame URL.

## Rollback

Activate the previous release on `/apps`. It is still installed (releases are
immutable and never replaced), and a failed activation leaves the previous one
serving — the pointer only moves after the new release prepares successfully.
