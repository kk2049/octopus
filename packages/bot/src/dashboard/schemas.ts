import { DASHBOARD_THEME_IDS } from "@claude-bot/dashboard-web/contract";

/**
 * Per-route body shapes.
 *
 * ── What a schema here does, and what it deliberately does not ──────────────
 *
 * Every handler in this panel reads its arguments as `String(body.x ?? "")`.
 * That is a coercion, not a check: `{device: {}}` becomes the device named
 * `"[object Object]"`, and `{username: ["a","b"]}` becomes `"a,b"`. A schema
 * with `coerceTypes: false` (see `http.ts`) turns those into refusals at the
 * boundary instead of into plausible-looking values further in.
 *
 * What they do NOT do:
 *
 *  · **Nothing is `required`.** Fastify validates AFTER routing but BEFORE the
 *    handler, and a required field would let a caller who should get 401/403/404
 *    learn "you are missing a field" instead. Identity comes first; the gate runs
 *    in `onRequest`, ahead of parsing, and requiredness of an identity field is
 *    the handler's answer once it knows who is asking. (The v3 Host found this
 *    the hard way — see its `BODY` docstring.)
 *  · **`additionalProperties` stays open, and nothing is stripped.** Clients send
 *    fields this server ignores (an older page's `username` echo, a `resource`
 *    handle beside the fields it replaces). Refusing or deleting them would
 *    change which requests are accepted, which is not a transport decision.
 *  · **No defaults.** A default is a value the caller did not send, and every
 *    "absent means X" rule here is already written in the handler where the
 *    reader can see it next to what X does.
 *
 * ── Fields deliberately left untyped ────────────────────────────────────────
 *
 * Some fields legitimately arrive as more than one type and the handler is the
 * only place that knows the rule:
 *
 *  · `/api/deploy/confirm` `intent_id` — the page sends a number, `scripts/ops`
 *    send whatever `jq` produced; the handler runs `Number()`.
 *  · `/api/admin/grant` `value` — accepted as `true` or `"true"` on purpose.
 *  · `/api/tickets` `parent_ticket_id` — same `Number()` treatment.
 *  · `/api/session-plus/act` `params` — an untrusted View's proposal, validated
 *    against the App's action contract by the coordinator, which is the only
 *    thing that knows the shapes.
 */

/** A short identifier-ish string: a username, a device, a session id, a slug. */
const NAME = { type: "string", maxLength: 512 } as const;
/** Same-origin document address carried through the login exchange. */
const LOGIN_NEXT = { type: "string", maxLength: 4096 } as const;
/** Free text a human typed. Capped far above every handler's own truncation. */
const TEXT = { type: "string", maxLength: 100_000 } as const;
/**
 * A prompt bound for a session. Deliberately no `maxLength`: JSON Schema counts
 * characters, the real budget is `MACHINE_LIMITS.appendMaxPromptBytes` UTF-8
 * BYTES, and the handler checks exactly that and says so. The panel's default
 * body window (1,000,000 bytes) holds any prompt the capability kernel's
 * 512 KiB argument envelope can carry downstream, so no route raises it.
 */
const PROMPT = { type: "string" } as const;
const PERFORMANCE_COUNT = { type: "integer", minimum: 0, maximum: 1_000_000 } as const;
const PERFORMANCE_MS = { type: "number", minimum: 0, maximum: 3_600_000 } as const;
/**
 * Tests an author asked a landing to run before the ff.
 *
 * Bounded, but NOT validated against a list of real projects or paths:
 * landing does not depend on these, so an unknown entry must fail as a test
 * run the author can read, not as a 400 on the merge.
 */
const TESTS = { type: "array", maxItems: 12, items: { type: "string", maxLength: 200 } } as const;
const RETRIEVAL_RECEIPTS = {
  type: "array",
  maxItems: 8,
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", pattern: "^kr_[0-9a-f]{32}$" },
      receipt_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      content: { type: "string", maxLength: 32 * 1024 },
    },
  },
} as const;


