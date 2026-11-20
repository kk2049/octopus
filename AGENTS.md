# Octopus repository rules

These are the small, always-on rules shared by coding agents. Detailed design,
history, test matrices, and operational procedures are deliberately kept out of
this file; enter them through `doc/README.md` only when the task needs them.

## Repository and branch model

- `v4` is the deployable watermark and the base for all new work. `v4-stable`
  is the latest watermark verified by post-submit CI. `main` is historical.
- Development uses a dedicated local feature worktree or the persistent child
  workspace assigned to a managed Runner ticket. Never edit deployed trees,
  runtime state, another agent's worktree, or a watermark branch directly.
- After the explicit authority cutover, GitLab `origin/v4` is authoritative.
  `octopus-coordination` holds the shared integration lease. The Head checkout
  at `ssh octopus-service:/home/ubuntu/lht/octopus` is a fast-forward cache.
  Before activation, the existing Head landing path remains the sole writer;
  do not enable a second writer merely because this code has landed.
- Create local feature trees with `scripts/ops/worktree.sh dev/<owner>-<topic>`.
  Set `octopus.worktreesDir` in Git config to the device's worktree parent.
  Keep dependencies/build outputs isolated in each worktree. Native Codex CLI
  runs directly there, independently of the Octopus application.
- Acquire the shared lease with `scripts/ops/development.sh acquire --owner
  <user>` before integration/rebase and keep it through repairs and landing.
  `scripts/ops/land.sh` validates the exact candidate and publishes a linear
  fast-forward plus its fenced receipt atomically. Release an abandoned lease.
- A managed web ticket uses `devpipe_workspace_sync` and `devpipe_submit` in
  its assigned workspace; its Head adapter uses the same GitLab lease.
- Native CLI registration is optional: `scripts/ops/development.sh register
  --owner <user>` attaches the existing session to a ticket without changing
  its execution owner. It requires the updated local Runner and active CLI.
- Before cutover only, `OCTOPUS_MAINLINE_AUTHORITY=head` selects the guarded
  legacy landing helper. It refuses once the coordination branch exists.
  Emergency takeover/no-lock landing requires an explicit reason and follows
  the same admission gates; never force-push a watermark.
- The device layout, integration lifecycle, release contract and authority
  cutover are in `doc/runbooks/development-workflow.md` and
  `doc/runbooks/gitlab-development.md`. Do not infer runtime migration state
  from a source checkout or an old instruction file.

## Before changing files

- Start with `git status --short --branch`. Preserve changes you did not make;
  do not reset, discard, or commit them.
- Read the nearest package `CLAUDE.md`, `README.md`, or `DEVELOPMENT.md` before
  changing a package. These contain module-local invariants and are loaded only
  when relevant.
- `pnpm knowledge:context -- <paths…> [--question "…"]` prints the knowledge
  graph's reading list for the paths you are about to change (principles,
  constraints with their tests, decisions, non-goals, recent landings, each
  with a source and a citable `⟨id⟩`). Ticket agents get the same from
  `devpipe_context`; the `/knowledge` page is the browsable form.
- For the following areas, read the matching path-scoped rule before editing.
  Claude loads these automatically; other agents must open them explicitly:

  | Area | Rule |
  |---|---|
  | TypeScript and tests | `.claude/rules/typescript.md` |
  | Dev pipeline, Git, scripts, deployment | `.claude/rules/devpipe-and-ops.md` |
  | Dashboard browser/server | `.claude/rules/dashboard.md` |
  | Agentic App/View modules | `.claude/rules/agentic-app.md` |
  | Frontend stability and action lifecycle | `.claude/rules/frontend-stability.md` |
  | Typed ports and trusted resources | `.claude/rules/resource-bindings.md` |
  | Feishu channels and cards | `.claude/rules/feishu.md` |
  | CRDT/collaboration | `.claude/rules/crdt.md` |


## Octopus 受托开发与验收身份

