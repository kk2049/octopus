import { GitLabMainline } from "./gitlab-mainline.js";
import type { WorkspaceProvider, WorkspaceTask } from "./workspace-provider.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../store/store.js";
import type { KnowledgeSpecification } from "../knowledge/specifications.js";
import {
  DevPipeline,
  buildInterjectionPrompt,
  buildIntroPrompt,
  buildTurnPrompt,
  buildToolsBrief,
  extractSlug,
  kindRule,
  ciRepairFollowUpPreface,
  ciMachineRule,
  devMachineRule,
  DEV_CONSTRAINTS,
  PRODUCTION_AUTHORIZATION_REMINDER,
  SLUG_MAX_CHARS,
  SLUG_RULE,
  SLUG_TARGET_CHARS,
  MCP_CONFIG_FILE,
  QUEUED_NOTICE,
  DEFAULT_GATE_STEPS,
  TCB_PATHS,
  tcbPathHits,
  AGENTIC_APP_RULE,
  appTicketRule,
  cliReportIntroductionMap,
  cliReportVersionMap,
  cliReceiptRecoveryReports,
  refreshSummary,
  type AppReleaseRefreshOutcome,
  type AppHotswapExecutor,
  type DevPipeEvent,
  type SubmitResult,
  type StatusResult,
  type CiMachineOpener,
  type CiMachineSync,
} from "./pipeline.js";
import type { DevTurnResult, DevTurnSpec, TurnLimits } from "./executor.js";
import type { LandGateCandidate, LandGateOutcome } from "./land-gate.js";
import { gitOrThrow } from "./worktree.js";
import type { AppTicketScope } from "./app-scopes.js";
import { SHARED_GATE_PREFIX, namedGateSteps } from "./pipeline.js";
import { BuildWarmer } from "./build-warm.js";
import { normalizeCliDeliveryTicketInput, normalizeDevTicketInput } from "./ticket-models.js";
import { CodexAccountRouter } from "./codex-account-router.js";
import {
  createRetrievalTraceEnvelope,
  traceEvent,
  type RetrievalTraceReceiptV1,
} from "../knowledge/retrieval-trace.js";
import type { CliRetrievalAttestation } from "./cli-report.js";
import { assertKnowledgeDeployable } from "./knowledge-deploy.js";

// The real knowledge review runs (and returns early in these policy-less
// fixture repos) unless a test scripts one verdict.
vi.mock("./knowledge-deploy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./knowledge-deploy.js")>();
  return { ...actual, assertKnowledgeDeployable: vi.fn(actual.assertKnowledgeDeployable) };
});

interface Env {
  dir: string;
  repo: string;
  store: Store;
  pipe: DevPipeline;
  turns: Array<DevTurnSpec & { cwd: string }>;
  events: DevPipeEvent[];
  /** Every gate run, with the App scope it was told to trim for (null = full). */
  gateCalls: Array<{ worktree: string; scope: AppTicketScope | null | undefined }>;
  /** Every thin land-gate check: which staging dir it ran in, at which HEAD. */
  landGateCalls: Array<{ dir: string; head: string; candidate?: LandGateCandidate }>;
  /** Every sha the post-landing build warmer was asked to pre-build. */
  warmCalls: string[];
  /** Every explicit or after-deploy release refresh the pipeline requested. */
  refreshCalls: Array<{
    appId: string;
    worktree: string;
    ticketId: number;
    actor: string;
    declareMissing?: boolean;
  }>;
}

const envs: Env[] = [];

/**
 * Harness: real git repos + an injectable turn. `onTurn` plays the agent —
 * it gets the per-turn devpipe token (read from the MCP config file exactly
 * the way the real MCP server receives it via env) and may call
 * pipe.toolClaim/toolSubmit, commit files, etc. Its string return becomes
 * the turn's result_text.
 */
async function makeEnv(opts?: {
  gate?: (worktree: string) => Promise<{ ok: boolean; log: string }>;
  /** Thin land gate stub; default passes. The recording wrapper always runs. */
  landGate?: (dir: string) => Promise<LandGateOutcome>;
  /** `selfhosting.land_gate`; default true (the production default). */
  landGateEnabled?: boolean;
  /** New lifecycle contract; older orthogonal tests disable it explicitly through this harness default. */
  knowledgeCaptureEnabled?: boolean;
  onTurn?: (ctx: {
    cwd: string;
    spec: DevTurnSpec;
    token: string | null;
    env: Env;
    limits?: TurnLimits;
  }) => Promise<string | DevTurnResult>;
  /** Ticket #20: stub for "session file exists on disk"; default = always false. */
  sessionExists?: (cwd: string, sessionId: string | null | undefined) => boolean;
  /** Ticket #20: keep the retry nap short in tests. */
  turnRetryDelayMs?: number;
  /** Keep restart pacing short and observable in focused scheduling tests. */
  restartContinuationPaceMs?: number;
  /** Merge-lock scheduling hooks for FIFO/lease tests. */
  specConcurrency?: number;
  mergeLockWakeLeaseMs?: number;
  /** Keep scheduling closed to exercise production's late-bind startup order. */
  autoStart?: boolean;
  gitlabMainline?: boolean;
  /**
   * Ticket #61: point the pipeline's "deployed run checkout" at the test repo.
   *
   * The repo sits on `live` while tickets land on `main`, which is exactly the
   * production shape — a run tree that is BEHIND the base branch until somebody
   * deploys — so `git merge --ff-only main` in a test is a deploy in miniature.
   */
  runTreeIsRepo?: boolean;
  /**
   * App tickets: what the release refresh reports. Absent leaves the pipeline
   * with NO refresher bound, which is its own honest state (a landed app ticket
   * then says this process hosts no Apps).
   */
  refresh?: (input: {
    appId: string;
    worktree: string;
    ticketId: number;
    actor: string;
    declareMissing?: boolean;
    prepareView?: boolean;
  }) => Promise<AppReleaseRefreshOutcome>;
  /** Exact-byte agent approval seam, deliberately separate from direct deploy drain. */
  hotswap?: AppHotswapExecutor;
  ciMachine?: CiMachineOpener;
  ciWorkspaceProvider?: (owner: string) => WorkspaceProvider | null;
  ciMachineSync?: CiMachineSync;
  codexAccountRouter?: CodexAccountRouter;
  creditExcludedUsers?: readonly string[];
}): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "devpipe-"));
  const repo = join(dir, "repo");
  await gitOrThrow(dir, ["init", "-b", "main", repo]);
  // Give the repo a persistent identity so any git that runs INSIDE the
  // pipeline (worktrees share this .git/config) — most importantly `git
  // rebase`, which reapplies commits and therefore needs a committer — has
  // one without depending on a global config. On the AWS host that global
  // config exists; on the GitLab CI Runner (root user, container hostname
  // `runner-…(none)`) it does not, and `unable to auto-detect email address`
  // surfaces as a rebase `read_error` (pipeline 49250).
  await gitOrThrow(repo, ["config", "user.email", "t@t"]);
  await gitOrThrow(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "base\n");
  if (opts?.knowledgeCaptureEnabled) {
    mkdirSync(join(repo, "architecture"), { recursive: true });
    writeFileSync(join(repo, "architecture", "atlas.json"), JSON.stringify({ modules: [], constraints: [] }));
    writeFileSync(join(repo, "AGENTS.md"), "# Test repository rules\n");
  }
  await gitOrThrow(repo, ["add", "."]);
  await gitOrThrow(repo, ["commit", "-m", "init"]);
  // The live tree sits on another branch, so `main` is free for the _base worktree.
  await gitOrThrow(repo, ["checkout", "-b", "live"]);

  const store = new Store(":memory:");
  store.saveUser({ username: "alice", uid: 1, home_dir: "/x", created_at: "2026-07-25T00:00:00.000Z" });

  const turns: Env["turns"] = [];
  const events: DevPipeEvent[] = [];
  const gateCalls: Env["gateCalls"] = [];
  const landGateCalls: Env["landGateCalls"] = [];
  const refreshCalls: Env["refreshCalls"] = [];
  const warmCalls: Env["warmCalls"] = [];

  const env: Env = {
    dir,
    repo,
    store,
    pipe: null as unknown as DevPipeline,
    turns,
    events,
    gateCalls,
    landGateCalls,
    refreshCalls,
    warmCalls,
  };

  // The real warmer would park a `_warm` worktree and run pnpm; this fixture
  // is a two-file git repo. Recording the sha is the observable half of "a
  // landing hands the deploy a warm cache", and the pnpm never runs.
  const buildWarmer = new BuildWarmer({
    repoDir: repo,
    worktreesDir: join(dir, "worktrees"),
    park: async (warmDir, sha) => {
      warmCalls.push(sha);
      return warmDir;
    },
    exec: async () => ({ ok: true, timedOut: false, log: "" }),
  });

  const runTurn = async (cwd: string, spec: DevTurnSpec, limits?: TurnLimits): Promise<DevTurnResult> => {
    turns.push({ ...spec, cwd });
    const sid = spec.sessionId ?? spec.resumeSessionId ?? "s-x";
    const base: DevTurnResult = { ok: true, exit_code: 0, timed_out: false, duration_ms: 5, session_id: sid };
    let token: string | null = null;
    if (spec.mcpConfigPath) {
      const cfg = JSON.parse(readFileSync(spec.mcpConfigPath, "utf8")) as {
        mcpServers: { devpipe: { env: { DEVPIPE_TOKEN: string } } };
      };
      token = cfg.mcpServers.devpipe.env.DEVPIPE_TOKEN;
    }
    if (opts?.onTurn) {
      const out = await opts.onTurn({ cwd, spec, token, env, limits });
      return typeof out === "string" ? { ...base, result_text: out } : out;
    }
    return { ...base, result_text: "收到,已了解。" };
  };

  let mainline: GitLabMainline | undefined;
  if (opts?.gitlabMainline) {
    await gitOrThrow(dir, ["init", "--bare", join(dir, "remote.git")]);
    await gitOrThrow(repo, ["remote", "add", "origin", join(dir, "remote.git")]);
    await gitOrThrow(repo, ["push", "origin", "main"]);
    mainline = new GitLabMainline({ repoDir: repo, branch: "main" });
    await mainline.activate(await gitOrThrow(repo, ["rev-parse", "main"]));
  }
  env.pipe = new DevPipeline({
    ...(mainline ? { mainline } : {}),
      // No remote in a temp repo, and a test must never push anywhere.
      pushRemote: null,
    store,
    repoDir: repo,
    worktreesDir: join(dir, "worktrees"),
    baseBranch: "main",
    ...(opts?.specConcurrency ? { specConcurrency: opts.specConcurrency } : {}),
    ...(opts?.mergeLockWakeLeaseMs ? { mergeLockWakeLeaseMs: opts.mergeLockWakeLeaseMs } : {}),
    notify: (ev) => events.push(ev),
    runTurn,
    ...(opts?.codexAccountRouter ? { codexAccountRouter: opts.codexAccountRouter } : {}),
    ...(opts?.creditExcludedUsers ? { creditExcludedUsers: opts.creditExcludedUsers } : {}),
    // Wrapped rather than passed straight through: which scope the gate was
    // handed is the observable half of "an app ticket runs a trimmed gate", and
    // every test gets to see it without opting in.
    gate: async (worktree, scope) => {
      gateCalls.push({ worktree, scope });
      return opts?.gate ? await opts.gate(worktree) : { ok: true, log: "gate ok" };
    },
    // Same wrapping as `gate`: WHERE the thin land gate ran (and at which sha)
    // is the observable half of "the gate checks the exact tree the ff lands",
    // so every test records it. The real install/build/tsc never runs here.
    landGateEnabled: opts?.landGateEnabled,
    knowledgeCaptureEnabled: opts?.knowledgeCaptureEnabled ?? false,
    landGateCheck: async (dir, candidate) => {
      landGateCalls.push({ dir, head: await gitOrThrow(dir, ["rev-parse", "HEAD"]), ...(candidate ? { candidate } : {}) });
      // Since 2026-08-21 the tests a landing NAMES are steps of this gate
      // (`candidate.namedTests`, refusal `named_tests`). The harness keeps
      // routing them through `opts.gate` — recorded in `gateCalls` with the
      // App scope the candidate carries — so a test can still hold or fail
      // "the named tests" without caring which machine runs them.
      if (candidate?.namedTests?.length) {
        gateCalls.push({ worktree: dir, scope: candidate.appScope });
        const named = opts?.gate ? await opts.gate(dir) : { ok: true, log: "gate ok" };
        if (!named.ok) return { ok: false, refusal: "named_tests", log: named.log };
      }
      return opts?.landGate ? await opts.landGate(dir) : { ok: true, log: "land gate ok" };
    },
    ...(opts?.refresh
      ? {
          refreshAppRelease: async (input) => {
            refreshCalls.push(input);
            return await opts.refresh!(input);
          },
        }
      : {}),
    ...(opts?.hotswap ? { appHotswapExecutor: opts.hotswap } : {}),
    ...(opts?.ciMachine ? { ciMachine: opts.ciMachine } : {}),
    ...(opts?.ciWorkspaceProvider ? { ciWorkspaceProvider: opts.ciWorkspaceProvider } : {}),
    ...(opts?.ciMachineSync ? { ciMachineSync: opts.ciMachineSync } : {}),
    ...(opts?.runTreeIsRepo ? { runTreeDir: repo } : {}),
    buildWarmer,
    mcpServerPath: "/nonexistent/mcp-server.js", // never spawned by the fake
    // Ticket #20 hooks — always inject "session not on disk" and a tiny
    // retry delay unless the test overrides them.
    sessionExists: opts?.sessionExists ?? (() => false),
    turnRetryDelayMs: opts?.turnRetryDelayMs ?? 5,
    ...(opts?.restartContinuationPaceMs !== undefined
      ? { restartContinuationPaceMs: opts.restartContinuationPaceMs }
      : {}),
  });
  env.pipe.setToolApi("http://127.0.0.1:1"); // enables MCP config writing
  if (opts?.autoStart !== false) env.pipe.start();
  envs.push(env);
  return env;
}

/** Wait until the pump has no in-flight turns and nothing left to schedule.
 *
 * The default budget was 500 rounds (≈5s) and was exceeded on GitLab pipeline
 * 49245 under `--maxWorkers=8`: a wake-triggered second submit (release → wake
 * message → pump → runTicketTurn → toolSubmit → rebase + ff) spawns ~10 git
 * subprocesses back to back, and on a loaded CI host that easily crosses 5s.
 * `settle` exits early as soon as `pipe.idle()` clears, so raising the ceiling
 * only affects the pathological case; healthy runs still return in
 * milliseconds. Same argument the browser suite writes above its own long
 * waits (`browser.e2e.test.ts`): a longer wait cannot hide a real defect, it
 * can only make a real one slower to report. */
async function settle(env: Env, rounds = 3000): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 10));
    if (env.pipe.idle() && env.store.devTickets.listTicketsNeedingTurn().length === 0) {
      // one extra beat, then re-check — a finishing turn may queue follow-ups
      await new Promise((r) => setTimeout(r, 20));
      if (env.pipe.idle() && env.store.devTickets.listTicketsNeedingTurn().length === 0) return;
    }
  }
}

/**
 * Wait for the fire-and-forget warm scheduling to reach the stub. Warming is
 * deliberately off the landing path, so nothing a landing returns can be
 * awaited for it — a bounded poll is the honest way to observe it.
 */
