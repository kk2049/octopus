/**
 * The review lane inside `devpipe_submit` (2026-08-20): a real git repo, a
 * scripted turn, a scripted publisher. The property under test is that a
 * review-lane submit is verified like a landing but never writes the base
 * branch — and says so to the agent.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../store/store.js";
import { DevPipeline, type DevPipeEvent, type SubmitResult } from "./pipeline.js";
import { BuildWarmer } from "./build-warm.js";
import { gitOrThrow } from "./worktree.js";
import type { DevTurnResult, DevTurnSpec } from "./executor.js";
import type { ProposalPublishInput, ProposalPublisher } from "./contrib-review.js";
import type { LandGateCandidate } from "./land-gate.js";

interface Env {
  dir: string;
  repo: string;
  store: Store;
  pipe: DevPipeline;
  events: DevPipeEvent[];
  published: ProposalPublishInput[];
  landGateCalls: Array<{ head: string; candidate?: LandGateCandidate }>;
  setLane(lane: "direct" | "review"): void;
}
const envs: Env[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) {
    await e.pipe.stop();
    e.store.close();
    rmSync(e.dir, { recursive: true, force: true });
  }
});

async function commitWork(cwd: string, rel: string, content = "work\n"): Promise<void> {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  await gitOrThrow(cwd, ["add", rel]);
  await gitOrThrow(cwd, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", `add ${rel}`]);
}

async function makeEnv(opts: {
  lane: "direct" | "review";
  publish?: (input: ProposalPublishInput) => Promise<{ pipelineId: string | null; pipelineUrl: string | null }>;
  onTurn: (ctx: { cwd: string; token: string; env: Env }) => Promise<string>;
}): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "devpipe-review-"));
  const repo = join(dir, "repo");
  await gitOrThrow(dir, ["init", "-b", "main", repo]);
  await gitOrThrow(repo, ["config", "user.email", "t@t"]);
  await gitOrThrow(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "base\n");
  await gitOrThrow(repo, ["add", "."]);
  await gitOrThrow(repo, ["commit", "-m", "init"]);
  await gitOrThrow(repo, ["checkout", "-b", "live"]);
  const store = new Store(":memory:");
  store.saveUser({ username: "lilei", uid: 1, home_dir: "/x", created_at: "2026-08-20T00:00:00.000Z" });
  const events: DevPipeEvent[] = [];
  const published: ProposalPublishInput[] = [];
  const landGateCalls: Env["landGateCalls"] = [];
  let lane = opts.lane;
  const env: Env = {
    dir,
    repo,
    store,
    pipe: null as unknown as DevPipeline,
    events,
    published,
    landGateCalls,
    setLane(next) { lane = next; },
  };
  const publisher: ProposalPublisher = {
    async publish(input) {
      published.push(input);
      return opts.publish ? await opts.publish(input) : { pipelineId: "p1", pipelineUrl: "https://ci/p1" };
    },
    async pipelineVerdict() { return { status: "running" }; },
    async openMergeRequest() { return null; },
    async closeMergeRequest() {},
  };
  env.pipe = new DevPipeline({
    pushRemote: null,
    store,
    repoDir: repo,
    worktreesDir: join(dir, "worktrees"),
    baseBranch: "main",
    notify: (ev) => events.push(ev),
    runTurn: async (cwd: string, spec: DevTurnSpec): Promise<DevTurnResult> => {
      const cfg = JSON.parse(readFileSync(spec.mcpConfigPath!, "utf8")) as { mcpServers: { devpipe: { env: { DEVPIPE_TOKEN: string } } } };
      const text = await opts.onTurn({ cwd, token: cfg.mcpServers.devpipe.env.DEVPIPE_TOKEN, env });
      return { ok: true, exit_code: 0, timed_out: false, duration_ms: 1, session_id: spec.sessionId ?? "s", result_text: text };
    },
    gate: async () => ({ ok: true, log: "" }),
    knowledgeCaptureEnabled: false,
    landGateCheck: async (dir, candidate) => {
      landGateCalls.push({ head: await gitOrThrow(dir, ["rev-parse", "HEAD"]), ...(candidate ? { candidate } : {}) });
      return { ok: true, log: "land gate ok" };
    },
    buildWarmer: new BuildWarmer({
      repoDir: repo,
      worktreesDir: join(dir, "worktrees"),
      park: async (warmDir) => warmDir,
      exec: async () => ({ ok: true, timedOut: false, log: "" }),
    }),
    mcpServerPath: "/nonexistent/mcp-server.js",
    sessionExists: () => false,
    turnRetryDelayMs: 5,
    resolveLane: () => lane,
    proposalPublisher: publisher,
  });
  env.pipe.setToolApi("http://127.0.0.1:1");
  env.pipe.start();
  envs.push(env);
  return env;
}

async function settle(env: Env, rounds = 3000): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 10));
    if (env.pipe.idle() && env.store.devTickets.listTicketsNeedingTurn().length === 0) {
      await new Promise((r) => setTimeout(r, 20));
      if (env.pipe.idle() && env.store.devTickets.listTicketsNeedingTurn().length === 0) return;
    }
  }
}

describe("review lane · devpipe_submit publishes instead of landing", () => {
  it("stores the lane at creation from the resolver, not from the caller", async () => {
    const env = await makeEnv({ lane: "review", onTurn: async () => "ok" });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "lilei", kind: "simple", lane: "direct" });
    expect(t.lane).toBe("review");
  });

  it("promotes an existing review ticket to direct before its turn and submit", async () => {
    let result: SubmitResult | undefined;
    const env = await makeEnv({
      lane: "review",
      onTurn: async ({ cwd, token, env }) => {
        expect(env.store.devTickets.getDevTicket(1)?.lane).toBe("direct");
        await commitWork(cwd, "promoted.txt");
        result = await env.pipe.toolSubmit(token, []);
        return "landed";
      },
    });
    const baseBefore = await gitOrThrow(env.repo, ["rev-parse", "main"]);
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "lilei", kind: "simple" });
    expect(t.lane).toBe("review");
    env.setLane("direct");
    await settle(env);

    expect(result).toMatchObject({ ok: true, sha: expect.any(String) });
    expect(result?.proposal).toBeUndefined();
    expect(env.store.devTickets.getDevTicket(t.id)?.lane).toBe("direct");
    expect(env.published).toHaveLength(0);
    expect(await gitOrThrow(env.repo, ["rev-parse", "main"])).not.toBe(baseBefore);
  });

  it("demotes an existing direct ticket to review before its turn and submit", async () => {
    let result: SubmitResult | undefined;
    const env = await makeEnv({
      lane: "direct",
      onTurn: async ({ cwd, token, env }) => {
        expect(env.store.devTickets.getDevTicket(1)?.lane).toBe("review");
        await commitWork(cwd, "demoted.txt");
        result = await env.pipe.toolSubmit(token, []);
        return "proposed";
      },
    });
    const baseBefore = await gitOrThrow(env.repo, ["rev-parse", "main"]);
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "lilei", kind: "simple" });
    expect(t.lane).toBe("direct");
    env.setLane("review");
    await settle(env);

    expect(result?.ok).toBe(true);
    expect(result?.proposal).toMatchObject({ status: "ci_pending" });
    expect(env.store.devTickets.getDevTicket(t.id)?.lane).toBe("review");
    expect(env.published).toHaveLength(1);
    expect(await gitOrThrow(env.repo, ["rev-parse", "main"])).toBe(baseBefore);
  });

  it("verifies, pushes, records a proposal and leaves the base branch alone", async () => {
    let result: SubmitResult | undefined;
    let status: Awaited<ReturnType<DevPipeline["toolStatus"]>> | undefined;
    const env = await makeEnv({
      lane: "review",
      onTurn: async ({ cwd, token, env }) => {
        await commitWork(cwd, "feature.txt");
        result = await env.pipe.toolSubmit(token, []);
        status = await env.pipe.toolStatus(token);
        return "已提交评审";
      },
    });
    const baseBefore = await gitOrThrow(env.repo, ["rev-parse", "main"]);
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "lilei", kind: "simple" });
    await settle(env);

    expect(result?.ok).toBe(true);
    expect(result?.proposal).toMatchObject({ branch: `contrib/lilei/ticket-${t.id}`, status: "ci_pending", pipeline_url: "https://ci/p1" });
    expect(result?.message).toContain("没有**合入");
    // The base branch did not move, and the ticket is still a conversation.
    expect(await gitOrThrow(env.repo, ["rev-parse", "main"])).toBe(baseBefore);
    const row = env.store.devTickets.getDevTicket(t.id)!;
    expect(row.dev_status).toBe("open");
    expect(row.commit_sha).toBeNull();
    // What was pushed is exactly the verified sha, rebased on the base tip.
    expect(env.published).toHaveLength(1);
    expect(env.published[0]).toMatchObject({ ticketId: t.id, requester: "lilei", baseSha: baseBefore });
    expect(env.published[0].sha).toBe(result!.sha);
    expect(env.landGateCalls.map((c) => c.head)).toEqual([result!.sha]);
    expect(env.landGateCalls[0].candidate?.changedFiles).toEqual(["feature.txt"]);
    const proposal = env.store.mergeProposals.liveForTicket(t.id)!;
    expect(proposal).toMatchObject({ status: "ci_pending", sha: result!.sha, base_sha: baseBefore, pipeline_id: "p1" });
    expect(env.events.some((e) => e.kind === "proposed" && e.ticket.id === t.id)).toBe(true);
    expect(env.events.some((e) => e.kind === "landed")).toBe(false);
    expect((status as { ticket: { lane: string } }).ticket.lane).toBe("review");
    expect(env.pipe.mergeLockHolder()).toBeNull();
  });

  it("a publish failure keeps the verified work on the branch and reports it", async () => {
    let result: SubmitResult | undefined;
    const env = await makeEnv({
      lane: "review",
      publish: async () => { throw new Error("remote refused"); },
      onTurn: async ({ cwd, token, env }) => {
        await commitWork(cwd, "feature.txt");
        result = await env.pipe.toolSubmit(token, []);
        return "failed";
      },
    });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "lilei", kind: "simple" });
    await settle(env);
    expect(result).toMatchObject({ ok: false, code: "merge_failed" });
    expect(result?.message).toContain("remote refused");
    expect(env.store.mergeProposals.latestForTicket(t.id)).toBeUndefined();
  });

  it("a resubmit supersedes the previous proposal", async () => {
    let turns = 0;
    const env = await makeEnv({
      lane: "review",
      onTurn: async ({ cwd, token, env }) => {
        turns++;
        await commitWork(cwd, `f${turns}.txt`);
        await env.pipe.toolSubmit(token, []);
        return `round ${turns}`;
      },
    });
    const t = env.pipe.createTicket({ title: "t", body: "b", requester: "lilei", kind: "simple" });
    await settle(env);
    env.pipe.postMessage(t.id, "lilei", "web", "再改一下");
    await settle(env);
    const rows = env.store.mergeProposals.listRecent().filter((r) => r.ticket_id === t.id);
    expect(rows.map((r) => r.status)).toEqual(["ci_pending", "superseded"]);
    expect(env.published).toHaveLength(2);
  });

  it("proposalApplied recognises an ancestor and a cherry-picked range", async () => {
    const env = await makeEnv({ lane: "direct", onTurn: async () => "x" });
    const base = await gitOrThrow(env.repo, ["rev-parse", "main"]);
    const wt = join(env.dir, "cand");
    await gitOrThrow(env.repo, ["worktree", "add", "--detach", wt, "main"]);
    await commitWork(wt, "a.txt");
    const candidate = await gitOrThrow(wt, ["rev-parse", "HEAD"]);
    // Landing 1: the candidate itself fast-forwarded.
    expect((await env.pipe.proposalApplied({ sha: candidate, base_sha: base }, candidate)).applied).toBe(true);
    // Landing 2: the same patch replayed on a different parent.
    const other = join(env.dir, "other");
    await gitOrThrow(env.repo, ["worktree", "add", "--detach", other, "main"]);
    await commitWork(other, "unrelated.txt");
    await gitOrThrow(other, ["-c", "user.email=t@t", "-c", "user.name=t", "cherry-pick", candidate]);
    const landed = await gitOrThrow(other, ["rev-parse", "HEAD"]);
    const picked = await env.pipe.proposalApplied({ sha: candidate, base_sha: base }, landed);
    expect(picked.applied).toBe(true);
    // Landing 3: nothing of the candidate made it.
    const bare = await gitOrThrow(other, ["rev-parse", "HEAD~1"]);
    expect((await env.pipe.proposalApplied({ sha: candidate, base_sha: base }, bare)).applied).toBe(false);
  });
});