function body(properties: Record<string, unknown>): { body: Record<string, unknown> } {
  return { body: { type: "object", additionalProperties: true, properties } };
}

export const PANEL_BODY_SCHEMAS = {
  login: body({ token: { type: "string", maxLength: 4096 }, next: LOGIN_NEXT }),
  register: body({ username: NAME }),
  check: body({ username: NAME, device: NAME }),
  themePreference: body({ theme: { type: "string", enum: [...DASHBOARD_THEME_IDS] } }),
  runnerToken: body({ username: NAME, device: NAME, platform: { type: "string", enum: ["unix", "windows", "windows-installed"] } }),
  runnerEnrollmentRedeem: body({ code: { type: "string", maxLength: 128 } }),
  runnerGuestEnrollment: body({
    device: { type: "string", maxLength: 64 },
    providers: { type: "array", maxItems: 4, items: { type: "string", maxLength: 32 } },
    ttl_days: { type: "number", minimum: 1, maximum: 30 },
  }),
  runnerDisplayName: body({ username: NAME, device: NAME, display_name: { type: "string", maxLength: 256 } }),
  runnerOnlineNotice: body({ username: NAME, device: NAME, channel: { type: "string", enum: ["feishu", "off"] } }),
  runnerDelete: body({ username: NAME, device: NAME }),
  runnerLocalAgentBridge: body({
    username: NAME,
    device: NAME,
    mode: { type: "string", enum: ["disabled", "manual", "full_access"] },
  }),
  runnerDefaultAgentInjection: body({
    username: NAME,
    device: NAME,
    enabled: { type: "boolean" },
  }),
  runnerGuiAutomation: body({
    username: NAME,
    device: NAME,
    enabled: { type: "boolean" },
  }),
  sessionsAppend: body({
    username: NAME,
    device: NAME,
    id: NAME,
    source: NAME,
    resource: TEXT,
    prompt: PROMPT,
    operation: NAME,
  }),
  sessionInteraction: body({
    username: NAME,
    device: NAME,
    provider: NAME,
    session_id: NAME,
    interaction_id: NAME,
    response_json: { type: "string", maxLength: 32 * 1024 },
  }),
  permissionsGrant: body({
    username: NAME,
    subject_type: NAME,
    subject_id: NAME,
    operations: { type: "array", maxItems: 200, items: { type: "string", maxLength: 200 } },
  }),
  permissionsRevoke: body({ username: NAME, subject_type: NAME, subject_id: NAME }),
  permissionStudioExplain: body({
    username: NAME,
    resource_id: NAME,
    holder_id: NAME,
    operation: NAME,
    proposed_mode: NAME,
  }),
  permissionStudioApply: body({ username: NAME, proposal_id: NAME }),
  // The MCP token lifecycle. `token_hash` names a row the owner already sees in
  // their list; it is a sha256 hex string, never the credential itself.
  mcpTokenCreate: body({
    username: NAME,
    label: NAME,
    ttl_days: { type: "number" },
    tool_groups: { type: "array", maxItems: 8, items: { type: "string", maxLength: 32 } },
    app_ids: { type: "array", maxItems: 32, items: { type: "string", maxLength: 64 } },
    app_instances: { type: "array", maxItems: 64, items: { type: "string", maxLength: 96 } },
    app_actions: { type: "array", maxItems: 64, items: { type: "string", maxLength: 64 } },
  }),
  mcpTokenRevoke: body({ username: NAME, token_hash: NAME }),
  tentacleShare: body({
    username: NAME,
    viewer: NAME,
    device: NAME,
    kind: NAME,
    resource_key: TEXT,
  }),
  tentacleRevoke: body({ username: NAME, viewer: NAME, object_id: TEXT }),
  feishuOAuth: body({ username: NAME, force: { type: "boolean" } }),
  githubConnectionStart: body({ username: NAME }),
  connectionUnbind: body({ username: NAME, connection_id: NAME }),
  webSessionRevoke: body({ username: NAME, sid: NAME }),
  webSessionRevokeOthers: body({ username: NAME }),
  sessionPlusAct: body({ action: NAME }),
  sessionPlusTrust: body({ decision: NAME }),
  sessionPlusPerformance: body({
    version: { type: "integer", enum: [1, 2] },
    windowMs: PERFORMANCE_MS,
    projectionCount: PERFORMANCE_COUNT,
    sessionRowsMax: PERFORMANCE_COUNT,
    sourceRowsMax: PERFORMANCE_COUNT,
    transcriptWindowsMax: PERFORMANCE_COUNT,
    transcriptMessagesMax: PERFORMANCE_COUNT,
    projectionDispatchMaxMs: PERFORMANCE_MS,
    longTaskCount: PERFORMANCE_COUNT,
    longTaskTotalMs: PERFORMANCE_MS,
    longTaskMaxMs: PERFORMANCE_MS,
    timerLagCount: PERFORMANCE_COUNT,
    timerLagMaxMs: PERFORMANCE_MS,
    viewReportCount: PERFORMANCE_COUNT,
    viewInputEventCount: PERFORMANCE_COUNT,
    viewInputFrameCount: PERFORMANCE_COUNT,
    viewInputFrameTotalMs: PERFORMANCE_MS,
    viewInputFrameMaxMs: PERFORMANCE_MS,
    viewInputFrameOver50Count: PERFORMANCE_COUNT,
    viewProjectionCommitCount: PERFORMANCE_COUNT,
    viewProjectionCommitTotalMs: PERFORMANCE_MS,
    viewProjectionCommitMaxMs: PERFORMANCE_MS,
    viewProjectionFrameCount: PERFORMANCE_COUNT,
    viewProjectionFrameTotalMs: PERFORMANCE_MS,
    viewProjectionFrameMaxMs: PERFORMANCE_MS,
    viewLongTaskCount: PERFORMANCE_COUNT,
    viewLongTaskTotalMs: PERFORMANCE_MS,
    viewLongTaskMaxMs: PERFORMANCE_MS,
    viewTimerLagCount: PERFORMANCE_COUNT,
    viewTimerLagMaxMs: PERFORMANCE_MS,
    viewDomNodesMax: PERFORMANCE_COUNT,
  }),
  land: body({ branch: NAME, tests: TESTS, retrieval_receipts: RETRIEVAL_RECEIPTS }),
  deploy: body({ target: NAME, manifest_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } }),
  deployConfirm: body({ decision: NAME }),
  // The review lane's maintainer verbs (2026-08-20). Ids are integers so a
  // path-shaped string cannot reach the repository; the note is bounded text.
  mergeDecide: body({ proposal_id: { type: "integer", minimum: 1 }, decision: NAME, note: TEXT }),
  mergeRun: body({ proposal_ids: { type: "array", maxItems: 100, items: { type: "integer", minimum: 1 } } }),
  verify: body({ result: NAME, notes: TEXT }),
  // `kind`/`app_id` remain accepted only so an old browser can file across the
  // rollout. The route ignores technical selectors (except the separate
  // discuss entry); submit classifies the final diff and checks the App set.
  ticketCreate: body({ title: TEXT, body: PROMPT, kind: NAME, app_id: NAME, model: NAME, effort: NAME, requester: NAME, agent_source: NAME, workspace: NAME }),
  // No schema for `/api/tickets/:id/:action`: one route serves `message`,
  // `kind`, `deploy-mark`, `approve-spec`, `requeue`, `cancel` and
  // `interrupt`, and those bodies have nothing in common (two of them have no
  // body at all). A schema wide enough for all of them would describe none.
  // One chunk of a file on its way to a ticket. `data` is base64 and is left
  // untyped-by-length on purpose: the panel's default body window bounds one
  // chunk, and the handler is the only thing that knows what decodes. Absent
  // chunk fields mean a whole file in one chunk (an older page's upload).
  attachment: body({
    name: NAME,
    media_type: NAME,
    data: { type: "string" },
    upload_id: { type: "string", maxLength: 64 },
    chunk_index: { type: "integer", minimum: 0 },
    chunk_count: { type: "integer", minimum: 1 },
    size: { type: "integer", minimum: 1 },
  }),
  adminGrant: body({ username: NAME, capability: NAME }),
  // A local account needs no external identity: the admin names it and hands
  // over the login key it returns. Same shape family as the Feishu import.
  adminLocalUser: body({ username: NAME, display_name: TEXT }),
  adminDashboardToken: body({ username: NAME }),
  // A digest names a release; it is never a path, so 64 hex is the whole rule
  // and the handler checks the alphabet as well. `/api/apps/install` has no
  // schema on purpose: its one field is a whole release bundle, and every
  // constraint that matters about it — asset names, per-asset and total bytes,
  // base64 round-tripping, then every digest recomputed from the real bytes —
  // is enforced by `parseBundle` and the registry, which are the only things
  // that know what a release is.
  // `app` is the stable App id the call is about. Typed and bounded here; the
  // handler looks it up in the catalog, which is the only thing that knows
  // which apps this composition serves — a schema that enumerated them would
  // have to be edited every time a composition changed.
  appsActivate: body({ app: { type: "string", maxLength: 64 }, package_digest: { type: "string", maxLength: 64 } }),
  appsUninstall: body({ app: { type: "string", maxLength: 64 }, package_digest: { type: "string", maxLength: 64 } }),
  appsDeactivate: body({ app: { type: "string", maxLength: 64 } }),
  // Declaring an App. Three bounded strings and nothing else — deliberately no
  // module, port, provider, directory, command or URL, because a declaration
  // that could name an implementation would be a declaration that could install
  // one. The grammar for each (the id doubles as a state directory name) is
  // checked by the composition root, which is the only thing that knows what a
  // declaration has to satisfy.
  // Driving one declared App. `app` also arrives in the query string (it names
  // the App, not a secret); the per-tab handle never appears in a body at all.
  appViewTrust: body({ decision: { type: "string", maxLength: 16 }, follow_updates: { type: "boolean" } }),
  // `params` is deliberately untyped: its shape is the App's own `app.yaml`
  // declaration, which this build reads at dispatch time. A schema here would be
  // a second, always-stale copy of somebody else's contract.
  appAgentStop: { body: { type: "object", additionalProperties: false, required: ["turnId"], properties: { turnId: { type: "string", minLength: 1, maxLength: 128 } } } },
  appViewAct: body({ action: { type: "string", maxLength: 128 } }),
  // Creating or joining one shared instance. The one field is a declared role
  // name; the instance key is a path segment (create mints it server-side, so
  // no body may carry one), and which roles exist is the App's own `app.yaml`
  // table, read by the handler from the release being served.
  appSharedInstance: body({ role: { type: "string", maxLength: 64 } }),
  appSharedMember: body({ username: NAME, role: { type: "string", maxLength: 64 } }),
  appSharedMemberRemove: body({ username: NAME }),
  // Handing one shared instance to an allow-listed external host
  // (`external-app-host/v1`). `host` is an operator-configured id, never an
  // origin the page may name, and `authority` is the human/agent decision this
  // request IS — the handler refuses anything but those two words rather than
  // defaulting, so the dangerous one is not reachable by omission.
  appExternalLaunch: body({
    instance_key: { type: "string", maxLength: 128 },
    host: { type: "string", maxLength: 64 },
    authority: { type: "string", maxLength: 16 },
  }),
  appExternalRevoke: body({ credential_id: { type: "string", maxLength: 128 } }),
  appsDeclare: body({
    app: { type: "string", maxLength: 64 },
    publisher: { type: "string", maxLength: 128 },
    title: { type: "string", maxLength: 120 },
  }),
  adminRename: body({ username: NAME, display_name: TEXT }),
  adminFeishuImport: body({ open_id: NAME, username: NAME, display_name: TEXT }),
} as const;