async function waitForWarm(env: Env, rounds = 200): Promise<void> {
  for (let i = 0; i < rounds && env.warmCalls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function commitWork(cwd: string, rel: string, content = "work\n"): Promise<void> {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  await gitOrThrow(cwd, ["add", rel]);
  await gitOrThrow(cwd, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", `add ${rel}`]);
}

let cliReportSeq = 0;
function landingSpecs(requirements: string[], decisions: string[], source: string, test: string): KnowledgeSpecification[] {
  return ([...requirements.map((statement) => ({ kind: "requirement" as const, statement })), ...decisions.map((statement) => ({ kind: "decision" as const, statement }))]).map((claim) => ({
    ...claim, strength: "agent_inferred", provenance: { author: { kind: "agent", name: "fixture", model: null, ref: "ticket:1" }, basis: ["ticket:1"], events: [] }, realized_by: [source], verified_by: [test],
  }));
}
async function commitCliReport(
  cwd: string,
  requester = "alice",
  retrieval: CliRetrievalAttestation = {
    traces: [],
    context_keys: [],
    feedback: [{ code: "not_run" }],
  },
  specifications?: KnowledgeSpecification[],
  nativeTicketId?: number,
): Promise<string> {
  const baseSha = await gitOrThrow(cwd, ["merge-base", "HEAD", "main"]);
  cliReportSeq++;
  const rel = `doc/cli-reports/2026-08-13-test-${cliReportSeq}.json`;
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify({
    version: 3,
    base_sha: baseSha,
    title: `CLI delivery ${cliReportSeq}`,
    summary: "The CLI branch is landed and traceable.",
    requester,
    requirements: ["land the exact branch range"],
    decisions: ["record retrieval non-use explicitly"],
    non_goals: [],
    risks: [],
    supersedes: [],
    verification: ["focused tests passed"],
    acceptance: ["the report appears in tickets"],
    retrieval,
    ...(nativeTicketId ? { native_ticket_id: nativeTicketId } : {}),
    ...(specifications ? { specifications } : {}),
  }));
  await gitOrThrow(cwd, ["add", rel]);
  await gitOrThrow(cwd, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", `report ${cliReportSeq}`]);
  return rel;
}

async function commitLegacyCliReport(cwd: string): Promise<string> {
  cliReportSeq++;
  const rel = `doc/cli-reports/2026-08-13-legacy-${cliReportSeq}.json`;
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify({
    version: 1,
    title: `Legacy CLI delivery ${cliReportSeq}`,
    summary: "Historical report remains visible.",
    requester: "alice",
    verification: ["focused tests passed"],
    acceptance: ["the report appears in tickets"],
  }));
  await gitOrThrow(cwd, ["add", rel]);
  await gitOrThrow(cwd, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", `legacy report ${cliReportSeq}`]);
  return rel;
}

function makeCliLandingReceipt(repoSha: string, lane: "cli" | "ticket" = "cli", successfulPath?: string) {
  const startedAt = new Date().toISOString();
  const envelope = createRetrievalTraceEnvelope({
    lane,
    purpose: "path_refinement",
    subject_ref: lane === "cli" ? "cli-scope:pipeline-test" : "ticket:7",
    query: "private pipeline test query",
    repo_sha: repoSha,
    graph_input_fingerprint: "b".repeat(64),
    started_at: startedAt,
  }, Buffer.alloc(32, 9));
  const receipt: RetrievalTraceReceiptV1 = {
    schema_version: 1,
    envelope,
    events: [
      traceEvent(envelope.trace_id, "started", { event: "started", payload: {} }, startedAt),
      traceEvent(envelope.trace_id, "result", successfulPath ? {
        event: "assembled", payload: { classifications: [{ dimension: "path", value: successfulPath, certainty: "exact", score: 1, reason_codes: ["explicit_path"] }], indexes: [], candidates: [], slots: [], context_keys: [], unknown: [{ code: "vector_unavailable" }], budget: { limit_chars: 4000, used_chars: 0, dropped_records: 0 }, performance: { total_ms: 1 } },
      } : {
        event: "error",
        payload: { stage: "vector", code: "provider_unavailable" },
      }, startedAt),
      traceEvent(envelope.trace_id, "delivery:cli_stdout", successfulPath ? { event: "delivered", payload: { channel: "cli_stdout" } } : {
        event: "delivered_error",
        payload: { stage: "delivery", code: "provider_unavailable" },
      }, startedAt),
    ],
  };
  const content = `${JSON.stringify(receipt)}\n`;
  const receiptSha256 = createHash("sha256").update(content, "utf8").digest("hex");
  return {
    traceId: envelope.trace_id,
    retrieval: {
      traces: [{ id: envelope.trace_id, receipt_sha256: receiptSha256 }],
      context_keys: [],
      feedback: [],
    } satisfies CliRetrievalAttestation,
    upload: {
      id: envelope.trace_id,
      receipt_sha256: receiptSha256,
      content,
    },
  };
}

/** Advance the base branch out-of-band (a human landing, in miniature). */
async function advanceBase(env: Env, rel: string): Promise<void> {
  const wt = join(env.dir, "advance-" + Math.floor(Math.random() * 1e9));
  await gitOrThrow(env.repo, ["worktree", "add", wt, "main"]);
  await commitWork(wt, rel);
  await gitOrThrow(env.repo, ["worktree", "remove", "--force", wt]);
}

afterEach(async () => {
  for (const e of envs.splice(0)) {
    await e.pipe.stop();
    e.store.close();
    rmSync(e.dir, { recursive: true, force: true });
  }
});

// ── prompt builders ──

describe("prompts", () => {
  const row = {
    id: 7,
    title: "新工单 · 08-17 13:00",
    requester: "alice",
    branch: "ticket/7-x",
    kind: "simple",
    parent_ticket_id: null,
    model: "omp-gpt-5.6-sol",
  } as never;

  it("gives a fresh ticket one short, ordered execution contract", () => {
    const prompt = buildIntroPrompt(
      row,
      [{ author: "alice", via: "web", body: "别抖了" } as never],
      { baseBranch: "v4", toolsAvailable: true },
    );
    expect(prompt).toContain("# 工单 #7");
    expect(prompt).toContain("[alice via web]: 别抖了");
    expect(prompt).toContain("devpipe_rename");
    expect(prompt).toContain("devpipe_submit");
    expect(prompt).toContain("base_changed_review");
    expect(prompt).toContain("## 名字");
    expect(prompt).toContain("OMP 还会发现");
    expect(prompt).not.toContain("devpipe_claim_workspace");
    expect(prompt.length).toBeLessThan(4_000);
  });

  it("keeps exactly the two mechanically enforced boundaries", () => {
    expect(DEV_CONSTRAINTS.match(/^- \*\*无对话级例外/gm)).toHaveLength(2);
    expect(DEV_CONSTRAINTS).toContain("保护路径");
    expect(DEV_CONSTRAINTS).toContain("唯一合入路径");
    expect(DEV_CONSTRAINTS).toContain("用户在本工单明确要求");
    expect(DEV_CONSTRAINTS).toContain("询问“是否已经上线”");
    expect(DEV_CONSTRAINTS).toContain("都不构成部署或发布授权");
  });

  it("refreshes production authorization on every resumed conversation", () => {
    const turn = buildTurnPrompt([
      { author: "alice", via: "web", body: "上线后这个页面有点挤" } as never,
    ]);
    expect(turn).toContain(PRODUCTION_AUTHORIZATION_REMINDER);
    expect(turn).toContain("full_deploy 只登记上线债务");
    expect(turn).toContain("命令式原话");
    expect(turn).toContain("没有这句原话就停在已合入/待上线");
  });

  it("uses one concrete sidebar naming rule in the ticket's own turn", () => {
    const prompt = buildIntroPrompt(row, [{ author: "alice", via: "web", body: "开工" } as never], {
      baseBranch: "v4",
      toolsAvailable: true,
    });
    expect(prompt).toContain(SLUG_RULE);
    expect(prompt).toContain(`${SLUG_TARGET_CHARS} 字左右`);
    expect(prompt).toContain("具体对象 + 具体动作/结论");
  });

  it("states each ticket kind without mixing their control flow", () => {
    const simple = kindRule({ kind: "simple" });
    expect(simple).toContain("不要向用户提问");
    expect(simple).toContain("submit");

    const complex = kindRule({ kind: "complex" });
    expect(complex).toContain("首轮只出方案");
    expect(complex).toContain("不要 submit");

    const discuss = kindRule({ kind: "discuss" });
    expect(discuss).toContain("读代码");
    expect(discuss).toContain("不要问用户「要不要开工单」");
  });

  it("ordinary intro keeps the App caveat short and leaves test recipes in CI", () => {
    const p = buildIntroPrompt(row, [{ author: "alice", via: "web", body: "加个模块" } as never], {
      baseBranch: "main",
      toolsAvailable: true,
    });
    expect(p).toContain("只在实际改到 App/View 时读 .claude/rules/agentic-app.md");
    expect(p).not.toContain("--project agent-workspace-files-view");
    expect(p).not.toContain("pnpm --filter @claude-bot/session-plus-view build");
    expect(AGENTIC_APP_RULE).toContain("明确显示 activate 成功");
    expect(p).toContain("delivery");
    expect(p).toContain("精确列全受影响 App");
    expect(AGENTIC_APP_RULE).toContain("权限契约变了还要每个用户重新同意");
  });

  it("toolless mode says so instead of promising tools", () => {
    expect(buildToolsBrief("main", false)).toContain("未启用 devpipe 工具");
    expect(buildToolsBrief("main", false)).not.toContain("devpipe_submit —");
  });

  it("warns OMP turns not to duplicate an in-flight submit", () => {
    const brief = buildToolsBrief("main", true, { cliFamily: "omp" });
    expect(brief).toContain("锁在本票");
    expect(brief).toContain("禁止重复 submit");
    expect(brief).toContain("No such tool");
    expect(brief).toContain("pnpm devpipe:call");
    expect(brief).toContain("其它错误不得走此恢复路径");
  });

  it("kind rule: complex is told to wait for a go-ahead, simple to just build", () => {
    expect(kindRule({ kind: "complex" })).toContain("明确认可");
    expect(kindRule({ kind: "simple" })).toContain("不要向用户提问");
  });

  // Ticket #38-4: the complex rule must say "先出方案 / 认可后再动手实现" so the
  // UI's "先出方案 → 你点头 → 才动手实现" description matches the agent's actual
  // contract. Both together buy back the truthfulness the ticket started from.
  it("kind rule: complex spells out that the first turn is plan-only, no code", () => {
    const r = kindRule({ kind: "complex" });
    expect(r).toContain("只出方案");
    expect(r).toContain("不要动代码");
    expect(r).toContain("不要 submit");
  });

  // Ticket #38-5: discuss mode's contract is chattier, workspace-backed, and
  // says explicitly that submitting is opt-in.
  it("kind rule: discuss stays chatty, only submits when told to", () => {
    const r = kindRule({ kind: "discuss" });
    expect(r).toContain("讨论需求");
    expect(r).toContain("默认只讨论");
    expect(r).toContain("devpipe_rename");
    expect(r).toContain("不要问用户「要不要开工单」");
  });

  it("kind rule: an authorized discussion keeps the CI validation route after implementation is approved", () => {
    const r = kindRule(
      { kind: "discuss" },
      { device: "lht-val15-ci", checkoutDir: "/work/tickets/ticket-237", syncedTo: "abcdef1234567890" },
    );
    expect(r).toContain("默认只讨论");
    expect(r).toContain("隔离 CI 开发环境");
    expect(r).toContain("设备 `lht-val15-ci`");
    expect(r).toContain("devpipe_ci_sync");
  });

  // Ticket #219: the repair lane's contract is not the one the user picked. A
  // repair ticket is filed as `simple` so the scheduler treats it like any
  // other one-turn task, but "the user chose not to be asked" is not what it
  // owes — CI named files, and the land gate will rerun them.
  it("kind rule: a CI repair ticket overrides its kind and names what it owes", () => {
    const r = kindRule({ kind: "simple", ci_roster: '["packages/bot/src/a.test.ts"]' });
    expect(r).toContain("CI 修复票");
    expect(r).toContain("packages/bot/src/a.test.ts");
    expect(r).toContain("落地门禁");
    expect(r).not.toContain("禁止向用户提问");
  });

  it("kind rule: an unparsed roster is stated as such, not hidden", () => {
    const r = kindRule({ kind: "simple", ci_roster: "[]" });
    expect(r).toContain("CI 修复票");
    expect(r).toContain("基础设施故障");
    expect(r).toContain("不要为它制造提交");
  });

  it("the repair lane inverts exactly the clause that would keep it guessing", () => {
    const ciRow = {
      id: 8,
      title: "CI 临时标题",
      requester: "alice",
      branch: "ticket/8-ci",
      kind: "simple",
      parent_ticket_id: null,
      model: "omp-gpt-5.6-sol",
      ci_roster: '["packages/bot/src/a.test.ts"]',
    } as never;
    const prompt = buildIntroPrompt(
      ciRow,
      [{ author: "pipeline", via: "gitlab-ci", body: "红了" } as never],
      {
        baseBranch: "v4",
        toolsAvailable: true,
        machine: { device: "lht-val15-ci", checkoutDir: "/work/octopus", syncedTo: "abcdef1234567890" },
      },
    );
    expect(prompt).toContain("CI 修复票");
    expect(prompt).toContain("packages/bot/src/a.test.ts");
    expect(prompt).toContain("失败 SHA");
    expect(prompt).toContain("machine_exec");
    expect(prompt).toContain("/work/octopus");
    expect(prompt).not.toContain(AGENTIC_APP_RULE);
    expect(prompt.length).toBeLessThan(4_000);

    const empty = kindRule({ kind: "simple", ci_roster: "[]" });
    expect(empty).toContain("基础设施故障");
    expect(empty).toContain("不要为它制造提交");
  });

  it("describes isolated verification environments without repeating a runbook", () => {
    const ci = ciMachineRule("lht-val15-ci", "/work/octopus", "c49936f6c0339e1b");
    expect(ci).toContain("c49936f6c033");
    expect(ci).toContain("reset --hard");
    expect(ci).toContain("timeout_ms=300000");
    expect(ci.length).toBeLessThan(800);

    const dev = devMachineRule("dev-1", "/work/tickets/ticket-1");
    expect(dev).toContain("devpipe_ci_sync");
    expect(dev).toContain("base_changed_review");
    expect(dev.length).toBeLessThan(700);
  });

  it("keeps provider-specific tool notes small and truthful", () => {
    const codex = buildToolsBrief("v4", true, { cliFamily: "codex" });
    expect(codex).toContain("60000ms");
    expect(codex).toContain("同步调用");
    expect(codex).toContain("不要轮询 devpipe_status");
    expect(codex).not.toContain("OMP 还会发现");

    const omp = buildToolsBrief("v4", true, { cliFamily: "omp" });
    expect(omp).toContain("OMP 还会发现");
    expect(omp).toContain("只有本轮配置的 devpipe/machines 属于本工单授权");

    const toolless = buildToolsBrief("v4", false);
    expect(toolless).toContain("未启用 devpipe 工具");
    expect(toolless).not.toContain("devpipe_submit");
  });

  it("keeps App instructions focused on scope, release state and approval", () => {
    expect(AGENTIC_APP_RULE).toContain(".claude/rules/agentic-app.md");
    expect(AGENTIC_APP_RULE).toContain("approval_required");
    expect(AGENTIC_APP_RULE).not.toContain("--project");
    const missing = appTicketRule(null, "retired-app");
    expect(missing).toContain("retired-app");
    expect(missing).toContain("不要改代码");
  });

  it("keeps follow-up and in-flight messages distinct", () => {
    const turn = buildTurnPrompt([{ author: "pipeline", via: "pipeline", body: "🔓 锁已释放" } as never]);
    expect(turn).toContain("🔓 锁已释放");
    expect(turn).toContain("请继续");
    expect(turn).not.toContain("devpipe_submit");

    const interjection = buildInterjectionPrompt([
      { author: "alice", via: "web", body: "顺便改标题" } as never,
    ]);
    expect(interjection).toContain("本轮执行途中");
    expect(interjection).toContain("顺便改标题");
    expect(interjection).not.toContain("请继续。");
  });

  it("restates the widened CI roster only when a later batch changes it", () => {
    const followUp = ciRepairFollowUpPreface(["a.test.ts", "b.test.ts"], true);
    expect(followUp).toContain("全量 CI 仍然失败");
    expect(followUp).toContain("a.test.ts");
    expect(followUp).toContain("b.test.ts");
    expect(followUp).toContain("同一个 session");
    expect(ciRepairFollowUpPreface([], false)).toContain("不要另起 agent");
  });
});

describe("DEFAULT_GATE_STEPS", () => {
  // Fresh worktrees have no dist/, and packages/bot imports sibling workspace
  // packages via subpath exports that resolve into dist/*.d.ts. So `pnpm -r build`
  // must run BEFORE `tsc`, otherwise every ticket's first submit fails with TS2307
  // on `@claude-bot/plugin-sessions/scan` — a full LLM turn wasted diagnosing
  // pipeline structure instead of the ticket. This test locks in the order.
  const cmd = (s: { bin: string; args: string[] }) => `${s.bin} ${s.args.join(" ")}`;

  it("runs `pnpm -r build` after install and before tsc", () => {
    const cmds = DEFAULT_GATE_STEPS.map(cmd);
    const install = cmds.findIndex((c) => c.startsWith("pnpm install"));
    const build = cmds.findIndex((c) => c === "pnpm -r build");
    const tsc = cmds.findIndex((c) => c.includes("tsc"));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(install);
    expect(tsc).toBeGreaterThan(build);
  });

  it("runs vitest last", () => {
    const cmds = DEFAULT_GATE_STEPS.map(cmd);
    const vitest = cmds.findIndex((c) => c.includes("vitest"));
    expect(vitest).toBe(cmds.length - 1);
  });

  it("caps the suite to one worker with a budget the suite actually fits in", () => {
    // Two cores, ~3.8G, shared with the production bot. Uncapped, the SES
    // sandbox children and three real-browser projects starve each other into
    // 5s-timeout cascades that read as flaky tests; and the full suite is a
    // measured ~21 minutes at one worker, so any budget below that SIGKILLs a
    // HEALTHY tree mid-suite — which presents as "the gate never finishes"
    // (2026-08-07, convergence plan §5). This test makes removing either half
    // a visible decision instead of a perf tweak.
    const vitest = DEFAULT_GATE_STEPS[DEFAULT_GATE_STEPS.length - 1]!;
    expect(vitest.args).toContain("--maxWorkers=1");
    expect(vitest.timeoutMs).toBeGreaterThanOrEqual(25 * 60 * 1000);
  });
});

describe("GitLab post-submit suite", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

  it("runs the configured suite in bounded, single-worker process batches", () => {
    const config = readFileSync(join(repoRoot, ".gitlab-ci.yml"), "utf8");

    expect(config).toContain('vitest list --filesOnly --json="$test_manifest"');
    expect(config).toContain("specs.map((spec) => spec.file)");
    expect(config).not.toContain("vitest list --filesOnly --static-parse");
    expect(config).toContain("batch_size=40");
    expect(config).toContain("pnpm exec vitest run");
    expect(config).toContain("--maxWorkers=1");
    expect(config).toContain("--no-file-parallelism");
    expect(config).toContain('--outputFile.junit="reports/vitest-junit-${batch}.xml"');
    expect(config).toContain("junit: reports/vitest-junit-*.xml");
  });

  it("pins Node from a checksummed cached tarball instead of the npm registry on every run", () => {
    // Pipeline 50121 failed before any test when installing `n` from npm timed out.
    const config = readFileSync(join(repoRoot, ".gitlab-ci.yml"), "utf8");
    expect(config).not.toContain("npm install -g n");
    expect(config).toContain("b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a  $tarball");
    // The Runner refuses an interpreter under the /cache volume (pipeline 50129),
    // so Node is unpacked into /usr/local, root-owned, on every run.
    expect(config).toContain('tar -xzf "$tarball" --no-same-owner --strip-components=1 -C /usr/local');
    expect(config).not.toContain("/cache/node/v22.23.2/bin");
    expect(config).toContain(`test "$(node --version)" = 'v22.23.2'`);
    // A shim from the previous Node layout dangles; corepack refuses to replace it.
    expect(config.indexOf("find /cache/bin -xtype l -delete")).toBeGreaterThan(-1);
    expect(config.indexOf("find /cache/bin -xtype l -delete")).toBeLessThan(config.indexOf("corepack enable --install-directory /cache/bin"));
  });

  it("a red batch does not end the run — one red must carry the complete failure roster", () => {
    // Observed live (ticket #235, 2026-08-17): with `set -e` aborting the loop
    // at the first red batch, three consecutive 20-45 minute round trips each
    // exposed exactly one more failing file. The loop now records failures and
    // keeps going, failing the job at the end.
    const config = readFileSync(join(repoRoot, ".gitlab-ci.yml"), "utf8");
    expect(config).toContain('|| failed_batches="${failed_batches} ${batch}"');
    expect(config).toContain('if [ -n "${failed_batches}" ]; then');
    expect(config).toContain("exit 1");
  });
});

describe("TCB_PATHS", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

  it("every entry exists in this repo", () => {
    // A path list is a list of STRINGS: a typo, a rename or a moved file makes
    // an entry silently stop matching, and the symptom of that is a TCB diff
    // sailing through the gate. Nothing else in the pipeline would ever notice.
    const missing = TCB_PATHS.filter((p) => !existsSync(join(repoRoot, p)));
    expect(missing).toEqual([]);
  });

  it("covers the three files doc/tcb-reading-guide.md calls «错了就是隔离失效»", () => {
    // §1: core / gate / canonical — 409 lines that must be perfect.
    for (const f of ["core.ts", "gate.ts", "canonical.ts"]) {
      expect(tcbPathHits([`packages/capability-kernel/src/${f}`])).toHaveLength(1);
    }
    // §4: the browser trust layer, one implementation shared by two surfaces.
    expect(tcbPathHits(["packages/web-trust/src/gate.ts"])).toHaveLength(1);
    // §3: the panel's route table + the Cedar policies.
    expect(tcbPathHits(["packages/bot/src/dashboard/authz.ts"])).toHaveLength(1);
  });

  it("directory entries cover files that do not exist yet", () => {
    // The guide says the closure is computed transitively so that "把逻辑挪进
    // 一个新文件躲不过去". A per-file list would hand that escape back; the two
    // packages whose whole purpose is being trusted are therefore prefixes.
    expect(tcbPathHits(["packages/capability-kernel/src/brand-new-helper.ts"])).toHaveLength(1);
    expect(tcbPathHits(["packages/web-trust/src/nested/deep.ts"])).toHaveLength(1);
  });

  it("file entries match exactly — a gate that fires on unrelated files gets routed around", () => {
    expect(tcbPathHits(["packages/bot/src/dashboard/authz.tsx"])).toEqual([]);
    expect(tcbPathHits(["packages/bot/src/dashboard/authz.test.ts"])).toEqual([]);
    // Neighbours in the same directory are ordinary code.
    expect(tcbPathHits(["packages/bot/src/dashboard/tickets-page.ts"])).toEqual([]);
    expect(tcbPathHits(["packages/bot/src/runner/archive.ts"])).toEqual([]);
    // And a package whose name merely starts the same way is not the package.
    expect(tcbPathHits(["packages/web-trust-extras/src/x.ts"])).toEqual([]);
  });
});

describe("extractSlug", () => {
  it("pulls the first line under ## 名字, stripping decoration", () => {
    expect(extractSlug("## 名字\n工单页滚动\n\n## 方案\n…")).toBe("工单页滚动");
    expect(extractSlug("## 名字\n- `会话浏览`\n")).toBe("会话浏览");
    expect(extractSlug("# 名字:\n**加粗名**")).toBe("加粗名");
  });
  it("misses gracefully", () => {
    expect(extractSlug(null)).toBeNull();
    expect(extractSlug("## 方案\n直接开写")).toBeNull();
    expect(extractSlug("## 名字\n## 方案\nx")).toBeNull();
  });
  it("clips to the char budget", () => {
    const long = "一二三四五六七八九十一二三四五六七";
    expect(extractSlug(`## 名字\n${long}`)).toBe([...long].slice(0, SLUG_MAX_CHARS).join(""));
  });
});

describe("CLI report startup inventory", () => {
  it("parses report origins and versions from batched Git output", () => {
    const a = "doc/cli-reports/2026-08-13-a.json";
    const b = "doc/cli-reports/2026-08-14-b.json";
    expect(cliReportIntroductionMap([
      `commit:${"a".repeat(40)}`,
      "",
      a,
      `commit:${"b".repeat(40)}`,
      "",
      b,
    ].join("\n"))).toEqual(new Map([
      [a, "a".repeat(40)],
      [b, "b".repeat(40)],
    ]));
    expect(cliReportVersionMap([
      `main:${a}:3:  "version": 1,`,
      `main:${b}:3:  "version": 3,`,
      `main:doc/cli-reports/future.json:3:  "version": 30,`,
    ].join("\n"))).toEqual(new Map([[a, 1], [b, 3]]));
    const receipt = `kr_${"c".repeat(32)}`;
    expect(cliReceiptRecoveryReports([
      `main:${a}:18:${receipt}`,
      `main:${a}:23:${receipt}`,
      `main:${b}:18:kr_${"d".repeat(32)}`,
    ].join("\n"), new Set([receipt]))).toEqual(new Set([a]));
  });
});


// ── conversation turns ──

describe("turn pump", () => {
  it("credits the requester from provider-reported tokens without duplicating a replayed turn", async () => {
    const env = await makeEnv({ autoStart: false });
    const ticket = env.pipe.createTicket({
      title: "account one turn",
      body: "measure it",
      requester: "alice",
      kind: "simple",
      model: "codex-gpt-5.6-sol",
      effort: "high",
    });
    const harness = env.pipe as unknown as {
      recordTurnCost(ticketId: number, creditRef: string, result: DevTurnResult): void;
    };
    const result: DevTurnResult = {
      ok: false,
      exit_code: 1,
      duration_ms: 20,
      timed_out: false,
      usage: { tokens_in: 30, tokens_out: 7, tokens_cached: 13 },
    };
    harness.recordTurnCost(ticket.id, "stable-provider-turn", result);
    expect(env.store.credits.balance("alice")).toBe(50);
    harness.recordTurnCost(ticket.id, "stable-provider-turn", result);
    expect(env.store.credits.balance("alice")).toBe(50);
    expect(env.store.credits.list("alice")).toHaveLength(1);
  });

  it("does not credit configured provider owners for their own tickets", async () => {
    const env = await makeEnv({ autoStart: false, creditExcludedUsers: ["alice"] });
    const ticket = env.pipe.createTicket({
      title: "provider-owned turn",
      body: "do not mint self-backed credit",
      requester: "alice",
      kind: "simple",
      model: "codex-gpt-5.6-sol",
      effort: "high",
    });
    const harness = env.pipe as unknown as {
      recordTurnCost(ticketId: number, creditRef: string, result: DevTurnResult): void;
    };
    harness.recordTurnCost(ticket.id, "provider-owned-turn", {
      ok: true,
      exit_code: 0,
      duration_ms: 10,
      timed_out: false,
      usage: { tokens_in: 30, tokens_out: 7, tokens_cached: 13 },
    });
    expect(env.store.credits.balance("alice")).toBe(0);
    expect(env.store.credits.list("alice")).toEqual([]);
  });

  it("retires a rejected tracked task without cloning its rejection", async () => {
    const env = await makeEnv({ autoStart: false });
    const harness = env.pipe as unknown as {
      track(task: Promise<void>): void;
      inflight: Set<Promise<void>>;
    };
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", recordUnhandled);
    try {
      const task = Promise.reject(new Error("background task failed"));
      harness.track(task);
      await task.catch(() => {});
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(harness.inflight.size).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }
  });

  it("rejects every direct Fable creation path and exposes one approved entry", async () => {
    const env = await makeEnv({ autoStart: false });
    const input = {
      title: "costly",
      body: "use Fable",
      requester: "alice",
      kind: "simple",
      model: "claude-fable-5-1",
      effort: "xhigh",
    };
    expect(() => env.pipe.createTicket(input)).toThrow(/必须经 lht 审批/);
    expect(env.store.devTickets.listDevTickets()).toEqual([]);

    const approved = env.pipe.createApprovedFableTicket(input);
    expect(approved).toMatchObject({ model: "claude-fable-5-1", effort: "xhigh" });
  });

  it("binds a new direct Codex session to the earliest-reset eligible slot and keeps it sticky", async () => {
    const now = 2_000_000_000_000;
    const resetsAt = (offset: number): number => (now + offset) / 1000;
    const router = new CodexAccountRouter({
      accounts: { earlier: "/srv/codex/earlier", later: "/srv/codex/later" },
      now: () => now,
      readRateLimits: async (slot) => ({
        rateLimitsByLimitId: { codex: { primary: {
          usedPercent: slot === "earlier" ? 65 : 33,
          windowDurationMins: 10_080,
          resetsAt: resetsAt(slot === "earlier" ? 3_000 : 5_000),
        } } },
      }),
    });
    const env = await makeEnv({ codexAccountRouter: router });
    const ticket = env.pipe.createTicket({
      title: "direct codex",
      body: "route me",
      requester: "alice",
      kind: "simple",
      model: "codex-gpt-5.6-sol",
      effort: "high",
    });
    await settle(env);
    expect(env.turns[0].codexHome).toBe("/srv/codex/earlier");
    expect(env.store.devTickets.getDevTicket(ticket.id)?.codex_account_slot).toBe("earlier");

    env.pipe.postMessage(ticket.id, "alice", "web", "continue");
    await settle(env);
    expect(env.turns[1].resumeSessionId).toBe("s-x");
    expect(env.turns[1].codexHome).toBe("/srv/codex/earlier");
  });

  it("does not migrate a legacy direct Codex session that has no persisted slot", async () => {
    const router = new CodexAccountRouter({
      accounts: { a: "/srv/codex/a" },
      readRateLimits: async () => { throw new Error("must not probe"); },
    });
    const env = await makeEnv({ codexAccountRouter: router, autoStart: false });
    const ticket = env.pipe.createTicket({
      title: "legacy codex",
      body: "resume",
      requester: "alice",
      kind: "simple",
      model: "codex-gpt-5.6-sol",
      effort: "high",
    });
    env.store.devTickets.updateDevTicket(ticket.id, { session_id: "legacy-session" });
    env.pipe.start();
    await settle(env);
    expect(env.turns[0].resumeSessionId).toBe("legacy-session");
    expect(env.turns[0].codexHome).toBeUndefined();
    expect(env.store.devTickets.getDevTicket(ticket.id)?.codex_account_slot).toBeNull();
  });

  it("a fresh ticket gets an intro turn; the reply lands in the conversation with a slug", async () => {
    const env = await makeEnv({
      onTurn: async () => "## 名字\n滚动修复\n\n方案:如此这般。有一个问题想确认:A 还是 B?",
    });
    const t = env.pipe.createTicket({ title: "修滚动条", body: "页面会跳", requester: "alice", kind: "complex" });
    await settle(env);

    expect(env.turns).toHaveLength(1);
    expect(env.turns[0].prompt).toContain("[alice via web]: 页面会跳");
    // Codex is the default ticket backend and chooses its own thread id. The
    // completed turn reports that id back instead of receiving a pre-minted
    // Claude session id in the launch spec.
    expect(env.turns[0].sessionId).toBeUndefined();

    const row = env.store.devTickets.getDevTicket(t.id)!;
    expect(row.session_id).toBe("s-x");
    expect(row.dev_status).toBe("open"); // no claim, no landing — still a conversation
    expect(row.slug).toBe("滚动修复");
    const msgs = env.store.devTickets.listTicketMessages(t.id);
    expect(msgs.at(-1)?.author).toBe("agent");
    expect(msgs.at(-1)?.body).toContain("A 还是 B");
    expect(env.events.map((e) => e.kind)).toEqual(["reply"]);
  });

  it("reports a committed turn that did not land as a failed turn", async () => {
    const env = await makeEnv({
      onTurn: async ({ cwd }) => {
        await commitWork(cwd, "unfinished.ts");
        return "已完成并提交，但 submit 结果未知。";
      },
    });
    const ticket = env.pipe.createTicket({ title: "未合入提交", body: "实现并合入", requester: "alice", kind: "simple" });
    await settle(env);

    const row = env.store.devTickets.getDevTicket(ticket.id)!;
    expect(row.dev_status).toBe("open");
    expect(row.commit_sha).toBeNull();
    expect(row.error).toContain("未合入");
    expect(env.events.at(-1)?.kind).toBe("turn_failed");
    expect(env.store.devTickets.listTicketMessages(ticket.id).some((message) => message.body.includes("未合入"))).toBe(true);
  });

  it("binds conflict tools, saved annotations, and closure to the ticket's landed subject", async () => {
    const subject = "non_goal_vs_requirement:non_goal:a:requirement:b";
    let ticketId = 0;
    let readResult: unknown;
    let refused: unknown;
    let resolved: unknown;
    let repeated: unknown;
    let config: unknown;
    const env = await makeEnv({
      autoStart: false,
      onTurn: async ({ spec, token, env: current }) => {
        if (!token || !spec.mcpConfigPath) throw new Error("conflict turn requires a live tool token");
        config = JSON.parse(readFileSync(spec.mcpConfigPath, "utf8"));
        readResult = await current.pipe.toolConflictRead(token);
        refused = await current.pipe.toolConflictResolve(token, "too early");
        current.store.devTickets.updateDevTicket(ticketId, {
          dev_status: "landed",
          commit_sha: "c".repeat(40),
        });
        resolved = await current.pipe.toolConflictResolve(token, "按已保存批注更新权威知识");
        repeated = await current.pipe.toolConflictResolve(token, "do not duplicate");
        return "## 名字\n冲突来源闭环\n\n已读取批注并按落地结果关闭。";
      },
    });
    const ticket = env.pipe.createTicket({
      title: "知识冲突协作",
      body: "读取批注并按用户意图处理",
      requester: "alice",
      kind: "simple",
      model: "codex-gpt-5.6-sol",
      effort: "high",
      knowledge_subject_id: subject,
    });
    ticketId = ticket.id;
    env.store.knowledge.recordAnnotation({ subject_id: subject, body: "保留新需求", actor: "alice" });
    env.pipe.start();
    await settle(env);

    expect(config).toMatchObject({
      mcpServers: { devpipe: { env: { DEVPIPE_KNOWLEDGE_CONFLICT: "1" } } },
    });
    expect(env.turns[0]?.prompt).toContain(`本工单绑定冲突:${subject}`);
    expect(env.turns[0]?.prompt).toContain("devpipe_conflict_read");
    expect(readResult).toMatchObject({
      ok: true,
      subject_id: subject,
      requester: "alice",
      annotations: [{ actor: "alice", body: "保留新需求" }],
    });
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("尚未通过 devpipe_submit") });
    expect(resolved).toMatchObject({ ok: true, review: { decision: "resolved" } });
    expect(repeated).toMatchObject({ ok: true, message: expect.stringContaining("没有重复写入") });
    expect(env.store.knowledge.listReviews().filter((row) => row.subject_id === subject)).toHaveLength(1);
  });

  it("messaging a LANDED ticket starts a turn — the ticket #12 hang, fixed", async () => {
    const env = await makeEnv({ onTurn: async () => "follow-up 收到" });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    env.store.devTickets.updateDevTicket(t.id, { dev_status: "landed", deploy_status: "verified" });

    env.pipe.postMessage(t.id, "alice", "web", "上线之后我又发现一个问题");
    await settle(env);

    expect(env.turns.length).toBe(2);
    expect(env.turns[1].prompt).toContain("上线之后我又发现一个问题");
    expect(env.turns[1].resumeSessionId).toBeTruthy(); // same conversation, resumed
    expect(env.store.devTickets.listTicketMessages(t.id).at(-1)?.author).toBe("agent");
  });

  it("a persistently failing turn auto-retries once, then stays open until the user replies (ticket #20)", async () => {
    let fail = true;
    const env = await makeEnv({
      onTurn: async () => {
        if (fail) return { ok: false, exit_code: 1, timed_out: false, duration_ms: 3, stderr_tail: "boom" } as DevTurnResult;
        return "这次好了";
      },
    });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    // Ticket #20: the transient-looking exit 1 triggers ONE auto-retry —
    // when it also fails, the ticket lands in the same "sit open, wait for
    // a reply" state as before, but with a pipeline note explaining the
    // retry was attempted.
    expect(env.turns.length).toBe(2);
    expect(env.store.devTickets.getDevTicket(t.id)!.dev_status).toBe("open");
    expect(env.store.devTickets.getDevTicket(t.id)!.error).toContain("exit 1");
    expect(env.events.at(-1)?.kind).toBe("turn_failed");
    const notes = env.store.devTickets.listTicketMessages(t.id).filter((m) => m.author === "pipeline").map((m) => m.body);
    expect(notes.some((b) => b.includes("自动重试"))).toBe(true);

    fail = false;
    env.pipe.postMessage(t.id, "alice", "web", "再试试");
    await settle(env);
    expect(env.store.devTickets.getDevTicket(t.id)!.error).toBeNull();
    expect(env.events.at(-1)?.kind).toBe("reply");
  });

  it("transient failure that recovers on the auto-retry surfaces as a single successful reply (ticket #20)", async () => {
    let attempt = 0;
    const env = await makeEnv({
      onTurn: async () => {
        attempt++;
        if (attempt === 1) {
          return { ok: false, exit_code: 1, timed_out: false, duration_ms: 3, stderr_tail: "boom" } as DevTurnResult;
        }
        return "第二次就通了";
      },
    });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    expect(attempt).toBe(2);
    // The retry succeeded — no turn_failed event surfaces to the notifier.
    expect(env.events.map((e) => e.kind)).toEqual(["reply"]);
    expect(env.store.devTickets.getDevTicket(t.id)!.error).toBeNull();
    // Only one agent reply lands (the successful one).
    const agent = env.store.devTickets.listTicketMessages(t.id).filter((m) => m.author === "agent");
    expect(agent).toHaveLength(1);
    expect(agent[0].body).toContain("第二次就通了");
  });

  it("a Codex initialize timeout retries once because no prompt was accepted (ticket #400)", async () => {
    let attempt = 0;
    const env = await makeEnv({
      onTurn: async () => {
        attempt++;
        if (attempt === 1) {
          return {
            ok: false,
            error: "codex app-server initialize timed out",
            retryable_error: true,
            exit_code: null,
            timed_out: false,
            duration_ms: 3,
          } as DevTurnResult;
        }
        return "初始化重试后继续完成";
      },
    });
    const t = env.pipe.createTicket({
      title: "codex cold start",
      body: "继续工作",
      requester: "alice",
      kind: "simple",
      model: "codex-gpt-5.6-sol",
    });
    await settle(env);

    expect(attempt).toBe(2);
    expect(env.store.devTickets.getDevTicket(t.id)?.error).toBeNull();
    const notes = env.store.devTickets.listTicketMessages(t.id).map((m) => m.body);
    expect(notes.some((body) => body.includes("codex app-server initialize timed out"))).toBe(true);
    expect(env.events.map((event) => event.kind)).toEqual(["reply"]);
  });

  it("a whole-turn timeout never retries even if an adapter tag is malformed (ticket #180)", async () => {
    let attempt = 0;
    const env = await makeEnv({
      onTurn: async () => {
        attempt++;
        return {
          ok: false,
          error: "codex app-server initialize timed out",
          retryable_error: true,
          exit_code: null,
          timed_out: true,
          duration_ms: 3,
        } as DevTurnResult;
      },
    });
    env.pipe.createTicket({ title: "bounded turn", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    expect(attempt).toBe(1);
  });

  it("a failed first Codex turn resumes the reported session with a short retry prompt", async () => {
    let attempt = 0;
    const env = await makeEnv({
      onTurn: async ({ limits }) => {
        attempt++;
        if (attempt === 1) {
          limits?.onSessionId?.("codex-retry-session");
          return { ok: false, exit_code: 1, timed_out: false, duration_ms: 3 } as DevTurnResult;
        }
        return "接着完成了";
      },
    });
    env.pipe.createTicket({
      title: "codex retry",
      body: "直接处理",
      requester: "alice",
      kind: "simple",
      model: "codex-gpt-5.6-sol",
      effort: "high",
    });
    await settle(env);

    expect(env.turns).toHaveLength(2);
    expect(env.turns[1].resumeSessionId).toBe("codex-retry-session");
    expect(env.turns[1].prompt).toContain("请继续");
    expect(env.turns[1].prompt).not.toContain("你是 octopus 秘书系统");
  });

  it("stall/abort/spawn failures are NOT retried — sleep does not fix them (ticket #20)", async () => {
    let attempt = 0;
    const env = await makeEnv({
      onTurn: async () => {
        attempt++;
        return { ok: false, error: "未找到 claude 命令 — bot 进程的 PATH 里没有它", exit_code: null, timed_out: false, duration_ms: 3 } as DevTurnResult;
      },
    });
    env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    expect(attempt).toBe(1); // spawn error is deterministic — a nap can't fix it
  });

  /**
   * Ticket #180 — "one ticket started executing twice".
   *
   * The ghost-session restart used to fire on a bare `!r.ok`, so a turn that
   * we ourselves killed (cancel / shutdown) or that ran past a bound was read
   * as "the session never materialised" and answered with a second FULL agent
   * run inside the same turn — new session id, whole intro prompt, the same
   * inbox. From the panel that is indistinguishable from the ticket starting
   * over on its own.
   */
  async function ghostRestartEnv(secondTurn: DevTurnResult) {
    let attempt = 0;
    const env = await makeEnv({
      onTurn: async () => {
        attempt++;
        // Turn 1 dies before any agent reply, so the ticket keeps a session id
        // that nothing on disk backs — the exact precondition for the restart.
        // A spawn error is used because ticket #20 never retries it, which
        // keeps the turn count in this test unambiguous.
        if (attempt === 1) {
          return { ok: false, error: "未找到 claude 命令", exit_code: null, timed_out: false, duration_ms: 3 } as DevTurnResult;
        }
        if (attempt === 2) return secondTurn;
        return "新会话接上了";
      },
    });
    // Ghost-session recovery is a Claude-only path: Claude receives a
    // pre-allocated id before launch, while Codex persists the id reported by
    // `thread.started` and therefore has no id when spawning fails this early.
    const t = env.pipe.createTicket({
      title: "t",
      body: "b",
      requester: "alice",
      kind: "simple",
      model: "claude-opus-5",
    });
    await settle(env);
    const ghostSession = env.store.devTickets.getDevTicket(t.id)!.session_id;
    expect(ghostSession).toBeTruthy();
    env.pipe.postMessage(t.id, "alice", "web", "再试一次");
    await settle(env);
    return { env, ticket: t, ghostSession };
  }

  it("an aborted turn is not a ghost session — it does not start a second agent run (ticket #180)", async () => {
    const { env, ticket, ghostSession } = await ghostRestartEnv({
      ok: false, aborted: true, exit_code: null, timed_out: false, duration_ms: 3,
    });

    // Two turns total: the first attempt and the resume we aborted. No third.
    expect(env.turns).toHaveLength(2);
    expect(env.turns[1].resumeSessionId).toBe(ghostSession);
    // The session id survives, so the panel still points at the conversation
    // the user was watching instead of a freshly minted empty one.
    expect(env.store.devTickets.getDevTicket(ticket.id)!.session_id).toBe(ghostSession);
    const bodies = env.store.devTickets.listTicketMessages(ticket.id).map((m) => m.body);
    expect(bodies.some((b) => b.includes("上一个会话没能恢复"))).toBe(false);
    expect(bodies.some((b) => b.includes("本轮被终止"))).toBe(true);
  });

  it("a stalled or timed-out turn is not a ghost session either (ticket #180)", async () => {
    const stalled = await ghostRestartEnv({
      ok: false, stalled: true, exit_code: null, timed_out: false, duration_ms: 3,
    });
    expect(stalled.env.turns).toHaveLength(2);

    const timedOut = await ghostRestartEnv({
      ok: false, exit_code: null, timed_out: true, duration_ms: 3,
    });
    expect(timedOut.env.turns).toHaveLength(2);
  });

  it("a resume that really found nothing still restarts once, and says so (ticket #180)", async () => {
    // The shape a ghost session actually has: the CLI came up, `--resume` found
    // no such conversation, it exited non-zero on its own.
    const { env, ticket, ghostSession } = await ghostRestartEnv({
      ok: false, exit_code: 1, timed_out: false, duration_ms: 3,
    });

    expect(env.turns).toHaveLength(3);
    expect(env.turns[2].resumeSessionId).toBeUndefined();
    expect(env.turns[2].sessionId).toBeTruthy();
    expect(env.turns[2].sessionId).not.toBe(ghostSession);
    expect(env.store.devTickets.getDevTicket(ticket.id)!.session_id).not.toBe(ghostSession);
    // The restart is now visible in the conversation rather than silent — a
    // second start nobody announced is what made this look like a bug.
    const bodies = env.store.devTickets.listTicketMessages(ticket.id).map((m) => m.body);
    expect(bodies.some((b) => b.includes("上一个会话没能恢复"))).toBe(true);
  });

  it("session already established → follow-up turn uses the SHORT prompt, not another intro (ticket #20)", async () => {
    // sessionExists returns true → the CLI has already been seeded with the
    // intro in a prior run, so the pipeline should switch to the "inbox +
    // 请继续" shape instead of re-injecting the whole intro. This models the
    // "first turn crashed after writing the session file" case that the
    // user hit and complained about ("prompt 组装了一个初始启动风格的很长的prompt").
    let sessionOnDisk = false;
    const env = await makeEnv({
      sessionExists: () => sessionOnDisk,
      onTurn: async () => {
        // Once the turn runs, pretend the CLI has now materialised the transcript.
        sessionOnDisk = true;
        return "第一轮";
      },
    });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    expect(env.turns[0].prompt).toContain("# 工单 #1"); // full intro on turn 1
    expect(env.turns[0].prompt).toContain("## 名字");

    // Now a user follow-up: the session file exists → short prompt.
    env.pipe.postMessage(t.id, "alice", "web", "追加一句");
    await settle(env);
    expect(env.turns).toHaveLength(2);
    expect(env.turns[1].prompt).not.toContain("# 工单 #1");
    expect(env.turns[1].prompt).not.toContain("## 名字");
    expect(env.turns[1].prompt).toContain("请继续");
    expect(env.turns[1].prompt).toContain("[alice via web]: 追加一句");
    expect(env.turns[1].resumeSessionId).toBeTruthy();
  });

  it("a message posted mid-turn goes INTO that turn, not into a queue (ticket #183)", async () => {
    let ticketId = 0;
    const delivered: string[] = [];
    let receipt: ReturnType<DevPipeline["postMessage"]> | undefined;
    const env = await makeEnv({
      onTurn: async ({ limits, env: e }) => {
        // The transport opens its interjection window for the whole turn.
        limits?.onInterject?.((text) => {
          delivered.push(text);
          return true;
        });
        // Somebody types while the agent is working.
        receipt = e.pipe.postMessage(ticketId, "alice", "web", "顺便把标题也改一下");
        limits?.onInterject?.(null);
        return "两件事都做完了";
      },
    });
    const t = env.pipe.createTicket({ title: "t", body: "做 A", requester: "alice", kind: "simple" });
    ticketId = t.id;
    await settle(env);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("[alice via web]: 顺便把标题也改一下");
    expect(delivered[0]).toContain("本轮执行途中"); // interjection wording, not a new-turn prompt
    // The whole point: no second turn had to be spawned for that message…
    expect(env.turns).toHaveLength(1);
    // …and the message is recorded as consumed by the turn that took it, so
    // the pump can never deliver it a second time.
    const msgs = env.store.devTickets.listTicketMessages(t.id);
    const injected = msgs.find((m) => m.body === "顺便把标题也改一下")!;
    expect(injected.delivered_turn).not.toBeNull();
    expect(receipt?.delivered_turn).toBe(injected.delivered_turn);
    expect(msgs.some((m) => m.author === "pipeline" && m.body.includes("已排队"))).toBe(false);
    expect(env.store.devTickets.listTicketsNeedingTurn()).toHaveLength(0);
  });

  it("holds a startup message until the live transport opens", async () => {
    let ticketId = 0;
    const delivered: string[] = [];
    let receipt: ReturnType<DevPipeline["postMessage"]> | undefined;
    const env = await makeEnv({
      onTurn: async ({ limits, env: e }) => {
        // `turn_started_at` is already visible, but an RPC process may still
        // be starting and has not published its provider channel yet.
        receipt = e.pipe.postMessage(ticketId, "alice", "web", "启动时补充一句");
        expect(receipt.delivered_turn).toBeNull();
        expect(e.store.devTickets.listTicketMessages(ticketId).at(-1)?.delivered_turn).toBeNull();

        limits?.onInterject?.((text) => {
          delivered.push(text);
          return true;
        });
        await Promise.resolve();
        limits?.onInterject?.(null);
        return "已收到启动阶段的补充消息";
      },
    });
    const t = env.pipe.createTicket({ title: "t", body: "做 A", requester: "alice", kind: "simple" });
    ticketId = t.id;
    await settle(env);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("[alice via web]: 启动时补充一句");
    expect(env.turns).toHaveLength(1);
    const messages = env.store.devTickets.listTicketMessages(t.id);
    expect(messages.find((row) => row.body === "启动时补充一句")?.delivered_turn).not.toBeNull();
    expect(messages.some((row) => row.author === "pipeline" && row.body === QUEUED_NOTICE)).toBe(false);
  });

  it("keeps an app-server steer pending until its async receipt arrives", async () => {
    let ticketId = 0;
    let acknowledge!: (accepted: boolean) => void;
    const env = await makeEnv({
      onTurn: async ({ limits, env: e }) => {
        limits?.onInterject?.(() => new Promise<boolean>((resolve) => { acknowledge = resolve; }));
        const posted = e.pipe.postMessage(ticketId, "alice", "web", "优先检查磁盘挂载");

        // An RPC write is not a delivery receipt. The panel must keep showing
        // 待送达 until app-server accepts turn/steer.
        expect(posted.delivered_turn).toBeNull();
        expect(e.store.devTickets.listTicketMessages(ticketId).at(-1)?.delivered_turn).toBeNull();
        acknowledge(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        limits?.onInterject?.(null);
        return "已把补充信息并入当前轮";
      },
    });
    const t = env.pipe.createTicket({ title: "t", body: "做 A", requester: "alice", kind: "simple" });
    ticketId = t.id;
    await settle(env);

    expect(env.turns).toHaveLength(1);
    const message = env.store.devTickets.listTicketMessages(t.id)
      .find((row) => row.body === "优先检查磁盘挂载");
    expect(message?.delivered_turn).not.toBeNull();
    expect(env.store.devTickets.listTicketsNeedingTurn()).toHaveLength(0);
  });

  it("a turn that cannot take live input queues the message and says so (ticket #183)", async () => {
    let ticketId = 0;
    let turnNo = 0;
    const receipts: Array<ReturnType<DevPipeline["postMessage"]>> = [];
    const env = await makeEnv({
      // A transport that has no live channel keeps the durable fallback.
      onTurn: async ({ env: e }) => {
        if (turnNo++ === 0) {
          receipts.push(e.pipe.postMessage(ticketId, "alice", "web", "补充一句"));
          receipts.push(e.pipe.postMessage(ticketId, "alice", "web", "再补一句"));
        }
        return `第 ${turnNo} 轮`;
      },
    });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    ticketId = t.id;
    await settle(env);

    // Unchanged fallback: the inbox flushes both into the next turn…
    expect(env.turns).toHaveLength(2);
    expect(env.turns[1].prompt).toContain("[alice via web]: 补充一句");
    expect(env.turns[1].prompt).toContain("[alice via web]: 再补一句");
    expect(receipts.map((row) => row.delivered_turn)).toEqual([null, null]);
    // …and the wait is stated once, not once per message.
    const notes = env.store.devTickets
      .listTicketMessages(t.id)
      .filter((m) => m.author === "pipeline" && m.body === QUEUED_NOTICE);
    expect(notes).toHaveLength(1);
  });

  it("an interjection swallowed by a failed attempt rides the retry (ticket #183)", async () => {
    let ticketId = 0;
    let attempt = 0;
    const env = await makeEnv({
      onTurn: async ({ limits, env: e }) => {
        attempt++;
        if (attempt === 1) {
          limits?.onInterject?.(() => true); // accepted, then the CLI dies
          e.pipe.postMessage(ticketId, "alice", "web", "别忘了 B");
          limits?.onInterject?.(null);
          return { ok: false, exit_code: 1, timed_out: false, duration_ms: 3 } as DevTurnResult;
        }
        return "第二次做完了 A 和 B";
      },
    });
    const t = env.pipe.createTicket({ title: "t", body: "做 A", requester: "alice", kind: "simple" });
    ticketId = t.id;
    await settle(env);

    expect(attempt).toBe(2);
    // The message was stamped delivered by the dead attempt, so the inbox
    // cannot re-flush it — the retry prompt has to carry it explicitly.
    expect(env.turns[1].prompt).toContain("别忘了 B");
    expect(env.store.devTickets.getDevTicket(t.id)!.error).toBeNull();
  });

  it("start() resumes a reset-killed discussion with only the minimal continuation prompt", async () => {
    const env = await makeEnv({ onTurn: async () => "续上了" });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "discuss" });
    await settle(env);
    env.store.devTickets.updateDevTicket(t.id, { turn_started_at: "2026-07-25T00:00:00.000Z" }); // as if killed mid-turn

    env.pipe.start();
    await settle(env);
    const bodies = env.store.devTickets.listTicketMessages(t.id).map((m) => m.body);
    expect(bodies.filter((body) => body === "继续执行")).toHaveLength(1);
    expect(env.turns).toHaveLength(2);
    expect(env.turns[1].prompt).toBe("继续执行");
  });

  it("paces restart launches without waiting for the earlier recovered turn to finish", async () => {
    let restartActive = 0;
    let restartMax = 0;
    let restartEntered = 0;
    let ordinaryEntered = 0;
    let restarting = false;
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const env = await makeEnv({
      specConcurrency: 3,
      restartContinuationPaceMs: 1_000,
      onTurn: async ({ spec }) => {
        if (!restarting) return "首轮完成";
        if (spec.prompt.includes("普通用户工作")) {
          ordinaryEntered++;
          return "首轮完成";
        }
        restartEntered++;
        restartActive++;
        restartMax = Math.max(restartMax, restartActive);
        if (restartEntered === 1) await firstMayFinish;
        restartActive--;
        return "恢复完成";
      },
    });
    const first = env.pipe.createTicket({ title: "first", body: "a", requester: "alice", kind: "simple" });
    const second = env.pipe.createTicket({ title: "second", body: "b", requester: "alice", kind: "simple" });
    const ordinary = env.pipe.createTicket({ title: "ordinary", body: "c", requester: "alice", kind: "simple" });
    await settle(env);
    env.store.devTickets.updateDevTicket(first.id, { turn_started_at: "2026-08-28T09:53:00.000Z" });
    env.store.devTickets.updateDevTicket(second.id, { turn_started_at: "2026-08-28T09:53:00.000Z" });
    env.store.devTickets.addTicketMessage(ordinary.id, "alice", "web", "普通用户工作");

    restarting = true;
    env.pipe.start();
    try {
      for (let i = 0; i < 160 && (restartEntered === 0 || ordinaryEntered === 0); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(restartEntered).toBe(1);
      expect(ordinaryEntered).toBe(1);
      env.pipe.postMessage(second.id, "alice", "web", "还要检查恢复后的测试");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(restartEntered).toBe(1);

      for (let i = 0; i < 300 && restartEntered < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(restartEntered).toBe(2);
      expect(restartMax).toBe(2);
      expect(env.turns.at(-1)?.prompt).toContain("还要检查恢复后的测试");
    } finally {
      releaseFirst();
    }
    await settle(env);
  });

  it("does not hide a user message that arrived around the reset wake-up", async () => {
    const env = await makeEnv({ onTurn: async () => "续上了" });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    env.store.devTickets.updateDevTicket(t.id, { turn_started_at: "2026-07-25T00:00:00.000Z" });
    env.store.devTickets.addTicketMessage(t.id, "alice", "web", "还要检查测试");

    env.pipe.start();
    await settle(env);
    expect(env.turns).toHaveLength(2);
    expect(env.turns[1].prompt).toContain("[alice via web]: 还要检查测试");
    expect(env.turns[1].prompt).toContain("请继续。");
  });

  it("does not launch a ticket before the tool API and pipeline are ready", async () => {
    const env = await makeEnv({ autoStart: false });
    env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(env.turns).toHaveLength(0);

    // setToolApi() is late-bound during bootstrap and must not open scheduling
    // by itself; start() is the single point that releases queued work.
    env.pipe.setToolApi("http://127.0.0.1:2");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(env.turns).toHaveLength(0);

    env.pipe.start();
    await settle(env);
    expect(env.turns).toHaveLength(1);
    expect(env.turns[0].mcpConfigPath).toBeTruthy();
  });

  it("stop() aborts a discussion turn and queues exactly one restart wake-up", async () => {
    let entered!: () => void;
    const running = new Promise<void>((resolve) => { entered = resolve; });
    const env = await makeEnv({
      onTurn: async ({ limits }) => {
        entered();
        while (!limits?.shouldAbort?.()) await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          ok: false,
          exit_code: null,
          timed_out: false,
          aborted: true,
          duration_ms: 5,
        };
      },
    });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "discuss" });
    await running;

    await env.pipe.stop();

    expect(env.pipe.idle()).toBe(true);
    expect(env.store.devTickets.getDevTicket(t.id)?.turn_started_at).toBeNull();
    const wake = env.store.devTickets.listTicketMessages(t.id).filter((m) => m.body === "继续执行");
    expect(wake).toHaveLength(1);
    expect(env.store.devTickets.listTicketsNeedingTurn().map((row) => row.id)).toContain(t.id);
    expect(env.events).toEqual([]); // restart interruption is not a failed development turn
  });

  it("approveSpec/requeue compat shims post conversation messages", async () => {
    const env = await makeEnv({ onTurn: async () => "ok" });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "complex" });
    await settle(env);
    env.pipe.approveSpec(t.id);
    await settle(env);
    const bodies = env.store.devTickets.listTicketMessages(t.id).map((m) => m.body);
    expect(bodies.some((b) => b.includes("开始实现"))).toBe(true);
    expect(env.turns.length).toBe(2);
  });

  it("marks an idle ticket completed without another turn, then resumes the same session on a new message", async () => {
    const env = await makeEnv({ onTurn: async () => "all done" });
    const ticket = env.pipe.createTicket({ title: "acceptance", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    const sessionId = env.store.devTickets.getDevTicket(ticket.id)?.session_id;
    expect(sessionId).toBeTruthy();
    env.pipe.completeTicket(ticket.id, "alice");
    await settle(env);
    expect(env.turns).toHaveLength(1);
    expect(env.store.devTickets.getDevTicket(ticket.id)?.dev_status).toBe("completed");
    env.pipe.postMessage(ticket.id, "alice", "web", "one more check");
    await settle(env);
    expect(env.turns).toHaveLength(2);
    expect(env.store.devTickets.getDevTicket(ticket.id)).toMatchObject({ dev_status: "open", session_id: sessionId });
  });

  it("cancel only applies to open tickets and blocks further messages", async () => {
    const env = await makeEnv({ onTurn: async () => "ok" });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    env.pipe.cancel(t.id);
    expect(() => env.pipe.postMessage(t.id, "alice", "web", "hi")).toThrow(/已取消/);
    expect(() => env.pipe.cancel(t.id)).toThrow(/不可取消/);
    env.store.devTickets.updateDevTicket(t.id, { dev_status: "landed" });
    expect(() => env.pipe.cancel(t.id)).toThrow(/不可取消/);
  });

  /**
   * Ticket #184. "Stop this turn" and "cancel this ticket" were the same
   * button, so the only way to interrupt an agent going the wrong way was to
   * throw the ticket away. They are now separate acts with separate outcomes.
   */
  describe("stopping one turn", () => {
    it("aborts the running turn while the ticket stays open and resumable", async () => {
      let sawAbort = false;
      const env = await makeEnv({
        onTurn: async ({ limits, env: e }) => {
          const id = e.store.devTickets.listDevTickets(10)[0].id;
          e.pipe.interruptTurn(id, "alice");
          // What the executor's watcher polls — the only channel a running
          // child has for learning that somebody pressed stop.
          sawAbort = limits?.shouldAbort?.() === true;
          return { ok: false, aborted: true, exit_code: null, timed_out: false, duration_ms: 5 } as DevTurnResult;
        },
      });
      const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
      await settle(env);

      expect(sawAbort).toBe(true);
      const row = env.store.devTickets.getDevTicket(t.id)!;
      // Open, un-errored, one turn only: not a failure and not a retry.
      expect(row.dev_status).toBe("open");
      expect(row.error).toBeFalsy();
      expect(env.turns).toHaveLength(1);
      const bodies = env.store.devTickets.listTicketMessages(t.id).map((m) => m.body);
      expect(bodies.some((b) => b.includes("alice 停止了这一轮"))).toBe(true);
      expect(bodies.some((b) => b.includes("工单已取消"))).toBe(false);
    });

    it("does not leak a stop request into the next turn", async () => {
      let turn = 0;
      const aborts: boolean[] = [];
      const env = await makeEnv({
        onTurn: async ({ limits, env: e }) => {
          turn += 1;
          const id = e.store.devTickets.listDevTickets(10)[0].id;
          if (turn === 1) e.pipe.interruptTurn(id, "alice");
          aborts.push(limits?.shouldAbort?.() === true);
          return turn === 1
            ? { ok: false, aborted: true, exit_code: null, timed_out: false, duration_ms: 5 } as DevTurnResult
            : "继续做完了";
        },
      });
      const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
      await settle(env);
      env.pipe.postMessage(t.id, "alice", "web", "换个方向做");
      await settle(env);

      // The second turn is the reader's follow-up and must run to completion.
      expect(aborts).toEqual([true, false]);
      const bodies = env.store.devTickets.listTicketMessages(t.id).map((m) => m.body);
      expect(bodies.some((b) => b.includes("继续做完了"))).toBe(true);
    });

    it("refuses when there is no turn to stop, rather than arming the next one", async () => {
      const env = await makeEnv({ onTurn: async () => "ok" });
      const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
      await settle(env);
      expect(() => env.pipe.interruptTurn(t.id, "alice")).toThrow(/没有正在执行的轮次/);
      expect(() => env.pipe.interruptTurn(99_999, "alice")).toThrow(/工单不存在/);
    });
  });

});