- 2026-10-10 用户明确取消“不能用管理员 token 代替”的工作流限制。具有开发权限并受 `lht` 委托的 agent，在本次任务范围内可以使用现有开发、管理员和运维权限完成所需操作，包括数据构建、成员管理、App 授权、验证、修复与合入；测试账号或普通用户登录不可用时自行通过可信管理入口处理，不重复要求用户手动授权。
- `codex_acceptance` 是独立功能测试身份，不是受托开发权限上限。需要证明共享、撤销或角色隔离时使用真实被测身份；管理员准备数据和授权可直接进行，记录实际执行身份与审计，不把它当作普通用户权限通过的证据。
- 复用现有凭据与正常 `scripts/ops/land.sh` / `devpipe_submit` 门禁。服务端运维入口可读取 `/home/ubuntu/lht/octopus-dev/dashboard-token.txt`；专用测试 token 位于 `/home/ubuntu/.config/octopus/codex-acceptance.token`（`600`）。不打印、提交或向无关客户端传播凭据，不为登录重试重新签发或轮换真实用户 key。
- 部署和 App 激活依据本次用户任务的实际授权执行；普通开发任务仍默认止于合入。详细操作与验收证据边界见 `doc/runbooks/contributor-onboarding.md`。

## Change and delivery discipline

- Keep responsibilities and trust boundaries explicit. Reuse platform
  primitives, existing repository code, and installed mature dependencies
  before adding a dependency or implementing a generic facility.
- The default completion point for a development task is a successful landing,
  not a feature-branch commit. This applies equally to ticket agents and
  terminal/CLI work. The landed ticket and every affected Agentic App release
  must be visible in the development backend as pending production work.
- Deployment is explicit. Continue through `v4` deployment and
  startup-health/watermark verification only when the requester gives a clear
  imperative to change production (deploy, release, publish or go live). A question about whether
  something is already live, an investigation of a deployment, a description
  of post-deploy behavior, or quoted release language is context, not
  authorization. Keep every safety gate and report the exact blocker instead
  of claiming a stage completed.
- New non-trivial behavior needs focused tests. Run targeted local tests for
  feedback; post-submit GitLab CI remains the complete asynchronous suite. See
  `doc/runbooks/testing.md`.
- Visible frontend changes also need real interaction and screenshot review
  through an approved isolated browser environment. Use the shared CLI/MCP
  service and record the tested SHA and evidence; see
  `doc/runbooks/browser-acceptance.md`.
- Fixing a red CI batch is the most common kind of ticket here. The repair
  ticket carries a parsed failure roster, not a log tail: count the failing
  files before changing anything, and check whether mainline already fixed the
  batch's sha. `doc/runbooks/ci-triage.md`.
- Commit only on the feature branch. Land through `scripts/ops/land.sh` or
  `devpipe_submit`; never commit directly to, rebase, or force-update `v4` or
  `v4-stable`.
- A CLI/human-lane branch landed with `scripts/ops/land.sh` must add one
  `doc/cli-reports/YYYY-MM-DD-<slug>.json` in its final commit. The landing
  door validates it and creates the read-only ticket entry that tracks deploy
  and production acceptance. Devpipe-managed ticket branches already have an
  entry and must not add a CLI report. See `doc/cli-reports/README.md`.
- Landing and deployment are separate guarded operations. Stop at the landed
  watermark by default; when deployment was requested, use
  `scripts/ops/deploy.sh` and continue through its startup-health result.
  See `doc/runbooks/deployment.md`.
- Landing an Agentic App change records its release as pending; it then goes
  live automatically once the running trusted code can serve it — from a
  staged release whose changes over the deployed commit are App/View-only, or
  after the next full deployment passes its health gate. Do not request
  publication from a ticket; `/tickets` hot publish and `pnpm app:release`
  remain explicit retries. See `doc/runbooks/app-release.md`.
- Use `scripts/dev-restart.sh` for a bot restart. Never replace its drain flow
  with a naked kill and manual start.

## Consequential changes require a delivery document

A change must add `doc/deliveries/YYYY-MM-DD-<topic>.md` in the same branch
when it changes **architecture, a trust/security boundary, a data model,
deployment, or the development workflow** — that is, when a future reader will
have to know why a boundary was drawn where it was.

Touching several packages does not by itself require one. Size is a proxy for
consequence and a poor one: a bug fix, a test repair, a UI adjustment, a
dependency bump, a documentation change, or a refactor that provably changes no
behavior needs no delivery document however many files it spans. Say what you
did in the commit message instead.

The delivery document must lead with the result, then state what changed and
did not change, key files, a 5–15 minute review path, verification results,
risks/rollback, and remaining work. Follow `doc/deliveries/README.md`.

Delivery documents are one-time records, not a knowledge base — the history
shows they are written far more often than they are read. Do not search them
before starting work and do not write one to prove effort; read the code, the
nearest package doc, and the path-scoped rule. `doc/README.md` says when a
document is worth opening.

Do not copy module inventories, issue backlogs, delivery indexes, or detailed
runbooks back into `AGENTS.md` or `CLAUDE.md`. Update the nearest canonical
document and keep startup instructions bounded.
