# Isolated browser service

This optional device tool exposes headed Playwright through a private Unix
socket. A bundled stdio MCP/CLI client supports native Codex and the existing
Runner capability registry without changes to the application protocol.
The operational acceptance loop is in
[the runbook](../../doc/runbooks/browser-acceptance.md).

## Components and trust

- `service.mjs` owns Chromium/Xvfb and the Unix HTTP service.
- `core.mjs` owns isolated contexts, private login checkpoints, input operations and evidence.
- `tools.mjs` is the common catalogue; `client.mjs` turns screenshots into MCP
  image blocks or local CLI paths.
- `build-client.mjs` bundles the repository's installed MCP SDK with its
  existing esbuild dependency. It does not install a second MCP framework.

Browser and driver are both Playwright **1.62.1**. Do not use a driver whose
expected browser revision differs from the image. Node 22+ runs the bundled
client. The Docker build installs only the pinned Playwright package and uses
the browsers already in the image. Native MCP's stdio protocol is documented
at [OpenAI](https://learn.chatgpt.com/docs/extend/mcp?surface=cli); container
version matching is documented at [Playwright](https://playwright.dev/docs/docker).

The socket and state directory belong to one trusted development OS account
(0600/0700). Context handles prevent accidental task crossover, not hostile
same-UID access. This is **not a multi-tenant browser sandbox**. Each context
has its own cookies/storage and no personal browser profile. A task can explicitly
opt into private login checkpoints; these are not shared with new contexts. A provider can
reach the device network; register it only for entrusted development users.
The container has no Docker socket, source-tree mount or personal agent keys.
Chromium's inner sandbox is off under the default Docker seccomp profile; the
container is non-root, capability-free, read-only and resource-limited. Use
this instance for trusted application acceptance, not arbitrary hostile sites.
An optional `OCTOPUS_BROWSER_SANDBOX=1` requires a separately validated host
user-namespace/seccomp configuration.

## Install on a Linux Docker host

Build the image from this directory, then build/install the client from the
same checkout (already has its frozen workspace dependencies):

```sh
docker build --network host -t octopus-browser-acceptance:20261010 ops/browser-acceptance
node ops/browser-acceptance/build-client.mjs /absolute/private-tools/client.mjs
```

`--network host` is only for fetching npm during image build on hosts without
a default Docker bridge. Runtime uses the explicitly selected existing
network namespace and its established routing policy.

Create a private state directory owned by the browser UID. Optionally place
the dedicated test-account credential in `credentials/acceptance.token`, mode
0600. Keep it outside Git. Example runtime, substituting reviewed host paths
and the existing research network container:

```sh
docker run -d --name octopus-browser-acceptance --restart unless-stopped \
  --init --user 1000:1000 --network container:RESEARCH_NETWORK_CONTAINER \
  --cpus 2 --memory 4g --memory-swap 4g --shm-size 512m --pids-limit 256 \
  --cap-drop ALL --security-opt no-new-privileges --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  --mount type=bind,src=/absolute/browser-state,dst=/state \
  --env HOME=/tmp \
  --env OCTOPUS_BROWSER_ORIGIN=https://YOUR_OCTOPUS_ORIGIN \
  --env OCTOPUS_BROWSER_CREDENTIAL_FILE=/state/credentials/acceptance.token \
  octopus-browser-acceptance:20261010
```

No ports are published. The browser UID must match the private state owner;
the base image's named `pwuser` is not assumed to be UID 1000. Install an
`octopus-browser` wrapper invoking the bundled file with Node and
`OCTOPUS_BROWSER_SOCKET=/absolute/browser-state/browser.sock`. The client
defaults to `$HOME/.local/state/octopus-browser/browser.sock`.

Test `octopus-browser doctor`. Check image ID, container resources, network
namespace and state owner. Before an update, check active tasks and suspend opted-in tasks or finish
ephemeral ones. A container restart drops live pages, but opted-in tasks can
resume their saved login using the same handle. Restarting the parent network
container with a new namespace also requires re-creating this service against
that new namespace. Keep screenshots/private state on the durable bind mount.

## Register native Codex and Runner

Add to the actual account's Codex configuration, preserving existing servers:

```toml
[mcp_servers.octopus_browser]
command = "/absolute/path/octopus-browser"
args = ["mcp"]
startup_timeout_sec = 10
tool_timeout_sec = 20
```

Register the same client through an owner-private 0600 Runner manifest:

```json
{
  "schema": "runner-capability-registration/v1",
  "id": "octopus-browser",
  "title": "Isolated browser acceptance",
  "version": "1.0.0",
  "command": "/absolute/path/octopus-browser",
  "args": ["mcp"],
  "cwd": "/absolute/private-tools",
  "enabled": true
}
```

Use `octopus-runner capabilities register /absolute/provider.json` and confirm
the provider is **ready** in the actual device inventory, not just registered
on disk. Reload with the current digest after updating a bundled client.
Follow the existing owner/token grants for remote use. A CLI tool call is
already available to trusted same-device ticket workspaces independently of
the Octopus application's availability.

## Verification and maintenance

```sh
pnpm exec vitest run --project node --maxWorkers=1 ops/browser-acceptance/core.test.mjs
```

These tests use a fake browser to check context isolation, unlimited lifetime, private login recovery, action deadlines,
credential destination restrictions, private evidence and output bounds.
They do not launch Chromium and do not replace real GUI acceptance.

After installing the service, explicitly run `node ops/browser-acceptance/smoke.mjs`
from the research network namespace. It serves a temporary loopback fixture,
checks real form submission, iframe interaction, isolated storage, screenshots,
popup tabs and console capture, then closes its own contexts and HTTP server.
Its JSON output names the screenshots to inspect. It is not selected by the
normal test gate and makes no production writes.

Runtime screenshots are viewport JPEGs up to 160 kB, so an image plus MCP
metadata fits the Runner's 256 KiB result limit. Long pages should be scoped
or scrolled. Source actions/errors deliberately omit request/response bodies,
headers and typed text; screenshot and accessibility evidence can still contain
application data and must be kept private. The installed credential is redacted
from text results, but screenshots must be reviewed before sharing.

To roll back the device tool, disable its Runner registration using its current
digest, remove only its native MCP configuration entry, and stop this container
after checking active task contexts. Preserve the private state/evidence.
There is no production service restart or application deployment in this setup.

## Long-running authenticated work

`browser_open` has no absolute or idle session lifetime (`expires_at: null`;
health `lease_seconds: null`). The former 20-minute expiry and cumulative
250-action limit are removed. Four concurrent contexts, eight tabs, per-action
deadlines and bounded screenshot evidence remain; action logs rotate at 64 KiB.
Capacity is never reclaimed by silently logging another task out.

Use `persist_login: true` when a delegated task needs user login across pauses
or service upgrades. Save its opaque handle in the task's private state:

```sh
octopus-browser browser_open '{"url":"https://example.com","label":"task-specific developer login","persist_login":true}'
octopus-browser browser_suspend '{"session":"HANDLE"}'
octopus-browser browser_resume '{"session":"HANDLE","url":"https://example.com"}'
```

Checkpoints capture Playwright cookies, localStorage and IndexedDB after
successful tool operations, every 30 seconds while idle, and on graceful
shutdown. A checkpoint is atomically replaced under `state/sessions/`, with
0700 directory / 0600 file permissions and a 4 MiB per-task disk bound. Larger
site storage is compressed losslessly, with a separate 64 MiB expansion bound.
Small checkpoints retain the original JSON format; compressed version 2 files
require this service version or newer. Cookies, localStorage and IndexedDB are
retained together; no heuristic deletes a site's storage or authentication data.
Contents never enter tool results. Failed saves set `login_checkpoint.failed`
and the health counter while preserving the previous checkpoint and live page.
Completed actions and observations still return their actual result; do not
repeat an input because recovery saving failed. Explicit suspend requires a
fresh successful checkpoint and otherwise leaves the task active.
No list/export/import endpoint exposes saved identity. Same-UID entrusted users
retain the existing OS trust boundary. Do not copy checkpoint files into Git,
reports, public artifacts or another task. Defaults remain ephemeral.

`browser_suspend` checkpoints and releases the browser slot; `browser_resume`
restores only that handle's login and opens its last page (or the supplied URL),
without replaying clicks or submissions. It does not restore unsaved DOM edits,
all popup tabs, sessionStorage or in-memory page state. Ordinary navigation may
run the site's scripts. Sites can still expire/revoke their own login; this tool
does not bypass their authentication policies. Abrupt crashes restore the last
completed checkpoint. Details of the underlying storage format are in
[Playwright's authentication documentation](https://playwright.dev/docs/auth).

When a task is finished, `browser_close` deletes its saved login even if it is
suspended, and retains screenshots/action evidence. Do not use close when a
long-running task is merely waiting for its user. On an uncertain action timeout,
the live context is retired but its last completed login checkpoint is retained;
resume to inspect application state before deciding whether any input is needed.

For a real browser persistence check, run `node ops/browser-acceptance/persistence-smoke.mjs`.
It uses a loopback-only fixture and no personal credentials. To additionally
verify a service restart, pass `--restart`, wait for its `ready_for_restart`
message, restart only the reviewed idle service, then send a newline to the
probe. Do not restart a service serving unrelated tasks.