// ── submit tool (ticket #16: parallel coding + serial merge) ──
//
// The claim tool is gone. Agents type in their own worktree with no coord,
// and every merge-phase concern (rebase, gates, ff, ghost guard) lives
// inside a single atomic toolSubmit call under the merge lock.
//
// Since 2026-08-09 a submit runs NOTHING unless the turn names tests, so every
// case below whose subject IS the gate window has to name one. `NAMED` is that
// opt-in: its value never reaches a real vitest — `makeEnv` intercepts the gate
// — what it buys is a non-empty step list, i.e. the window existing at all.
const NAMED = ["packages/bot/src/devpipe"];

describe("submit (owns the whole merge phase)", () => {
  it("reuses a clean primary worktree that already holds the base branch", async () => {
    const env = await makeEnv({
      autoStart: false,
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "primary-holder.ts");
        const sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        expect(sub.ok).toBe(true);
        return "已通过主基线树落地";
      },
    });
    await gitOrThrow(env.repo, ["checkout", "main"]);
    env.pipe.start();

    const ticket = env.pipe.createTicket({ title: "primary holder", body: "b", requester: "alice", kind: "simple" });
    await settle(env);

    expect(env.store.devTickets.getDevTicket(ticket.id)?.dev_status).toBe("landed");
    expect(await gitOrThrow(env.repo, ["status", "--porcelain"])).toBe("");
    expect(readdirSync(join(env.dir, "worktrees")).some((name) => name.startsWith("_base-main-"))).toBe(false);
  });

  it("hands the landed sha to the build warmer, after the merge lock is released", async () => {
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "warm-me.ts");
        const sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        expect(sub.ok).toBe(true);
        // The whole point of warming AFTER the ff: submit returns without
        // waiting for a build, and the lock is already free for the next
        // ticket. A warm that blocked here would just move the user's wait.
        expect(e.pipe.mergeLockHolder()).toBe(null);
        return "已落地";
      },
    });

    const ticket = env.pipe.createTicket({ title: "warm", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    await waitForWarm(env);

    const row = env.store.devTickets.getDevTicket(ticket.id)!;
    expect(row.dev_status).toBe("landed");
    expect(env.warmCalls).toEqual([row.commit_sha]);
  });

  it("refuses to advance through a dirty primary base holder", async () => {
    const env = await makeEnv({ autoStart: false });
    await gitOrThrow(env.repo, ["checkout", "main"]);
    writeFileSync(join(env.repo, "local-note.txt"), "do not overwrite\n");

    await expect(env.pipe.ffBranchTo("main", "main")).rejects.toThrow(/不是干净的只读基线树/);
    expect(readFileSync(join(env.repo, "local-note.txt"), "utf8")).toBe("do not overwrite\n");
  });

  it("never reuses v2's legacy _base worktree for another base branch", async () => {
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "v3-only.ts");
        const sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        expect(sub.ok).toBe(true);
        return "已落到 main,没有碰 legacy";
      },
    });

    // Model the production layout found during the v3 review: `_base` already
    // belongs to the old line. The old implementation saw a valid worktree and
    // merged there, while reporting the ticket as landed on `main`.
    await gitOrThrow(env.repo, ["branch", "legacy", "main"]);
    const legacyBase = join(env.dir, "worktrees", "_base");
    mkdirSync(dirname(legacyBase), { recursive: true });
    await gitOrThrow(env.repo, ["worktree", "add", legacyBase, "legacy"]);

    const beforeLegacy = await gitOrThrow(env.repo, ["rev-parse", "legacy"]);
    const t = env.pipe.createTicket({ title: "v3", body: "b", requester: "alice", kind: "simple" });
    await settle(env);

    const row = env.store.devTickets.getDevTicket(t.id)!;
    expect(row.dev_status).toBe("landed");
    expect(await gitOrThrow(env.repo, ["rev-parse", "main"])).toBe(row.commit_sha);
    expect(await gitOrThrow(env.repo, ["rev-parse", "legacy"])).toBe(beforeLegacy);
    expect(readdirSync(join(env.dir, "worktrees")).some((n) => n.startsWith("_base-main-"))).toBe(true);
  });

  it("simple ticket: commit → submit lands on the base branch in one turn", async () => {
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "packages/bot/src/fix.ts");
        const sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        expect(sub.ok).toBe(true);
        return "## 名字\n一轮闭环\n\n已实现并落地。";
      },
    });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);

    const row = env.store.devTickets.getDevTicket(t.id)!;
    expect(row.dev_status).toBe("landed");
    expect(row.deploy_status).toBe("pending");
    expect(row.commit_sha).toBeTruthy();
    expect(row.landed_at).toBeTruthy(); // ticket #16 T5a
    expect(env.events.map((e) => e.kind)).toEqual(["landed"]);
    // The base branch really moved.
    const baseTip = await gitOrThrow(env.repo, ["rev-parse", "main"]);
    expect(baseTip).toBe(row.commit_sha);
  });

  it("synthesizes a minimal landing record when submit lands but the agent has no final reply", async () => {
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "resultless.ts");
        const sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        expect(sub.ok).toBe(true);
        return {
          ok: true,
          session_id: "s-x",
          exit_code: 0,
          timed_out: false,
          duration_ms: 5,
        } satisfies DevTurnResult;
      },
    });
    const ticket = env.pipe.createTicket({ title: "resultless", body: "b", requester: "alice", kind: "simple" });
    await settle(env);

    const row = env.store.devTickets.getDevTicket(ticket.id)!;
    expect(row.dev_status).toBe("landed");
    expect(row.error).toBeNull();
    const messages = env.store.devTickets.listTicketMessages(ticket.id);
    expect(messages.filter((message) => message.author === "agent")).toHaveLength(0);
    const synthesized = messages.filter((message) => message.body.includes("系统合成落地记录"));
    expect(synthesized).toHaveLength(1);
    expect(synthesized[0]).toMatchObject({ author: "pipeline", via: "pipeline" });
    expect(synthesized[0]!.body).toContain(row.commit_sha);
    expect(synthesized[0]!.body).toContain("交付分类: `full_deploy`");
    expect(synthesized[0]!.body).toContain("受影响 App 数: 0");
    expect(env.events.map((event) => event.kind)).toEqual(["landed"]);
  });

  it("keeps an agent landing reply without adding a synthesized duplicate", async () => {
    const finalReply = "## 名字\n正常收尾记录\n\n已落地并完成验证。";
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "with-final.ts");
        const sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        expect(sub.ok).toBe(true);
        return finalReply;
      },
    });
    const ticket = env.pipe.createTicket({ title: "with final", body: "b", requester: "alice", kind: "simple" });
    await settle(env);

    const messages = env.store.devTickets.listTicketMessages(ticket.id);
    expect(messages.filter((message) => message.author === "agent").map((message) => message.body)).toEqual([finalReply]);
    expect(messages.some((message) => message.body.includes("系统合成落地记录"))).toBe(false);
  });

  it("submit keeps the lock across moved-base review/revalidation, then lands the stable candidate", async () => {
    const subs: SubmitResult[] = [];
    const holdersDuringReview: Array<number | null> = [];
    // Seed a "prior" landed ticket so landed_ahead has something to name.
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e, spec }) => {
        // Match the posted message verbatim, not a substring of it: the intro
        // prompt is long prose and "动手" alone started matching turn 1 the
        // moment an old repository-wide policy paragraph added that word.
        if (!spec.prompt.includes("现在动手")) return "先看看";
        await commitWork(cwd, "mine.ts");
        subs.push((await e.pipe.toolSubmit(token!)) as SubmitResult);
        holdersDuringReview.push(e.pipe.mergeLockHolder());
        // Stand in for the agent's landed_ahead review + CI revalidation. The
        // second submit re-enters the lock and may fast-forward without another
        // ticket moving the base during that review window.
        subs.push((await e.pipe.toolSubmit(token!)) as SubmitResult);
        return "已 submit";
      },
    });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env); // worktree branched at the original base

    // Stand in for "another ticket landed while I was coding": bump base and
    // fake a dev_tickets row whose commit_sha points at the new base tip, so
    // landedAheadOf() finds it.
    await advanceBase(env, "moved.txt");
    const moverSha = (await gitOrThrow(env.repo, ["rev-parse", "main"])).trim();
    const mover = env.store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "mover", body: "先我一步", requester: "alice",
    }));
    env.store.devTickets.updateDevTicket(mover.id, {
      dev_status: "landed",
      deploy_status: "pending",
      commit_sha: moverSha,
      landed_at: new Date().toISOString(),
    });
    env.store.devTickets.takeTicketInbox(mover.id, 999); // silence its own turn

    env.pipe.postMessage(t.id, "alice", "web", "现在动手");
    await settle(env);

    expect(subs[0]?.ok).toBe(false);
    expect(subs[0]?.code).toBe("base_changed_review");
    expect(subs[0]?.ff_commits).toContain("add moved.txt");
    expect(subs[0]?.landed_ahead?.[0]?.id).toBe(mover.id);
    expect(subs[0]?.landed_ahead?.[0]?.title).toBe("mover");
    expect(subs[0]?.landed_ahead?.[0]?.body_head).toContain("先我一步");
    expect(subs[0]?.message).toContain("devpipe_ci_sync");
    expect(subs[0]?.message).toContain("合并锁仍由本轮持有");
    expect(holdersDuringReview).toEqual([t.id]);
    expect(subs[1]?.ok).toBe(true);
    expect(env.pipe.mergeLockHolder()).toBeNull();
    // The worktree now contains the moved base's file.
    const wt = env.store.devTickets.getDevTicket(t.id)!.worktree!;
    expect(readFileSync(join(wt, "moved.txt"), "utf8")).toBe("work\n");
  });

  it("turn end releases a lock retained for moved-base review", async () => {
    let sub: SubmitResult | undefined;
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e, spec }) => {
        if (!spec.prompt.includes("现在动手")) return "先看看";
        await commitWork(cwd, "mine.ts");
        sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        return "复验没做完,结束本轮";
      },
    });
    const ticket = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    await advanceBase(env, "moved.txt");

    env.pipe.postMessage(ticket.id, "alice", "web", "现在动手");
    await settle(env);

    expect(sub?.code).toBe("base_changed_review");
    expect(env.pipe.mergeLockHolder()).toBeNull();
    expect(env.store.devTickets.listTicketMessages(ticket.id).map((row) => row.body).join("\n"))
      .toContain("落地未完成),已自动释放");
  });

  it("ci-sync ships only a clean committed HEAD to the ticket's isolated workspace", async () => {
    const syncs: Array<{ sourceDir: string; ref: string; ticketId: number }> = [];
    let result: Awaited<ReturnType<DevPipeline["toolCiSync"]>> | undefined;
    let machinesEnv: Record<string, string> | undefined;
    const env = await makeEnv({
      ciMachine: () => ({
        apiUrl: "http://127.0.0.1:2",
        apiToken: "machine-token",
        target: { device: "ci", checkoutDir: "/work/octopus" },
        close: () => {},
      }),
      ciMachineSync: async (input) => {
        syncs.push(input);
        return {
          ok: true,
          sha: await gitOrThrow(input.sourceDir, ["rev-parse", "HEAD"]),
          checkoutDir: `/work/tickets/ticket-${input.ticketId}`,
        };
      },
      onTurn: async ({ cwd, token, env: e, spec }) => {
        const config = JSON.parse(readFileSync(spec.mcpConfigPath!, "utf8")) as {
          mcpServers: { machines: { env: Record<string, string> } };
        };
        machinesEnv = config.mcpServers.machines.env;
        await commitWork(cwd, "verified.ts");
        result = await e.pipe.toolCiSync(token!);
        return "已同步验证";
      },
    });
    const ticket = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);

    expect(syncs).toHaveLength(2); // turn-start seed + post-commit exact HEAD
    expect(syncs[1]).toMatchObject({ ref: "HEAD", ticketId: ticket.id });
    expect(result?.ok).toBe(true);
    expect(result?.device).toBe("ci");
    expect(result?.checkout_dir).toBe(`/work/tickets/ticket-${ticket.id}`);
    expect(result?.message).toContain("machine_exec(device=ci");
    expect(result?.message).toContain("编译并跑相关小测试");
    expect(machinesEnv).toMatchObject({
      MACHINES_DEVICE: "ci",
      MACHINES_AUTO_ALLOW: "1",
      MACHINES_TOKEN: "machine-token",
    });
  });

  it("keeps a timed-out submit alive and rejects a same-turn duplicate", async () => {
    // The package targets ES2022, so capture resolvers explicitly instead of
    // relying on the ES2024 Promise.withResolvers API.
    let markGateEntered: (() => void) | undefined;
    let releaseGate: (() => void) | undefined;
    let markTurnTimedOut: (() => void) | undefined;
    const gateEntered = new Promise<void>((resolve) => { markGateEntered = resolve; });
    const gateReleased = new Promise<void>((resolve) => { releaseGate = resolve; });
    const turnTimedOut = new Promise<void>((resolve) => { markTurnTimedOut = resolve; });
    let detached: Promise<SubmitResult> | undefined;
    let duplicate: SubmitResult | undefined;
    let activeStatus: StatusResult | undefined;
    let gateCalls = 0;
    const env = await makeEnv({
      gate: async () => {
        gateCalls += 1;
        markGateEntered?.();
        await gateReleased;
        return { ok: true, log: "ok" };
      },
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "singleflight.ts");
        detached = e.pipe.toolSubmit(token!, NAMED);
        await gateEntered;
        duplicate = await e.pipe.toolSubmit(token!, NAMED);
        activeStatus = await e.pipe.toolStatus(token!) as StatusResult;
        markTurnTimedOut?.();
        // Reproduce an MCP client timeout: the agent turn ends without awaiting
        // the first HTTP operation. runTicketTurn must preserve that submit.
        return "MCP 客户端已超时";
      },
    });

    const ticket = env.pipe.createTicket({ title: "singleflight", body: "b", requester: "alice", kind: "simple" });
    await turnTimedOut;

    expect(duplicate?.code).toBe("submit_in_progress");
    expect(duplicate?.message).toContain("原调用");
    expect(activeStatus).toMatchObject({
      submits_left: 2,
      submit: { state: "running" },
    });
    expect(activeStatus?.message).toContain("禁止重复调用");
    expect(gateCalls).toBe(1);

    releaseGate?.();
    await settle(env);
    await expect(detached).resolves.toMatchObject({ ok: true });
    expect(env.store.devTickets.getDevTicket(ticket.id)?.dev_status).toBe("landed");
  });

  it("the merge lock is exclusive: second submitter parks, release wakes it, second try lands", async () => {
    let holdRelease: (() => void) | undefined;
    const held = new Promise<void>((r) => (holdRelease = r));
    const queued: SubmitResult[] = [];
    // Track whether we've already committed each ticket's work: a wake
    // turn revisits the same worktree and commit is idempotent (nothing
    // new to add), so we skip re-committing on the retry.
    const committed = new Set<string>();
    const env = await makeEnv({
      gate: async () => {
        // "A" is running its gate — hold the merge lock until we say go.
        await held;
        return { ok: true, log: "ok" };
      },
      onTurn: async ({ cwd, spec, token, env: e }) => {
        const key = spec.prompt.includes("霸占") ? "a" : "b";
        if (!committed.has(cwd)) {
          await commitWork(cwd, `${key}.ts`);
          committed.add(cwd);
        }
        let r = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        if (r.code === "queued") {
          queued.push(r);
          return "被排队,先歇了";
        }
        if (r.code === "base_changed_review") {
          // The production agent reviews landed_ahead, syncs and revalidates
          // before this retry; this harness has no product code to reconcile.
          r = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        }
        return r.ok ? "落地了" : "失败";
      },
    });
    const a = env.pipe.createTicket({ title: "a", body: "霸占锁", requester: "alice", kind: "simple" });
    const b = env.pipe.createTicket({ title: "b", body: "也想合并", requester: "alice", kind: "simple" });
    try {
      // Wait until one submitter is queued while the scheduler-selected holder's
      // gate blocks. Ticket turns start concurrently, so either may acquire first.
      for (let i = 0; i < 200 && queued.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      const firstHolder = queued[0]?.holder;
      expect(firstHolder).toBeDefined();
      expect(env.pipe.lockWaiterIds()).toHaveLength(1);
      expect(env.store.devTickets.listMergeWaiters().map((row) => row.ticket_id)).toEqual(env.pipe.lockWaiterIds());
      expect([firstHolder!, env.pipe.lockWaiterIds()[0]].sort((x, y) => x - y)).toEqual(
        [a.id, b.id].sort((x, y) => x - y),
      );
    } finally {
      // The holder's gate returns → ff → release → waiter gets a wake message.
      holdRelease?.();
    }
    await settle(env);
    const bMsgs = env.store.devTickets.listTicketMessages(b.id).map((m) => m.body);
    const aMsgs = env.store.devTickets.listTicketMessages(a.id).map((m) => m.body);
    expect([...aMsgs, ...bMsgs].some((m) => m.includes("FIFO 合并锁已为本票短暂预留"))).toBe(true);
    // On its wake turn, the waiter re-submitted, rebased, and landed.
    expect(env.store.devTickets.getDevTicket(a.id)!.dev_status).toBe("landed");
    const rowB = env.store.devTickets.getDevTicket(b.id)!;
    expect(rowB.dev_status).toBe("landed");
    expect(rowB.landed_at).toBeTruthy();
  });

  it("restores and wakes a landed ticket's durable follow-up wait after restart", async () => {
    let prompt = "";
    const env = await makeEnv({
      autoStart: false,
      onTurn: async ({ spec }) => {
        prompt = spec.prompt;
        return "已收到恢复后的 FIFO 唤醒";
      },
    });
    const ticket = env.pipe.createTicket({ title: "landed follow-up", body: "old", requester: "alice", kind: "simple" });
    env.store.devTickets.takeTicketInbox(ticket.id, 1);
    env.store.devTickets.updateDevTicket(ticket.id, { dev_status: "landed" });
    env.store.devTickets.rememberMergeWaiter(ticket.id, "2026-08-25T00:00:00.000Z");

    env.pipe.start();
    await settle(env);

    expect(prompt).toContain("FIFO 合并锁已为本票短暂预留");
    expect(env.store.devTickets.listMergeWaiters().map((row) => row.ticket_id)).toEqual([ticket.id]);
    expect(env.pipe.lockWaiterIds()).toEqual([ticket.id]);
  });

  it("release targets only the FIFO head instead of waking every parked ticket", async () => {
    let releaseFirst!: () => void;
    let allowWakeTurns!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const wakeTurnsAllowed = new Promise<void>((resolve) => { allowWakeTurns = resolve; });
    const committed = new Map<string, string>();
    const queued: SubmitResult[] = [];
    let gateRuns = 0;
    const env = await makeEnv({
      specConcurrency: 3,
      gate: async () => {
        gateRuns++;
        if (gateRuns === 1) await firstGate;
        return { ok: true, log: "ok" };
      },
      onTurn: async ({ cwd, spec, token, env: e }) => {
        if (spec.prompt.includes("FIFO 合并锁已为本票短暂预留")) {
          await wakeTurnsAllowed;
        }
        if (!committed.has(cwd)) {
          const rel = `change-${committed.size + 1}.ts`;
          committed.set(cwd, rel);
          await commitWork(cwd, rel);
        }
        let result = (await e.pipe.toolSubmit(token!, NAMED)) as SubmitResult;
        if (result.code === "base_changed_review") {
          result = (await e.pipe.toolSubmit(token!, NAMED)) as SubmitResult;
        }
        if (result.code === "queued") queued.push(result);
        return result.ok ? "落地" : `暂停:${result.code}`;
      },
    });
    const ids = [
      env.pipe.createTicket({ title: "a", body: "持锁-A", requester: "alice", kind: "simple" }).id,
      env.pipe.createTicket({ title: "b", body: "等待-B", requester: "alice", kind: "simple" }).id,
      env.pipe.createTicket({ title: "c", body: "等待-C", requester: "alice", kind: "simple" }).id,
    ];

    try {
      for (let i = 0; i < 300 && queued.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(queued).toHaveLength(2);
      expect(env.pipe.lockWaiterIds()).toHaveLength(2);

      releaseFirst();
      for (let i = 0; i < 300; i++) {
        const hasTarget = ids.some((id) => env.store.devTickets.listTicketMessages(id)
          .some((message) => message.body.includes("FIFO 合并锁已为本票短暂预留")));
        if (hasTarget) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const targeted = ids.filter((id) => env.store.devTickets.listTicketMessages(id)
        .some((message) => message.body.includes("FIFO 合并锁已为本票短暂预留")));
      expect(targeted).toHaveLength(1);
      expect(env.pipe.lockWaiterIds()).toHaveLength(2);
    } finally {
      releaseFirst();
      allowWakeTurns();
    }

    await settle(env);
    expect(ids.map((id) => env.store.devTickets.getDevTicket(id)?.dev_status)).toEqual([
      "landed",
      "landed",
      "landed",
    ]);
  });

  it("preflight: dirty tree and no-commits fail without taking the lock", async () => {
    const results: SubmitResult[] = [];
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        results.push((await e.pipe.toolSubmit(token!)) as SubmitResult); // no_commits
        writeFileSync(join(cwd, "loose.txt"), "uncommitted\n");
        results.push((await e.pipe.toolSubmit(token!)) as SubmitResult); // dirty
        return "done";
      },
    });
    env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    expect(results.map((r) => r.code)).toEqual(["no_commits", "dirty"]);
    // Lock never got taken by the failed preflights — verified by mergeLockHolder.
    expect(env.pipe.mergeLockHolder()).toBeNull();
  });

  it("submit blocks protected paths (preflight, before the merge lock)", async () => {
    let sub: SubmitResult | undefined;
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "scripts/evil.sh");
        sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        return "done";
      },
    });
    env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    expect(sub?.ok).toBe(false);
    expect(sub?.code).toBe("protected_paths");
    expect(sub?.files).toEqual(["scripts/evil.sh"]);
    expect((await gitOrThrow(env.repo, ["log", "--oneline", "main"])).split("\n")).toHaveLength(1);
    expect(env.pipe.mergeLockHolder()).toBeNull();
  });

  it("submit lands a TCB diff and records one concise trust-boundary note", async () => {
    let sub: SubmitResult | undefined;
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "packages/capability-kernel/src/core.ts");
        sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        return "done";
      },
    });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);

    expect(sub?.ok).toBe(true);
    expect(sub?.code).toBeUndefined();
    expect(sub?.message).toContain("已记录提示但不阻断合入");
    expect((await gitOrThrow(env.repo, ["log", "--oneline", "main"])).split("\n")).toHaveLength(2);
    expect(env.pipe.mergeLockHolder()).toBeNull();
    expect(env.store.devTickets.getDevTicket(t.id)!.dev_status).toBe("landed");
    const note = env.store.devTickets.listTicketMessages(t.id).find((m) => m.author === "pipeline");
    expect(note?.body).toContain("packages/capability-kernel/src/core.ts");
    expect(note?.body).toContain("doc/tcb-reading-guide.md");
  });

  it("ordinary code next door to a TCB file lands as usual", async () => {
    // Keep the observability list precise enough that its notes stay useful.
    // These two files live in directories that DO contain TCB files.
    let sub: SubmitResult | undefined;
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "packages/bot/src/dashboard/tickets-page.ts");
        await commitWork(cwd, "packages/bot/src/runner/archive.ts");
        sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        return "落地了";
      },
    });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);

    expect(sub?.code).toBeUndefined();
    expect(sub?.ok).toBe(true);
    expect(env.store.devTickets.getDevTicket(t.id)!.dev_status).toBe("landed");
  });

  it("renaming a TCB file to an unlisted name remains visible in the landing note", async () => {
    // `git diff --name-only` has rename detection on by default and prints
    // only the destination — so without --no-renames, `git mv authz.ts
    // authz2.ts` shows only the destination and loses the useful signal.
    let sub: SubmitResult | undefined;
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        await gitOrThrow(cwd, ["mv", "packages/bot/src/dashboard/authz.ts", "packages/bot/src/dashboard/authz2.ts"]);
        await gitOrThrow(cwd, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "move it"]);
        sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        return "done";
      },
    });
    // The guarded file has to pre-exist on the base for a rename to be a rename.
    await advanceBase(env, "packages/bot/src/dashboard/authz.ts");
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);

    expect(sub?.ok).toBe(true);
    const note = env.store.devTickets.listTicketMessages(t.id).find((m) => m.author === "pipeline");
    expect(note?.body).toContain("packages/bot/src/dashboard/authz.ts");
  });

  it("gate failure releases the lock, feeds the log back, caps attempts per turn", async () => {
    const results: SubmitResult[] = [];
    let gateCalls = 0;
    const env = await makeEnv({
      gate: async () => ({ ok: false, log: `vitest exploded (${++gateCalls})` }),
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "fix.ts");
        for (let i = 0; i < 4; i++) results.push((await e.pipe.toolSubmit(token!, NAMED)) as SubmitResult);
        return "修不动了";
      },
    });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    expect(results.map((r) => r.code)).toEqual(["gate_failed", "gate_failed", "gate_failed", "attempts_exhausted"]);
    expect(results[0].gate_log_tail).toContain("vitest exploded");
    expect(gateCalls).toBe(3); // 4th capped
    // Each gate failure released the lock (parallel coding + serial merge: a
    // lock hung on failure would deadlock every other submitter).
    expect(env.pipe.mergeLockHolder()).toBeNull();
    expect(env.store.devTickets.getDevTicket(t.id)!.dev_status).toBe("open");
  });

  it("rebase conflict releases the lock, hands back conflict files, worktree stays mid-rebase", async () => {
    let sub: SubmitResult | undefined;
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e, spec }) => {
        if (!spec.prompt.includes("现在冲突")) {
          // Set up: create a commit touching README that will clash later.
          await commitWork(cwd, "README.md", "ticket edit\n");
          return "先码好";
        }
        sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        return "conflict test done";
      },
    });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    await advanceBase(env, "README.md"); // same file → rebase conflict
    env.pipe.postMessage(t.id, "alice", "web", "现在冲突");
    await settle(env);

    expect(sub?.ok).toBe(false);
    expect(sub?.code).toBe("rebase_conflict");
    expect(sub?.conflict_files?.length).toBeGreaterThan(0);
    // Lock must be released so other submitters are not blocked by our conflict.
    expect(env.pipe.mergeLockHolder()).toBeNull();
    // The worktree is left mid-rebase for the agent to resolve.
    const wt = env.store.devTickets.getDevTicket(t.id)!.worktree!;
    expect(existsSync(join(wt, ".git")) || existsSync(join(wt, "..", ".git"))).toBe(true);
  });

  it("base moved during the gate → base_moved, lock released, next submit lands", async () => {
    const subs: SubmitResult[] = [];
    let gated = false;
    const env = await makeEnv({
      gate: async () => {
        if (!gated) {
          gated = true;
          // A human lands something after our rebase, during our gate.
          await advanceBase(env!, "their.ts");
        }
        return { ok: true, log: "ok" };
      },
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "mine.ts");
        subs.push((await e.pipe.toolSubmit(token!, NAMED)) as SubmitResult);
        // Rebase now requires semantic review + revalidation before landing.
        subs.push((await e.pipe.toolSubmit(token!, NAMED)) as SubmitResult);
        subs.push((await e.pipe.toolSubmit(token!, NAMED)) as SubmitResult);
        return "落地了";
      },
    });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    expect(subs[0].code).toBe("base_moved");
    expect(subs[1].code).toBe("base_changed_review");
    expect(subs[2].ok).toBe(true);
    expect(env.store.devTickets.getDevTicket(t.id)!.dev_status).toBe("landed");
  });

  it("ghost guard: a lock lost while the gates run refuses the merge", async () => {
    let sub: SubmitResult | undefined;
    let envRef: Env | undefined;
    let ticketId = 0;
    const env = await makeEnv({
      gate: async () => {
        // The turn dies mid-gate (production: stall kill → turn-end
        // releases the lock). cancel() is the accessible stand-in here.
        envRef!.pipe.cancel(ticketId);
        return { ok: true, log: "ok" };
      },
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "late.ts");
        sub = (await e.pipe.toolSubmit(token!, NAMED)) as SubmitResult;
        return "done";
      },
    });
    envRef = env;
    ticketId = env.pipe.createTicket({ title: "t", body: "干活", requester: "alice", kind: "simple" }).id;
    await settle(env);
    expect(sub?.ok).toBe(false);
    // cancel() during a gate race can be caught by either guard depending
    // on order:
    //   * cancel() releases the merge lock synchronously → the withGitLock
    //     ghost check runs first and returns "not_holder"
    //   * lock hadn't released yet → the isCancelled() branch returns
    //     "cancelled"
    // Both are correct refusals; the invariant we care about is that base
    // is untouched.
    expect(["not_holder", "cancelled"]).toContain(sub?.code);
    // main untouched — the gates passed but nobody was accountable for the merge.
    expect((await gitOrThrow(env.repo, ["log", "--oneline", "main"])).split("\n")).toHaveLength(1);
  });

  it("a stale token from an ended turn gets nothing", async () => {
    let stale: string | null = null;
    const env = await makeEnv({
      onTurn: async ({ token }) => {
        stale = token;
        return "ok";
      },
    });
    env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    expect(stale).toBeTruthy();
    const sub = (await env.pipe.toolSubmit(stale!)) as SubmitResult;
    expect(sub.ok).toBe(false);
    expect(sub.code).toBe("not_holder");
    expect(sub.message).toContain("轮次已结束");
    expect(env.pipe.resolveToolToken(stale!)).toBeUndefined();
  });

  it("lockWaiterIds surfaces parked tickets so the panel can render 'waiting for merge' honestly", async () => {
    let holdRelease: (() => void) | undefined;
    const held = new Promise<void>((r) => (holdRelease = r));
    const queued: SubmitResult[] = [];
    const outcomes: SubmitResult[] = [];
    const committed = new Set<string>();
    // Post-submit model (commit 45f825c): the gate only runs when the agent
    // NAMED tests, so pass NAMED here to actually hand this test's `held`
    // promise a role. Without it the submit path is subseconds and the parking
    // observation becomes a subprocess-scheduling race — locally it usually
    // wins, under `--maxWorkers=8` CI it becomes 50/50, and a B whose second
    // submit races through fast enough to hit a transient rebase error would
    // return "落地" from the harness without actually landing (this test used
    // to silently mask that as bId staying `open`; assert on the real submit
    // outcome below to name it instead).
    const env = await makeEnv({
      gate: async () => { await held; return { ok: true, log: "ok" }; },
      onTurn: async ({ cwd, spec, token, env: e }) => {
        if (!committed.has(cwd)) {
          await commitWork(cwd, spec.prompt.includes("霸占") ? "a.ts" : "b.ts");
          committed.add(cwd);
        }
        let r = (await e.pipe.toolSubmit(token!, NAMED)) as SubmitResult;
        if (r.code === "queued") { queued.push(r); return "被排队"; }
        if (r.code === "base_changed_review") {
          r = (await e.pipe.toolSubmit(token!, NAMED)) as SubmitResult;
        }
        outcomes.push(r);
        return "落地";
      },
    });
    const aId = env.pipe.createTicket({ title: "a", body: "霸占锁", requester: "alice", kind: "simple" }).id;
    const bId = env.pipe.createTicket({ title: "b", body: "也要合", requester: "alice", kind: "simple" }).id;
    try {
      for (
        let i = 0;
        i < 200 && (queued.length === 0 || env.pipe.lockWaiterIds().length === 0);
        i++
      ) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // Scheduling decides which ticket acquires the lock first. The observable
      // invariant is that exactly one of the two owns it and the other is parked.
      const holder = env.pipe.mergeLockHolder();
      const waiters = env.pipe.lockWaiterIds();
      expect(holder).not.toBeNull();
      expect(waiters).toHaveLength(1);
      expect([holder!, waiters[0]].sort((a, b) => a - b)).toEqual([aId, bId].sort((a, b) => a - b));
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ code: "queued", holder });
    } finally {
      // Never strand the merge gate when an assertion fails: teardown also
      // waits for both ticket turns to settle.
      holdRelease?.();
    }
    await settle(env);
    // Cleared once the parked ticket's wake-up submit runs.
    expect(env.pipe.lockWaiterIds()).toEqual([]);
    expect(env.pipe.mergeLockHolder()).toBeNull();
    // Assert on submit outcomes BEFORE asserting on dev_status so a transient
    // rebase/ff failure names itself in the diff instead of showing up as a
    // silent `open` (the harness's onTurn returns "落地" for any non-`queued`
    // reply, so a failed submit and a landed submit look identical from the
    // ticket row alone).
    expect(outcomes.every((r) => r.ok), `submits: ${JSON.stringify(outcomes)}`).toBe(true);
    expect(env.store.devTickets.getDevTicket(aId)!.dev_status).toBe("landed");
    expect(env.store.devTickets.getDevTicket(bId)!.dev_status).toBe("landed");
  });
});

