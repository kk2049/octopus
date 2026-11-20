/**
 * Configuration loading and type definitions.
 * Loads config.yaml and provides typed access.
 */

import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import type { DiscussionsConfig } from './discussions/types.js';

// ── Config Types ──

export interface FeishuChannelConfig {
  enabled: boolean;
  app_id: string;
  app_secret: string;
  /** Optional bot open_id for exact mention matching in discussion groups. */
  bot_open_id?: string;
}

export interface ChannelsConfig {
  feishu?: FeishuChannelConfig;
}

export interface AgentConfig {
  provider: "claude" | "openai";
  /** Default model for App agents when `app_agents.default_model` is unset. */
  model: string;
}

export interface AnthropicConfig {
  base_url: string;
  api_key: string;
}

export interface OpenAIConfig {
  base_url: string;
  api_key: string;
}

export interface FeishuOAuthConfig {
  app_id: string;
  app_secret: string;
}

export interface FeishuDocsAddonConfig {
  enabled?: boolean;
  /** Feishu tenant_key, not the developer console's numeric tenant ID. */
  tenant_key: string;
  /** Actual native widget iframe origins, exact HTTPS origins only. */
  allowed_origins: string[];
  /**
   * The widget's block type id (`blk_…`, from the developer console). With it,
   * the owner's agents can insert a card block into a document through the
   * OpenAPI; without it, only the card's own picker can place one.
   */
  block_type_id?: string;
}

export interface InstanceConfig {
  name: string;
  data_dir: string;
}

/**
 * The retired secretary network's block (retired 2026-10-15). Nothing in it is
 * read except `scan_homes`, which the Session Hub still honours per user as a
 * deprecated alias of `session_hub.scan_homes` and warns about at startup. The
 * other keys an old config may still carry (`group_delivery`, `model`, …) load
 * and are ignored.
 */
export interface RetiredSecretaryConfig {
  scan_homes?: Record<string, string>;
}

/**
 * The Session Hub's own settings.
 *
 * `scan_homes` used to live under `secretary` only. The secretary network is
 * retired; the old location still works (with a deprecation warning at
 * startup) and this one is where the setting belongs.
 */
export interface SessionHubConfig {
  /**
   * username → home dir whose ~/.claude / ~/.codex the Session Hub may scan ON
   * THIS HOST. Operator-declared trust: only map a
   * user to a real machine home if that home is actually theirs. An online
   * laptop Runner takes priority; users with neither fall back to their
   * bot-managed home (typically empty — the honest empty answer).
   */
  scan_homes?: Record<string, string>;
  /**
   * Trusted owners whose own interactive browser submissions may drive their
   * own Runner session without a second approval click.  This is deliberately
   * an operator allow-list, not a browser toggle: raw bearer requests, Apps,
   * Agents, other owners and all non-session Runner operations still go through
   * the ordinary approval policy.
   */
  direct_submit_auto_allow_users?: string[];
}

/**
 * Session Plus — the isolated Agentic App probe (`packages/bot/src/session-plus`).
 *
 * Off unless `enabled: true`, and an absent block is off: this is an experiment
 * that adds a second browser origin to the deployment, so it may not arrive by
 * default with an upgrade. When it IS on, an unusable block is a startup
 * failure rather than a silent skip — an operator who wrote `enabled: true`
 * believes the feature is running.
 *
 * See `doc/adr/0001-session-plus-trust-boundaries.md` for the origin, cookie
 * and CSP contract, and for what the reverse proxy has to do.
 */
