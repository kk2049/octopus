# Session Hub

Session Hub lets a user inspect and continue CLI sessions on devices owned by
that user. It is a service boundary, not a collection of dashboard routes.

Read `doc/development/session-hub-v3-execution-plan.md` and
`doc/development/session-hub-unified-worklog.md` for detailed evolution.

## Resource and authority model

- Session metadata/transcript access and session mutation are separate
  capability resources. Read access must not imply append/resume authority.
- The trusted service binds the authenticated owner and selected device/session
  before dispatch. Browser input never supplies an authoritative owner, device
  route, canonical path, or credential. A named administrator may act on any
  account through that account's own grants (owner decision, 2026-10-15); each
  such call writes an `admin_access` audit row on the account naming the admin.
  The shared admin key names nobody and still gets no session material.
- Session operations use the shared capability Gate and persist an operation
  record. Do not create a route-local permission shortcut.
- The first-party MCP session surface reuses this boundary. Its roster/search/read
  calls opt into the trusted Sessions+ split-session catalog. The owner's
  append/resume exception applies to every credential of the owner (browser,
  script, MCP token), so sending to one's own session never waits for an
  approval; other accounts still never reach a grant here.
- Device target changes revoke roots derived from the previous target set before
  new credentials become usable.

## Operation lifecycle

- A submit becomes a durable `SessionOperation` before external execution. Its
  state is one of submitted, waiting approval, running, succeeded, failed,
  rejected, or unknown.
- Non-retry-safe work interrupted after dispatch becomes `unknown`; the host
  must not pretend it failed or replay it. A refusal the Runner proves came
  before any transport is `failed` with its reason, so the person can resend.
- An `unknown` receipt is queried with backoff (5 s to 60 s) for 30 minutes,
  the Runner's late-evidence window; then its observation ends and the record
  says querying stopped. Takeover wording appears only after a terminal write
  into a CLI pane; managed turns point to the transcript.
- Retry-safe reads may return to waiting approval without resetting their
  original expiry. Recovery never executes the call by itself.
- UI status text is projected from the durable operation; the browser does not
  reconstruct truth from transient SSE events.
- Ordinary Session operations send their trusted operation id plus
  `input_receipt: true`. Runner v1 top-level `state` still represents the provider
  turn's completion; its optional `input` is evidence on that same durable row.
  The Session UI action succeeds on native acceptance/local queue evidence, while
  a bare terminal write stays unknown. Ticket callers continue waiting for completion.
- `RunnerCapabilities.querySessionOperation(owner, id)` is the recovery seam.
  The stored intent fixes the device and optional shared-runtime identity; a fresh
  narrow Gate context rechecks authority and can only query this operation. It
  never dispatches start/append or obtains a ticket execution token.
- Migration 74 is additive; old rows lack a receipt binding and retain their old
  outcomes. Input projection contains no prompt, raw transcript or credential.
  Bootstrap holds a split launch's original scoped credential until its own
  provider identity arrives, scope expiry or an explicit terminal refusal. A
  quick running receipt and a lost response do not revoke that scope. Existing
  unbound scopes still fail closed after Bot restart; receipt recovery cannot
  reconstruct execution authority.

## Dedupe and leases

- Device-side dedupe and bot-host operation dedupe answer different failure
  modes. Keep their keys and lifetimes separate.
- A lease prevents two trusted workers from running one operation concurrently.
  Lease loss stops ownership; it does not prove the external side effect did
  or did not happen.
- Bind derived handles to the credential/lease that created them. Replacing a
  device token or operation holder revokes the old derivation chain.

## Honest boundaries

- A worktree/cwd is display and routing context, not confinement.
- Bot-host sessions without a Runner resource cannot expose Runner-only file
  operations.
- CLI transcript formats are normalized by the sessions plugin. Do not add
  browser branches for individual CLI implementations.
- A session is `live` only with fresh evidence: a Runner-verified process with
  a working/needs-input turn, or a turn state or transcript activity that is
  recent under the contract's `activityPhase` rule. Never add another variant.
- Three CLI kinds exist (`claude`, `codex`, `omp`). Decide a kind against
  `ENUMERATED_SOURCES` / `SESSION_CLI_KINDS`, never a two-value comparison.
- Claude/Codex report through installed hooks; omp is DISCOVERED from the
  breadcrumbs it already writes. "Observed, not attached" therefore does not
  imply a missing hook install.
- The Codex scanner may declare a Multi-Agent V2 `thread_spawn` child as
  `parent_owned` together with its exact parent thread id. Normalization accepts
  only that complete bounded provider claim, marks the child non-resumable, and
  mints the parent as an opaque resource on the same owner/device/provider.
  Provider-declared legacy Codex lineage can also mint a parent navigation
  resource without claiming input ownership. Claude sidechain metadata uses
  its distinct agent id plus parent session id; those transcripts are observable
  under the same parent-owned guard because they have no independent resume id.
  Missing or malformed metadata stays undecided; labels, paths and cwd never
  become parent identity.
- `runner-tail.ts` owns change-aware `read_session` polling over an injected,
  already-authorized RPC closure. HTTP fan-out and App authority lifetimes stay
  in their callers.

## Focused verification

```bash
npx vitest run --project node --maxWorkers=1 packages/bot/src/sessionhub
npx vitest run --project node --maxWorkers=1 packages/bot/src/session-resource
```