// ── App tickets: a path allowlist buys a trimmed gate ──

/** Files inside `session-plus`'s scope, used by several cases below. */
const APP_FILE = "packages/session-plus-view/src/App.tsx";
/** Shared by Session Plus and Research Program; exercises a real multi-App impact set. */
const SHARED_SESSIONS_MODULE_FILE = "packages/agent-sessions-view/src/manifests.ts";
/** Compiled into the App's bundle, but shared platform — deliberately outside. */
const PLATFORM_FILE = "packages/agent-view-react/src/client.ts";

const REFRESH_OK: AppReleaseRefreshOutcome = {
  ok: true,
  appId: "session-plus",
  packageDigest: "a".repeat(64),
  hostLabel: `app-${"a".repeat(20)}.example`,
  deduplicated: false,
  changed: true,
  coexistence: "multi_version",
  coexistenceReason: null,
};

function hotswapFake(calls: { prepare: string[]; preview: string[]; activate: string[] }): AppHotswapExecutor {
  return {
    prepare: async (input) => {
      calls.prepare.push(`${input.appId}:${input.worktree}:${input.actor}`);
      return {
        ok: true,
        appId: input.appId,
        packageDigest: "a".repeat(64),
        hostLabel: `app-${"a".repeat(20)}`,
        previousPackageDigest: "b".repeat(64),
        permissionContractDigest: "c".repeat(64),
        coexistence: "multi_version",
        coexistenceReason: null,
        deduplicated: false,
      };
    },
    preview: async (appId, digest) => {
      calls.preview.push(`${appId}:${digest}`);
      return {
        ok: true,
        appId,
        packageDigest: digest,
        hostLabel: `app-${digest.slice(0, 20)}`,
        previousPackageDigest: "b".repeat(64),
        permissionContractDigest: "c".repeat(64),
        coexistence: "multi_version",
        coexistenceReason: null,
      };
    },
    activate: async (appId, digest, actor) => {
      calls.activate.push(`${appId}:${digest}:${actor}`);
      return { ...REFRESH_OK, appId, packageDigest: digest };
    },
  };
}

