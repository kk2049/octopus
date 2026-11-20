/**
 * The deployment execution profile — what KIND of host this process is, decided
 * once by whoever runs it, and never by anything that runs inside it.
 *
 * ── Why this exists, and why it is not `secure_mode` ────────────────────────
 *
 * `secure-mode.ts` answers "may an unisolated execution path exist in this
 * process at all". It is a single boolean an operator flips for local probe
 * work, and flipping it re-enables the coding-CLI adapters everywhere.
 *
 * SEC-06 asks a different question, and it has a different answer: on a host
 * that serves MORE THAN ONE PERSON, an ordinary v3 App must not be able to
 * select Claude Code or Codex as its Agent backend — no matter what secure mode
 * says. Those CLIs are complete developer agents (native file, shell, network,
 * plugin, session and credential semantics); running one as a shared service
 * puts the host's whole permission domain, its credentials and its cross-session
 * state inside the application TCB. There is no per-deployment reason to allow
 * it, so there is no per-deployment switch that allows it.
 *
 * The two are therefore composed, not merged:
 *
 *     cloud-multi-user  → ordinary App agents: NO coding CLI, ever.
 *                         secure_mode=false does not reach this decision.
 *     local-owner       → one person, one trust domain. Coding CLI is allowed
 *                         for App agents, subject to secure mode, and the boot
 *                         log + the permissions UI say plainly that this
 *                         deployment makes no multi-user file-isolation promise.
 *     trusted-service   → a process that only runs owner-only privileged
 *                         executors (Dev Factory). No ordinary App agents live
 *                         here at all.
 *
 * ── What the ban does NOT touch ────────────────────────────────────────────
 *
 * It is a ban on ONE thing: an ordinary App choosing a coding CLI as its Agent
 * loop. Three paths that also involve those CLIs are deliberately outside it,
 * because they are not "a public service running a developer agent":
 *
 *   · Session Hub. list/search/read/live/append/resume operate on sessions the
 *     USER already started on their OWN machine. The CLI runs on their laptop,
 *     under their OS account, with credentials they installed. What this system
 *     controls is the session operations, and it controls them per owner.
 *   · `system:dev-factory`. An owner-only trusted service with a fixed repo,
 *     worktree and command boundary, audited as a privileged executor and shown
 *     as one. Not a normal App Agent and not pretending to be.
 *   · An explicit `local-owner` deployment, as above.
 *
 * Which is why the enforcement point is the ADAPTER SELECTION of an App agent,
 * and why nothing here deletes `CliLoop` from the shared library: deleting it
 * would break all three of the paths that are supposed to keep working.
 */

import { adapterAllowed, adapterRefusal, secureMode } from "./secure-mode.js";

export const DEPLOYMENT_PROFILES = ["cloud-multi-user", "local-owner", "trusted-service"] as const;
export type DeploymentProfile = (typeof DEPLOYMENT_PROFILES)[number];

/**
 * Adapters that ARE a full developer agent rather than a tool-calling loop.
 * Kept separate from `UNISOLATED_ADAPTERS` even though the two lists are equal
 * today: they answer different questions, and if a third CLI arrives that is
 * isolated but still a developer agent, only one of the lists should grow.
 */
export const CODING_CLI_ADAPTERS = ["claude-code", "codex"] as const;

/**
 * Default is the strict one. A deployment that forgot to declare its profile is
 * far more likely to be a shared host than a laptop, and the failure mode of
 * guessing wrong in that direction is "an operator has to type one line".
 */
let profile: DeploymentProfile = "cloud-multi-user";
/** True once a trusted caller declared the profile — for the boot inventory. */
let declared = false;

/**
 * Called once at boot from operator config. Not exported through any request
 * path, and there is no per-app or per-agent override: an App that could
 * declare its own execution profile would be an App granting itself a host.
 */
export function setDeploymentProfile(value: string | undefined): DeploymentProfile {
  const v = String(value ?? "").trim();
  if (!v) {
    profile = "cloud-multi-user";
    declared = false;
    return profile;
  }
  if (!(DEPLOYMENT_PROFILES as readonly string[]).includes(v)) {
    throw new Error(
      `unknown deployment profile "${v}" (known: ${DEPLOYMENT_PROFILES.join(", ")})`,
    );
  }
  profile = v as DeploymentProfile;
  declared = true;
  return profile;
}

export function deploymentProfile(): DeploymentProfile {
  return profile;
}

/** Whether the profile came from configuration or from the strict default. */
export function deploymentProfileDeclared(): boolean {
  return declared;
}

/** Test-only reset, so one suite cannot leak a profile into the next. */
export function resetDeploymentProfile(): void {
  profile = "cloud-multi-user";
  declared = false;
}

export function isCodingCliAdapter(kind: string): boolean {
  return (CODING_CLI_ADAPTERS as readonly string[]).includes(kind);
}

/**
 * Machine-readable refusal codes. The UI and the tests both want to distinguish
 * "this deployment forbids it structurally" from "secure mode is on", because
 * only the second one has an operator switch.
 */
export type AdapterRefusalCode = "profile_forbids_coding_cli" | "secure_mode" | "unknown_adapter";

export type AdapterVerdict =
  | { ok: true }
  | { ok: false; code: AdapterRefusalCode; reason: string };

/**
 * May an ORDINARY App agent run on this adapter, here, right now?
 *
 * The order matters: the profile ban is checked first and answers on its own,
 * so no combination of secure-mode settings can reach past it. That is the
 * whole of "`secure_mode=false` cannot buy back the exception".
 */