export interface SessionPlusConfig {
  /** Missing or false = closed: no route, no navigation tab, no listener. */
  enabled?: boolean;
  /** Opt into digest paths on dashboard.public_url; supports public HTTPS IP addresses. */
  shared_origin?: boolean;
  /**
   * The exact public origin of the Agent View, whose first DNS label must be
   * `app-<first 20 hex of this build's package digest>` — the startup log
   * prints the label this build expects. Example:
   * `https://app-a74cf19708be421842fa.apps.example.org`.
   *
   * Local development may use `http://app-<label>.localhost:<port>`: browsers
   * resolve `*.localhost` to loopback, and it is a different HOST, which is
   * what keeps the panel's host-only cookies away from it. Another PORT would
   * not — cookies are not port-scoped.
   */
  view_origin?: string;
  /**
   * The host SUFFIX every release of this app is served under, e.g.
   * `apps.example.org`. Mutually exclusive with `view_origin`, and the form a
   * deployment that wants HOT RELEASE UPDATES has to use: the origin becomes
   * `<app_scheme>://app-<20 hex>.<app_domain>`, recomputed from whichever
   * release is active, so activating another one does not need a reverse-proxy
   * edit. Pair it with on-demand TLS gated by `origin_ask_port`.
   */
  app_domain?: string;
  /** `https` (default), or `http` for the documented loopback dev path only. */
  app_scheme?: string;
  /** Public port for the App origin, when the proxy does not terminate on 443/80. */
  app_public_port?: number;
  /** Local port that listener binds. Default: the origin's port, else 9821. */
  view_port?: number;
  /** Local interface for it. Default 127.0.0.1 — a reverse proxy dials it. */
  view_host?: string;
  /**
   * Loopback port for the reverse proxy's on-demand-TLS `ask` endpoint.
   *
   * Absent or 0 leaves it unbuilt. It answers "is this hostname one this host
   * publishes" for exactly the `app-<20 hex>.<app_domain>` shape and refuses
   * everything else, so a proxy configured with `ask` will not try to obtain a
   * certificate for a name nobody serves. Loopback only: a routable bind is an
   * enumeration API for which releases exist here, and the config refuses it.
   */
  origin_ask_port?: number;
  /** Interface for that endpoint. Default 127.0.0.1; non-loopback is refused. */
  origin_ask_host?: string;
  /**
   * App supervisors simultaneously hosted by this bot, including Session Plus.
   * Default 12; valid range 1–64. Excess declarations stay durable but are not
   * composed until capacity is available.
   */
  max_hosted_apps?: number;
  /**
   * Account-scoped deployment grants used by the first-party probe. Entries
   * are persisted as source=config and therefore shown read-only in the UI.
   */
  grants?: Record<string, {
    operations?: string[];
    auto_allow?: string[];
  }>;
}

export interface RunnerGatewayConfig {
  /** Accept Runner device connections. */
  enabled?: boolean;
  /** Public WS port runners dial into. */
  port?: number;
  host?: string;
}

/**
 * One external trusted host that may hold an App binding
 * (`external-app-host/v1`). Secret-free by construction: an entry names an
 * origin a browser can be at, never a credential.
 */
export interface ExternalAppHostConfig {
  /** Stable id a person picks on the trusted page, e.g. `dsh-local`. */
  id: string;
  /** Shown beside the id; defaults to the id. */
  label?: string;
  /** EXACT origin, no wildcard. Plain http is accepted only on loopback. */
  origin: string;
  /** Absolute path on that host which receives the launch fragment. */
  launch_path?: string;
}

/**
 * External Agentic App hosts. Default OFF, and off means every
 * `external-app-host/v1` route answers 404 — there is no implicit localhost.
 * Validated at startup by `app-external/settings.ts`; a malformed entry is a
 * boot failure rather than a silently dropped row.
 */
export interface ExternalAppHostsConfig {
  enabled?: boolean;
  hosts?: ExternalAppHostConfig[];
  /** Seconds a one-shot launch grant stays redeemable (15..900, default 120). */
  launch_ttl_seconds?: number;
  /** Seconds an exchanged binding stays usable (300..2592000, default 43200). */
  capability_ttl_seconds?: number;
  /** Live bindings one account may hold per App (1..64, default 8). */
  max_bindings_per_user?: number;
}