function appTicket(env: Env, extra: Partial<{ title: string }> = {}) {
  return env.pipe.createTicket({
    title: extra.title ?? "改会话+的布局",
    body: "b",
    requester: "alice",
    kind: "app",
    app_id: "session-plus",
  });
}

describe("app tickets: filing", () => {
  it("requires an App this repository can actually ticket", async () => {
    const env = await makeEnv();
    // Refused at FILING, not at submit: the scope is the whole contract of this
    // kind, so a ticket that cannot name one would burn a turn writing code the
    // merge phase was always going to refuse.
    expect(() =>
      env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "app", app_id: "no-such-app" }),
    ).toThrow(/App 工单需要指定/);
    expect(() =>
      env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "app" }),
    ).toThrow(/App 工单需要指定/);
    expect(env.store.devTickets.listDevTickets(10)).toHaveLength(0);
  });

  it("stores the app id only for app tickets", async () => {
    const env = await makeEnv();
    const app = appTicket(env);
    expect(app.kind).toBe("app");
    expect(app.app_id).toBe("session-plus");
    // An app id on a `simple` row would be a claim nothing reads — and two
    // facts nothing reconciles are how the panel and the merge phase end up
    // disagreeing about what a ticket is.
    const plain = env.store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "t", body: "b", requester: "alice", kind: "simple", app_id: "session-plus",
    }));
    expect(plain.app_id).toBeNull();
  });

  it("setKind carries the app id in and clears it on the way out", async () => {
    const env = await makeEnv();
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    expect(() => env.pipe.setKind(t.id, "app")).toThrow(/App 工单需要指定/);

    const promoted = env.pipe.setKind(t.id, "app", "session-plus");
    expect(promoted.kind).toBe("app");
    expect(promoted.app_id).toBe("session-plus");

    const demoted = env.pipe.setKind(t.id, "complex");
    expect(demoted.kind).toBe("complex");
    expect(demoted.app_id).toBeNull();
  });

  it("the App intro states the path domain, async runner and automatic release rule", async () => {
    const env = await makeEnv({ onTurn: async ({ spec }) => spec.prompt });
    const t = appTicket(env);
    await settle(env);
    const prompt = env.turns[0].prompt;
    expect(prompt).toContain("App 工单");
    expect(prompt).toContain("packages/session-plus-view/");
    expect(prompt).toContain("diff 只能触碰");
    expect(prompt).toContain("相关测试");
    expect(prompt).not.toContain("--project session-plus-view");
    // Landing records the release; it goes live by itself when the deployed
    // trusted code can serve it, so the agent does not request publication.
    expect(prompt).toContain("自动上线");
    expect(prompt).toContain("已合入、待发布");
    expect(prompt).toContain("devpipe_app_hotswap");
    expect(prompt).toContain("approval_required");
    expect(prompt).toContain("重新同意");
    expect(env.store.devTickets.getDevTicket(t.id)!.kind).toBe("app");
  });

  it("an app ticket whose App vanished from the table is told so, not defaulted", () => {
    // A row can outlive its scope (the App was removed from APP_TICKET_SCOPES
    // while the ticket sat open). Falling back to the first App in the table
    // would hand it a real App's allowlist.
    const rule = appTicketRule(null, "retired-app");
    expect(rule).toContain("retired-app");
    expect(rule).toContain("App scope");
  });
});

describe("app tickets: the path allowlist", () => {
  it("a diff inside the App's packages lands, and named tests are told which App it is", async () => {
    let sub: SubmitResult | undefined;
    const env = await makeEnv({
      refresh: async () => REFRESH_OK,
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, APP_FILE);
        await commitWork(cwd, "packages/bot/src/session-plus/app/app.yaml");
        sub = (await e.pipe.toolSubmit(token!, NAMED)) as SubmitResult;
        return "落地了";
      },
    });
    const t = appTicket(env);
    await settle(env);

    expect(sub?.ok).toBe(true);
    expect(env.store.devTickets.getDevTicket(t.id)!.dev_status).toBe("landed");
    // Tests the turn named ran ONCE, and were told which App this is — the App
    // the allowlist just enforced, which is why the two cannot disagree. The
    // scope no longer decides WHICH tests run (the turn named them), but it is
    // still what an App-aware gate implementation would trim by, so it is still
    // handed over rather than dropped.
    expect(env.gateCalls).toHaveLength(1);
    expect(env.gateCalls[0].scope?.appId).toBe("session-plus");
  });

  it("one file outside the App's packages refuses the merge and names the ordinary lane", async () => {
    let sub: SubmitResult | undefined;
    const env = await makeEnv({
      refresh: async () => REFRESH_OK,
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, APP_FILE);
        await commitWork(cwd, PLATFORM_FILE);
        sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        return "submitted";
      },
    });
    const t = appTicket(env);
    await settle(env);

    expect(sub?.ok).toBe(false);
    expect(sub?.code).toBe("app_scope");
    expect(sub?.files).toEqual([PLATFORM_FILE]);
    expect(sub?.message).toContain("另开一张普通工单");
    // Refused in the LOCK-FREE preflight: no gate ran, no lock was taken, and
    // nothing was republished.
    expect(env.gateCalls).toHaveLength(0);
    expect(env.refreshCalls).toHaveLength(0);
    expect(env.pipe.mergeLockHolder()).toBeNull();
    expect(env.store.devTickets.getDevTicket(t.id)!.dev_status).toBe("open");
    // The base branch is untouched: only the initial commit.
    expect((await gitOrThrow(env.repo, ["log", "--oneline", "main"])).split("\n")).toHaveLength(1);
  });

  it("renaming a platform file INTO the App's packages still trips the gate", async () => {
    // `--no-renames` is load-bearing for this path-domain gate:
    // with rename detection on, `git mv` would print only the destination and
    // the moved-out platform file would never be seen.
    let sub: SubmitResult | undefined;
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        mkdirSync(join(cwd, "packages/session-plus-view"), { recursive: true });
        await gitOrThrow(cwd, ["mv", "README.md", "packages/session-plus-view/README.md"]);
        await gitOrThrow(cwd, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "move"]);
        sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        return "submitted";
      },
    });
    appTicket(env);
    await settle(env);

    expect(sub?.code).toBe("app_scope");
    expect(sub?.files).toEqual(["README.md"]); // the deletion, seen because renames are split
  });

  it("messages and retries do not open the App path-domain gate", async () => {
    const subs: SubmitResult[] = [];
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        if (!existsSync(join(cwd, PLATFORM_FILE))) await commitWork(cwd, PLATFORM_FILE);
        subs.push((await e.pipe.toolSubmit(token!)) as SubmitResult);
        return "submitted";
      },
    });
    const t = appTicket(env);
    await settle(env);
    env.pipe.postMessage(t.id, "alice", "web", "我确认了，再试一次");
    await settle(env);
    env.pipe.postMessage(t.id, "alice", "web", "再试一次");
    await settle(env);

    expect(subs.map((s) => s.code)).toEqual(["app_scope", "app_scope", "app_scope"]);
    expect(env.store.devTickets.getDevTicket(t.id)!.dev_status).toBe("open");
  });

  it("an app ticket whose app id is unknown at submit time fails closed", async () => {
    let sub: SubmitResult | undefined;
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, APP_FILE);
        sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        return "submitted";
      },
    });
    // Written straight to the store, which is how a row survives an App being
    // removed from the scope table while the ticket sat open.
    env.store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "t", body: "b", requester: "alice", kind: "app", app_id: "retired-app",
    }));
    env.pipe.kick();
    await settle(env);

    expect(sub?.code).toBe("app_scope");
    // No path domain means no enforceable gate, so nothing runs.
    expect(env.gateCalls).toHaveLength(0);
  });
});

describe("app tickets: hard path gates remain", () => {
  it("a trust-sensitive diff outside an App's domain is still refused as app_scope", async () => {
    let sub: SubmitResult | undefined;
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "packages/web-trust/src/gate.ts");
        sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        return "submitted";
      },
    });
    const t = appTicket(env);
    await settle(env);

    expect(sub?.code).toBe("app_scope");
    expect(sub?.message).toContain("App 工单");
    expect(sub?.message).toContain("session-plus");
    expect(env.store.devTickets.getDevTicket(t.id)!.dev_status).toBe("open");
    expect(env.gateCalls).toHaveLength(0);
    const notes = env.store.devTickets.listTicketMessages(t.id).filter((m) => m.author === "pipeline");
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toContain("本轮已结束但未合入");
    expect(notes[0].body).not.toContain("可信边界");
  });

  it("protected paths still refuse first, on an app ticket like any other", async () => {
    let sub: SubmitResult | undefined;
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "scripts/ops/land.sh");
        sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        return "submitted";
      },
    });
    appTicket(env);
    await settle(env);
    expect(sub?.code).toBe("protected_paths");
  });
});

describe("app tickets: landing records release debt", () => {
  it("app.hot_replace refuses a non-App ticket before reading any asserted selector", async () => {
    let result: Awaited<ReturnType<DevPipeline["toolAppHotswap"]>> | undefined;
    const env = await makeEnv({
      onTurn: async ({ token, env: e }) => {
        result = await e.pipe.toolAppHotswap(token!, {
          app: "session-plus",
          expected_commit: "1".repeat(40),
          source: "landed_ticket",
        });
        return "refused";
      },
    });
    env.pipe.createTicket({ title: "ordinary", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    expect(result).toMatchObject({ ok: false, status: "refused", code: "not_app_ticket" });
  });

  it("does not publish at land time, even when a release host is available", async () => {
    let sub: SubmitResult | undefined;
    const env = await makeEnv({
      refresh: async () => REFRESH_OK,
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, APP_FILE);
        sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        return "落地了";
      },
    });
    const t = appTicket(env);
    await settle(env);

    expect(sub?.ok).toBe(true);
    expect(sub?.app_release).toBeUndefined();
    expect(sub?.app_release_owed).toEqual(["session-plus"]);
    expect(sub?.message).toContain("待发布");
    expect(env.store.devTickets.getDevTicket(t.id)!.dev_status).toBe("landed");
    expect(env.store.appCatalog.listPendingAppReleases()).toEqual([
      expect.objectContaining({ app_id: "session-plus", ticket_id: t.id, commit_sha: sub?.sha }),
    ]);
    expect(env.refreshCalls).toEqual([]);
  });

  it("a simple ticket never publishes at land time, whatever it touched", async () => {
    const env = await makeEnv({
      refresh: async () => REFRESH_OK,
      onTurn: async ({ cwd, token, env: e }) => {
        // The same file an app ticket would change. Either kind records debt;
        // neither kind may publish merely because landing succeeded.
        await commitWork(cwd, APP_FILE);
        await e.pipe.toolSubmit(token!, NAMED);
        return "落地了";
      },
    });
    env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);

    expect(env.refreshCalls).toEqual([]);
    // …and its named tests were run with NO App scope, because a simple ticket
    // has no path domain for one to be trimmed against.
    expect(env.gateCalls).toHaveLength(1);
    expect(env.gateCalls[0].scope ?? null).toBeNull();
  });

  it("records Runner bundle debt on a managed ticket without activating at land time", async () => {
    let submitted: SubmitResult | undefined;
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "packages/runner/src/delivery-marker.ts");
        submitted = (await e.pipe.toolSubmit(token!, NAMED)) as SubmitResult;
        return "落地了";
      },
    });
    const ticket = env.pipe.createTicket({ title: "Runner update", body: "b", requester: "alice", kind: "simple" });
    await settle(env);

    expect(submitted?.ok).toBe(true);
    expect(env.store.runnerArtifacts.listPending()).toEqual([
      expect.objectContaining({ ticket_id: ticket.id, commit_sha: submitted?.sha }),
    ]);
    expect(env.store.devTickets.getDevTicket(ticket.id)?.deploy_status).toBe("pending");
  });

  it("app.hot_replace treats app, commit and source as assertions and parks on approval_required", async () => {
    const calls = { prepare: [] as string[], preview: [] as string[], activate: [] as string[] };
    const refused: string[] = [];
    let requested: Awaited<ReturnType<DevPipeline["toolAppHotswap"]>> | undefined;
    const env = await makeEnv({
      hotswap: hotswapFake(calls),
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, APP_FILE);
        const submitted = await e.pipe.toolSubmit(token!);
        if (!submitted.ok) throw new Error(submitted.message);
        mkdirSync(join(cwd, "node_modules"), { recursive: true });
        refused.push((await e.pipe.toolAppHotswap(token!, {
          app: "other-app", expected_commit: submitted.sha, source: "landed_ticket",
        })).message);
        refused.push((await e.pipe.toolAppHotswap(token!, {
          app: "session-plus", expected_commit: "0".repeat(40), source: "landed_ticket",
        })).message);
        refused.push((await e.pipe.toolAppHotswap(token!, {
          app: "session-plus", expected_commit: submitted.sha, source: "worktree",
        })).message);
        requested = await e.pipe.toolAppHotswap(token!, {
          app: "session-plus", expected_commit: submitted.sha, source: "landed_ticket",
        });
        return "approval_required 后结束";
      },
    });
    const ticket = appTicket(env);
    await settle(env);

    expect(refused[0]).toContain("App 断言不匹配");
    expect(refused[1]).toContain("commit");
    expect(refused[2]).toContain("source");
    expect(requested).toMatchObject({
      ok: false,
      status: "approval_required",
      app: "session-plus",
      previous_package_digest: "b".repeat(64),
      coexistence: "multi_version",
    });
    expect(calls.prepare).toHaveLength(1);
    expect(calls.activate).toEqual([]);

    const pending = env.pipe.listAppHotswapApprovals()[0]!;
    env.store.devTickets.updateDevTicket(ticket.id, { commit_sha: "f".repeat(40) });
    const stale = await env.pipe.decideAppHotswapApproval(pending.id, "approve", "user:root");
    expect(stale).toMatchObject({ ok: false, code: "ticket_closure_changed" });
    expect(calls.activate).toEqual([]);
    expect(env.store.appCatalog.listPendingAppReleases()).toEqual([
      expect.objectContaining({ app_id: "session-plus", ticket_id: ticket.id }),
    ]);
  });
});

describe("refreshSummary", () => {
  it("distinguishes «the App changed» from «these bytes were already active»", () => {
    expect(refreshSummary(REFRESH_OK)).toContain("已自动刷新并激活");
    expect(refreshSummary(REFRESH_OK)).toContain("旧实例仍可");
    const unchanged = refreshSummary({ ...REFRESH_OK, changed: false, deduplicated: true });
    expect(unchanged).toContain("active 指针没有移动");
    expect(unchanged).not.toContain("已自动刷新并激活");

    const refreshRequired = refreshSummary({
      ...REFRESH_OK,
      coexistence: "refresh_required",
      coexistenceReason: "state_epoch_changed",
    });
    expect(refreshRequired).toContain("不会被自动刷新");
    expect(refreshRequired).toContain("state_epoch_changed");
  });

  it("every refusal says the code landed anyway and forbids the 已上线 claim", () => {
    for (const step of ["pack", "install", "activate", "unsupported"] as const) {
      const text = refreshSummary({ ok: false, appId: "session-plus", step, code: "c", message: "m" });
      // Both halves matter: the merge is NOT undone by a publication failing,
      // and the agent must not report a release nobody is being served.
      expect(text).toContain("合入基线");
      expect(text).toContain("不要在回复里说「已上线」");
    }
  });
});

// ── ticket #15: concurrency + cancellation ──

describe("cancellation cannot be outrun", () => {
  it("a ticket cancelled mid-turn cannot land", async () => {
    let submit: SubmitResult | null = null;
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        // The user hits ✖ while the agent is still working.
        const id = e.store.devTickets.listDevTickets(10)[0].id;
        e.pipe.cancel(id);
        await commitWork(cwd, "sneaky.txt");
        submit = await e.pipe.toolSubmit(token!);
        return "我还是提交了";
      },
    });
    env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);

    expect(submit!.ok).toBe(false);
    expect(submit!.code).toBe("cancelled");
    // The base branch must be untouched: only the initial commit.
    expect((await gitOrThrow(env.repo, ["log", "--oneline", "main"])).split("\n")).toHaveLength(1);
    // ...and the cancellation must not have been overwritten by "landed".
    expect(env.store.devTickets.listDevTickets(10)[0].dev_status).toBe("cancelled");
  });
});

describe("a turn's credential stays inside its own worktree", () => {
  it("writes the config in the ticket worktree and deletes it afterwards", async () => {
    let seenPath = "";
    let existedDuringTurn = false;
    const env = await makeEnv({
      onTurn: async ({ cwd, spec }) => {
        seenPath = spec.mcpConfigPath ?? "";
        existedDuringTurn = existsSync(seenPath);
        return "ok";
      },
    });
    env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);

    const wt = env.store.devTickets.listDevTickets(10)[0].worktree!;
    expect(seenPath).toBe(join(wt, MCP_CONFIG_FILE));
    expect(existedDuringTurn).toBe(true);
    // Gone once the turn ends — the token is dead, the file should be too.
    expect(existsSync(seenPath)).toBe(false);
    // Nothing token-shaped left in the SHARED parent, where a sibling
    // ticket's agent would have found it with a plain `ls ..`.
    const parent = readdirSync(join(env.dir, "worktrees"));
    expect(parent.filter((n) => n.startsWith(".mcp-"))).toEqual([]);
  });

  it("the config file never reads as uncommitted work", async () => {
    let submit: SubmitResult | null = null;
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "real.txt");
        // The config file is sitting right there in cwd while we submit.
        submit = await e.pipe.toolSubmit(token!);
        return "ok";
      },
    });
    env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    expect(submit!.ok).toBe(true);
    // And `git add -A` in the worktree would not have picked it up either.
    const wt = env.store.devTickets.listDevTickets(10)[0].worktree!;
    const tracked = await gitOrThrow(wt, ["ls-files", MCP_CONFIG_FILE]);
    expect(tracked).toBe("");
  });
});

describe("a ticket that cannot get a worktree does not spin", () => {
  it("consumes its inbox instead of rescheduling itself forever", async () => {
    const env = await makeEnv();
    // Make worktree creation impossible: a plain FILE where the worktrees
    // directory must be.
    writeFileSync(join(env.dir, "worktrees"), "not a directory\n");
    env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);

    const t = env.store.devTickets.listDevTickets(10)[0];
    expect(t.error).toContain("worktree");
    // The trigger is drained, so the pump has nothing to pick up again. Before
    // #15 this stayed non-empty forever and held a concurrency slot.
    expect(env.store.devTickets.listTicketsNeedingTurn()).toHaveLength(0);
  });
});

describe("submit lands exactly the commit it pinned", () => {
  it("refuses when the branch moved while the named tests ran", async () => {
    let submit: SubmitResult | null = null;
    let workCwd = "";
    const env = await makeEnv({
      gate: async () => {
        // A background shell commits to the TICKET worktree DURING the gate
        // run (the gate itself runs in `_land`, parked at the pinned sha).
        await commitWork(workCwd, "late.txt");
        return { ok: true, log: "gate ok" };
      },
      onTurn: async ({ cwd, token, env: e }) => {
        workCwd = cwd;
        await commitWork(cwd, "reviewed.txt");
        submit = await e.pipe.toolSubmit(token!, NAMED);
        return "ok";
      },
    });
    env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);

    expect(submit!.ok).toBe(false);
    expect(submit!.message).toContain("submit 认定要合入的是");
    // Untested code must not be on the base branch.
    const log = await gitOrThrow(env.repo, ["log", "--oneline", "main"]);
    expect(log).not.toContain("late.txt");
    expect(existsSync(join(workCwd, "late.txt"))).toBe(true); // still in the branch
  });
});

/**
 * The human lane, after the 2026-08-09 switch to post-submit testing.
 *
 * `land()` had no direct coverage before this, which is part of why the switch
 * is worth pinning here rather than only in the submit tests: the human lane is
 * the one an operator drives at 3am, and "did it test anything?" must be a
 * question the code answers the same way twice.
 */
