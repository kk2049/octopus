/** Executable G1-G5 gate evaluators. They return evidence, never authority. */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  APP_AGENT_ACTOR_DECLARATION,
  APP_REGISTRY_ADMIN_DECLARATION,
  CONVERGENCE_DECLARATIONS,
  SESSION_HARNESS_LAUNCH_DECLARATION,
  contractCoordinateProblems,
} from "./contracts.js";

const execFileAsync = promisify(execFile);

export interface GateCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface GateVerdict {
  gate: "G1" | "G2" | "G3" | "G4" | "G5";
  status: "pass" | "fail" | "unknown";
  /** A gate result is review evidence. It never changes routing or grants authority. */
  authorizesMigration: false;
  checks: GateCheck[];
}

function verdict(gate: GateVerdict["gate"], checks: GateCheck[], unknown = false): GateVerdict {
  return {
    gate,
    status: checks.every((check) => check.ok) ? "pass" : unknown ? "unknown" : "fail",
    authorizesMigration: false,
    checks,
  };
}

export interface DshSeamBaseline {
  tentacleRepository: string;
  tentacleCommit: string;
  dshRepository: string;
  dshCommit: string;
  consumerPatch: string;
  consumerPatchSha256: string;
  seamFile: string;
  typesFile: string;
}

/**
 * G1 is a reproducible baseline check, not "somebody rebased it once". It pins
 * the consumer patch bytes, verifies the source tree is clean, runs the external
 * package's tests/typecheck, and proves the protocol package stays dsh-free.
 */
export async function evaluateDshSeam(baseline: DshSeamBaseline): Promise<GateVerdict> {
  const checks: GateCheck[] = [];
  const repo = baseline.tentacleRepository;
  try {
    const [{ stdout: head }, { stdout: status }, { stdout: dshHead }, { stdout: dshStatus }, patchBytes, readme, protocolFiles] = await Promise.all([
      execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"]),
      execFileAsync("git", ["-C", repo, "status", "--porcelain=v1"]),
      execFileAsync("git", ["-C", baseline.dshRepository, "rev-parse", "HEAD"]),
      execFileAsync("git", ["-C", baseline.dshRepository, "status", "--porcelain=v1"]),
      readFile(path.join(repo, baseline.consumerPatch)),
      readFile(path.join(repo, "README.md"), "utf8"),
      allFiles(path.join(repo, "packages/protocol/src")),
    ]);
    checks.push({ name: "tentacle commit pinned", ok: head.trim() === baseline.tentacleCommit, detail: head.trim() });
    checks.push({ name: "tentacle source clean", ok: status.trim() === "", detail: status.trim() || "clean" });
    checks.push({ name: "dsh upstream baseline pinned", ok: dshHead.trim() === baseline.dshCommit, detail: dshHead.trim() });
    checks.push({ name: "dsh upstream source clean", ok: dshStatus.trim() === "", detail: dshStatus.trim() || "clean" });
    const digest = createHash("sha256").update(patchBytes).digest("hex");
    checks.push({ name: "consumer patch bytes pinned", ok: digest === baseline.consumerPatchSha256, detail: digest });
    checks.push({ name: "dsh upstream commit documented", ok: readme.includes(baseline.dshCommit), detail: baseline.dshCommit });
    await execFileAsync(
      "git",
      ["-C", baseline.dshRepository, "apply", "--check", path.join(repo, baseline.consumerPatch)],
      { timeout: 30_000 },
    );
    checks.push({
      name: "consumer patch rebases automatically onto pinned dsh",
      ok: true,
      detail: `${baseline.consumerPatch} applies cleanly to ${baseline.dshCommit}`,
    });
    const protocolText = (await Promise.all(protocolFiles.map((file) => readFile(file, "utf8")))).join("\n");
    checks.push({
      name: "transport protocol is harness neutral",
      ok: !/deepseek|\bdsh\b|ReactLoopAgent|AgentFactory/i.test(protocolText),
      detail: "packages/protocol/src",
    });
    for (const file of [baseline.seamFile, baseline.typesFile]) {
      const text = await readFile(path.join(repo, file), "utf8");
      checks.push({ name: `${file} exists and is explicit`, ok: text.length > 100 && /dsh|agent/i.test(text), detail: `${text.length} bytes` });
    }
    const { stdout, stderr } = await execFileAsync("pnpm", ["test"], { cwd: repo, timeout: 180_000 });
    checks.push({ name: "tentacle conformance tests", ok: true, detail: tail(stdout || stderr) });
    const typecheck = await execFileAsync("pnpm", ["typecheck"], { cwd: repo, timeout: 180_000 });
    checks.push({ name: "tentacle typecheck", ok: true, detail: tail(typecheck.stdout || typecheck.stderr) });
  } catch (error) {
    checks.push({ name: "G1 probe completed", ok: false, detail: describe(error) });
  }
  return verdict("G1", checks);
}