export interface DashboardConfig {
  enabled?: boolean;
  port?: number;
  host?: string;
  /** Optional bearer token; empty = open (the bot then forces a loopback bind). */
  auth_token?: string;
  /**
   * Usernames whose personal `dt_` key carries admin rights (ticket #15):
   * cross-user read, plus handing out capabilities at /admin. Deliberately
   * config-only — if admins could be minted from the panel, one compromised
   * admin could mint more. Empty = no account is admin and only the shared
   * `auth_token` has the full view.
   *
   * Admin is a capability, NOT an identity swap: an admin still writes as
   * themselves, and still cannot write into another user's resources (that
   * would forge authorship).
   */
  admins?: string[];
  /**
   * Public URL runners should dial (shown verbatim in the onboarding
   * tutorial). Set this to the TLS endpoint behind a reverse proxy, e.g.
   * "wss://octopus.example.com/runner". When empty the tutorial falls back
   * to ws://<public_host>:<runner-port> (plaintext — dev only).
   */
  runner_public_url?: string;
  /**
   * Host/IP outside devices use to reach this machine, shown in onboarding
   * tutorials (dashboard page + /runner-token reply). When empty the bot
   * auto-detects it once at startup (EC2 metadata, then an outbound IP echo);
   * set explicitly when detection is wrong (NAT, DNS name, private overlay).
   */
  public_host?: string;
  /**
   * Full public URL of the dashboard itself (e.g. "https://octopus.example.com"
   * behind a TLS reverse proxy). Used verbatim for /dashboard login links;
   * when empty, links fall back to http://<public_host>:<port>.
   */
  public_url?: string;
  /** GitHub OAuth App credentials; the secret is config-only and never stored. */
  oauth_github?: {
    client_id: string;
    client_secret: string;
  };
  /** Whether a verified, unbound external identity may create an account. */
  registration?: "open" | "closed";
}