describe("land: tests are named, never assumed", () => {
  /** A buffer branch one commit ahead of main. */
  async function bufferBranch(env: Env, rel = "feature.ts"): Promise<string> {
    const wt = join(env.dir, "buf");
    await gitOrThrow(env.repo, ["worktree", "add", "-b", "buf", wt, "main"]);
    await commitWork(wt, rel);
    await commitCliReport(wt);
    return await gitOrThrow(wt, ["rev-parse", "HEAD"]);
  }

  it("runs no tests when none are named — only the thin land gate — and fast-forwards", async () => {
    const env = await makeEnv();
    const head = await bufferBranch(env);

    const r = await env.pipe.land("buf", "alice");

    expect(r.ok).toBe(true);
    expect(r.to_sha).toBe(head);
    expect(r.ticket_id).toBeGreaterThan(0);
    expect(r.report_path).toMatch(/^doc\/cli-reports\//);
    expect(env.store.devTickets.getDevTicket(r.ticket_id)).toMatchObject({
      kind: "cli",
      dev_status: "landed",
      deploy_status: "pending",
      commit_sha: head,
    });
    expect(env.store.devTickets.listTicketsNeedingTurn()).toEqual([]);
    expect(await gitOrThrow(env.repo, ["rev-parse", "main"])).toBe(head);
    // The human lane warms the same way the ticket lane does: whoever landed
    // it, the next deploy should restore instead of rebuild.
    await waitForWarm(env);
    expect(env.warmCalls).toEqual([head]);
    // The 2026-08-09 point stands: not a trimmed suite, not a fast suite — no
    // TESTS. What does run since 2026-08-11 is the thin typecheck gate, at the
    // exact sha being landed.
    expect(env.gateCalls).toEqual([]);
    expect(env.landGateCalls).toHaveLength(1);
    expect(env.landGateCalls[0].head).toBe(head);
    // The gate is handed this landing's own diff, so it can rerun the spec
    // files the diff touched (the measured dominant red-batch class).
    expect(env.landGateCalls[0].candidate?.changedFiles).toContain("feature.ts");
    // The landing record shows what the gate did instead of reading empty.
    expect(r.gate_log_tail).toContain("land gate ok");
  });

  it("records App release debt for a human/CLI landing and links it to the generated ticket", async () => {
    const env = await makeEnv();
    const head = await bufferBranch(env, SHARED_SESSIONS_MODULE_FILE);

    const r = await env.pipe.land("buf", "alice");

    expect(r.app_release_owed).toEqual(["session-plus", "research-program", "research-v2", "research-docs"]);
    expect(env.store.appCatalog.listPendingAppReleases()).toEqual([
      expect.objectContaining({ app_id: "research-docs", commit_sha: head, ticket_id: r.ticket_id, requested_by: "cli:alice" }),
      expect.objectContaining({
        app_id: "research-program",
        commit_sha: head,
        ticket_id: r.ticket_id,
        requested_by: "cli:alice",
      }),
      expect.objectContaining({
        app_id: "research-v2",
        commit_sha: head,
        ticket_id: r.ticket_id,
        requested_by: "cli:alice",
      }),
      expect.objectContaining({
        app_id: "session-plus",
        commit_sha: head,
        ticket_id: r.ticket_id,
        requested_by: "cli:alice",
      }),
    ]);
    const notes = env.store.devTickets.listTicketMessages(r.ticket_id).filter((message) => message.author === "pipeline");
    expect(notes.some((message) => message.body.includes("已记录为待发布"))).toBe(true);
  });

  it("records Runner bundle debt for a human/CLI landing", async () => {
    const env = await makeEnv();
    const head = await bufferBranch(env, "packages/runner/src/delivery-marker.ts");

    const result = await env.pipe.land("buf", "alice");

    expect(env.store.runnerArtifacts.listPending()).toEqual([
      expect.objectContaining({
        ticket_id: result.ticket_id,
        commit_sha: head,
        requested_by: "cli:alice",
        last_error: null,
      }),
    ]);
    const notes = env.store.devTickets.listTicketMessages(result.ticket_id);
    expect(notes.some((message) => message.body.includes("Runner 客户端 bundle"))).toBe(true);
  });

  it("with the gate configured off and nothing named, the record still explains itself", async () => {
    const env = await makeEnv({ landGateEnabled: false });
    const head = await bufferBranch(env);
    const r = await env.pipe.land("buf", "alice");
    expect(r.to_sha).toBe(head);
    expect(env.landGateCalls).toEqual([]);
    expect(r.gate_log_tail).toContain("没有点名");
  });

  it("runs exactly what was named, and still fast-forwards", async () => {
    const env = await makeEnv();
    const head = await bufferBranch(env);

    const r = await env.pipe.land("buf", "alice", ["packages/bot/src/devpipe"]);

    expect(r.ok).toBe(true);
    expect(await gitOrThrow(env.repo, ["rev-parse", "main"])).toBe(head);
    expect(env.gateCalls).toHaveLength(1);
    // A human landing has no App scope to trim by, named or not.
    expect(env.gateCalls[0].scope ?? null).toBeNull();
  });

  it("a named test that fails leaves the watermark untouched", async () => {
    const env = await makeEnv({ gate: async () => ({ ok: false, log: "vitest exploded" }) });
    const before = await gitOrThrow(env.repo, ["rev-parse", "main"]);
    await bufferBranch(env);

    await expect(env.pipe.land("buf", "alice", ["project:node"])).rejects.toMatchObject({
      code: "gate_failed",
    });
    expect(await gitOrThrow(env.repo, ["rev-parse", "main"])).toBe(before);
  });

  it("an empty or blank list is the same as naming nothing", async () => {
    // The HTTP and MCP surfaces both filter their input rather than refusing it,
    // so blanks reach here. They must not create an empty vitest run that passes
    // vacuously and reads, in the record, like tests were run.
    const env = await makeEnv();
    await bufferBranch(env);
    await env.pipe.land("buf", "alice", ["", "   "]);
    expect(env.gateCalls).toEqual([]);
  });

  it("refuses a human/CLI branch with no durable report before any gate runs", async () => {
    const env = await makeEnv();
    const wt = join(env.dir, "buf");
    await gitOrThrow(env.repo, ["worktree", "add", "-b", "buf", wt, "main"]);
    await commitWork(wt, "unreported.ts");

    await expect(env.pipe.land("buf", "alice")).rejects.toMatchObject({ code: "report_missing" });
    expect(env.gateCalls).toEqual([]);
    expect(env.landGateCalls).toEqual([]);
  });

  it("requires the report requester to be a registered production acceptor", async () => {
    const env = await makeEnv();
    const wt = join(env.dir, "buf");
    await gitOrThrow(env.repo, ["worktree", "add", "-b", "buf", wt, "main"]);
    await commitWork(wt, "feature.ts");
    await commitCliReport(wt, "ghost");

    await expect(env.pipe.land("buf", "alice")).rejects.toMatchObject({ code: "report_invalid" });
  });


  it("requires the tip commit to contain only its newly added report", async () => {
    const env = await makeEnv();
    const wt = join(env.dir, "buf");
    await gitOrThrow(env.repo, ["worktree", "add", "-b", "buf", wt, "main"]);
    await commitWork(wt, "feature.ts");
    await commitCliReport(wt);
    writeFileSync(join(wt, "smuggled.ts"), "not part of the reviewed implementation\n");
    await gitOrThrow(wt, ["add", "smuggled.ts"]);
    await gitOrThrow(wt, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--amend", "--no-edit"]);

    await expect(env.pipe.land("buf", "alice")).rejects.toMatchObject({ code: "report_invalid" });
    expect(await gitOrThrow(env.repo, ["rev-parse", "main"])).not.toBe(await gitOrThrow(wt, ["rev-parse", "HEAD"]));
  });

  it("marks a ticket-lane receipt invalid instead of crediting it to a CLI landing", async () => {
    const env = await makeEnv();
    const wt = join(env.dir, "buf");
    await gitOrThrow(env.repo, ["worktree", "add", "-b", "buf", wt, "main"]);
    await commitWork(wt, "feature.ts");
    const implementationSha = await gitOrThrow(wt, ["rev-parse", "HEAD"]);
    const evidence = makeCliLandingReceipt(implementationSha, "ticket");
    await commitCliReport(wt, "alice", evidence.retrieval);

    const landed = await env.pipe.land("buf", "alice", [], [evidence.upload]);
    expect(landed.retrieval_receipts).toEqual([{ id: evidence.traceId, state: "invalid" }]);
    expect(env.store.knowledgeRetrieval.getTrace(evidence.traceId)).toBeNull();
  });

  it("marks a receipt for a different implementation commit invalid", async () => {
    const env = await makeEnv();
    const wt = join(env.dir, "buf");
    await gitOrThrow(env.repo, ["worktree", "add", "-b", "buf", wt, "main"]);
    await commitWork(wt, "feature.ts");
    const evidence = makeCliLandingReceipt("f".repeat(40));
    await commitCliReport(wt, "alice", evidence.retrieval);

    const landed = await env.pipe.land("buf", "alice", [], [evidence.upload]);
    expect(landed.retrieval_receipts).toEqual([{ id: evidence.traceId, state: "invalid" }]);
    expect(env.store.knowledgeRetrieval.getTrace(evidence.traceId)).toBeNull();
  });

  it("imports an exact CLI receipt once and records one landing-bound reported use", async () => {
    const env = await makeEnv();
    const wt = join(env.dir, "buf");
    await gitOrThrow(env.repo, ["worktree", "add", "-b", "buf", wt, "main"]);
    await commitWork(wt, "feature.ts");
    const implementationSha = await gitOrThrow(wt, ["rev-parse", "HEAD"]);
    const evidence = makeCliLandingReceipt(implementationSha);
    await commitCliReport(wt, "alice", evidence.retrieval);

    const landed = await env.pipe.land("buf", "alice", [], [evidence.upload]);
    expect(landed.retrieval_receipts).toEqual([{ id: evidence.traceId, state: "imported" }]);
    const detail = env.store.knowledgeRetrieval.getTrace(evidence.traceId)!;
    expect(detail.events.filter((event) => event.event === "reported_use")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          landing_ref: `cli:${landed.ticket_id}@${landed.to_sha}`,
          repo_sha: implementationSha,
          receipt_bindings: [expect.objectContaining({ trace_id: evidence.traceId })],
        }),
      }),
    ]);
  });
  it("reconciles a report after the explicit emergency local ff path", async () => {
    const env = await makeEnv();
    const wt = join(env.dir, "buf");
    await gitOrThrow(env.repo, ["worktree", "add", "-b", "buf", wt, "main"]);
    await commitWork(wt, "emergency.ts");
    await commitCliReport(wt);
    const head = await gitOrThrow(wt, ["rev-parse", "HEAD"]);

    await env.pipe.ffBranchTo("main", "buf");
    expect(env.store.devTickets.listDevTickets()).toEqual([]);
    const first = await env.pipe.reconcileCliDeliveryReports();
    expect(first).toMatchObject({ reports: 1, processed: 1, skipped: 0, projected: 1 });
    expect(env.store.devTickets.listDevTickets()).toEqual([
      expect.objectContaining({ kind: "cli", commit_sha: head, deploy_status: "pending" }),
    ]);
    const second = await env.pipe.reconcileCliDeliveryReports();
    expect(second).toMatchObject({ reports: 1, processed: 0, skipped: 1, projected: 0 });
    expect(env.store.devTickets.listDevTickets()).toHaveLength(1);
  });

  it("fast-paths an already projected v1 report without inventing a knowledge landing", async () => {
    const env = await makeEnv();
    const wt = join(env.dir, "buf");
    await gitOrThrow(env.repo, ["worktree", "add", "-b", "buf", wt, "main"]);
    await commitWork(wt, "legacy.ts");
    await commitLegacyCliReport(wt);

    await env.pipe.ffBranchTo("main", "buf");
    expect(await env.pipe.reconcileCliDeliveryReports()).toMatchObject({ processed: 1, projected: 1 });
    const ticket = env.store.devTickets.listDevTickets()[0]!;
    expect(env.store.knowledge.listLandings(ticket.id)).toEqual([]);
    expect(await env.pipe.reconcileCliDeliveryReports()).toMatchObject({ processed: 0, skipped: 1 });
  });

  it("atomically reconciles CLI App/Runner debt and never restores it after settlement", async () => {
    const env = await makeEnv();
    const wt = join(env.dir, "buf");
    await gitOrThrow(env.repo, ["worktree", "add", "-b", "buf", wt, "main"]);
    await commitWork(wt, SHARED_SESSIONS_MODULE_FILE);
    await commitWork(wt, "packages/runner/src/delivery-marker.ts");
    await commitCliReport(wt);
    const sha = await gitOrThrow(wt, ["rev-parse", "HEAD"]);
    await env.pipe.ffBranchTo("main", "buf");
    const fail = vi.spyOn(env.store.runnerArtifacts, "recordPending").mockImplementationOnce(() => { throw new Error("interrupted projection"); });
    await env.pipe.reconcileCliDeliveryReports();
    expect(env.store.devTickets.listDevTickets()).toEqual([]);
    expect(env.store.appCatalog.listPendingAppReleases()).toEqual([]);
    expect(env.store.devTickets.cliReleaseProjection(sha)).toBeUndefined();
    fail.mockRestore();
    await env.pipe.reconcileCliDeliveryReports();
    const ticket = env.store.devTickets.listDevTickets()[0]!;
    expect(env.store.appCatalog.listPendingAppReleases()).toHaveLength(4);
    expect(env.store.runnerArtifacts.listPending()).toEqual([expect.objectContaining({ ticket_id: ticket.id, commit_sha: sha })]);
    expect(env.store.devTickets.cliReleaseProjection(sha)?.ticket_id).toBe(ticket.id);
    env.store.runnerArtifacts.markFailed([{ ticket_id: ticket.id, commit_sha: sha }], "candidate", "retained failure", "before");
    await env.pipe.reconcileCliDeliveryReports();
    expect(env.store.runnerArtifacts.listPending()[0]).toMatchObject({ last_error: "retained failure", last_attempt_at: "before" });
    for (const app of env.store.appCatalog.listPendingAppReleases()) env.store.appCatalog.clearPendingAppRelease(app.app_id);
    env.store.runnerArtifacts.clearIf(ticket.id, sha);
    await env.pipe.reconcileCliDeliveryReports();
    expect(env.store.appCatalog.listPendingAppReleases()).toEqual([]);
    expect(env.store.runnerArtifacts.listPending()).toEqual([]);
  });

  it.each(["pending", "verified"])("backfills a previously projected %s report without changing its verdict", async (status) => {
    const env = await makeEnv();
    const sha = await bufferBranch(env, "packages/runner/src/delivery-marker.ts");
    await env.pipe.ffBranchTo("main", "buf");
    const ticket = env.store.devTickets.createCliDeliveryTicket(normalizeCliDeliveryTicketInput({ title: "existing", body: "preserve", spec: "accept", requester: "alice", branch: "main", commit_sha: sha }));
    env.store.devTickets.updateDevTicket(ticket.id, { deploy_status: status });
    await env.pipe.reconcileCliDeliveryReports();
    expect(env.store.devTickets.getDevTicket(ticket.id)).toMatchObject({ title: "existing", body: "preserve", deploy_status: status });
    expect(env.store.runnerArtifacts.listPending()).toHaveLength(status === "pending" ? 1 : 0);
    expect(env.store.devTickets.cliReleaseProjection(sha)?.ticket_id).toBe(ticket.id);
  });

  it("does not replace newer App debt when recovering an older CLI report", async () => {
    const env = await makeEnv();
    const sha = await bufferBranch(env, SHARED_SESSIONS_MODULE_FILE);
    const wt = join(env.dir, "buf");
    await commitWork(wt, "later.ts");
    const newer = await gitOrThrow(wt, ["rev-parse", "HEAD"]);
    await env.pipe.ffBranchTo("main", "buf");
    const newerTicket = env.store.devTickets.createCliDeliveryTicket(normalizeCliDeliveryTicketInput({ title: "newer", body: "b", spec: "s", requester: "alice", branch: "main", commit_sha: newer }));
    env.store.appCatalog.recordPendingAppRelease({ app_id: "session-plus", commit_sha: newer, ticket_id: newerTicket.id,
      requested_at: "before", requested_by: "other-landing", reason: "keep" });
    await env.pipe.reconcileCliDeliveryReports();
    expect(env.store.appCatalog.listPendingAppReleases().find(row => row.app_id === "session-plus"))
      .toMatchObject({ commit_sha: newer, ticket_id: newerTicket.id, requested_at: "before", reason: "keep" });
    expect(env.store.appCatalog.listPendingAppReleaseRevisions("session-plus").map(row => row.commit_sha).sort())
      .toEqual([sha, newer].sort());
    expect(env.store.devTickets.cliReleaseProjection(sha)).toBeDefined();
  });

  it("preserves an accepted native ticket while backfilling its missing release projection", async () => {
    const env = await makeEnv();
    const native = env.store.devTickets.registerNativeTicket({ owner: "alice", device: "runner", source: "codex",
      sessionId: "native", workspaceId: "workspace", relativePath: "feature", branch: "buf", remote: "git@example:repo.git", title: "native" });
    const wt = join(env.dir, "buf");
    await gitOrThrow(env.repo, ["worktree", "add", "-b", "buf", wt, "main"]);
    await commitWork(wt, "packages/runner/src/delivery-marker.ts");
    await commitCliReport(wt, "alice", undefined, undefined, native.id);
    const sha = await gitOrThrow(wt, ["rev-parse", "HEAD"]);
    await env.pipe.ffBranchTo("main", "buf");
    env.store.devTickets.createCliDeliveryTicket(normalizeCliDeliveryTicketInput({ native_ticket_id: native.id,
      title: "accepted native", body: "preserved report", spec: "accepted", requester: "alice", branch: "buf", commit_sha: sha }));
    env.store.devTickets.updateDevTicket(native.id, { deploy_status: "verified" });
    await env.pipe.reconcileCliDeliveryReports();
    expect(env.store.devTickets.getDevTicket(native.id)).toMatchObject({ title: "accepted native", body: "preserved report", deploy_status: "verified", native_binding: native.native_binding });
    expect(env.store.runnerArtifacts.listPending()).toEqual([]);
    expect(env.store.devTickets.cliReleaseProjection(sha)?.ticket_id).toBe(native.id);
  });

  it("still deep-reconciles a projected v3 report when a crash receipt appears", async () => {
    const env = await makeEnv();
    const wt = join(env.dir, "buf");
    await gitOrThrow(env.repo, ["worktree", "add", "-b", "buf", wt, "main"]);
    await commitWork(wt, "receipt-recovery.ts");
    const implementationSha = await gitOrThrow(wt, ["rev-parse", "HEAD"]);
    const evidence = makeCliLandingReceipt(implementationSha);
    await commitCliReport(wt, "alice", evidence.retrieval);
    await env.pipe.ffBranchTo("main", "buf");

    expect(await env.pipe.reconcileCliDeliveryReports()).toMatchObject({ processed: 1, projected: 1 });
    expect(env.store.knowledgeRetrieval.getTrace(evidence.traceId)).toBeNull();

    const commonDir = await gitOrThrow(env.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const receiptDir = join(commonDir, "octopus", "knowledge-retrieval");
    const receiptFile = join(receiptDir, `${evidence.traceId}.json`);
    mkdirSync(receiptDir, { recursive: true });
    const unrelatedFile = join(receiptDir, `kr_${"0".repeat(32)}.json`);
    writeFileSync(unrelatedFile, "unrelated receipt", { mode: 0o600 });
    expect(await env.pipe.reconcileCliDeliveryReports()).toMatchObject({
      processed: 0, skipped: 1, projected: 0, receiptRecoveryFiles: 1,
    });
    expect(existsSync(unrelatedFile)).toBe(true);
    writeFileSync(receiptFile, evidence.upload.content, { mode: 0o600 });

    expect(await env.pipe.reconcileCliDeliveryReports()).toMatchObject({
      processed: 1,
      skipped: 0,
      projected: 0,
      receiptRecoveryFiles: 2,
    });
    expect(env.store.knowledgeRetrieval.getTrace(evidence.traceId)).not.toBeNull();
    expect(existsSync(receiptFile)).toBe(false);
    expect(existsSync(unrelatedFile)).toBe(true);
    expect(await env.pipe.reconcileCliDeliveryReports()).toMatchObject({ processed: 0, skipped: 1 });
  });
});

/**
 * The thin pre-land gate (land-gate.ts, delivery 2026-08-11): incremental tsc
 * + frozen-lockfile install, run by the pipeline in the `_land` staging
 * worktree before EITHER door fast-forwards the base branch. What these tests
 * pin: it checks the exact sha the ff lands, its refusal is a gate refusal
 * (never dressed up as a CI verdict), it refuses BEFORE any ref moves, the
 * merge lock is released so the refusal blocks nobody else, and the config
 * flag really bypasses it. The real install/build/tsc is unit-tested in
 * land-gate.test.ts; here it is always the recording fake.
 */
describe("the thin land gate", () => {
  /** A buffer branch one commit ahead of main (human lane). */
  async function bufferBranch(env: Env, rel = "feature.ts"): Promise<string> {
    const wt = join(env.dir, "buf");
    await gitOrThrow(env.repo, ["worktree", "add", "-b", "buf", wt, "main"]);
    await commitWork(wt, rel);
    await commitCliReport(wt);
    return await gitOrThrow(wt, ["rev-parse", "HEAD"]);
  }

  it("submit: checks the exact sha the ff lands, in the _land staging worktree", async () => {
    let submit: SubmitResult | null = null;
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "fix.ts");
        submit = await e.pipe.toolSubmit(token!);
        return "ok";
      },
    });
    env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);

    expect(submit!.ok).toBe(true);
    expect(env.landGateCalls).toHaveLength(1);
    // The gate ran in the landing machinery's staging tree, not the ticket's —
    // pipeline-owned node_modules/dist and ONE warm incremental cache.
    expect(env.landGateCalls[0].dir.endsWith("_land")).toBe(true);
    // …and at the exact commit that became the base tip.
    expect(env.landGateCalls[0].head).toBe(await gitOrThrow(env.repo, ["rev-parse", "main"]));
    // The ticket door hands over its diff too — base..sha0 is exactly this
    // ticket's contribution after the rebase.
    expect(env.landGateCalls[0].candidate?.changedFiles).toContain("fix.ts");
  });

  it("submit: a refusal is honest, moves no ref, releases the lock; the next submit lands", async () => {
    const results: SubmitResult[] = [];
    let fail = true;
    const env = await makeEnv({
      landGate: async () => {
        if (!fail) return { ok: true, log: "clean" };
        fail = false;
        return { ok: false, refusal: "typecheck", log: "src/x.ts(1,1): error TS2322: nope" };
      },
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "fix.ts");
        results.push(await e.pipe.toolSubmit(token!));
        results.push(await e.pipe.toolSubmit(token!));
        return "ok";
      },
    });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);

    expect(results.map((r) => r.code)).toEqual(["land_gate_failed", undefined]);
    // A gate refusal, said as one: names the gate, disclaims the CI verdict,
    // and hands back the tsc tail.
    expect(results[0].message).toContain("落地门禁");
    expect(results[0].message).toContain("不是完整 CI 的结论");
    expect(results[0].gate_log_tail).toContain("TS2322");
    expect(results[1].ok).toBe(true);
    expect(env.store.devTickets.getDevTicket(t.id)!.dev_status).toBe("landed");
    expect(env.pipe.mergeLockHolder()).toBeNull();
  });

  it("submit: land_gate off = no check, straight to the ff", async () => {
    let submit: SubmitResult | null = null;
    const env = await makeEnv({
      landGateEnabled: false,
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "fix.ts");
        submit = await e.pipe.toolSubmit(token!);
        return "ok";
      },
    });
    env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    await settle(env);
    expect(submit!.ok).toBe(true);
    expect(env.landGateCalls).toEqual([]);
  });

  it("land(): a refusal reaches the caller with the code, the message and the tail; base stays put", async () => {
    const env = await makeEnv({
      landGate: async () => ({ ok: false, refusal: "lockfile", log: "ERR_PNPM_OUTDATED_LOCKFILE" }),
    });
    const before = await gitOrThrow(env.repo, ["rev-parse", "main"]);
    await bufferBranch(env);

    await expect(env.pipe.land("buf", "alice")).rejects.toMatchObject({
      code: "land_gate_failed",
      gateLogTail: expect.stringContaining("ERR_PNPM_OUTDATED_LOCKFILE"),
    });
    expect(await gitOrThrow(env.repo, ["rev-parse", "main"])).toBe(before);
  });

  it("land(): the named tests are the gate's first verdict — their red is gate_failed and the thin steps never run", async () => {
    // Since 2026-08-21 the named tests are a step of the land gate itself
    // (`candidate.namedTests`), run after the build and before the diff's
    // spec files; the thin steps that follow are not reached after a red.
    const env = await makeEnv({
      gate: async () => ({ ok: false, log: "vitest exploded" }),
      landGate: async () => {
        throw new Error("the thin steps must not run after the named tests already refused");
      },
    });
    await bufferBranch(env);
    await expect(env.pipe.land("buf", "alice", ["project:node"])).rejects.toMatchObject({ code: "gate_failed" });
    expect(env.landGateCalls).toHaveLength(1);
    expect(env.landGateCalls[0].candidate?.namedTests).toEqual(["project:node"]);
    expect(env.gateCalls).toHaveLength(1);
    expect(env.gateCalls[0].worktree.endsWith("_land")).toBe(true);
  });
});

describe("namedGateSteps", () => {
  it("is empty when nothing is named — so callers can test `.length` for «run anything at all»", () => {
    expect(namedGateSteps([])).toEqual([]);
    expect(namedGateSteps(["", "  "])).toEqual([]);
  });

  it("keeps projects and paths in SEPARATE commands", () => {
    // Not stylistic: `--project a --project b <path>` filters every selected
    // project by a path that exists in one of them, and silently runs nothing.
    const steps = namedGateSteps(["project:web", "packages/bot/src/devpipe", "packages/engine"]);
    const vitest = steps.filter((s) => s.args[0] === "vitest").map((s) => s.args);
    expect(vitest).toEqual([
      ["vitest", "run", "--project", "web", "--maxWorkers=1"],
      ["vitest", "run", "--maxWorkers=1", "packages/bot/src/devpipe", "packages/engine"],
    ]);
  });

  it("still installs, builds and typechecks first, because a path filter cannot run without dist", () => {
    const steps = namedGateSteps(["packages/engine"]);
    expect(steps.slice(0, SHARED_GATE_PREFIX.length)).toEqual([...SHARED_GATE_PREFIX]);
  });
});

