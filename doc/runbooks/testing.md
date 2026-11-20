# Testing and post-submit CI

## Local feedback

Use the smallest test scope that owns the change. This machine has limited
memory, so keep Vitest at one worker unless a narrower package documents a
different safe setting.

Managed development tickets requested by the configured CI-device owner receive
an isolated `/work/tickets/ticket-<id>` workspace in the lht-val15 CI container.
The agent commits locally, calls `devpipe_ci_sync`, then runs the affected
module's compile command and related small tests there. Each ticket owns its
node_modules and generated workspace links; git objects and the pnpm content
store are shared only as caches. Full-suite testing remains post-submit.

```bash
npx vitest run --project node --maxWorkers=1 packages/bot/src/<area>
npx vitest run --project <browser-project> --maxWorkers=1
npx tsc --noEmit -p packages/bot/tsconfig.json
```

Package-level `CLAUDE.md` files and path-scoped rules list the focused commands
for their area. New non-trivial behavior needs focused tests next to the code.

For visible frontend changes, also exercise the affected interaction and view
screenshots using the approved isolated [browser acceptance service](browser-acceptance.md).
Its CLI/MCP entry can run in a coding worktree; Chromium runs in the separate
browser container. Record the preview/deployed SHA and actual GUI results.
This complements scoped code tests and does not move Chrome into the coding
container or the synchronous landing gate. Deployment timing diagnosis and
proposed optimizations are in [release latency](release-latency.md).

Run the agent-document budget after instruction changes:

```bash
pnpm docs:check
```

## Landing semantics

`scripts/ops/land.sh` and `devpipe_submit` do not synchronously run the complete
suite. The thin land gate runs the frozen install, incremental typecheck, the
non-browser tests the landing named (`devpipe_submit` `tests`, `land.sh --test`), and the
spec files the landing's own diff touched — `*.test.*` files in the diff plus
the existing `X.test.ts(x)` sibling of every changed source `X.ts(x)`. A red
there refuses the landing (`named_tests` / `changed_tests`); run those files
yourself first. CI repair tickets additionally re-run their failure roster.
Everything runs once, in one tree, outside the Git merge lock.

Specs that import Playwright, Puppeteer or Cypress are never run by the
synchronous landing/deployment path. This applies even when they appear in a
CI repair roster, knowledge evidence, a changed-test selection, an explicit
path, or an entire named Vitest project: exact files are skipped and broad
runs receive explicit `--exclude` filters. The gate pins the omitted paths in
its log and leaves their execution to post-submit GitLab CI. Do not weaken this
boundary to make a landing prove browser behavior; use the isolated CI Runner
or an explicitly approved browser-capable environment.

When `selfhosting.ci_machine` is configured and its Runner is online, the gate
runs those steps inside the lht-val15 CI container (pipeline-owned `/work/land`
worktree, see `ops/ci-container/README.md`) and falls back to `_land` on the
bot host otherwise. `devpipe_submit` is therefore a synchronous call that
normally returns within one to three minutes; agents wait for it instead of
polling `devpipe_status`.

One exception closes the automated repair loop: after a CI repair landing,
the monitor immediately starts another **complete** GitLab suite. That result is
asynchronous, but it is the repair ticket's final gate: red resumes the same
ticket/session with the full widened failure roster; green closes the loop.

```bash
scripts/ops/land.sh \
  --test packages/bot/src/devpipe \
  --test project:dashboard-web
```

Keep `project:<name>` and path filters as separate test invocations. Combining
them can filter another project to zero tests and produce a misleading pass.

`devpipe_submit` may rebase concurrent landings. When it returns
`base_changed_review`, nothing landed and the merge lock is already free. Read
the returned `landed_ahead`, review shared modules/interfaces/behavior, fix and
commit if needed, then `devpipe_ci_sync` and repeat the scoped compile/tests
before submitting again. A textually clean rebase is not accepted as proof of
semantic compatibility.

## Complete suite

Pushes to `v4` do not start pipelines. At **04:00 Beijing time every day**, the
bot triggers one GitLab CI run for the then-current mirrored `v4` tip on the
dedicated Runner. All commits therefore accumulate into one overnight verdict.
It advances `v4-stable` only after green.

A red run executes every Vitest batch before failing, so one red carries the
complete parsed error list and every failing file. The repair prompt also gets
every commit since the previous green plus, for each associated ticket, either
the requester's original input and agent summary or the CLI modification-result
report. The same repair ticket and provider session iterate without an
automatic retry cap; each repair landing triggers immediate full verification,
and only green satisfies the repair's final gate.

Runner or scheduling failures are infrastructure failures, not code failures.
They are recorded as aborted and retried after the infrastructure backoff.
CI remains separate from deployment: inspect `scripts/ops/status.sh` before a
risky deployment even when the latest overnight batch is green.


## Executable temporary fixtures

CLI and release tests create executable stubs under `os.tmpdir()`. The Node
project's setup file (`tools/test-support/vitest-node-setup.mjs`) proves that
directory can execute a script; when `/tmp` is mounted `noexec` it moves
`TMPDIR` to `~/.cache/octopus-test-tmp`, and fails the run loudly if neither
works. Setting `TMPDIR` to an executable directory inside the task's approved
temporary workspace remains the preferred explicit choice.

Fake agent CLIs use `fakeExecutables()` from
`tools/test-support/fake-executables.mjs`: its PATH reaches only the fakes,
the runner's own `node` and `/usr/bin:/bin` (checked to hold no real
`claude`/`codex`/`omp`), and HOME is private, so a broken fake is "not found"
instead of a real subscription call. Do not prepend a fake directory to the
inherited PATH. On 4090, do not launch local Chrome for these checks; the `web`
project uses jsdom.