export interface SelfHostingConfig {
  /** Master switch for the dev-ticket pipeline (phase 1: dev + gates + panel; deploy stays manual). */
  enabled?: boolean;
  /** Bot repo the ticket worktrees hang off. Default: the running checkout. */
  repo_dir?: string;
  /** Where ticket worktrees live. Default: <repo_dir>/../octopus-worktrees */
  worktrees_dir?: string;
  /**
   * Branch landed tickets merge into. It must not be checked out in the
   * deployed run tree, which stays detached. It may be held by a clean primary
   * reference worktree; the pipeline reuses that holder for its ff-only merge.
   */
  base_branch?: string;
  /** Enable only after the old Head writer is drained and the remote lease is initialized. */
  mainline?: { authority: "gitlab"; remote?: string; control_branch?: string };
  /**
   * How many conversation turns may run at once (ticket #12: one pump, no
   * lanes). Code mutation is serialized by the claim lock, not this cap. Turns
   * execute on Runner devices, so it bounds only Head-side supervision.
   * Default 16. (Name kept from the two-lane era.)
   */
  spec_concurrency?: number;
  /**
   * Direct Codex account pool: opaque slot → independent CODEX_HOME. Each
   * directory owns its own file-mode login. New Codex ticket sessions bind to
   * one slot; existing sessions never migrate between slots.
   */
  codex_accounts?: Record<string, string>;
  /** Minimum long-window quota remaining for deliberate new-session routing. Default 5. */
  codex_min_remaining_percent?: number;
  /** devpipe_submit attempts per turn — each failed one burns a gate run. Default 3. */
  max_gate_attempts?: number;
  /**
   * Wall-clock cap on a single dev turn, in minutes. 0/absent = unlimited —
   * a healthy agent is never killed for taking long; hangs are caught by the
   * stall detector below. (Replaced the old fixed 30-min kill, 2026-07-25.)
   */
  turn_timeout_minutes?: number;
  /**
   * Kill a turn whose session transcript stops growing for this many
   * minutes (the observable definition of a hung headless CLI). 0 = never.
   * Default 20.
   */
  turn_stall_minutes?: number;
  /**
   * Run tree the supervisor deploys into (a worktree of repo_dir, detached
   * at the deployed sha). Setting this enables the phase-2 deploy service.
   */
  run_dir?: string;
  /** Verified watermark branch (rollback anchor). Default "stable". */
  stable_branch?: string;
  /** Users allowed to trigger deploys; empty = every personal identity. */
  deployers?: string[];
  /**
   * Thin pre-land gate (default ON): before ANY landing fast-forwards
   * base_branch — web /api/land and devpipe_submit alike — run
   * `pnpm install --frozen-lockfile` + incremental `tsc --noEmit` for
   * packages/bot against the candidate tree in the `_land` staging worktree.
   * Typecheck only, no vitest; the batched post-submit CI stays the complete
   * verdict. `false` = land without the check. (The OPS_LAND_LOCAL=1 fallback
   * in scripts/ops/land.sh never reaches this process, so it bypasses the
   * gate by construction — that path exists for when the deployed machinery
   * itself is broken.)
   */
  land_gate?: boolean;
  /**
   * Run a CI repair ticket's failure roster inside the land gate (default ON;
   * ticket #219). The one lane where the gate runs vitest: a repair ticket's
   * acceptance criterion IS a list of spec files, and letting it land an
   * unverified guess spends a 20-45 minute batch to say "still red". Only the
   * files that batch named are run, in the `_land` staging tree, under their
   * own budget. `false` drops just this step — separate from `land_gate` so an
   * operator can shed the minutes without also losing the typecheck.
   */
  ci_roster_gate?: boolean;
  /**
   * Rerun the spec files a landing's own diff touched (and the sibling
   * `X.test.ts(x)` of changed sources) inside the land gate, both doors
   * (default ON; 2026-08-17). Measured motivation: in 8 of 11 red batches on
   * 2026-08-17 the failing spec file was modified inside that batch's own
   * landing window — the landing shipped a test it never ran. `false` drops
   * just this step, keeping the typecheck and the repair-roster step.
   */
  changed_tests_gate?: boolean;
  /** Control-node release installation. The configured CI provider builds complete releases. */
  deployment_build?: {
    mode: "remote" | "gitlab";
    gitlab?: { api_url: string; project: string; token_file: string };
    /** Execution devices whose build capability is explicitly served by ci_machine (for example its isolated CI container). */
    execution_devices?: string[];
  };
  /**
   * The lht-val15 CI container an eligible development agent may work inside.
   *
   * Set it and tickets requested by the device owner get `machine_*` tools
   * bound to that device, running unsupervised in per-ticket worktrees. The
   * grant remains owner-bound: another requester's ticket gets no cross-user
   * machine authority. Credentials are minted per turn and revoked at end.
   *
   * Absent = the lane behaves exactly as it did before: this node only, and
   * the prompt says nothing about machine tools. Deploy the container with
   * `ops/ci-container/install.sh` on lht-val15.
   */
  ci_machine?: {
    /**
     * Existing bot username that owns this exact Runner registration. Device
     * labels are owner-scoped and must never be resolved globally.
     */
    owner: string;
    /** Runner device name, as `machines_list` reports it. */
    device: string;
    /** Shared object/Runner checkout inside the container, e.g. /work/octopus. Ticket worktrees are siblings under /work/tickets. */
    checkout_dir: string;
    /**
     * Run the landing gate's steps (install, incremental tsc, the named and
     * diff-derived tests) on this machine, in the pipeline-owned
     * `<work>/land` worktree, instead of on this node (default true,
     * 2026-08-21). The gate falls back to `_land` here whenever the device is
     * offline or stops answering; `false` keeps it here unconditionally.
     */
    gate?: boolean;
    /** Registered workspace provider; activates durable jobs and prohibits local gate fallback. */
    workspace_id?: string;
    remote_required?: boolean;
    /**
     * How many ticket workspace syncs (install + test-ready builds) may run
     * on the machine at the same time (default 1, 2026-08-22). Three at once
     * saturated the 48-core box: load 48, the Runner silent for a minute,
     * sshd's key exchange stalled past LoginGraceTime. The land gate is
     * already serialised by the merge lock and is not counted here.
     */
    sync_concurrency?: number;
    /**
     * When the device's Runner is offline, reach the box over ssh
     * (`ops/ci-container/sync-workspace.sh`, bastion-hopped) instead of
     * waiting. Default false since 2026-08-22: the ssh path storms the
     * bastion with serial round trips exactly when the box is struggling,
     * and a turn that waits is told the moment the Runner is back
     * (resources/recovery.ts). `true` restores the old fallback.
     */
    ssh_fallback?: boolean;
  };
  /**
   * Durable knowledge artifact production on one trusted Runner device.
   * Missing inherits `ci_machine`; false disables without exposing a fallback.
   */
  knowledge_index?: {
    enabled?: boolean;
    /** Independent first-party provider; absent preserves the ci_machine target. */
    runner?: {
      owner: string;
      device: string;
      checkout_dir: string;
    };
  };
  /**
   * Per-user development machines (2026-08-20), keyed by username: a
   * contributor's own container, reached only through their Runner. Same shape
   * as `ci_machine`; the difference is transport — code is synced as a one-shot
   * git bundle the container downloads from `dashboard.public_url`, because
   * the bot host has no ssh into somebody's laptop. The owner check is
   * structural: the grant is derived for the requester over their own device,
   * and a device not registered to them yields no machine lane at all.
   */
  dev_machines?: Record<string, { device: string; checkout_dir: string }>;
  /**
   * codex-runner ticket lane (#358), keyed by username: which of the user's
   * OWN Runner devices hosts their Codex login for dev-ticket turns. Optional —
   * without an entry the pipeline picks the user's online device whose
   * inventory reports an authenticated Codex (sorted by device name). The
   * ownership check stays structural either way: a device not registered to
   * the requester yields no lane.
   */
  dev_codex_runners?: Record<string, string>;
  /** Required to execute ticket agents. Missing refuses execution; Head CLI fallback is retired. */
  runner_tickets?: import("./devpipe/runner-ticket.js").TicketRunnerConfig;
  /**
   * Post-landing build warming (default ON): after any landing fast-forwards
   * base_branch, build that exact sha in the `_warm` staging worktree so the
   * shared build cache (`tools/build-cache`) is already populated when someone
   * deploys. Purely a latency optimisation — it holds no lock, changes nothing
   * about what lands or deploys, and a failure just means the deploy builds
   * the way it did before. `false` = never warm.
   */
  build_warm?: boolean;
  /**
   * Optional overnight GitLab CI projection. At Beijing 04:00 it triggers one
   * complete mainline scan; every repair landing is then verified immediately
   * in the same ticket/session until a green batch closes the loop.
   */
  gitlab_ci?: {
    enabled?: boolean;
    /** GitLab v4 API root, for example https://gitlab.example/api/v4. */
    api_url: string;
    /** Numeric project id or namespace/project path. */
    project: string | number;
    /** Access token with api scope (read results + trigger batches). */
    token?: string;
    /**
     * Private file holding that token instead of an inline `token`, e.g. the
     * `deployment_build.gitlab.token_file` the release path already reads.
     */
    token_file?: string;
    /** Branch scanned overnight. Defaults to base_branch. */
    ref?: string;
    /** Existing bot username that owns the one continuing repair conversation. */
    repair_requester: string;
    poll_seconds?: number;
    /** A due scan waits for the mainline tip to stay still this long. Default 60s. */
    debounce_seconds?: number;
  };
}

