import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createLogger } from "../logger.js";
import type { RunnerBundleRegistry } from "../runner/bundle-registry.js";
import type { PendingRunnerBundleRow, Store } from "../store/store.js";
import { git } from "./worktree.js";

const log = createLogger("runner-bundle-delivery");

const RUNNER_BUNDLE_INPUTS = [
  "packages/runner/src/",
  "plugins/sessions/src/",
  // The Runner compiles in the contract's effort ladders (`/providers`).
  "packages/agent-sessions-contract/src/",
] as const;
const RUNNER_BUNDLE_FILES = new Set([
  "packages/agent-sessions-contract/package.json",
  "packages/runner/package.json",
  "packages/runner/tsconfig.json",
  "packages/runner/tsup.config.ts",
  "plugins/sessions/package.json",
  "plugins/sessions/tsconfig.json",
  "plugins/sessions/tsup.config.ts",
  "pnpm-lock.yaml",
  "tsconfig.json",
]);

/**
 * Conservative, reviewable definition of changes that can alter standalone.js.
 * Tests and docs under these packages are excluded because tsup never consumes
 * them; dependency resolution stays included through package manifests + lock.
 */
export function runnerBundleInputsChanged(files: readonly string[]): boolean {
  return files.some((file) => {
    if (RUNNER_BUNDLE_FILES.has(file)) return true;
    if (!RUNNER_BUNDLE_INPUTS.some((prefix) => file.startsWith(prefix))) return false;
    return !/(?:^|\/)(?:__tests__|test|tests)\//.test(file)
      && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
  });
}

export interface RunnerBundleDrainResult {
  ok: boolean;
  targetCommit: string | null;
  candidateSha: string | null;
  activeSha: string | null;
  coveredTicketIds: number[];
  remainingTicketIds: number[];
  outcome: "nothing_pending" | "nothing_deployed" | "activated" | "unchanged" | "failed";
  error?: string;
}

/**
 * Settles only debt whose commit is already contained by the deployed run
 * checkout. That containment proof is what keeps a mere landing production
 * neutral and prevents an old/explicit deployment from publishing newer bytes.
 */
export class RunnerBundleDelivery {
  constructor(
    private readonly store: Store,
    private readonly repoDir: string,
    private readonly runTreeDir: string,
    private readonly registry: RunnerBundleRegistry,
  ) {}

  async activateDeployedPending(actor: string, expectedTarget?: string): Promise<RunnerBundleDrainResult> {
    const pending = this.store.runnerArtifacts.listPending();
    if (!pending.length) return this.result("nothing_pending", null, null, []);

    const attemptedAt = new Date().toISOString();
    const head = await git(this.runTreeDir, ["rev-parse", "HEAD"]);
    if (!head.ok || !head.stdout) {
      const message = `无法读取已部署 checkout: ${head.stderr || "git rev-parse HEAD failed"}`;
      this.store.runnerArtifacts.markFailed(pending, null, message, attemptedAt);
      return this.result(
        "nothing_deployed",
        null,
        null,
        [],
        message,
      );
    }
    const targetCommit = head.stdout.trim();
    if (expectedTarget && targetCommit !== expectedTarget) {
      const message = `已部署 checkout ${targetCommit} 与成功部署意图 ${expectedTarget} 不一致`;
      const pendingIds = pending.map((row) => row.ticket_id);
      const before = this.registry.health();
      this.store.runnerArtifacts.markFailed(pending, null, message, attemptedAt);
      this.store.runnerArtifacts.recordAudit({
        target_commit: targetCommit,
        candidate_sha: null,
        previous_sha: before.activeSha,
        outcome: "failed",
        actor,
        attempted_at: attemptedAt,
        error: message,
      });
      return this.result("failed", targetCommit, null, pendingIds, message);
    }
    const covered: PendingRunnerBundleRow[] = [];
    for (const row of pending) {
      const contains = await git(this.repoDir, ["merge-base", "--is-ancestor", row.commit_sha, targetCommit]);
      if (contains.ok) covered.push(row);
    }
    if (!covered.length) return this.result("nothing_deployed", targetCommit, null, []);

    const bundlePath = path.join(this.runTreeDir, "packages/runner/dist/standalone.js");
    let bytes: Buffer;
    let candidateSha: string | null = null;
    const before = this.registry.health();
    try {
      bytes = readFileSync(bundlePath);
      candidateSha = createHash("sha256").update(bytes).digest("hex");
      const outcome = before.ok && before.activeSha === candidateSha ? "unchanged" : "activated";
      const health = outcome === "unchanged" ? before : this.registry.activate(bytes, actor);
      if (!health.ok || health.activeSha !== candidateSha) {
        throw new Error(health.error ?? `active digest mismatch: ${health.activeSha ?? "none"}`);
      }
      this.store.runnerArtifacts.clearCoveredAndRecordAudit(covered, {
        target_commit: targetCommit,
        candidate_sha: candidateSha,
        previous_sha: before.activeSha,
        outcome,
        actor,
        attempted_at: attemptedAt,
        error: null,
      });
      log.info(
        { target: targetCommit.slice(0, 10), digest: candidateSha.slice(0, 16), outcome, tickets: covered.map((r) => r.ticket_id) },
        "settled deployed Runner bundle debt",
      );
      return this.result(outcome, targetCommit, candidateSha, covered.map((row) => row.ticket_id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const coveredIds = covered.map((row) => row.ticket_id);
      this.store.runnerArtifacts.markFailed(covered, candidateSha, message, attemptedAt);
      this.store.runnerArtifacts.recordAudit({
        target_commit: targetCommit,
        candidate_sha: candidateSha,
        previous_sha: before.activeSha,
        outcome: "failed",
        actor,
        attempted_at: attemptedAt,
        error: message,
      });
      log.error({ target: targetCommit.slice(0, 10), candidateSha, tickets: coveredIds, error: message }, "Runner bundle activation failed");
      return this.result("failed", targetCommit, candidateSha, coveredIds, message);
    }
  }

  private result(
    outcome: RunnerBundleDrainResult["outcome"],
    targetCommit: string | null,
    candidateSha: string | null,
    coveredTicketIds: number[],
    error?: string,
  ): RunnerBundleDrainResult {
    const health = this.registry.health();
    return {
      ok: outcome !== "failed" && outcome !== "nothing_deployed",
      targetCommit,
      candidateSha,
      activeSha: health.activeSha,
      coveredTicketIds,
      remainingTicketIds: this.store.runnerArtifacts.listPending().map((row) => row.ticket_id),
      outcome,
      ...(error ? { error } : {}),
    };
  }
}
