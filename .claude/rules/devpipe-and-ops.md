---
paths:
  - "packages/bot/src/devpipe/**/*"
  - "packages/bot/src/bootstrap-v3.ts"
  - "packages/bot/src/config.ts"
  - "scripts/**/*"
  - "ops/**/*"
  - ".gitlab-ci.yml"
  - "config.yaml.example"
---

# Dev pipeline, Git, and operations

- Read `doc/runbooks/development-workflow.md` before changing branch or
  worktree behavior and `doc/design-self-hosting.md` before changing trust or
  concurrency semantics.
- `v4` advances through one fenced integration lease and a fast-forward. Never add a
  second branch writer or use `git branch -f` as a normal path.
- The primary worktree may hold `v4`; reuse an existing clean branch holder.
  Refuse a dirty holder rather than hiding or overwriting its changes.
- Human/CLI feature worktrees use `scripts/ops/worktree.sh`; it materialises
  branch-local pnpm workspace links and required test outputs. Never symlink
  `node_modules` or copy `dist` from a different worktree.
- Worktrees are working directories, not security sandboxes. Dev agents share
  the bot OS account; authorization and protected-path checks remain separate.
- After explicit activation, GitLab `origin/v4` and its coordination ref own
  mainline and the integration lease; the Head only fast-forwards its cache.
  Before cutover, the legacy Head remains the sole writer. Follow
  `doc/runbooks/gitlab-development.md`; never run both writers.
- Landing does not itself deploy and is the default completion point for a
  development task, including the terminal/CLI lane. It must leave trusted-code
  and App-release debt visible in the development backend. When to continue to
  deployment is defined only in `AGENTS.md` ("Deployment is explicit"); the
  procedure is `doc/runbooks/deployment.md`.
- Protect per-turn credentials inside the ticket worktree, mode 0600, and
  delete them after the turn. Never place them in the shared worktree parent.
- GitLab CI is post-submit and batched. Infrastructure failures are not test
  failures, and a repair ticket stays routable until a later green batch
  verifies its landing.
- Run `npx vitest run --project node --maxWorkers=1 packages/bot/src/devpipe`
  for pipeline changes.