export interface BotConfig {
  discussions?: DiscussionsConfig;
  instance: InstanceConfig;
  channels: ChannelsConfig;
  agent: AgentConfig;
  anthropic: AnthropicConfig;
  openai: OpenAIConfig;
  /** Inherits app_agents enablement and its existing shared model resource. */
  research_v2?: {
    filter_model?: string;
    transcription_model?: string;
    /** The device owns its fixed MOSS pipeline, model and output configuration. */
    moss?: { device: string; timeout_ms?: number };
  };
  feishu_oauth?: FeishuOAuthConfig;
  feishu_docs_addon?: FeishuDocsAddonConfig;
  /**
   * What an ordinary Agent may do with the account owner's Feishu identity
   * (SEC-03, `packages/bot/src/feishu/grants.ts`).
   *
   * Absent means no agent gets any Feishu tool. The gateway makes "as whom" a
   * server-side decision; this makes "to do what" an explicit one, because
   * removing the confused deputy is not the same as granting an agent the
   * whole catalog.
   */
  feishu_gateway?: import("./feishu/grants.js").FeishuGatewayYamlConfig;
  secretary?: RetiredSecretaryConfig;
  session_hub?: SessionHubConfig;
  session_plus?: SessionPlusConfig;
  runner?: RunnerGatewayConfig;
  external_app_hosts?: ExternalAppHostsConfig;
  dashboard?: DashboardConfig;
  selfhosting?: SelfHostingConfig;
  hq?: HqConfig;
  app_agents?: AppAgentsConfig;
  /**
   * Legacy home of `app_agents.deployment_profile`. The v3 engine Host this
   * block once configured is retired; bootstrap-v3 still reads the profile from
   * here (and refuses a conflicting duplicate), so only that key remains typed.
   */
  v3_host?: { deployment_profile?: AppAgentsConfig["deployment_profile"] };
}