export function appAgentAdapterVerdict(kind: string): AdapterVerdict {
  if (isCodingCliAdapter(kind)) {
    if (profile === "cloud-multi-user") {
      return { ok: false, code: "profile_forbids_coding_cli", reason: codingCliRefusal(kind) };
    }
    if (profile === "trusted-service") {
      return {
        ok: false,
        code: "profile_forbids_coding_cli",
        reason:
          `部署配置为 trusted-service：本进程只运行 owner-only 的受信执行器，`
          + `不承载普通 App Agent，因此适配器「${kind}」在这里没有可用的入口。`,
      };
    }
    // local-owner: allowed as far as the profile is concerned; secure mode
    // still gets its say below.
  }
  if (!adapterAllowed(kind)) {
    return { ok: false, code: "secure_mode", reason: adapterRefusal(kind) };
  }
  return { ok: true };
}

/** Convenience for call sites that only branch on the boolean. */
export function appAgentAdapterAllowed(kind: string): boolean {
  return appAgentAdapterVerdict(kind).ok;
}

export function codingCliRefusal(kind: string): string {
  return (
    `部署配置为 cloud-multi-user：普通 App 的 Agent 后端不能是「${kind}」。`
    + `Claude Code / Codex 是完整的开发者代理（原生文件、shell、网络、插件、会话与凭据语义），`
    + `把宿主机上的一个 CLI 进程当作多用户公共服务，会把过大的权限域、宿主凭据和跨会话状态`
    + `带进应用 TCB。这条限制不受 secure_mode 影响。`
    + `\n· 要操作你自己机器上已有的 Claude/Codex 会话，请用会话中心（Session Hub）：`
    + `它只授权 list/read/live/append/resume，CLI 内部权限由设备主人配置。`
    + `\n· 需要重型 coding CLI 的开发流水线是 system:dev-factory 受信服务，不经普通 App Agent 启动。`
    + `\n· 单人本地部署可显式声明 v3_host.deployment_profile: local-owner（无多用户文件隔离承诺）。`
  );
}

/**
 * One line for the boot log and the permissions UI, when the deployment has
 * traded the multi-user guarantee away. Empty when it has not.
 */
export function profileDisclosure(): string {
  switch (profile) {
    case "local-owner":
      return (
        "部署配置为 local-owner：单人信任域，普通 App Agent 可使用 coding CLI，"
        + "本部署不提供多用户文件隔离保证。"
      );
    case "trusted-service":
      return "部署配置为 trusted-service：只承载 owner-only 受信执行器，不承载普通 App Agent。";
    default:
      return "";
  }
}

// ── startup inventory ──

export interface ExecutorEntry {
  /** Stable id used by tests and the permissions UI. */
  id: string;
  kind: "loop-adapter" | "cli-executor" | "trusted-service";
  /** Who can reach it: an ordinary App agent, or only a privileged path. */
  reachableBy: "app-agent" | "owner-session" | "trusted-service";
  /** True when this entry is a full coding CLI rather than a tool-calling loop. */
  codingCli: boolean;
  /** Whether it is actually wired up in this process right now. */
  registered: boolean;
  note?: string;
}

export interface ExecutionInventory {
  profile: DeploymentProfile;
  profileDeclared: boolean;
  secureMode: boolean;
  disclosure: string;
  executors: ExecutorEntry[];
  /**
   * The number SEC-06 §4.4.5 asks for: coding CLIs an ordinary App agent could
   * reach. Must be 0 on a `cloud-multi-user` host, and the assertion for that
   * lives in the tests rather than in a comment.
   */
  appReachableCodingCli: number;
}

/**
 * Assemble the inventory from what is actually registered, not from what the
 * config asked for. Callers pass the adapter kinds they wired plus any
 * privileged executors they own, so a process that quietly registered
 * something extra shows up here rather than in nobody's log.
 */
export function executionInventory(o: {
  /** Loop adapters registered on the ordinary AgentPlane. */
  appAdapters?: readonly string[];
  /** Owner-bound CLI surfaces (Session Hub) that are enabled. */
  ownerCliSurfaces?: readonly { id: string; note?: string }[];
  /** Privileged executors (Dev Factory and friends) that are enabled. */
  trustedServices?: readonly { id: string; note?: string }[];
}): ExecutionInventory {
  const executors: ExecutorEntry[] = [];
  for (const kind of o.appAdapters ?? []) {
    executors.push({
      id: `loop:${kind}`,
      kind: "loop-adapter",
      reachableBy: "app-agent",
      codingCli: isCodingCliAdapter(kind),
      registered: true,
    });
  }
  for (const s of o.ownerCliSurfaces ?? []) {
    executors.push({
      id: s.id,
      kind: "cli-executor",
      reachableBy: "owner-session",
      codingCli: true,
      registered: true,
      note: s.note,
    });
  }
  for (const s of o.trustedServices ?? []) {
    executors.push({
      id: s.id,
      kind: "trusted-service",
      reachableBy: "trusted-service",
      codingCli: true,
      registered: true,
      note: s.note,
    });
  }
  return {
    profile,
    profileDeclared: declared,
    secureMode: secureMode(),
    disclosure: profileDisclosure(),
    executors,
    appReachableCodingCli: executors.filter((e) => e.reachableBy === "app-agent" && e.codingCli).length,
  };
}