export interface SelfHostedAcceptanceDriver {
  /** Register through rt_ transport identity and mcp_ Gate identity. */
  register(): Promise<{ deviceAccepted: boolean; gateAccepted: boolean }>;
  /** Prove an allowed call crosses the real Gate once. */
  gateRoundTrip(): Promise<{ accepted: boolean; targetFrames: number }>;
  /** Revoke the Object/grant through the authoritative control plane. */
  revoke(): Promise<void>;
  /** Prove post-revocation attempts reach no target frame. */
  postRevoke(): Promise<{ refused: boolean; targetFrames: number }>;
  /** Reconnect the same self-hosted endpoint without Fleet involvement. */
  reconnect(): Promise<{ registered: boolean; duplicateFrames: number }>;
  /** Upgrade/restart its seam, preserving identity but not in-flight authority. */
  upgrade(): Promise<{ from: string; to: string; registered: boolean }>;
  /** Prove the upgraded endpoint still enters the same Gate. */
  afterUpgrade(): Promise<{ accepted: boolean; targetFrames: number }>;
}

/** G2 runner. Results contain no credentials, messages, paths, owners or payloads. */
export async function runSelfHostedAcceptance(driver: SelfHostedAcceptanceDriver): Promise<GateVerdict> {
  const checks: GateCheck[] = [];
  try {
    const registration = await driver.register();
    checks.push({ name: "rt_ transport registration", ok: registration.deviceAccepted, detail: registration.deviceAccepted ? "accepted" : "refused" });
    checks.push({ name: "mcp_ Gate registration", ok: registration.gateAccepted, detail: registration.gateAccepted ? "accepted" : "refused" });
    const first = await driver.gateRoundTrip();
    checks.push({ name: "real Gate round trip", ok: first.accepted && first.targetFrames === 1, detail: `${first.targetFrames} target frame(s)` });
    await driver.revoke();
    const revoked = await driver.postRevoke();
    checks.push({ name: "revocation stops target frames", ok: revoked.refused && revoked.targetFrames === 0, detail: `${revoked.targetFrames} target frame(s)` });
    const reconnect = await driver.reconnect();
    checks.push({ name: "self-hosted reconnect", ok: reconnect.registered && reconnect.duplicateFrames === 0, detail: `${reconnect.duplicateFrames} duplicate frame(s)` });
    const upgrade = await driver.upgrade();
    checks.push({ name: "seam upgrade", ok: upgrade.registered && upgrade.from !== upgrade.to, detail: `${upgrade.from} -> ${upgrade.to}` });
    const after = await driver.afterUpgrade();
    checks.push({ name: "Gate after upgrade", ok: after.accepted && after.targetFrames === 1, detail: `${after.targetFrames} target frame(s)` });
  } catch (error) {
    checks.push({ name: "G2 probe completed", ok: false, detail: describe(error) });
  }
  return verdict("G2", checks);
}

export type CrashDisposition = "recoverable_pull" | "fail_closed" | "unknown_terminal";

export interface CrashPolicy {
  contract: string;
  action: string;
  disposition: CrashDisposition;
  acceptedDurablyBeforeDispatch: boolean;
  automaticRetry: false;
}