describe("mirroring the watermark to a remote", () => {
  /**
   * On 2026-08-09 the remote had no `v4` at all — 84 commits, two days of work,
   * everything running in production, in one `.git` on one machine. Landing
   * only ever fast-forwarded locally and nobody had pushed since the rename.
   * These two cases are the fix and its cost ceiling.
   */
  it("pushes the base branch after a landing, without being asked", async () => {
    const bare = mkdtempSync(join(tmpdir(), "remote-"));
    await gitOrThrow(bare, ["init", "--bare", "-b", "main", "."]);
    const env = await makeEnv();
    await gitOrThrow(env.repo, ["remote", "add", "backup", bare]);
    (env.pipe as unknown as { pushRemote: string }).pushRemote = "backup";

    const wt = join(env.dir, "buf2");
    await gitOrThrow(env.repo, ["worktree", "add", "-b", "buf2", wt, "main"]);
    await commitWork(wt, "pushed.ts");
    await commitCliReport(wt);
    const head = await gitOrThrow(wt, ["rev-parse", "HEAD"]);

    await env.pipe.land("buf2", "alice");
    // The push is deliberately behind the landing, so wait for the chain.
    await (env.pipe as unknown as { pushChain: Promise<void> }).pushChain;

    expect(await gitOrThrow(bare, ["rev-parse", "main"])).toBe(head);
    rmSync(bare, { recursive: true, force: true });
  });

  it("a remote that does not work costs the landing nothing", async () => {
    // A backup is not a gate: making the merge depend on the network would
    // reintroduce, in a new costume, the thing this week removed.
    const env = await makeEnv();
    (env.pipe as unknown as { pushRemote: string }).pushRemote = "nowhere-at-all";

    const wt = join(env.dir, "buf3");
    await gitOrThrow(env.repo, ["worktree", "add", "-b", "buf3", wt, "main"]);
    await commitWork(wt, "still-lands.ts");
    await commitCliReport(wt);
    const head = await gitOrThrow(wt, ["rev-parse", "HEAD"]);

    const r = await env.pipe.land("buf3", "alice");
    await (env.pipe as unknown as { pushChain: Promise<void> }).pushChain;

    expect(r.ok).toBe(true);
    expect(await gitOrThrow(env.repo, ["rev-parse", "main"])).toBe(head);
  });
});

// Ticket #38-5: discuss mode + devpipe_rename tool.
describe("discuss mode (ticket #38-5)", () => {
  it("createTicket accepts kind='discuss' and files an open conversation", async () => {
    const env = await makeEnv({ onTurn: async () => "## 名字\n谈谈想法\n\n听你说。" });
    const t = env.pipe.createTicket({
      title: "新讨论 · 08-10 15:00",
      body: "秘书投递流程里 SEC-01 是怎么解决 confused deputy 的?",
      requester: "alice",
      kind: "discuss",
    });
    await settle(env);
    const row = env.store.devTickets.getDevTicket(t.id)!;
    expect(row.kind).toBe("discuss");
    expect(row.dev_status).toBe("open");
    // The discuss intro carries the discuss contract, not the simple/complex one.
    expect(env.turns[0].prompt).toContain("讨论需求");
    expect(env.turns[0].prompt).toContain("devpipe_rename");
    expect(env.turns[0].prompt).not.toContain("禁止向用户提问");
  });

  it("devpipe_rename updates a ticket's generated title and posts a pipeline note", async () => {
    let renameResult: { ok: boolean; message: string } | undefined;
    const env = await makeEnv({
      onTurn: async ({ token, env: e }) => {
        // The token is only live for the duration of the turn — the finally
        // block in `runTicketTurn` deletes it once `onTurn` returns. Call the
        // rename tool from inside the turn, just like `toolSubmit` is called
        // in the submit tests above.
        renameResult = await e.pipe.toolRename(token!, "秘书投递 SEC-01 追问");
        return "## 名字\n聊 SEC-01\n\n收到,准备开聊。";
      },
    });
    const t = env.pipe.createTicket({
      title: "新讨论 · x",
      body: "问点问题",
      requester: "alice",
      kind: "discuss",
    });
    await settle(env);
    expect(renameResult?.ok).toBe(true);
    const row = env.store.devTickets.getDevTicket(t.id)!;
    expect(row.title).toBe("秘书投递 SEC-01 追问");
    // A pipeline note lets the user see the rename in the conversation.
    const msgs = env.store.devTickets.listTicketMessages(t.id);
    expect(msgs.some((m) => m.author === "pipeline" && m.body.includes("已命名为"))).toBe(true);
  });

  /**
   * Ticket #201. Two statuses used to describe every finished turn — a
   * conversation, or a package waiting for deploy — and an agent that landed
   * half the work and asked about the rest produced the second one. The board
   * then said "done" over the top of a question nobody would read.
   */
  it("devpipe_ask records an unanswered question without touching dev_status", async () => {
    let asked: { ok: boolean; message: string } | undefined;
    const env = await makeEnv({
      onTurn: async ({ token, env: e }) => {
        asked = await e.pipe.toolAsk(token!, "剩下那一半要改权限契约,做吗?");
        return "先做了这一半。";
      },
    });
    const t = env.pipe.createTicket({ title: "x", body: "y", requester: "alice", kind: "simple" });
    await settle(env);

    expect(asked?.ok).toBe(true);
    const row = env.store.devTickets.getDevTicket(t.id)!;
    expect(row.open_question).toBe("剩下那一半要改权限契约,做吗?");
    // It is a second axis, not a status: nothing else about the ticket moved.
    expect(row.dev_status).toBe("open");
  });

  it("clears the question the moment the requester speaks, and not before", async () => {
    const env = await makeEnv({
      onTurn: async ({ token, env: e }) => {
        await e.pipe.toolAsk(token!, "A 还是 B?");
        return "等你定。";
      },
    });
    const t = env.pipe.createTicket({ title: "x", body: "y", requester: "alice", kind: "simple" });
    await settle(env);
    expect(env.store.devTickets.getDevTicket(t.id)!.open_question).toBe("A 还是 B?");

    // A pipeline note is not an answer — only a person's message is.
    env.store.devTickets.addTicketMessage(t.id, "pipeline", "pipeline", "📝 一条系统备注");
    expect(env.store.devTickets.getDevTicket(t.id)!.open_question).toBe("A 还是 B?");

    env.pipe.postMessage(t.id, "alice", "web", "选 B");
    expect(env.store.devTickets.getDevTicket(t.id)!.open_question).toBeNull();
  });

  /**
   * Ticket #236. Reported from the panel: a landed ticket ended on a question
   * the requester did not want to answer, and there was no way to take it off
   * the board — cancel is refused after landing, and answering was the only
   * other exit.
   */
  it("dismisses the question without answering it, waking no turn", async () => {
    let turns = 0;
    const env = await makeEnv({
      onTurn: async ({ token, env: e }) => {
        turns += 1;
        await e.pipe.toolAsk(token!, "要不要继续追那个具体成因?");
        return "先到这里。";
      },
    });
    const t = env.pipe.createTicket({ title: "x", body: "y", requester: "alice", kind: "simple" });
    await settle(env);
    expect(turns).toBe(1);
    expect(env.store.devTickets.getDevTicket(t.id)!.open_question).toBe("要不要继续追那个具体成因?");

    const row = env.pipe.dismissQuestion(t.id, "alice");
    expect(row.open_question).toBeNull();
    // The dismissal is visible in the conversation, by the person who made it.
    const notes = env.store.devTickets
      .listTicketMessages(t.id)
      .filter((m) => m.author === "pipeline" && m.body.includes("关闭了这个未决问题"));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain("alice");
    expect(notes[0]!.body).toContain("要不要继续追那个具体成因?");

    // And it stays quiet: no unread inbox message, so no second turn.
    await settle(env);
    expect(turns).toBe(1);
    // Nothing else about the ticket moved.
    expect(row.dev_status).toBe("open");

    // Idempotent — a second click (or a second tab) is not an error.
    expect(env.pipe.dismissQuestion(t.id, "alice").open_question).toBeNull();
    expect(
      env.store.devTickets
        .listTicketMessages(t.id)
        .filter((m) => m.author === "pipeline" && m.body.includes("关闭了这个未决问题")),
    ).toHaveLength(1);
  });

  it("devpipe_ask with an empty string retracts, rather than recording an empty question", async () => {
    let retracted: { ok: boolean; message: string } | undefined;
    const env = await makeEnv({
      onTurn: async ({ token, env: e }) => {
        await e.pipe.toolAsk(token!, "要不要?");
        retracted = await e.pipe.toolAsk(token!, "");
        return "想明白了,不用问了。";
      },
    });
    const t = env.pipe.createTicket({ title: "x", body: "y", requester: "alice", kind: "simple" });
    await settle(env);
    expect(retracted?.ok).toBe(true);
    expect(env.store.devTickets.getDevTicket(t.id)!.open_question).toBeNull();
  });

  it("devpipe_rename replaces a generated title for a non-discuss ticket", async () => {
    let renameResult: { ok: boolean; message: string } | undefined;
    const env = await makeEnv({
      onTurn: async ({ token, env: e }) => {
        renameResult = await e.pipe.toolRename(token!, "定位登录会话漂移");
        return "## 名字\n登录会话漂移\n\ndone.";
      },
    });
    const t = env.pipe.createTicket({
      title: "新工单 · 08-17 13:00",
      body: "登录后会跳回",
      requester: "alice",
      kind: "simple",
    });
    await settle(env);
    expect(renameResult?.ok).toBe(true);
    expect(env.store.devTickets.getDevTicket(t.id)!.title).toBe("定位登录会话漂移");
  });

  it("devpipe_rename enforces 2..60 chars and strips a stray 讨论: prefix", async () => {
    const results: Array<{ ok: boolean; message: string }> = [];
    const env = await makeEnv({
      onTurn: async ({ token, env: e }) => {
        results.push(await e.pipe.toolRename(token!, "x")); // too short
        results.push(await e.pipe.toolRename(token!, "y".repeat(61))); // too long
        results.push(await e.pipe.toolRename(token!, "讨论: 真正的标题"));
        return "## 名字\n随便\n";
      },
    });
    const t = env.pipe.createTicket({ title: "x", body: "y", requester: "alice", kind: "discuss" });
    await settle(env);
    expect(results[0]?.ok).toBe(false);
    expect(results[1]?.ok).toBe(false);
    expect(results[2]?.ok).toBe(true);
    expect(env.store.devTickets.getDevTicket(t.id)!.title).toBe("真正的标题");
  });

  it("devpipe_rename with an unknown token is a stale-turn message, not a throw", async () => {
    const env = await makeEnv();
    const r = await env.pipe.toolRename("dp_notreal", "任何标题");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("token");
  });
});

// ── Ticket #61: an ordinary ticket may owe an App a republication ──
//
// The gap this closes: `simple`/`complex` tickets are ALLOWED to edit the
// module packages an App's View is compiled from, so they routinely change a
// release — and landing one used to leave the App serving its previous bytes
// with nothing saying so. The debt is now recorded, announced, settled by one
// tool call, and (when only a deploy can settle it) drained after the deploy.

describe("an ordinary ticket that changes an App's release", () => {
  function plainTicket(env: Env) {
    return env.pipe.createTicket({ title: "改会话+的导航栏", body: "b", requester: "alice", kind: "simple" });
  }

  it("records the debt and says so in the submit answer", async () => {
    let sub: SubmitResult | undefined;
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, SHARED_SESSIONS_MODULE_FILE);
        sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        return "落地了";
      },
    });
    const t = plainTicket(env);
    await settle(env);

    expect(sub?.ok).toBe(true);
    expect(sub?.app_release_owed).toEqual(["session-plus", "research-program", "research-v2", "research-docs"]);
    expect(sub?.message).toContain("完整部署");
    // Durable, because an agent that ignores the sentence must not be the only
    // thing standing between the user and their change.
    const pending = env.store.appCatalog.listPendingAppReleases();
    expect(pending.map((row) => row.app_id)).toEqual(["research-docs", "research-program", "research-v2", "session-plus"]);
    expect(pending.every((row) => row.commit_sha === sub?.sha)).toBe(true);
    expect(pending.every((row) => row.ticket_id === t.id)).toBe(true);
    // And no refresh happened by itself: this is not an app ticket.
    expect(env.refreshCalls).toHaveLength(0);
  });

  it("accepts an exact multi-App declaration, adds the union gate, and publishes from its worktree", async () => {
    let sub: SubmitResult | undefined;
    const env = await makeEnv({
      refresh: async (input) => ({ ...REFRESH_OK, appId: input.appId, packageDigest: input.appId.padEnd(64, "a").slice(0, 64) }),
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "packages/agent-deck-view/src/modules.tsx");
        sub = await e.pipe.toolSubmit(
          token!,
          [],
          undefined,
          undefined,
          [],
          { mode: "app_releases", apps: ["showcase", "ppt-studio"] },
        );
        mkdirSync(join(cwd, "node_modules"), { recursive: true });
        return "落地了";
      },
    });
    const t = plainTicket(env);
    await settle(env);

    expect(sub).toMatchObject({
      ok: true,
      app_release_owed: ["showcase", "ppt-studio"],
      delivery: { mode: "app_releases", apps: ["ppt-studio", "showcase"] },
    });
    const landed = env.store.devTickets.getDevTicket(t.id)!;
    expect(landed.delivery_mode).toBe("app_releases");
    expect(JSON.parse(landed.delivery_apps!)).toEqual(["ppt-studio", "showcase"]);
    expect(landed.deploy_status).toBe("pending");
    const named = env.landGateCalls[0]?.candidate?.namedTests ?? [];
    expect(named).toEqual(expect.arrayContaining([
      "project:agent-deck-view",
      "project:ppt-studio-view",
      "project:showcase-view",
      "packages/bot/src/app-registry",
    ]));

    const published = await env.pipe.publishPendingAppReleases("user:alice");
    expect(published).toMatchObject({ ok: true, remaining: [] });
    expect(env.refreshCalls.map((call) => call.appId).sort()).toEqual(["ppt-studio", "showcase"]);
    expect(env.refreshCalls.every((call) => call.worktree === landed.worktree)).toBe(true);
    expect(env.store.devTickets.getDevTicket(t.id)?.deploy_status).toBe("app_live");
  });

  it("refuses an App-only declaration that hides a trusted release input", async () => {
    let sub: SubmitResult | undefined;
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "packages/bot/src/app-core/view-app.ts");
        sub = await e.pipe.toolSubmit(
          token!, [], undefined, undefined, [],
          {
            mode: "app_releases",
            apps: [
              "session-plus", "showcase", "ppt-studio", "chess", "daily-brief",
              "meeting-room", "expense-intake", "report-space", "research-program", "research-v2", "research-docs",
            ],
          },
        );
        return "refused";
      },
    });
    const t = plainTicket(env);
    await settle(env);

    expect(sub).toMatchObject({
      ok: false,
      code: "delivery_scope",
      files: ["packages/bot/src/app-core/view-app.ts"],
    });
    expect(env.store.devTickets.getDevTicket(t.id)?.dev_status).toBe("open");
    expect(env.gateCalls).toHaveLength(0);
  });

  it("records a proven documentation/test-only landing as needing no production action", async () => {
    let sub: SubmitResult | undefined;
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "doc/notes.md");
        sub = await e.pipe.toolSubmit(token!, [], undefined, undefined, [], { mode: "none" });
        return "landed";
      },
    });
    const t = plainTicket(env);
    await settle(env);

    expect(sub).toMatchObject({ ok: true, delivery: { mode: "none", apps: [] } });
    expect(env.store.devTickets.getDevTicket(t.id)).toMatchObject({
      dev_status: "landed",
      deploy_status: "not_needed",
      delivery_mode: "none",
    });
    expect(env.warmCalls).toEqual([]);
  });

  it("does not let a later narrow follow-up erase an earlier undeployed full-deploy debt", async () => {
    let turn = 0;
    const submissions: SubmitResult[] = [];
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        turn++;
        if (turn === 1) {
          await commitWork(cwd, "packages/bot/src/runtime-change.ts");
          submissions.push(await e.pipe.toolSubmit(token!)); // old-client fallback: full deploy
        } else {
          await commitWork(cwd, "doc/follow-up.md");
          submissions.push(await e.pipe.toolSubmit(token!, [], undefined, undefined, [], { mode: "none" }));
        }
        return "landed";
      },
    });
    const t = plainTicket(env);
    await settle(env);
    env.pipe.postMessage(t.id, "alice", "web", "补一份说明");
    await settle(env);

    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toMatchObject({ ok: true, delivery: { mode: "full_deploy" } });
    expect(env.store.devTickets.getDevTicket(t.id)).toMatchObject({
      deploy_status: "pending",
      delivery_mode: "full_deploy",
    });
  });

  it("owes nothing when the diff touches no App's release inputs", async () => {
    let sub: SubmitResult | undefined;
    const env = await makeEnv({
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "packages/bot/src/dashboard/server.ts");
        sub = (await e.pipe.toolSubmit(token!)) as SubmitResult;
        return "落地了";
      },
    });
    plainTicket(env);
    await settle(env);
    expect(sub?.ok).toBe(true);
    expect(sub?.app_release_owed).toBeUndefined();
    expect(env.store.appCatalog.listPendingAppReleases()).toEqual([]);
  });

  it("devpipe_app_release prepares every owed App and never activates in the agent turn", async () => {
    let out: Awaited<ReturnType<DevPipeline["toolAppRelease"]>> | undefined;
    const calls = { prepare: [] as string[], preview: [] as string[], activate: [] as string[] };
    const env = await makeEnv({
      refresh: async () => REFRESH_OK,
      hotswap: hotswapFake(calls),
      runTreeIsRepo: true,
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, SHARED_SESSIONS_MODULE_FILE);
        await e.pipe.toolSubmit(token!);
        // A deployed tree carrying the landed ordinary-ticket commit.
        await gitOrThrow(e.repo, ["merge", "--ff-only", "main"]);
        out = await e.pipe.toolAppRelease(token!);
        return "候选待批";
      },
    });
    mkdirSync(join(env.repo, "node_modules"), { recursive: true });
    const t = plainTicket(env);
    await settle(env);

    expect(out?.ok).toBe(false);
    expect(out?.status).toBe("approval_required");
    expect(out?.app).toBeUndefined();
    expect(out?.pending_ids).toHaveLength(4);
    expect(calls.prepare).toHaveLength(4);
    expect(calls.activate).toEqual([]);
    expect(env.store.appCatalog.listPendingAppReleases()).toHaveLength(4);
    const pending = env.pipe.listAppHotswapApprovals();
    expect(pending).toEqual([
      expect.objectContaining({ ticketId: t.id, appId: "research-docs" }),
      expect.objectContaining({ ticketId: t.id, appId: "research-program" }),
      expect.objectContaining({ ticketId: t.id, appId: "research-v2" }),
      expect.objectContaining({ ticketId: t.id, appId: "session-plus" }),
    ]);

    for (const approval of pending) {
      const decided = await env.pipe.decideAppHotswapApproval(approval.id, "approve", "user:root");
      expect(decided).toMatchObject({ ok: true, changed: true });
    }
    expect(calls.activate).toEqual([
      `research-docs:${"a".repeat(64)}:user:root`,
      `research-program:${"a".repeat(64)}:user:root`,
      `research-v2:${"a".repeat(64)}:user:root`,
      `session-plus:${"a".repeat(64)}:user:root`,
    ]);
    expect(env.store.appCatalog.listPendingAppReleases()).toEqual([]);
  });

  it("defers to the next deploy when no packable checkout carries the change", async () => {
    let out: Awaited<ReturnType<DevPipeline["toolAppRelease"]>> | undefined;
    // The run tree is the repo itself, parked on `live` — built, but behind.
    const env = await makeEnv({
      refresh: async () => REFRESH_OK,
      runTreeIsRepo: true,
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, APP_FILE);
        await e.pipe.toolSubmit(token!);
        out = await e.pipe.toolAppRelease(token!);
        return "等部署";
      },
    });
    // `node_modules` in the run tree only; the ticket worktree has none, which
    // is the ordinary-ticket shape (nothing ever installed there).
    mkdirSync(join(env.repo, "node_modules"), { recursive: true });
    plainTicket(env);
    await settle(env);

    expect(out?.ok).toBe(false);
    expect(out?.message).toContain("下一次部署");
    // Nothing was packed, and the debt survives for the sweep.
    expect(env.refreshCalls).toHaveLength(0);
    expect(env.store.appCatalog.listPendingAppReleases()).toHaveLength(1);
  });

  it("automatic publication waits for the deployed tree and then publishes from it", async () => {
    const env = await makeEnv({
      refresh: async () => REFRESH_OK,
      runTreeIsRepo: true,
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, APP_FILE);
        await e.pipe.toolSubmit(token!);
        return "落地了";
      },
    });
    mkdirSync(join(env.repo, "node_modules"), { recursive: true });
    const t = plainTicket(env);
    await settle(env);
    expect(env.store.appCatalog.listPendingAppReleases()).toHaveLength(1);

    // Still behind, and no staged release: publication must not pack
    // yesterday's tree under the claim that it is this change.
    await env.pipe.autoPublishPendingAppReleases();
    expect(env.refreshCalls).toHaveLength(0);
    expect(env.store.appCatalog.listPendingAppReleases()).toHaveLength(1);

    // The deploy, in miniature: the run tree now carries the landed commit.
    await gitOrThrow(env.repo, ["merge", "--ff-only", "main"]);
    await env.pipe.autoPublishPendingAppReleases();

    expect(env.refreshCalls).toHaveLength(1);
    expect(env.refreshCalls[0].worktree).toBe(env.repo);
    expect(env.refreshCalls[0].actor).toBe("devpipe:automatic");
    // A reviewed repository App that this host does not serve yet is declared.
    expect(env.refreshCalls[0].declareMissing).toBe(true);
    expect(env.store.appCatalog.listPendingAppReleases()).toEqual([]);
    const notes = env.store.devTickets.listTicketMessages(t.id).filter((m) => m.author === "pipeline");
    expect(notes.filter((m) => m.body.includes("App release 自动发布"))).toEqual([
      expect.objectContaining({ body: expect.stringContaining("来自当前部署") }),
    ]);
  });

  it.each(["automatic", "hot-publish"])("%s publishes each prepared revision while later App work stays pending", async (mode) => {
    let turn = 0;
    const env = await makeEnv({
      refresh: async () => REFRESH_OK,
      runTreeIsRepo: true,
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, APP_FILE, `revision ${++turn}\n`);
        await e.pipe.toolSubmit(token!);
        return "landed";
      },
    });
    mkdirSync(join(env.repo, "node_modules"), { recursive: true });
    const tickets = [];
    for (let i = 0; i < 3; i++) {
      const ticket = plainTicket(env);
      await settle(env);
      tickets.push(env.store.devTickets.getDevTicket(ticket.id)!);
    }
    const publish = () => mode === "automatic"
      ? env.pipe.autoPublishPendingAppReleases()
      : env.pipe.publishPendingAppReleases("user:alice");
    expect(env.store.appCatalog.listPendingAppReleaseRevisions()).toHaveLength(3);
    expect(env.store.appCatalog.listPendingAppReleases()).toEqual([
      expect.objectContaining({ ticket_id: tickets[2].id }),
    ]);
    for (let i = 0; i < tickets.length; i++) {
      await gitOrThrow(env.repo, ["merge", "--ff-only", tickets[i].commit_sha!]);
      await publish();
      expect(env.refreshCalls).toHaveLength(i + 1);
      expect(env.refreshCalls[i]).toMatchObject({ worktree: env.repo, ticketId: tickets[i].id });
      expect(env.store.appCatalog.listPendingAppReleaseRevisions().map(row => row.ticket_id))
        .toEqual(tickets.slice(i + 1).map(ticket => ticket.id));
      // A restart while the later release is still building must not publish
      // this same revision again or undo an operator's App rollback.
      await publish();
      expect(env.refreshCalls).toHaveLength(i + 1);
    }
    expect(env.store.appCatalog.listPendingAppReleases()).toEqual([]);
  });

  it("settles an older App-only ticket whose debt was folded into a newer landing", async () => {
    let turn = 0;
    const env = await makeEnv({
      refresh: async (input) => ({
        ...REFRESH_OK,
        appId: input.appId,
        packageDigest: input.appId.padEnd(64, "a").slice(0, 64),
      }),
      runTreeIsRepo: true,
      onTurn: async ({ cwd, token, env: e }) => {
        turn++;
        await commitWork(cwd, SHARED_SESSIONS_MODULE_FILE, `work ${turn}\n`);
        if (turn === 1) {
          await e.pipe.toolSubmit(
            token!, [], undefined, undefined, [],
            { mode: "app_releases", apps: ["research-docs", "research-program", "research-v2", "session-plus"] },
          );
        } else {
          await e.pipe.toolSubmit(
            token!, [], undefined, undefined, [],
            { mode: "full_deploy" },
          );
        }
        return "landed";
      },
    });
    mkdirSync(join(env.repo, "node_modules"), { recursive: true });

    const older = plainTicket(env);
    await settle(env);
    const newer = plainTicket(env);
    await settle(env);

    expect(env.store.appCatalog.listPendingAppReleases()).toEqual([
      expect.objectContaining({ app_id: "research-docs", ticket_id: newer.id }),
      expect.objectContaining({ app_id: "research-program", ticket_id: newer.id }),
      expect.objectContaining({ app_id: "research-v2", ticket_id: newer.id }),
      expect.objectContaining({ app_id: "session-plus", ticket_id: newer.id }),
    ]);
    expect(env.store.devTickets.getDevTicket(older.id)?.deploy_status).toBe("pending");

    await gitOrThrow(env.repo, ["merge", "--ff-only", "main"]);
    await env.pipe.autoPublishPendingAppReleases();

    expect(env.store.appCatalog.listPendingAppReleases()).toEqual([]);
    expect(env.store.devTickets.getDevTicket(older.id)?.deploy_status).toBe("app_live");
    expect(env.store.devTickets.getDevTicket(newer.id)?.deploy_status).toBe("pending");
    const notes = env.store.devTickets.listTicketMessages(older.id).filter((message) => message.author === "pipeline");
    expect(notes.some((message) => message.body.includes("当前或较新的 active release"))).toBe(true);
  });

  it("projects the automatic drain and joins a concurrent hot-publish request to it", async () => {
    let releaseRefresh!: () => void;
    const refreshHeld = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const env = await makeEnv({
      refresh: async () => {
        await refreshHeld;
        return REFRESH_OK;
      },
      runTreeIsRepo: true,
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, APP_FILE);
        await e.pipe.toolSubmit(
          token!, [], undefined, undefined, [],
          { mode: "app_releases", apps: ["session-plus"] },
        );
        return "landed";
      },
    });
    mkdirSync(join(env.repo, "node_modules"), { recursive: true });
    plainTicket(env);
    await settle(env);
    await gitOrThrow(env.repo, ["merge", "--ff-only", "main"]);

    const sweep = env.pipe.autoPublishPendingAppReleases();
    for (let i = 0; i < 100 && env.refreshCalls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(env.pipe.appReleaseDrainState()).toEqual({ active: true, mode: "automatic" });

    const joined = env.pipe.publishPendingAppReleases("user:alice");
    releaseRefresh();
    const [, result] = await Promise.all([sweep, joined]);

    expect(result).toMatchObject({ ok: true, remaining: [] });
    expect(result.results).toHaveLength(1);
    expect(env.refreshCalls).toHaveLength(1);
    expect(env.refreshCalls[0]?.actor).toBe("devpipe:automatic");
    expect(env.pipe.appReleaseDrainState()).toEqual({ active: false, mode: null });
  });

  it("hot-publishes App-only debt from the deployed tree and may declare a missing App", async () => {
    const env = await makeEnv({
      refresh: async () => REFRESH_OK,
      runTreeIsRepo: true,
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, APP_FILE);
        await e.pipe.toolSubmit(token!);
        return "落地了";
      },
    });
    mkdirSync(join(env.repo, "node_modules"), { recursive: true });
    const t = plainTicket(env);
    await settle(env);
    await gitOrThrow(env.repo, ["merge", "--ff-only", "main"]);

    const result = await env.pipe.publishPendingAppReleases("user:alice");

    expect(result).toMatchObject({ ok: true, remaining: [] });
    expect(env.refreshCalls).toEqual([
      expect.objectContaining({
        worktree: env.repo,
        actor: "user:alice",
        declareMissing: true,
      }),
    ]);
    expect(env.store.appCatalog.listPendingAppReleases()).toEqual([]);
    expect(env.store.devTickets.getDevTicket(t.id)?.deploy_status).toBe("pending");
    const notes = env.store.devTickets.listTicketMessages(t.id).filter((m) => m.author === "pipeline");
    expect(notes.some((m) => m.body.includes("未重启 bot"))).toBe(true);
  });

  /** A complete staged release in miniature: a detached checkout of `ref`. */
  async function stagedRelease(env: Env, ref = "main"): Promise<{ sha: string; dir: string }> {
    const sha = await gitOrThrow(env.repo, ["rev-parse", ref]);
    const dir = join(env.dir, "releases", sha);
    await gitOrThrow(env.repo, ["worktree", "add", "--detach", dir, sha]);
    return { sha, dir };
  }

  function drainNotes(env: Env, ticketId: number) {
    return env.store.devTickets.listTicketMessages(ticketId)
      .filter((m) => m.author === "pipeline" && /App release 自动发布|热发布 App/.test(m.body));
  }

  it("publishes App-only debt from a staged release the deployed trusted code can serve (#61)", async () => {
    const env = await makeEnv({
      refresh: async () => REFRESH_OK,
      runTreeIsRepo: true,
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, APP_FILE);
        await e.pipe.toolSubmit(token!, [], undefined, undefined, [], { mode: "app_releases", apps: ["session-plus"] });
        return "landed";
      },
    });
    const t = plainTicket(env);
    await settle(env);
    const staged = await stagedRelease(env);
    env.pipe.setAppReleaseTrees(async () => [staged]);

    await env.pipe.autoPublishPendingAppReleases();

    expect(env.refreshCalls).toEqual([expect.objectContaining({
      appId: "session-plus",
      worktree: staged.dir,
      actor: "devpipe:automatic",
      declareMissing: true,
    })]);
    expect(env.store.appCatalog.listPendingAppReleases()).toEqual([]);
    expect(env.store.devTickets.getDevTicket(t.id)?.deploy_status).toBe("app_live");
    const notes = drainNotes(env, t.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain(`来自发布包 ${staged.sha.slice(0, 10)}`);

    // Settled inputs are not drained again on the next idle poll.
    await env.pipe.autoPublishPendingAppReleases();
    expect(env.refreshCalls).toHaveLength(1);
  });

  it("leaves App debt for the next deployment when undeployed trusted code sits under it", async () => {
    let turn = 0;
    const env = await makeEnv({
      refresh: async () => REFRESH_OK,
      runTreeIsRepo: true,
      onTurn: async ({ cwd, token, env: e }) => {
        turn++;
        if (turn === 1) {
          await commitWork(cwd, "packages/bot/src/runtime-change.ts");
          await e.pipe.toolSubmit(token!, [], undefined, undefined, [], { mode: "full_deploy" });
        } else {
          await commitWork(cwd, APP_FILE);
          await e.pipe.toolSubmit(token!, [], undefined, undefined, [], { mode: "app_releases", apps: ["session-plus"] });
        }
        return "landed";
      },
    });
    plainTicket(env);
    await settle(env);
    const app = plainTicket(env);
    await settle(env);
    const landed = env.store.devTickets.getDevTicket(app.id)!;
    expect(landed.delivery_mode).toBe("app_releases");
    // Even a built, exact App-only worktree must not ship bytes that sit on
    // trusted code the running process does not have.
    mkdirSync(join(landed.worktree!, "node_modules"), { recursive: true });
    const staged = await stagedRelease(env);
    env.pipe.setAppReleaseTrees(async () => [staged]);

    await env.pipe.autoPublishPendingAppReleases();
    expect((await env.pipe.publishPendingAppReleases("user:alice")).ok).toBe(false);
    expect(env.refreshCalls).toEqual([]);
    expect(env.store.appCatalog.listPendingAppReleases()).toHaveLength(1);
    expect(env.store.devTickets.getDevTicket(app.id)?.deploy_status).toBe("pending");
    expect(drainNotes(env, app.id)).toEqual([]);

    // The full deployment in miniature; the same automatic drain then publishes.
    await gitOrThrow(env.repo, ["merge", "--ff-only", "main"]);
    await env.pipe.autoPublishPendingAppReleases();
    expect(env.refreshCalls).toEqual([expect.objectContaining({ worktree: env.repo, actor: "devpipe:automatic" })]);
    expect(env.store.devTickets.getDevTicket(app.id)?.deploy_status).toBe("app_live");
  });

  it("notes a failed automatic publication once and retries only when its inputs change", async () => {
    const env = await makeEnv({
      refresh: async (input) => ({
        ok: false,
        appId: input.appId,
        step: "activate",
        code: "runtime_unhealthy",
        message: "backend did not come up",
      }),
      runTreeIsRepo: true,
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, APP_FILE);
        await e.pipe.toolSubmit(token!, [], undefined, undefined, [], { mode: "app_releases", apps: ["session-plus"] });
        return "landed";
      },
    });
    const t = plainTicket(env);
    await settle(env);
    const staged = await stagedRelease(env);
    env.pipe.setAppReleaseTrees(async () => [staged]);

    await env.pipe.autoPublishPendingAppReleases();
    await env.pipe.autoPublishPendingAppReleases();
    expect(env.refreshCalls).toHaveLength(1);
    expect(env.store.appCatalog.listPendingAppReleases()).toHaveLength(1);
    expect(drainNotes(env, t.id)).toEqual([
      expect.objectContaining({ body: expect.stringContaining("发布失败(activate/runtime_unhealthy)") }),
    ]);

    // A deployment changes the inputs: one retry, and the identical failure is not repeated in the thread.
    await gitOrThrow(env.repo, ["merge", "--ff-only", "main"]);
    await env.pipe.autoPublishPendingAppReleases();
    expect(env.refreshCalls).toHaveLength(2);
    expect(drainNotes(env, t.id)).toHaveLength(1);
  });

  it("writes one note per ticket when a shared View change publishes several Apps", async () => {
    const env = await makeEnv({
      refresh: async (input) => ({
        ...REFRESH_OK,
        appId: input.appId,
        packageDigest: input.appId.padEnd(64, "a").slice(0, 64),
      }),
      runTreeIsRepo: true,
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, SHARED_SESSIONS_MODULE_FILE);
        await e.pipe.toolSubmit(
          token!, [], undefined, undefined, [],
          { mode: "app_releases", apps: ["research-docs", "research-program", "research-v2", "session-plus"] },
        );
        return "landed";
      },
    });
    const t = plainTicket(env);
    await settle(env);
    const staged = await stagedRelease(env);
    env.pipe.setAppReleaseTrees(async () => [staged]);

    await env.pipe.autoPublishPendingAppReleases();

    expect(env.refreshCalls).toHaveLength(4);
    expect(env.store.devTickets.getDevTicket(t.id)?.deploy_status).toBe("app_live");
    const notes = drainNotes(env, t.id);
    expect(notes).toHaveLength(1);
    for (const title of ["研究文档", "自动科研项目台（research program）", "自动科研 v2", "会话+（Session Plus）"]) {
      expect(notes[0]!.body).toContain(title);
    }
    expect(env.store.devTickets.listTicketMessages(t.id)
      .filter((m) => m.author === "pipeline" && m.body.includes("当前或较新的 active release"))).toEqual([]);
  });

  it("defers an agent hot-swap whose worktree sits on undeployed trusted code", async () => {
    let turn = 0;
    let requested: Awaited<ReturnType<DevPipeline["toolAppHotswap"]>> | undefined;
    const calls = { prepare: [] as string[], preview: [] as string[], activate: [] as string[] };
    const env = await makeEnv({
      hotswap: hotswapFake(calls),
      runTreeIsRepo: true,
      onTurn: async ({ cwd, token, env: e }) => {
        turn++;
        if (turn === 1) {
          await commitWork(cwd, "packages/bot/src/runtime-change.ts");
          await e.pipe.toolSubmit(token!, [], undefined, undefined, [], { mode: "full_deploy" });
          return "landed";
        }
        await commitWork(cwd, APP_FILE);
        const submitted = await e.pipe.toolSubmit(token!, [], undefined, undefined, [], { mode: "app_releases", apps: ["session-plus"] });
        if (!submitted.ok) throw new Error(submitted.message);
        mkdirSync(join(cwd, "node_modules"), { recursive: true });
        requested = await e.pipe.toolAppHotswap(token!, {
          app: "session-plus", expected_commit: submitted.sha, source: "landed_ticket",
        });
        return "deferred";
      },
    });
    plainTicket(env);
    await settle(env);
    plainTicket(env);
    await settle(env);

    expect(requested).toMatchObject({ ok: false, status: "deferred", code: "awaiting_deploy" });
    expect(calls.prepare).toEqual([]);
    expect(env.store.appCatalog.listPendingAppReleases()).toHaveLength(1);
  });

  it("holds an ahead staged release on a tier-3 knowledge verdict and skips the review for the deployed tree", async () => {
    const env = await makeEnv({
      refresh: async () => REFRESH_OK,
      runTreeIsRepo: true,
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, APP_FILE);
        await e.pipe.toolSubmit(token!, [], undefined, undefined, [], { mode: "app_releases", apps: ["session-plus"] });
        return "landed";
      },
    });
    const t = plainTicket(env);
    await settle(env);
    const staged = await stagedRelease(env);
    env.pipe.setAppReleaseTrees(async () => [staged]);
    const review = vi.mocked(assertKnowledgeDeployable);
    review.mockClear();
    review.mockRejectedValueOnce(new Error("知识裁决阻止上线：required_record_changed:x"));

    await env.pipe.autoPublishPendingAppReleases();

    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]![0]).toMatchObject({ target: staged.sha, previous: await gitOrThrow(env.repo, ["rev-parse", "HEAD"]) });
    expect(env.refreshCalls).toEqual([]);
    expect(env.store.appCatalog.listPendingAppReleases()).toHaveLength(1);
    expect(drainNotes(env, t.id)).toEqual([
      expect.objectContaining({ body: expect.stringContaining("knowledge_review") }),
    ]);

    // The deployment that carries the commit already passed its own review.
    review.mockClear();
    await gitOrThrow(env.repo, ["merge", "--ff-only", "main"]);
    await env.pipe.autoPublishPendingAppReleases();
    expect(review).not.toHaveBeenCalled();
    expect(env.refreshCalls).toEqual([expect.objectContaining({ worktree: env.repo })]);
  });

  it("publishes an ahead staged release with a visible warning when the knowledge review cannot run", async () => {
    const env = await makeEnv({
      refresh: async (input) => ({
        ...REFRESH_OK,
        appId: input.appId,
        packageDigest: input.appId.padEnd(64, "a").slice(0, 64),
      }),
      runTreeIsRepo: true,
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, SHARED_SESSIONS_MODULE_FILE);
        await e.pipe.toolSubmit(
          token!, [], undefined, undefined, [],
          { mode: "app_releases", apps: ["research-docs", "research-program", "research-v2", "session-plus"] },
        );
        return "landed";
      },
    });
    const t = plainTicket(env);
    await settle(env);
    const staged = await stagedRelease(env);
    env.pipe.setAppReleaseTrees(async () => [staged]);
    const review = vi.mocked(assertKnowledgeDeployable);
    review.mockClear();
    review.mockImplementationOnce(async (input) => { input.onUnavailable?.("Runner offline"); });

    await env.pipe.autoPublishPendingAppReleases();

    // One review for the one source, four Apps published, one warning in one note.
    expect(review).toHaveBeenCalledTimes(1);
    expect(env.refreshCalls).toHaveLength(4);
    const notes = drainNotes(env, t.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body.match(/知识审查未能运行\(Runner offline\)/g)).toHaveLength(1);
  });

  it("lets the explicit hot publication pack a compatible staged release", async () => {
    const env = await makeEnv({
      refresh: async () => REFRESH_OK,
      runTreeIsRepo: true,
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, APP_FILE);
        await e.pipe.toolSubmit(token!, [], undefined, undefined, [], { mode: "app_releases", apps: ["session-plus"] });
        return "landed";
      },
    });
    const t = plainTicket(env);
    await settle(env);
    const staged = await stagedRelease(env);
    env.pipe.setAppReleaseTrees(async () => [staged]);

    expect(await env.pipe.publishPendingAppReleases("user:alice")).toMatchObject({ ok: true, remaining: [] });
    expect(env.refreshCalls).toEqual([expect.objectContaining({ worktree: staged.dir, actor: "user:alice" })]);
    expect(drainNotes(env, t.id)).toEqual([
      expect.objectContaining({ body: expect.stringContaining("未重启 bot") }),
    ]);
  });

  it("builds an ahead App ticket from its path-gated worktree and marks it live", async () => {
    const env = await makeEnv({
      refresh: async () => REFRESH_OK,
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, APP_FILE);
        await e.pipe.toolSubmit(token!);
        return "落地了";
      },
    });
    const ticket = appTicket(env);
    await settle(env);
    const landed = env.store.devTickets.getDevTicket(ticket.id)!;
    mkdirSync(join(landed.worktree!, "node_modules"), { recursive: true });

    expect((await env.pipe.publishPendingAppReleases("user:alice")).ok).toBe(true);
    expect(env.refreshCalls).toEqual([
      expect.objectContaining({
        worktree: landed.worktree,
        declareMissing: true,
        prepareView: true,
      }),
    ]);
    expect(env.store.devTickets.getDevTicket(ticket.id)?.deploy_status).toBe("app_live");
  });

  it("names the App when asked to, and says so when there is nothing to publish", async () => {
    let named: Awaited<ReturnType<DevPipeline["toolAppRelease"]>> | undefined;
    let nothing: Awaited<ReturnType<DevPipeline["toolAppRelease"]>> | undefined;
    let unknown: Awaited<ReturnType<DevPipeline["toolAppRelease"]>> | undefined;
    const env = await makeEnv({
      refresh: async () => REFRESH_OK,
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "packages/bot/src/dashboard/server.ts");
        await e.pipe.toolSubmit(token!);
        nothing = await e.pipe.toolAppRelease(token!);
        unknown = await e.pipe.toolAppRelease(token!, { app: "no-such-app" });
        mkdirSync(join(cwd, "node_modules"), { recursive: true });
        named = await e.pipe.toolAppRelease(token!, { app: "session-plus" });
        return "ok";
      },
    });
    plainTicket(env);
    await settle(env);

    expect(nothing?.ok).toBe(false);
    expect(nothing?.message).toContain("没有待发布");
    expect(unknown?.ok).toBe(false);
    expect(unknown?.message).toContain("no-such-app");
    // A name is an assertion over an App ticket's hard scope, never a chooser.
    expect(named?.ok).toBe(false);
    expect(named?.message).toContain("不是选择权");
    expect(env.refreshCalls).toEqual([]);
  });
});