/**
 * App agents: the backend-side agents an Agentic App release declares.
 *
 * Everything here is an OPERATOR decision, which is the point of it being
 * configuration and not release metadata. A release names an agent, an adapter,
 * a model and a prompt; the deployment decides whether agents run at all, which
 * models it is willing to pay for, and how much of its own machine one turn may
 * use. The two never merge: a release cannot widen this, and this cannot
 * rewrite what a release asked for (an unserved model is a refusal at prepare,
 * not a silent substitution — swapping a model swaps the cost, the behaviour
 * and the output with nobody informed).
 */
export interface AppAgentsConfig {
  /** Default OFF. An agent plane that appears by accident is a spend nobody chose. */
  enabled?: boolean;
  /**
   * SEC-06 execution profile, declared explicitly.
   *
   * The engine's default is already the strict one (`cloud-multi-user`), so
   * omitting this is not a hole — but the `local-owner` disclosure ("this
   * deployment makes no multi-user file-isolation promise") cannot be printed
   * by a process that was never told, and an operator who believes they
   * configured `local-owner` has no way to find out they did not.
   */
  deployment_profile?: "cloud-multi-user" | "local-owner" | "trusted-service";
  /**
   * Models a release may name. Empty or absent means this deployment is not
   * adjudicating models, and a release's choice is served as written.
   */
  models?: string[];
  /** Used when a release names no model. */
  default_model?: string;
  default_effort?: "minimal" | "low" | "medium" | "high" | "max";
  /** Tool-loop ceiling per turn. Default 24 (the engine's value). */
  max_tool_turns?: number;
  /** Whole-turn budget, including every tool call. Default 10 minutes. */
  turn_timeout_ms?: number;
  /** One LLM request's budget. Default 5 minutes. */
  request_timeout_ms?: number;
  /** Turns in flight across every App and account. Default 2. */
  max_concurrent_turns?: number;
  /** Per (app, scope, agent), per local day. Default 60. */
  turns_per_account_per_day?: number;
}

