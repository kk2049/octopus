# Browser acceptance for CLI and ticket agents

Use the shared browser service for changes to visible frontend behavior. It
runs headed Chromium in an isolated sibling container on the 4090 host;
the coding container does not launch Chrome. Native MCP, the installed CLI and
the Runner extension expose the same tools and task-owned browser contexts.
Source and reproducible installation: [ops/browser-acceptance](../../ops/browser-acceptance/README.md).

## A short acceptance loop

1. Run the smallest relevant unit/type checks. Start this worktree's documented
   preview if testing unlanded code; record its commit and URL. An online
   production test proves the deployed release, not changes in a local tree.
2. Run `octopus-browser doctor`, then `browser_open` with the preview URL and
   task label. Keep the returned opaque `session` private to this task. The
   browser shares the research container's network namespace, so its loopback
   previews are reachable directly. A host-only or other-container preview
   needs an explicitly reachable private address or tunnel.
3. For the configured production origin, `browser_login_acceptance` logs in
   through the real form using the device-private test account. Never paste a
   real user's key into a prompt or URL. Other test identities can be
   provisioned by the entrusted developer through existing authorized admin
   operations; state which identity performed setup and which tested behavior.
4. Use `browser_observe` for the rendered accessibility tree and
   `browser_screenshot` for the actual pixels. **View the returned image.**
   Use `selector` or `frame_selector` to inspect a relevant panel instead of
   repeatedly reading an entire ticket history.
5. Use `browser_action` to click, fill, type, press, select, check, scroll or
   drag. Coordinates refer to the current screenshot viewport. Interact with
   the actual iframe using `frame_selector` when testing an Agentic App.
   `browser_wait_for` waits for a visible completion state, at most eight
   seconds. Observe/screenshot the result: an input returning successfully is
   not evidence that the application saved the intended change.
6. Cover the affected happy path and one meaningful failure/recovery case;
   when layout changed, also open a narrow viewport (for example 390×844).
   Use disposable test data. Do not resume real agents, submit duplicate
   tickets or deploy merely to check a button. Read `browser_errors` and
   distinguish expected permission refusals from broken assets/exceptions.
7. Record expected/observed results, release or preview SHA, identity,
   screenshots and unresolved issues. Close with `browser_close`; evidence
   remains. For a long-running delegated login task, open with `persist_login: true`,
   save the handle privately, and use `browser_suspend` while paused. Resume with
   `browser_resume` after a pause or service restart; close only when finished.
   Browser tests supplement focused tests and post-submit CI; they
   never run inside the synchronous merge lock or become a reason to weaken
   that gate.

Example CLI calls (substitute the handle from `browser_open`):

```sh
octopus-browser browser_open '{"url":"http://127.0.0.1:5173","label":"ticket-123-preview"}'
octopus-browser browser_observe '{"session":"HANDLE","selector":"main"}'
octopus-browser browser_action '{"session":"HANDLE","action":"click","selector":"button:has-text(\"Save\")"}'
octopus-browser browser_wait_for '{"session":"HANDLE","selector":"text=Saved"}'
octopus-browser browser_screenshot '{"session":"HANDLE"}'
octopus-browser browser_errors '{"session":"HANDLE"}'
octopus-browser browser_close '{"session":"HANDLE"}'
```

CLI screenshots return a private absolute artifact path. Native MCP returns
an image content block as well, allowing the agent to inspect pixels directly.
`octopus-browser tools` prints the complete schema. A running Codex session may
need its ordinary reconnect/resume to load newly configured MCP tools; its
CLI entry works immediately without changing the agent execution mode.

## Managed agents and remote access

On the 4090 host, ticket workspaces use `/usr/local/bin/octopus-browser`; in the
research container use `/home/ubuntu/.local/bin/octopus-browser`. Both reach
the same private service, with separate browser contexts. No agent gets a
Docker socket or a command-execution endpoint in the browser container.

The device-owner Runner registration `octopus-browser` also advertises the
tools through `runner_capability_list`, `runner_capability_describe` and
`runner_capability_call`. Follow [Runner capabilities](../runner-capabilities.md):
the `runner_capabilities` token group and the owner's actual discovery,
description and invocation grants are required. A registered/ready provider
is not an authorization grant to every Octopus user. Do not automatically
enable a blanket grant to all current and future extensions. Same-device
entrusted development can use the installed CLI independently of the Head.
The accompanying Head change forwards successful Runner screenshots as real
MCP image blocks, retaining request/revision metadata and excluding image
base64 from the text/structured receipt. That relay and the new managed-ticket
prompt require a normal application deployment; the native stdio/CLI service
works immediately after device installation.

## Bounds and recovery

The service permits four live contexts and eight tabs each. There is no absolute
or idle lifetime and no cumulative action limit. Each context retains the
80-screenshot/16 MiB evidence budget, with bounded rotating action logs. A tool has a 15-second deadline beneath the Runner's 20-second limit;
timed-out operations retire the live context and must not be replayed blindly.
Opted-in tasks can resume the last completed private login checkpoint to inspect
the application; site-controlled login expiry still applies.
The client also reports uncertain transport outcomes. Inspect existing
application state before sending another input.

If the service is unavailable, use `doctor` and the device operations notes;
do not silently label a code-only check as GUI acceptance. If capacity is full,
suspend a persistent context owned by this task or close a finished one; do not
wait for expiry or close another task. The evidence store stops at
128 session directories; archive completed, unreferenced evidence before
opening more. Retention never deletes another task's screenshots automatically.
