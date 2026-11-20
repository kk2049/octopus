# Runner capability directory and hot registration

An updated Runner can publish additional tools from locally registered **stdio
MCP servers**. Head uses its existing authenticated Runner connection and
capability Gate. Registering another provider does not require changing Head,
rebuilding Runner, reconnecting MCP clients, or restarting resident sessions.

The Dashboard endpoint overview has a **Runner 能力** section for each device.
It shows built-in capability availability and extension status, version,
revision, tool descriptions and input/output schemas. Search and expanded
details survive inventory refresh. An offline device is never presented as
callable. Old Runners can still report built-in inventory; absence of
`runner-capabilities/v1` means hot registration is not supported yet.

## Device-owner registration

First install a Runner build containing this protocol through the normal
Runner update process. This initial binary upgrade is distinct from hot
registration and still follows the existing managed-work drain rules.

Prepare a private JSON manifest on the execution device:

```json
{
  "schema": "runner-capability-registration/v1",
  "id": "my-tools",
  "title": "My local tools",
  "version": "1.0.0",
  "command": "/absolute/path/to/python3",
  "args": ["/absolute/path/to/my_mcp_server.py"],
  "cwd": "/absolute/path/to/project",
  "enabled": true
}
```

`command` and optional `cwd` must be absolute. The program must implement
MCP stdio (`initialize`, `tools/list`, `tools/call`); Python, Node and other
languages use the same interface. Optional `env` contains explicit string
environment overrides. Runner inherits the MCP SDK's minimal environment,
not its own full service environment. Provider stderr is drained locally and
never forwarded to Head.

On POSIX, the manifest must belong to the Runner OS user and have mode 0600.
On Windows, restrict its ACL to that user and SYSTEM. Symlink manifests are
refused where the platform supports `O_NOFOLLOW`.

```sh
chmod 600 /absolute/path/provider.json
octopus-runner capabilities register /absolute/path/provider.json
octopus-runner capabilities list
```

The installed CLI writes device-private desired state beneath
`SCAN_HOME/.octopus/runner/capabilities`. Its list output contains the current
configuration digest, public metadata and enabled state; actual readiness is
shown by Head after Runner connects and validates the provider.

The resident polls the small registry every two seconds. Starting a provider
and validating its catalogue take additional time. With machine operations
disabled, registered providers remain visible as disabled and are never started. It publishes inventory
changes immediately, without waiting for the regular agent-backend scan.
The Dashboard retains its ordinary overview refresh interval.

Updates, reloads, enable/disable and removal require the current digest
returned by `capabilities list`, preventing accidental overwrites:

```sh
octopus-runner capabilities register /absolute/path/provider.json CURRENT_DIGEST
octopus-runner capabilities reload my-tools CURRENT_DIGEST
octopus-runner capabilities disable my-tools CURRENT_DIGEST
octopus-runner capabilities enable my-tools CURRENT_DIGEST
octopus-runner capabilities remove my-tools CURRENT_DIGEST
```

Reload after changing program code or environment even if its public version
string is unchanged. Every registration update receives a new generation.
Invalid configuration or an unavailable provider closes admission and reports
an error; Runner does not silently continue accepting calls through the old
configuration. A failed provider is retried by an explicit reload. Existing
in-flight calls drain on their original provider connection before it closes.

Registration is a local operator action, not a remote Agent tool or browser
command-execution endpoint. There is no package downloader, public plugin
marketplace, or untrusted-code sandbox. A provider runs as the Runner OS user,
with that user's filesystem and network authority. Use existing OS/container
isolation when a provider needs a narrower execution environment.

## Agent discovery and invocation

In **权限 → MCP 接入**, separately grant discovery, description and invocation.
Existing workspace, session or command grants do not imply these rights.
The optional MCP token group is `runner_capabilities`. Opted-in managed
sessions and the ordinary local Runner MCP bridge use the same account
permissions and Gate.

There are three stable MCP tools:

1. `runner_capability_list({query?, after?})` returns up to 20 current tool
   entries with an opaque `capability_ref`; `next_cursor` reads the next page.
   Discovery reads Head's current inventory and does not contact every Runner.
2. `runner_capability_describe({capability_ref})` returns the exact input and
   optional output JSON Schema.
3. `runner_capability_call({capability_ref, request_id, input_json})` dispatches
   directly through Head to the bound device/provider/tool revision.
   `input_json` is a JSON object encoded as a string, preserving arbitrary
   nested JSON Schema within the existing primitive capability ABI.

Tool addition/removal is visible through these stable tools; it does not
require dynamic insertion of hundreds of names into a client's cached
`tools/list`. A changed provider or schema invalidates old references and
old pending approvals. List/describe again after a stale-reference refusal.

All extension calls have **execute** effect, irrespective of MCP tool
annotations. Default invocation requires the owner to approve the exact call.
Repeat the identical arguments after approval to collect its result, rather
than issuing another request ID. Explicitly selecting auto-allow is a broad
grant to this owner's **current and future locally registered extensions**;
the permission description says so. Token groups only narrow that authority.

Only the Runner's control site receives this catalogue or its invocation
adapter. Secondary sites are refused locally. Owner identity is fixed by
authentication; callers cannot inject an owner, path, command or environment
into the outer invocation envelope.

## Bounds and uncertain results

- At most 8 providers, 32 tools per provider, 8 KiB per schema and 256 KiB per
  public catalogue. Remote schema references are refused.
- One in-flight call per provider, a 20-second MCP call deadline, 64 KiB input
  and 256 KiB accepted output. Oversized output is not truncated into success.
- Identical request IDs and arguments join the original call/result within
  the current resident generation; changed arguments are refused. Receipts
  are isolated by the locally authenticated site credential.
- The bounded cache holds at most 256 results. Before dropping a full cache,
  Runner rotates all callable references while no calls are in flight.
  Old references cannot replay an evicted call. Re-discover before new work.
- Restart also changes every reference. These receipts are not a durable
  job journal. Transport loss, provider timeout or invalid result means
  **indeterminate**; never automatically repeat with a fresh request ID.
- Long-running tools should return a job handle promptly and expose their own
  status/cancel tools. Existing workspace, knowledge and transcription jobs
  retain their existing durable managers; this change does not migrate them.

For diagnosis, inspect the public provider status, correct its local manifest
or executable, and reload using the current digest. No provider logs or
credential values are included in the directory. A CLI killed during a write
may leave `.write-lock`; verify no registry CLI writer is alive before
removing that lock locally.

## Verification

Focused automated coverage exercises private registration and CAS, schema
validation, duplicate delivery, generation changes, draining, control-site
isolation, approval resume, permission revocation, dynamic MCP discovery,
and UI state preservation. A real standalone Runner test registers/removes a
real stdio MCP provider while both gateway connections and the resident
process remain alive.
