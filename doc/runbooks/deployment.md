# Deployment and rollback

控制节点启用远端发布模式时，完整依赖与构建输出由 Runner 生成，采用准备新目录后切换的发布流程。配置、迁移及故障检查见 [远端完整发布包](remote-release.md)；下文的本机构建描述只适用于未启用该模式的既有安装。

GitLab 模式使用 [本地开发与发布流程](gitlab-development.md)：先检查更新，准备完成后上线检查所得的精确 SHA 和 manifest hash。下文的 Head 构建描述只适用于 legacy 模式；GitLab 模式不在应用主机触发构建。

## Normal path

Landing changes `v4`; deployment is a separate guarded action. For a
development task, the default handoff is the landed `v4` watermark with its
ticket visible as pending in `/tickets`. Affected App releases are recorded
there too and go live automatically once the deployed trusted code can serve
them (`doc/runbooks/app-release.md`). Do not deploy merely because development
finished.

Whether the task owner continues to production is defined in one place,
`AGENTS.md` ("Deployment is explicit"); this runbook is the procedure once it
applies, without asking again. If trusted code is pending under an authorized
request, run this full deployment path; once its health gate passed, the
automatic App drain publishes every recorded release the new checkout contains.
App-only debt needs no deployment: it goes live from its staged release, and
`/tickets` offers the administrator hot publication as an immediate retry. See
`doc/runbooks/app-release.md`.