describe("landing knowledge lifecycle", () => {
  it("records CLI receipts when present and never refuses a landing for missing specifications or receipts", async () => {
    const env = await makeEnv({ knowledgeCaptureEnabled: true });
    const wt = join(env.dir, "buf");
    await gitOrThrow(env.repo, ["worktree", "add", "-b", "buf", wt, "main"]);
    await commitWork(wt, "knowledge-receipt.ts");
    const evidence = makeCliLandingReceipt(await gitOrThrow(wt, ["rev-parse", "HEAD"]), "cli", "other-path.ts");
    // No specifications, and a receipt that neither covers the change nor arrives intact.
    await commitCliReport(wt, "alice", evidence.retrieval);
    const before = await gitOrThrow(env.repo, ["rev-parse", "main"]);
    const result = await env.pipe.land("buf", "alice", [], [{ ...evidence.upload, content: "{}" }]);
    expect(result).toMatchObject({ ok: true, retrieval_receipts: [{ id: evidence.upload.id, state: "invalid" }] });
    expect(await gitOrThrow(env.repo, ["rev-parse", "main"])).not.toBe(before);

    const next = join(env.dir, "next");
    await gitOrThrow(env.repo, ["worktree", "add", "-b", "next", next, "main"]);
    await commitWork(next, "knowledge-next.ts");
    const recorded = makeCliLandingReceipt(await gitOrThrow(next, ["rev-parse", "HEAD"]), "cli", "knowledge-next.ts");
    await commitCliReport(next, "alice", recorded.retrieval);
    expect(await env.pipe.land("next", "alice", [], [recorded.upload]))
      .toMatchObject({ ok: true, retrieval_receipts: [{ id: recorded.upload.id, state: "imported" }] });
  });

  it("refuses an otherwise landable commit without structured knowledge", async () => {
    let result: SubmitResult | undefined;
    const env = await makeEnv({
      knowledgeCaptureEnabled: true,
      onTurn: async ({ cwd, token, env: current }) => {
        await commitWork(cwd, "knowledge-required.ts");
        result = await current.pipe.toolSubmit(token!);
        return "submit checked";
      },
    });
    env.pipe.createTicket({ title: "knowledge required", body: "record the landing intent", requester: "alice" });
    await settle(env);
    expect(result).toMatchObject({ ok: false, code: "knowledge_required" });
    expect(env.store.knowledge.listPreparedLandings()).toEqual([]);
  });

  it("stores the exact landing range without treating agent facts as user approval", async () => {
    let result: SubmitResult | undefined;
    const env = await makeEnv({
      knowledgeCaptureEnabled: true,
      onTurn: async ({ cwd, token, env: current }) => {
        await commitWork(cwd, "knowledge-landed.ts");
        await commitWork(cwd, "knowledge-landed.test.ts");
        result = await current.pipe.toolSubmit(token!, [], undefined, {
          specifications: landingSpecs(["every landing keeps its exact base and tip"], ["use a prepared SQLite outbox around the Git fast-forward"], "knowledge-landed.ts", "knowledge-landed.test.ts"),
          summary: "landing range is durable",
          requirements: ["every landing keeps its exact base and tip"],
          decisions: ["use a prepared SQLite outbox around the Git fast-forward"],
          non_goals: ["do not infer intent from transcript prose"],
          risks: ["Git and SQLite cannot share one transaction"],
          verification: ["pipeline focused test passed"],
          context_keys: [],
          supersedes: [],
        });
        return "landed with knowledge";
      },
    });
    const before = await gitOrThrow(env.repo, ["rev-parse", "main"]);
    const ticket = env.pipe.createTicket({
      title: "durable landing range",
      body: "preserve exact base and tip",
      requester: "alice",
    });
    await settle(env);

    expect(result?.ok).toBe(true);
    const rows = env.store.knowledge.listLandings(ticket.id);
    expect(rows).toEqual([
      expect.objectContaining({
        status: "landed",
        from_sha: before,
        to_sha: result?.sha,
        base_before: before,
        tip_sha: result?.sha,
      }),
    ]);
    expect(env.store.knowledge.search("landing range durable")).toContainEqual(
      expect.objectContaining({ kind: "outcome", ticket_id: ticket.id, authority: "derived" }),
    );
  });

  it("lands a knowledge record without specifications or path retrieval", async () => {
    let result: SubmitResult | undefined;
    const env = await makeEnv({ knowledgeCaptureEnabled: true, onTurn: async ({ cwd, token, env: current }) => {
      await commitWork(cwd, "specification-optional.ts");
      result = await current.pipe.toolSubmit(token!, [], undefined, {
        summary: "knowledge was maintained", requirements: ["preserve the user design"], decisions: ["use existing patterns"], non_goals: [], risks: [], verification: ["tests passed"], context_keys: [], supersedes: [],
      });
      return "checked";
    } });
    const ticket = env.pipe.createTicket({ title: "optional specifications", body: "record what landed", requester: "alice" });
    await settle(env);
    expect(result).toMatchObject({ ok: true });
    const [landing] = env.store.knowledge.listLandings(ticket.id);
    expect(landing).toMatchObject({ status: "landed" });
    expect(JSON.parse(landing!.knowledge_json)).toMatchObject({ requirements: ["preserve the user design"] });
    expect(JSON.parse(landing!.knowledge_json)).not.toHaveProperty("specifications");
  });
});

it("workspace jobs use the turn owner's exact committed source and preserve typed uncertainty", async () => {
  const tasks: WorkspaceTask[] = []; const replies: Record<string, unknown>[] = [];
  const provider = { target: { owner: "alice", device: "ci", workspaceId: "registered" },
    async submit(task: WorkspaceTask) { tasks.push(task); return { state: "running", job_id: "one" }; },
    async query() { const { WorkspaceProviderUnknown } = await import("./workspace-provider.js"); throw new WorkspaceProviderUnknown("query original job"); },
  } as unknown as WorkspaceProvider;
  let staleToken = "";
  const env = await makeEnv({
    ciWorkspaceProvider: (owner) => owner === "alice" ? provider : null,
    onTurn: async ({ cwd, token, env: e }) => {
      staleToken = token!;
      writeFileSync(join(cwd, "README.md"), "dirty");
      replies.push(await e.pipe.toolCiJob(token!, { action: "start", request_key: "tests", command: "echo test" }));
      await gitOrThrow(cwd, ["add", "."]); await gitOrThrow(cwd, ["commit", "-m", "prepared"]);
      replies.push(await e.pipe.toolCiJob(token!, { action: "start", request_key: "tests", prepare: true, command: "echo test" }));
      replies.push(await e.pipe.toolCiJob(token!, { action: "status", request_key: "tests" }));
      return "done";
    },
  });
  const ticket = env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
  await settle(env);
  expect(replies[0]).toMatchObject({ ok: false, code: "dirty" });
  expect(replies[1]).toMatchObject({ ok: true, task: { job_id: "one" } });
  expect(replies[2]).toMatchObject({ ok: false, code: "unknown" });
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ key: `ticket:${ticket.id}:tests`, workspaceKey: `ticket-${ticket.id}`, sourceDir: env.turns[0].cwd,
    sha: await gitOrThrow(env.turns[0].cwd, ["rev-parse", "HEAD"]) });
  expect(await env.pipe.toolCiJob(staleToken, { action: "start", request_key: "again" })).toMatchObject({ code: "not_holder" });
});
it("workspace job tool refuses a requester without the configured provider binding", async () => {
  let result: Record<string, unknown> | undefined;
  const env = await makeEnv({ ciWorkspaceProvider: () => null,
    onTurn: async ({ token, env: e }) => { result = await e.pipe.toolCiJob(token!, { action: "start", request_key: "tests" }); return "done"; },
  });
  env.pipe.createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" }); await settle(env);
  expect(result).toMatchObject({ ok: false, code: "unavailable" });
});


describe("GitLab authority in the shared landing pipeline", () => {
  async function bufferBranch(env: Env): Promise<string> {
    const wt = join(env.dir, "buf");
    await gitOrThrow(env.repo, ["worktree", "add", "-b", "buf", wt, "main"]);
    await commitWork(wt, "feature.ts"); await commitCliReport(wt);
    return await gitOrThrow(wt, ["rev-parse", "HEAD"]);
  }
  it("publishes a CLI candidate to GitLab before advancing the service cache", async () => {
    const env = await makeEnv({ gitlabMainline: true });
    const head = await bufferBranch(env);
    expect((await env.pipe.land("buf", "alice")).to_sha).toBe(head);
    expect(await gitOrThrow(join(env.dir, "remote.git"), ["rev-parse", "main"])).toBe(head);
    expect(await gitOrThrow(env.repo, ["rev-parse", "main"])).toBe(head);
    const remote = new GitLabMainline({ repoDir: env.repo, branch: "main" });
    expect((await remote.snapshot()).state.holder).toBeNull();
  });
  it("refuses a legacy CLI landing while an external native CLI holds the lease", async () => {
    const env = await makeEnv({ gitlabMainline: true });
    await bufferBranch(env);
    const remote = new GitLabMainline({ repoDir: env.repo, branch: "main" });
    const old = (await remote.snapshot()).main;
    const claim = await remote.acquire({ id: "external-cli", owner: "alice", label: "native" });
    expect(claim.acquired).toBe(true);
    await expect(env.pipe.land("buf", "alice")).rejects.toMatchObject({ code: "busy" });
    expect((await remote.snapshot()).main).toBe(old);
    expect((await remote.snapshot()).state.queue).toEqual([]);
    expect(env.landGateCalls).toEqual([]);
    if (claim.acquired) await remote.release(claim.lease);
  });
  it("retains the ticket lease across a failed gate and repair in the same turn", async () => {
    let gateCount = 0, result: SubmitResult | undefined;
    const env = await makeEnv({ gitlabMainline: true,
      landGate: async () => ++gateCount === 1 ? { ok: false, refusal: "typecheck", log: "repair this" } : { ok: true, log: "repaired" },
      onTurn: async ({ cwd, token, env: e }) => {
        await commitWork(cwd, "feature.ts");
        const failed = await e.pipe.toolSubmit(token!);
        expect(failed.ok).toBe(false);
        const remote = new GitLabMainline({ repoDir: e.repo, branch: "main" });
        expect((await remote.snapshot()).state.holder?.id).toMatch(/^ticket:/);
        const other = { id: "external-cli", owner: "alice", label: "native" };
        expect(await remote.acquire(other)).toMatchObject({ acquired: false });
        await remote.cancel(other);
        result = await e.pipe.toolSubmit(token!);
        return "repaired and landed";
      },
    });
    env.pipe.createTicket({ title: "Native coordination", body: "b", requester: "alice", kind: "simple" }); await settle(env);
    expect(result?.ok).toBe(true);
    expect(gateCount).toBe(2);
    expect(await gitOrThrow(join(env.dir, "remote.git"), ["rev-parse", "main"])).toBe(result?.sha);
  });
});