/**
 * The block that configured the retired HQ workbench chat (retired
 * 2026-10-15). Knowledge Chat still reads its model from here, so only these
 * two keys remain; the old `chat_max_tool_turns` and
 * `daily_refresh_hour_beijing` load and are ignored.
 */
export interface HqConfig {
  /** Knowledge Chat model. Default gpt-6-astra. */
  chat_model?: string;
  /** Thinking effort for that model. Default high. */
  chat_reasoning_effort?: "minimal" | "low" | "medium" | "high";
}

// ── Defaults ──

const DEFAULT_CONFIG: BotConfig = {
  instance: {
    name: "claude-bot",
    data_dir: "/data",
  },
  channels: {},
  agent: {
    provider: "openai",
    model: "gpt-4.1-mini",
  },
  anthropic: {
    base_url: "https://api.anthropic.com",
    api_key: "",
  },
  openai: {
    base_url: "https://api.openai.com/v1",
    api_key: "",
  },
};

// ── Loader ──

/** Every top-level key BotConfig declares; the compiler keeps it in step with the interface. */
const KNOWN_CONFIG_KEYS: Record<keyof BotConfig, true> = {
  discussions: true, instance: true, channels: true, agent: true, anthropic: true, openai: true,
  research_v2: true, feishu_oauth: true, feishu_docs_addon: true, feishu_gateway: true, secretary: true,
  session_hub: true, session_plus: true, runner: true, external_app_hosts: true, dashboard: true,
  selfhosting: true, hq: true, app_agents: true, v3_host: true,
};

/**
 * Top-level keys of retired features (the v2 entry's chat runtime, the legacy
 * remote MCP switch, the dsh session channel, the per-user dsh fleet). Existing
 * config.yaml files still carry them; they load and do nothing, and they are
 * not typos, so they are not reported.
 */
const RETIRED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "session_channel", "plugins", "skills", "remotes", "presets", "rag", "group_mode", "notify_on_start",
  "lifecycle", "security", "fleet",
]);

/** Top-level keys no part of the bot declares: usually a typo that silently does nothing. */
export function unknownConfigKeys(parsed: Record<string, unknown>): string[] {
  return Object.keys(parsed).filter((key) => !Object.hasOwn(KNOWN_CONFIG_KEYS, key) && !RETIRED_CONFIG_KEYS.has(key));
}

/**
 * Unknown keys are only reported, never refused: they stay in the merged
 * object for deployment/rollback compatibility.
 */