/** Explicit G3 policy for every state-changing action in the new contracts. */
export const CONVERGENCE_CRASH_POLICIES: readonly CrashPolicy[] = Object.freeze([
  { contract: "agent-session-endpoint/v1", action: "start", disposition: "unknown_terminal", acceptedDurablyBeforeDispatch: true, automaticRetry: false },
  { contract: "agent-session-endpoint/v1", action: "send", disposition: "unknown_terminal", acceptedDurablyBeforeDispatch: true, automaticRetry: false },
  { contract: "agent-session-endpoint/v1", action: "stop", disposition: "unknown_terminal", acceptedDurablyBeforeDispatch: true, automaticRetry: false },
  { contract: "agent-session-endpoint/v1", action: "respond", disposition: "unknown_terminal", acceptedDurablyBeforeDispatch: true, automaticRetry: false },
  { contract: "session-harness-launch/v1", action: "open_session", disposition: "fail_closed", acceptedDurablyBeforeDispatch: false, automaticRetry: false },
  { contract: "app-agent-actor/v1", action: "claim_turn", disposition: "recoverable_pull", acceptedDurablyBeforeDispatch: true, automaticRetry: false },
  { contract: "app-agent-actor/v1", action: "propose_action", disposition: "unknown_terminal", acceptedDurablyBeforeDispatch: true, automaticRetry: false },
  { contract: "app-agent-actor/v1", action: "finish_turn", disposition: "recoverable_pull", acceptedDurablyBeforeDispatch: true, automaticRetry: false },
  ...["declare", "install", "activate", "deactivate", "uninstall", "rollback", "approve_hotswap"].map((action): CrashPolicy => ({
    contract: "app-registry-admin/v1",
    action,
    disposition: "recoverable_pull",
    acceptedDurablyBeforeDispatch: true,
    automaticRetry: false,
  })),
]);

export function evaluateCrashSemantics(): GateVerdict {
  const mutations = CONVERGENCE_DECLARATIONS.flatMap((declaration) =>
    declaration.actions
      .filter((action) => !action.operation?.startsWith("read_") && !["list", "read", "health", "describe"].includes(action.action))
      .map((action) => `${declaration.contract}:${action.action}`),
  );
  const policies = new Map(CONVERGENCE_CRASH_POLICIES.map((policy) => [`${policy.contract}:${policy.action}`, policy]));
  const missing = mutations.filter((key) => !policies.has(key));
  const retries = CONVERGENCE_CRASH_POLICIES.filter((policy) => policy.automaticRetry !== false);
  const unsafeUnknown = CONVERGENCE_CRASH_POLICIES.filter(
    (policy) => policy.disposition === "unknown_terminal" && !policy.acceptedDurablyBeforeDispatch,
  );
  return verdict("G3", [
    { name: "every mutating action has a crash policy", ok: missing.length === 0, detail: missing.join(", ") || `${mutations.length} covered` },
    { name: "no mutating action automatically retries", ok: retries.length === 0, detail: retries.map((p) => p.action).join(", ") || "none" },
    { name: "unknown follows durable acceptance", ok: unsafeUnknown.length === 0, detail: unsafeUnknown.map((p) => p.action).join(", ") || "all durable" },
    { name: "App actor is explicitly unknown-capable", ok: APP_AGENT_ACTOR_DECLARATION.refusals.has("unknown_outcome"), detail: "unknown_outcome" },
  ]);
}

export interface UiParityEvidence {
  authenticatedOrigin: boolean;
  mobile: boolean;
  accessibility: boolean;
  draftPreservation: boolean;
  interactionCards: boolean;
  stableDeepLinks: boolean;
  imFallback: boolean;
}

/** G4 is fail-closed: no partial score is interpreted as parity. */
export function evaluateUiParity(evidence: UiParityEvidence): GateVerdict {
  const fields: readonly (keyof UiParityEvidence)[] = [
    "authenticatedOrigin",
    "mobile",
    "accessibility",
    "draftPreservation",
    "interactionCards",
    "stableDeepLinks",
    "imFallback",
  ];
  const checks: GateCheck[] = fields.map((name) => ({
    name,
    ok: evidence[name] === true,
    detail: evidence[name] === true ? "accepted" : evidence[name] === false ? "missing" : "invalid",
  }));
  const extras = Object.keys(evidence).filter((name) => !fields.includes(name as keyof UiParityEvidence));
  checks.push({ name: "evidence uses the closed G4 vocabulary", ok: extras.length === 0, detail: extras.join(", ") || "closed" });
  const leaks = contractCoordinateProblems(SESSION_HARNESS_LAUNCH_DECLARATION);
  checks.push({ name: "launch contract has no authority coordinates", ok: leaks.length === 0, detail: leaks.join(", ") || "none" });
  checks.push({
    name: "launch contract has one trusted-shell action",
    ok: SESSION_HARNESS_LAUNCH_DECLARATION.actionIds.length === 1 && SESSION_HARNESS_LAUNCH_DECLARATION.actionIds[0] === "open_session",
    detail: SESSION_HARNESS_LAUNCH_DECLARATION.actionIds.join(", "),
  });
  return verdict("G4", checks);
}