Triggering runs the tier-3 knowledge review (#522) on the exact target. A
computed verdict refuses the deployment until the conflict is reviewed on
`/knowledge`. If the review cannot run (knowledge Runner unavailable), the
deployment proceeds and the intent carries the warning, shown in `/tickets`
and printed by `scripts/ops/deploy.sh`.

```bash
scripts/ops/status.sh
scripts/ops/deploy.sh
scripts/ops/status.sh
git -C /home/ubuntu/lht/octopus-run rev-parse HEAD
```

Deployment attribution is recorded at `POST /api/deploy`. Browser-session
requests display the authenticated user and “网页手动更新”; bearer calls without
metadata display the authenticated user (or unnamed admin key) and CLI/API.
Callers that know their Agent context may add `source` to the existing JSON body:

```json
{"source":{"kind":"ticket_agent","ticket_id":523}}
```

or `{"source":{"kind":"cli_agent","agent":"Codex","device":"laptop","session":"session-label"}}`.
These fields are explicitly caller-reported display metadata, never authorization.
Ticket references must belong to the caller unless it is an administrator; titles
and models come from the stored ticket. CLI labels are limited to 120 characters
and must not contain secrets or command lines. Older `scripts/ops/deploy.sh` calls
remain supported and show CLI/API with Agent information unavailable. Metadata is
returned only by authenticated APIs, not the public startup-status projection.

The supervisor deploys into `/home/ubuntu/lht/octopus-run`, a detached worktree.
It backs up the database, checks out the requested SHA, installs and builds
before touching the old process, drains in-flight work, starts the new process,
and waits for the startup health gate. Passing the gate completes deployment
immediately; there is no manual confirmation window.

The default startup gate allows 240 seconds after process launch. The CLI
observer allows 30 minutes for the complete build, drain, lease retry and
startup sequence; its deadline does not change the supervisor's state machine.

That build is normally short, because it is mostly cache restores. Each
package's build runs through `tools/build-cache`, which keys byte-exact
outputs on the package's content plus its workspace dependencies, the
lockfile, the root manifests and the Node version; and every landing schedules
a warm build of the landed SHA in the `_warm` worktree
(`packages/bot/src/devpipe/build-warm.ts`), so the cache is usually already
populated before anyone deploys. Both are pure latency optimisations: the
deployed content still comes only from Git, and with `OCTO_BUILD_CACHE=0` or
`selfhosting.build_warm: false` the deploy simply builds everything as it did
before. Deploy logs show `[build-cache] 命中 …` per restored package;
`devpipe_status` reports whether the latest landed SHA is warm.

Before changing the checkout, the supervisor retains the current verified
release's build outputs under `/home/ubuntu/lht/octopus-dev/releases`. It keeps
the five most recent packages, each keyed by its full Git SHA and protected by
a SHA-256 checksum. Source remains in Git and dependencies are restored from
that release's lockfile.

If the new process cannot pass the startup health gate, the supervisor
automatically checks out the previous verified SHA, restores its retained build
package, and gates that process. It does not rebuild the previous release. If
the retained package itself cannot be restored, the supervisor stops and
requires SSH intervention rather than trying progressively older source.

Build or checkout failures happen before the old process is stopped. The
supervisor restores the previous checkout/package on disk and reports failure,
while the old process continues serving.

Successful requested deployment requires the final status to show the deployed
SHA at the intended `v4` watermark. After the new process starts and the
supervisor health gate passes, deploy finalization activates recorded
Runner-bundle debt whose commit is contained by that exact deployed checkout,
then the automatic App drain publishes recorded App-release debt (never while a
deployment is in flight). These independent drains have no ordering
dependency. Runner activation reuses the content-addressed
registry's protocol, syntax, digest and atomic pointer health gates. A failed
Runner activation leaves its ticket pending and visible with the last error;
that ticket is excluded from the product-acceptance checklist and cannot be
verified until the debt clears. Verify the Runner and App pending lists cleared
and each intended digest is active; a healthy trusted-code deploy alone does
not prove either independent artifact is live.

## Restart without a deployment intent

The public Dashboard can retain a loading page while Bot has no listener.
Install the edge-owned fallback once, before the first covered restart, using
[`ops/caddy/README.md`](../../ops/caddy/README.md). Its review-only
`python3 ops/caddy/install-status.py` does not affect production; its `--apply`
requires production authorization and installs both the independent observer
and the loading page before Bot is stopped. The page is served by Caddy from retained
static assets, so drain, cold start and rollback do not depend on Bot serving
its own outage message. API failures remain failures; only the public deployment
projection and credential-free readiness probe are automatically repeated.
When `dashboard.public_url` is configured, deployment and product acceptance
check these edge assets against the exact Git version. The `/tickets` panel
keeps missing, stale or mismatched ingress visible as a separate obligation.
Reinstall from the landed target before deploying a change to these assets.
HTTP readiness alone never confirms an upgrade: the loading page waits for the
supervisor's result and displays rollback explicitly.

```bash
scripts/dev-restart.sh
```

This is the only supported direct restart path. It builds while the old bot is
running, performs a SIGTERM drain, waits for the old PID to exit, starts one new
process, and waits for the ready line. Do not replace it with `kill`, `pkill`,
or a manually started `tsx` process.

## Operational ownership

- Do not edit or switch branches in `/home/ubuntu/lht/octopus-run`.
- Do not modify `bot.db` to emulate deploy or ticket actions; use
  `scripts/ops/*.sh`, which call the same API as the dashboard.
- Changing `selfhosting.repo_dir`, `worktrees_dir`, `run_dir`, watermark names,
  or supervisor paths is an operational migration. Update code/config/runbooks
  together and deploy before removing any compatibility worktree.
- **Deploying trusted code never republishes an unrecorded Agentic App.** The
  host serves whichever App release the registry pointer says is active, and the
  checkout alone does not move it. Only publications that both landing lanes
  recorded as owed are drained, automatically, when the running trusted code
  can serve them and no deployment is in flight. An agent tool
  (`devpipe_app_hotswap` or compatible `devpipe_app_release`) only installs an
  exact candidate and creates a pending approval that a Dashboard administrator
  consumes. The CLI (`pnpm app:release`) and direct `/apps` operator actions
  remain explicit, and a manual rollback on `/apps` stays rolled back. See
  `doc/runbooks/app-release.md`. Production deployment also never implies
  permission-contract activation for an App.
- **Landing Runner code never moves the Runner active pointer.** A landing that
  changes the standalone bundle's inputs records per-ticket debt. Only a later
  deployed checkout containing that commit may settle it automatically; ahead
  commits remain pending. Gateway self-update, installer downloads and direct
  downloads continue to share the same active digest. Explicit
  `runner-bundle activate/rollback` remains an operator recovery door, not a
  substitute for clearing the ticket delivery state through the normal deploy.

Design details and failure reasoning are in `doc/design-lifecycle-persistence.md`
and `doc/design-self-hosting.md`.