export function loadConfig(configPath: string, warn: (message: string) => void = (message) => console.warn(message)): BotConfig {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = yaml.load(raw) as Record<string, unknown> | null;
  if (!parsed) {
    throw new Error(`Empty config file: ${configPath}`);
  }
  const unknown = unknownConfigKeys(parsed);
  if (unknown.length) {
    warn(`config ${configPath}: unknown top-level key(s) ${unknown.join(", ")} have no effect; check the spelling against config.yaml.example`);
  }

  // Preserve unknown fields for deployment/rollback compatibility. In particular,
  // legacy research_v2.moss paths may still exist in YAML; bootstrap deliberately
  // forwards only device/timeout_ms to the device-managed transcription provider.
  const merged = deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, parsed) as unknown as BotConfig;

  // Backward compatibility for old config without provider:
  // if only anthropic key is configured, keep using claude by default.
  const parsedAgent = parsed.agent as Record<string, unknown> | undefined;
  const hasProvider = typeof parsedAgent?.provider === "string";
  if (!hasProvider) {
    const anthropicKey = merged.anthropic.api_key?.trim();
    const openaiKey = merged.openai.api_key?.trim();
    if (anthropicKey && !openaiKey) {
      merged.agent.provider = "claude";
      if (merged.agent.model === DEFAULT_CONFIG.agent.model) {
        merged.agent.model = "claude-sonnet-4-6";
      }
    }
  }

  const runnerPublicUrl = merged.dashboard?.runner_public_url;
  if (typeof runnerPublicUrl === "string" && runnerPublicUrl.length > 0) {
    assertRunnerPublicUrl(runnerPublicUrl);
  }

  const ciMachine = merged.selfhosting?.ci_machine;
  if (ciMachine?.workspace_id !== undefined && !/^ws_[0-9a-f]{24}$/.test(ciMachine.workspace_id)) {
    throw new Error("selfhosting.ci_machine.workspace_id must be a registered workspace id");
  }
  if ((ciMachine?.workspace_id || ciMachine?.remote_required) && ciMachine.gate === false) {
    throw new Error("required workspace provider gate cannot be disabled");
  }
  if (ciMachine && (
    typeof ciMachine.owner !== "string"
    || ciMachine.owner.trim() !== ciMachine.owner
    || ciMachine.owner.length < 1
    || ciMachine.owner.length > 128
  )) {
    throw new Error("selfhosting.ci_machine.owner must be an explicit bot username");
  }

  for (const [owner, target] of Object.entries(merged.selfhosting?.runner_tickets?.targets ?? {})) {
    const defaults = (target?.workspaces ?? []).filter((workspace) => workspace?.default === true);
    if (defaults.length > 1) {
      throw new Error(`selfhosting.runner_tickets.targets.${owner}.workspaces marks more than one default workspace`);
    }
  }

  const knowledgeRunner = merged.selfhosting?.knowledge_index?.runner;
  if (knowledgeRunner !== undefined) {
    if (!knowledgeRunner || typeof knowledgeRunner !== "object" || Array.isArray(knowledgeRunner)) {
      throw new Error("selfhosting.knowledge_index.runner must be an explicit owner/device/checkout_dir target");
    }
    for (const key of ["owner", "device"] as const) {
      const value = knowledgeRunner[key];
      if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) {
        throw new Error(`selfhosting.knowledge_index.runner.${key} must be an explicit non-empty identifier`);
      }
    }
    const checkout = knowledgeRunner.checkout_dir;
    if (typeof checkout !== "string" || !checkout.startsWith("/") || checkout.length > 4096
      || checkout === "/" || checkout.trim() !== checkout || /[\x00-\x1f\x7f]/.test(checkout)
      || checkout.split("/").some((part) => part === "." || part === "..")) {
      throw new Error("selfhosting.knowledge_index.runner.checkout_dir must be an absolute Linux checkout path");
    }
  }

  return merged;
}

/**
 * Fail-closed check on `dashboard.runner_public_url`: plaintext `ws://` is
 * only accepted on loopback (127.0.0.1, ::1, localhost) because that URL is
 * shown verbatim in the onboarding tutorial and dictates the transport a
 * remote runner will actually use. Any public host must be reached over TLS.
 */
/** The GitLab CI token: inline `token`, else the first line of `token_file`. */
export function gitlabCiToken(cfg: NonNullable<SelfHostingConfig["gitlab_ci"]>): string {
  const token = cfg.token ?? (cfg.token_file ? readFileSync(cfg.token_file, "utf8").trim() : "");
  if (!token) throw new Error("selfhosting.gitlab_ci needs token or token_file");
  return token;
}

export function assertRunnerPublicUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `dashboard.runner_public_url is not a valid URL: ${JSON.stringify(value)}`,
    );
  }
  if (url.protocol === "wss:") return;
  if (url.protocol === "ws:") {
    const raw = url.hostname;
    const host = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
    if (host === "127.0.0.1" || host === "::1" || host === "localhost") return;
    throw new Error(
      `dashboard.runner_public_url rejects ws:// on non-loopback host ${JSON.stringify(raw)}; use wss:// for public runner endpoints.`,
    );
  }
  throw new Error(
    `dashboard.runner_public_url must use wss:// (or ws:// for loopback only); got ${JSON.stringify(url.protocol)}.`,
  );
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

// ── Constants ──

export const HEALTH_FILE = "/tmp/claude-bot-health";