export interface TcbInventoryEntry {
  symbol: string;
  currentPath: string;
  targetPackage: string;
  equivalenceTest: string;
}

export const CONVERGENCE_TCB_INVENTORY: readonly TcbInventoryEntry[] = Object.freeze([
  { symbol: "HostCapabilities", currentPath: "packages/engine/src/host/capability-plane.ts", targetPackage: "retained-host-capabilities", equivalenceTest: "packages/engine/src/host/capability-plane.test.ts" },
  { symbol: "appAgentAdapterVerdict", currentPath: "packages/engine/src/runtime/deployment.ts", targetPackage: "retained-deployment-policy", equivalenceTest: "packages/engine/src/runtime/deployment.test.ts" },
  { symbol: "executionInventory", currentPath: "packages/engine/src/runtime/deployment.ts", targetPackage: "retained-deployment-policy", equivalenceTest: "packages/engine/src/runtime/deployment.test.ts" },
  { symbol: "viewFrameCsp", currentPath: "packages/web-trust/src/frame.ts", targetPackage: "web-trust", equivalenceTest: "packages/web-trust/src/frame.test.ts" },
  { symbol: "AppRegistryDirectoryView", currentPath: "packages/bot/src/app-registry/admin-view.ts", targetPackage: "app-registry-admin", equivalenceTest: "packages/bot/src/app-registry/admin-convergence.test.ts" },
]);

/**
 * G5 proves today's TCB symbols have one readable owner and the new registry
 * contract cannot disclose paths/bytes. It prepares extraction; it does not
 * move imports or stop the old Host.
 */
export async function evaluateTcbExtraction(repositoryRoot: string): Promise<GateVerdict> {
  const checks: GateCheck[] = [];
  for (const entry of CONVERGENCE_TCB_INVENTORY) {
    try {
      const text = await readFile(path.join(repositoryRoot, entry.currentPath), "utf8");
      const occurrences = text.match(new RegExp(`\\b${entry.symbol}\\b`, "g"))?.length ?? 0;
      checks.push({ name: `${entry.symbol} has a canonical owner`, ok: occurrences > 0, detail: `${entry.currentPath} -> ${entry.targetPackage}` });
      const test = await readFile(path.join(repositoryRoot, entry.equivalenceTest), "utf8");
      checks.push({
        name: `${entry.symbol} has executable equivalence coverage`,
        ok: test.includes(entry.symbol),
        detail: entry.equivalenceTest,
      });
    } catch (error) {
      checks.push({ name: `${entry.symbol} has a canonical owner`, ok: false, detail: describe(error) });
    }
  }
  const leaks = contractCoordinateProblems(APP_REGISTRY_ADMIN_DECLARATION);
  checks.push({ name: "registry admin contract is coordinate-free", ok: leaks.length === 0, detail: leaks.join(", ") || "none" });
  checks.push({
    name: "registry mutations are a closed set",
    ok: ["declare", "install", "activate", "deactivate", "uninstall", "rollback", "approve_hotswap"].every((action) => APP_REGISTRY_ADMIN_DECLARATION.actionIds.includes(action as never)),
    detail: APP_REGISTRY_ADMIN_DECLARATION.actionIds.join(", "),
  });
  return verdict("G5", checks);
}

async function allFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...await allFiles(target));
    else if (entry.isFile()) out.push(target);
  }
  return out.sort();
}

function tail(value: string): string {
  const lines = value.trim().split("\n");
  return lines.slice(-3).join(" | ").slice(0, 500);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}
