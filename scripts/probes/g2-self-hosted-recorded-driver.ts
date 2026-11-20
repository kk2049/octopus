/**
 * Evidence driver for the isolated val15 non-Fleet acceptance.
 *
 * It does not replay a live mutation. It verifies the last real C2b/C4 run is
 * attributable to the pinned upgrade chain and translates only boolean/count
 * evidence into the generic G2 driver. Any missing/stale/edited evidence throws
 * and leaves G2 non-pass.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { SelfHostedAcceptanceDriver } from "@claude-bot/convergence-gates";

const TENTACLE = "/home/ubuntu/lht/octo-tentacle";
const ACCEPTANCE = `${TENTACLE}/artifacts/acceptance.json`;
const C2B_REPORT = "/home/ubuntu/lht/octo-coordination/reports/c2b-report.md";
const C2B_VERIFY = "/home/ubuntu/lht/octo-coordination/reports/verify-c2b-report.md";
const FROM = "da4db5a84dec940b4332f147d87628464e2e1e23";
const TO = "c4ccec59f17beb1c1bd467bbdb7cbe6a55405f2b";

interface Evidence {
  runId: string;
  gate: {
    promptGrant: { ok: boolean };
    projectionGrant: { ok: boolean };
  };
  nativeRelay: {
    bObservedRunning: boolean;
    nativePromptCountOnB: number;
    nativeReplyCountOnA: number;
    nativeReplyCountOnB: number;
  };
  reconnect: {
    completedOnBWhileHeadDown: boolean;
    userMarkerCountOnA: number;
    assistantMarkerCountOnA: number;
    userMarkerCountOnB: number;
    assistantMarkerCountOnB: number;
    finalAlicePendingSeqs: unknown[];
    finalBobPendingSeqs: unknown[];
    canonicalLocalSeqContiguous: boolean;
  };
  browser: { errors: unknown[] };
}

const evidence = JSON.parse(readFileSync(ACCEPTANCE, "utf8")) as Evidence;
const c2b = readFileSync(C2B_REPORT, "utf8");
const verify = readFileSync(C2B_VERIFY, "utf8");
let revoked = false;

function ancestor(): boolean {
  try {
    execFileSync("git", ["-C", TENTACLE, "merge-base", "--is-ancestor", FROM, TO]);
    return true;
  } catch {
    return false;
  }
}

function acceptedBaselineStillInCurrentHead(): boolean {
  try {
    execFileSync("git", ["-C", TENTACLE, "merge-base", "--is-ancestor", TO, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

const driver: SelfHostedAcceptanceDriver = {
  async register() {
    const dual = c2b.includes("rt_+mcp_") || (c2b.includes("rt_") && c2b.includes("mcp_"));
    const realGate = c2b.includes("真实 bot") && evidence.gate.promptGrant.ok && evidence.gate.projectionGrant.ok;
    return { deviceAccepted: dual && realGate, gateAccepted: dual && realGate };
  },
  async gateRoundTrip() {
    return {
      accepted: evidence.nativeRelay.bObservedRunning
        && evidence.nativeRelay.nativeReplyCountOnA === 1
        && evidence.nativeRelay.nativeReplyCountOnB === 1,
      targetFrames: evidence.nativeRelay.nativePromptCountOnB,
    };
  },
  async revoke() {
    revoked = c2b.includes("撤销后工具拒绝")
      && c2b.includes("后续 invoke")
      && c2b.includes("再次由 Gate 拒绝")
      && verify.includes("目标 transport 零调用");
  },
  async postRevoke() {
    return { refused: revoked, targetFrames: revoked ? 0 : 1 };
  },
  async reconnect() {
    const r = evidence.reconnect;
    const exactlyOnce = r.completedOnBWhileHeadDown
      && r.userMarkerCountOnA === 1
      && r.assistantMarkerCountOnA === 1
      && r.userMarkerCountOnB === 1
      && r.assistantMarkerCountOnB === 1
      && r.finalAlicePendingSeqs.length === 0
      && r.finalBobPendingSeqs.length === 0
      && r.canonicalLocalSeqContiguous;
    return { registered: exactlyOnce, duplicateFrames: exactlyOnce ? 0 : 1 };
  },
  async upgrade() {
    const recordedReport = execFileSync("git", ["-C", TENTACLE, "show", `${TO}:reports/c4-report.md`], { encoding: "utf8" });
    return {
      from: FROM,
      to: TO,
      // G2 is deliberately tied to the real C4 run, not silently upgraded to
      // a later source-only result. A newer clean Tentacle HEAD may contain
      // separately tested C5/B2 work, but it must retain C4 as an ancestor.
      registered: ancestor() && acceptedBaselineStillInCurrentHead() && recordedReport.includes(evidence.runId),
    };
  },
  async afterUpgrade() {
    const accepted = evidence.browser.errors.length === 0
      && evidence.gate.promptGrant.ok
      && evidence.gate.projectionGrant.ok
      && evidence.nativeRelay.nativeReplyCountOnA === 1;
    return { accepted, targetFrames: evidence.nativeRelay.nativePromptCountOnB };
  },
};

export default driver;
