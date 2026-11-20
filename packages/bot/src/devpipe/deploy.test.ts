import { describe, it, expect, afterEach, vi } from "vitest";
import { StartupIngress } from "./startup-ingress.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import type { DeployIntentRow } from "../store/repositories/dev-tickets.js";
import { DeployService, extractAcceptance, moduleOf, type DeployEvent, type DeployServiceOpts } from "./deploy.js";
import type { RunnerBundleDrainResult } from "./runner-bundle-delivery.js";
import { normalizeCliDeliveryTicketInput, normalizeDevTicketInput } from "./ticket-models.js";
import { gitOrThrow } from "./worktree.js";
import type { BuildWarmJoinResult } from "./build-warm.js";
import { assertKnowledgeDeployable } from "./knowledge-deploy.js";

// The real review runs (and returns early in these policy-less fixture repos)
// unless a test scripts one verdict.
vi.mock("./knowledge-deploy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./knowledge-deploy.js")>();
  return { ...actual, assertKnowledgeDeployable: vi.fn(actual.assertKnowledgeDeployable) };
});

describe("moduleOf / extractAcceptance", () => {
  it("maps files to coarse modules", () => {
    expect(moduleOf("packages/bot/src/dashboard/live.ts")).toBe("packages/bot");
    expect(moduleOf("plugins/sessions/src/scan.ts")).toBe("plugins/sessions");
    expect(moduleOf("doc/design.md")).toBe("doc/");
    expect(moduleOf("CLAUDE.md")).toBe("CLAUDE.md");
  });

  it("extracts the acceptance section, falls back to the whole spec", () => {
    expect(extractAcceptance("## 方案\nx\n\n## 验收标准\n- A\n- B")).toBe("- A\n- B");
    expect(extractAcceptance("just text")).toBe("just text");
  });
});

describe("DeployService", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  async function makeEnv(
    prepareTarget?: (sha: string) => Promise<BuildWarmJoinResult>,
    settleRunnerBundle?: (store: Store, intent: DeployIntentRow) => Promise<RunnerBundleDrainResult>,
    ingress?: StartupIngress,
    preparation: Partial<Pick<DeployServiceOpts, "releaseStatus" | "prewarmRelease" | "prepareRelease" | "publishApps">> = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), "deploysvc-"));
    const repo = join(dir, "repo");
    await gitOrThrow(dir, ["init", "-b", "trunk", repo]);
    writeFileSync(join(repo, "a.txt"), "v1\n");
    await gitOrThrow(repo, ["add", "."]);
    await gitOrThrow(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "v1"]);
    const v1 = await gitOrThrow(repo, ["rev-parse", "HEAD"]);
    await gitOrThrow(repo, ["branch", "stable", v1]);
    // trunk moves ahead (a gated ticket's merge)
    writeFileSync(join(repo, "packages"), ""); // placeholder file removed below
    rmSync(join(repo, "packages"));
    writeFileSync(join(repo, "b.txt"), "v2\n");
    await gitOrThrow(repo, ["add", "."]);
    await gitOrThrow(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "v2 ticket work"]);
    const v2 = await gitOrThrow(repo, ["rev-parse", "HEAD"]);
    // detached checkout so neither trunk nor stable is busy
    await gitOrThrow(repo, ["checkout", "--detach", v1]);

    const store = new Store(":memory:");
    store.saveUser({ username: "alice", uid: 1, home_dir: "/x", created_at: "2026-07-25T00:00:00.000Z" });
    const t = store.devTickets.createDevTicket(normalizeDevTicketInput({ title: "Add b", body: "b", requester: "alice" }));
    store.devTickets.updateDevTicket(t.id, {
      dev_status: "landed",
      deploy_status: "pending",
      spec: "## 方案\nx\n\n## 验收标准\n- b.txt 存在",
      session_id: "sess-t1",
      worktree: "/wt/ticket-1",
      commit_sha: v2,
    });

    const events: DeployEvent[] = [];
    const rescueSnapshots: Array<{ activeIntent: boolean }> = [];
    const svc = new DeployService({
      ...preparation,
      store,
      repoDir: repo,
      ingress,
      baseBranch: "trunk",
      runTreeDir: "/run/tree",
      supervisorLog: "/run/supervisor.log",
      backupsDir: "/run/backups",
      ...(prepareTarget ? { prepareTarget } : {}),
      ...(settleRunnerBundle ? {
        settleRunnerBundle: (intent) => settleRunnerBundle(store, intent),
      } : {}),
      notify: async (ev) => {
        if (ev.kind === "rescue") rescueSnapshots.push({ activeIntent: Boolean(store.devTickets.getActiveDeployIntent()) });
        events.push(ev);
      },
    });
    cleanups.push(() => {
      svc.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    return { repo, store, svc, events, rescueSnapshots, ticket: t, v1, v2 };
  }

  it("warms the exact watermark without deploying and refuses activation until staging is ready", async () => {
    const prewarmRelease = vi.fn(async () => {});
    let ready = false;
    const releaseStatus = vi.fn(async (sha: string) => ({ sha, state: ready ? "ready" : "receiving" }));
    const f = await makeEnv(undefined, undefined, undefined, { prewarmRelease, releaseStatus });
    await f.svc.pollOnce();
    await vi.waitFor(() => expect(prewarmRelease).toHaveBeenCalledWith(f.v2));
    expect(f.store.devTickets.getActiveDeployIntent()).toBeUndefined();
    expect((await f.svc.preparationStatus())?.state).toBe("receiving");
    await expect(f.svc.trigger("alice")).rejects.toThrow(/暂存/);
    expect(f.events).toEqual([]);
    ready = true;
    expect((await f.svc.trigger("alice")).target_sha).toBe(f.v2);
  });

  it("trigger: rescue card goes out BEFORE the intent exists; tickets → deploying", async () => {
    const { store, svc, events, rescueSnapshots, ticket, v2 } = await makeEnv();
    const intent = await svc.trigger("alice");
    expect(intent.target_sha).toBe(v2);
    expect(rescueSnapshots).toEqual([{ activeIntent: false }]); // card first, row second
    const rescue = events.find((e) => e.kind === "rescue") as Extract<DeployEvent, { kind: "rescue" }>;
    expect(rescue.text).toContain("#" + ticket.id);
    expect(rescue.text).toContain("sess-t1");
    expect(rescue.text).toContain("/run/supervisor.log");
    expect(store.devTickets.getDevTicket(ticket.id)!.deploy_status).toBe("deploying");
    await expect(svc.trigger("alice")).rejects.toThrow(/进行中/);
  }, 15_000);

  it("refuses deployment before creating an intent when the independent ingress is missing", async () => {
    const ingress = new StartupIngress("/unused", "https://example.com");
    vi.spyOn(ingress, "check").mockResolvedValue({ ready: false, reason: "ingress missing" });
    const { store, svc, ticket, events } = await makeEnv(undefined, undefined, ingress);
    await expect(svc.trigger("alice")).rejects.toThrow("ingress missing");
    expect(store.devTickets.getActiveDeployIntent()).toBeUndefined();
    expect(store.devTickets.getDevTicket(ticket.id)?.deploy_status).toBe("pending");
    expect(events).toEqual([]);
  });

  it("keeps product acceptance open if ingress delivery is lost after deployment", async () => {
    const env = await makeEnv();
    const intent = await env.svc.trigger("alice");
    env.store.devTickets.updateDeployIntent(intent.id, { status: "succeeded", base_sha: env.v1 });
    await env.svc.pollOnce();
    const verify = env.store.devTickets.getOpenVerifyBlock()!;
    const ingress = new StartupIngress(env.repo, "https://example.com");
    const check = vi.spyOn(ingress, "check").mockResolvedValue({ ready: false, reason: "observer stale" });
    const restarted = new DeployService({ store: env.store, repoDir: env.repo, baseBranch: "trunk", ingress });
    cleanups.push(() => restarted.stop());
    await expect(restarted.resolveVerify(verify.id, "passed", "alice")).rejects.toThrow("observer stale");
    expect(check).toHaveBeenCalledWith(env.v1, true);
    expect(env.store.devTickets.getVerifyTicket(verify.id)?.status).toBe("open");
    expect(env.store.devTickets.getDevTicket(env.ticket.id)?.deploy_status).toBe("live_unverified");
    expect(await restarted.runningSha()).toBe(env.v1);
    await gitOrThrow(env.repo, ["checkout", "--detach", env.v2]);
    expect(await restarted.runningSha()).toBe(env.v1); // Disk can move before the old process exits.
  });

  it("joins an in-flight warm before exposing the deploy intent", async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preparing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const env = await makeEnv(async (sha) => {
      started();
      await gate;
      return { sha, ready: true, joined: true, waitedMs: 12, outcome: { ok: true, sha, ms: 34 } };
    });

    const triggering = env.svc.trigger("alice");
    await preparing;
    expect(env.store.devTickets.getActiveDeployIntent()).toBeUndefined();
    expect(env.events).toEqual([]);
    release();

    await expect(triggering).resolves.toMatchObject({ target_sha: env.v2 });
    expect(env.events[0]).toMatchObject({ kind: "rescue" });
  });

  it("keeps the normal deploy path when build preparation fails", async () => {
    const env = await makeEnv(async () => {
      throw new Error("warm tree disappeared");
    });
    await expect(env.svc.trigger("alice")).resolves.toMatchObject({ target_sha: env.v2 });
    expect(env.store.devTickets.getActiveDeployIntent()).not.toBeNull();
  });

  it("does not fold App-only tickets into a trusted-code deployment", async () => {
    const env = await makeEnv();
    const app = env.store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "App-only",
      body: "view bytes",
      requester: "alice",
      kind: "app",
      app_id: "session-plus",
    }));
    env.store.devTickets.updateDevTicket(app.id, {
      dev_status: "landed",
      deploy_status: "pending",
      commit_sha: env.v2,
    });

    const intent = await env.svc.trigger("alice");

    expect(env.store.devTickets.getDevTicket(env.ticket.id)?.deploy_status).toBe("deploying");
    expect(env.store.devTickets.getDevTicket(app.id)?.deploy_status).toBe("pending");
    env.store.devTickets.updateDeployIntent(intent.id, { status: "succeeded", base_sha: env.v1 });
    await env.svc.pollOnce();
    const verify = (env.events.find((event) => event.kind === "deploy_result") as Extract<DeployEvent, { kind: "deploy_result" }>).verify!;
    expect(JSON.parse(verify.ticket_ids)).not.toContain(app.id);
  }, 20_000);

  it("uses the submit declaration rather than the historical filing kind", async () => {
    const env = await makeEnv();
    const appOnly = env.store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "multi-App",
      body: "shared view bytes",
      requester: "alice",
      kind: "simple",
    }));
    env.store.devTickets.updateDevTicket(appOnly.id, {
      dev_status: "landed",
      deploy_status: "pending",
      delivery_mode: "app_releases",
      delivery_apps: '["ppt-studio","showcase"]',
      commit_sha: env.v2,
    });
    const trusted = env.store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "trusted legacy-kind row",
      body: "bot change",
      requester: "alice",
      kind: "app",
      app_id: "session-plus",
    }));
    env.store.devTickets.updateDevTicket(trusted.id, {
      dev_status: "landed",
      deploy_status: "pending",
      delivery_mode: "full_deploy",
      delivery_apps: "[]",
      commit_sha: env.v2,
    });

    await env.svc.trigger("alice");

    expect(env.store.devTickets.getDevTicket(appOnly.id)?.deploy_status).toBe("pending");
    expect(env.store.devTickets.getDevTicket(trusted.id)?.deploy_status).toBe("deploying");
  }, 20_000);

  it("confirm_wait requests confirmation once; success finalizes into a verify ticket", async () => {
    const { store, svc, events, ticket, v1, v2 } = await makeEnv();
    const intent = await svc.trigger("alice");

    // Simulate the supervisor walking the intent.
    store.devTickets.updateDeployIntent(intent.id, { status: "confirm_wait", base_sha: v1 });
    await svc.pollOnce();
    await svc.pollOnce();
    expect(events.filter((e) => e.kind === "confirm_request")).toHaveLength(1);

    expect(svc.decide(intent.id, "alive", "bob")).toBe(true);
    store.devTickets.updateDeployIntent(intent.id, { status: "succeeded" });
    await svc.pollOnce();

    const result = events.find((e) => e.kind === "deploy_result") as Extract<DeployEvent, { kind: "deploy_result" }>;
    expect(result.verify).toBeTruthy();
    const v = result.verify!;
    expect(JSON.parse(v.ticket_ids)).toEqual([ticket.id]);
    expect(JSON.parse(v.modules_touched)).toContain("b.txt");
    expect(JSON.parse(v.checklist)[0].criteria).toBe("- b.txt 存在");
    expect(JSON.parse(v.assignees)).toEqual(["alice"]);
    expect(store.devTickets.getDevTicket(ticket.id)!.deploy_status).toBe("live_unverified");
    expect(store.devTickets.getDeployIntent(intent.id)!.notified).toBe(1);

    // Product acceptance verifies the ticket; CI owns the stable watermark.
    const resolved = await svc.resolveVerify(v.id, "passed", "alice", "都好");
    expect(resolved.status).toBe("passed");
    expect(store.devTickets.getDevTicket(ticket.id)!.deploy_status).toBe("verified");
  }, 20_000);

  it("a tier-3 knowledge verdict refuses the deployment before any intent exists", async () => {
    const env = await makeEnv();
    vi.mocked(assertKnowledgeDeployable).mockRejectedValueOnce(new Error("知识裁决阻止上线：required_record_changed:x"));
    await expect(env.svc.trigger("alice")).rejects.toThrow(/知识裁决阻止上线/);
    expect(env.store.devTickets.getActiveDeployIntent()).toBeUndefined();
    expect(env.events).toEqual([]);
    expect(env.store.devTickets.getDevTicket(env.ticket.id)!.deploy_status).toBe("pending");
  }, 20_000);

  it("an unavailable knowledge review does not block the deployment and is recorded on it", async () => {
    const env = await makeEnv();
    vi.mocked(assertKnowledgeDeployable).mockImplementationOnce(async (input) => { input.onUnavailable?.("Runner offline"); });
    const intent = await env.svc.trigger("alice");
    expect(intent.detail).toContain("知识审查未能运行(Runner offline)");
    expect(env.store.devTickets.getDeployIntent(intent.id)?.detail).toBe(intent.detail);
    const rescue = env.events.find((event) => event.kind === "rescue") as Extract<DeployEvent, { kind: "rescue" }>;
    expect(rescue.text).toContain("知识审查未能运行");
    expect(env.store.devTickets.getDevTicket(env.ticket.id)!.deploy_status).toBe("deploying");
  }, 20_000);

  it("includes every pending ticket in a deployment, however long the ticket list is", async () => {
    const env = await makeEnv();
    // More newer, already-verified landings than the panel's first page holds.
    for (let i = 0; i < 201; i++) {
      const done = env.store.devTickets.createDevTicket(normalizeDevTicketInput({ title: `done ${i}`, body: "b", requester: "alice" }));
      env.store.devTickets.updateDevTicket(done.id, {
        dev_status: "landed",
        deploy_status: "verified",
        landed_at: "2026-10-01T00:00:00.000Z",
      });
    }
    await env.svc.trigger("alice");
    expect(env.store.devTickets.getDevTicket(env.ticket.id)!.deploy_status).toBe("deploying");
  }, 20_000);

  it("publishes App debt only while no deployment is in flight", async () => {
    const publishApps = vi.fn(async () => {});
    const env = await makeEnv(undefined, undefined, undefined, { publishApps });
    const intent = await env.svc.trigger("alice");
    for (const status of ["requested", "building", "restarting", "health_gate"]) {
      env.store.devTickets.updateDeployIntent(intent.id, { status });
      await env.svc.pollOnce();
    }
    // The new process has not passed its health gate: a rollback must not
    // leave Apps on packages built for it.
    expect(publishApps).not.toHaveBeenCalled();

    env.store.devTickets.updateDeployIntent(intent.id, { status: "succeeded", base_sha: env.v1 });
    await env.svc.pollOnce();
    expect(publishApps).toHaveBeenCalledTimes(1);
    expect(env.store.devTickets.getDeployIntent(intent.id)?.notified).toBe(1);
  }, 20_000);

  it("keeps a ticket pending when its Runner artifact debt was not settled", async () => {
    const env = await makeEnv();
    const intent = await env.svc.trigger("alice");
    env.store.runnerArtifacts.recordPending({
      ticket_id: env.ticket.id,
      commit_sha: env.v2,
      requested_by: "test",
      requested_at: "2026-08-29T00:00:00.000Z",
    });
    env.store.devTickets.updateDeployIntent(intent.id, { status: "succeeded", base_sha: env.v1 });

    await env.svc.pollOnce();

    expect(env.store.devTickets.getDevTicket(env.ticket.id)?.deploy_status).toBe("pending");
    const result = env.events.find((event) => event.kind === "deploy_result") as Extract<DeployEvent, { kind: "deploy_result" }>;
    expect(JSON.parse(result.verify!.ticket_ids)).not.toContain(env.ticket.id);
  }, 20_000);

  it("settles Runner debt only after the supervisor health gate succeeds", async () => {
    let calls = 0;
    const env = await makeEnv(undefined, async (store, succeededIntent) => {
      calls += 1;
      expect(succeededIntent.status).toBe("succeeded");
      expect(store.runnerArtifacts.clearIf(env.ticket.id, env.v2)).toBe(true);
      return {
        ok: true,
        targetCommit: env.v2,
        candidateSha: "a".repeat(64),
        activeSha: "a".repeat(64),
        coveredTicketIds: [env.ticket.id],
        remainingTicketIds: [],
        outcome: "activated",
      };
    });
    const intent = await env.svc.trigger("alice");
    env.store.runnerArtifacts.recordPending({
      ticket_id: env.ticket.id,
      commit_sha: env.v2,
      requested_by: "test",
      requested_at: "2026-08-29T00:00:00.000Z",
    });
    env.store.devTickets.updateDeployIntent(intent.id, { status: "confirm_wait", base_sha: env.v1 });

    await env.svc.pollOnce();
    expect(calls).toBe(0);
    expect(env.store.runnerArtifacts.listPending()).toHaveLength(1);

    env.store.devTickets.updateDeployIntent(intent.id, { status: "succeeded" });
    await env.svc.pollOnce();

    expect(calls).toBe(1);
    expect(env.store.runnerArtifacts.listPending()).toEqual([]);
    expect(env.store.devTickets.getDevTicket(env.ticket.id)?.deploy_status).toBe("live_unverified");
    const result = env.events.find((event) => event.kind === "deploy_result") as Extract<DeployEvent, { kind: "deploy_result" }>;
    expect(JSON.parse(result.verify!.ticket_ids)).toContain(env.ticket.id);
  }, 20_000);

  it("refuses product acceptance if Runner debt appears before verification", async () => {
    const env = await makeEnv();
    const intent = await env.svc.trigger("alice");
    env.store.devTickets.updateDeployIntent(intent.id, { status: "succeeded", base_sha: env.v1 });
    await env.svc.pollOnce();
    const verify = (env.events.find((event) => event.kind === "deploy_result") as Extract<DeployEvent, { kind: "deploy_result" }>).verify!;
    env.store.runnerArtifacts.recordPending({
      ticket_id: env.ticket.id,
      commit_sha: env.v2,
      requested_by: "test",
      requested_at: "2026-08-29T00:00:00.000Z",
    });

    await expect(env.svc.resolveVerify(verify.id, "passed", "alice")).rejects.toThrow(/Runner bundle/);
    expect(env.store.devTickets.getVerifyTicket(verify.id)?.status).toBe("open");
    expect(env.store.devTickets.getDevTicket(env.ticket.id)?.deploy_status).toBe("live_unverified");
  }, 20_000);

  it("carries CLI report acceptance through deploy and product verification", async () => {
    const env = await makeEnv();
    const cli = env.store.devTickets.createCliDeliveryTicket(normalizeCliDeliveryTicketInput({
      title: "CLI architecture detail",
      body: "summary",
      spec: "## 验收标准\n- 点击节点显示详情",
      requester: "alice",
      branch: "dev/architecture",
      commit_sha: "d".repeat(40),
    }));

    const intent = await env.svc.trigger("alice");
    env.store.devTickets.updateDeployIntent(intent.id, { status: "succeeded", base_sha: env.v1 });
    await env.svc.pollOnce();
    const verify = (env.events.find((event) => event.kind === "deploy_result") as Extract<DeployEvent, { kind: "deploy_result" }>).verify!;
    expect(JSON.parse(verify.ticket_ids)).toContain(cli.id);
    expect(JSON.parse(verify.checklist)).toContainEqual({
      ticket_id: cli.id,
      title: cli.title,
      criteria: "- 点击节点显示详情",
    });
    expect(env.store.devTickets.getDevTicket(cli.id)?.deploy_status).toBe("live_unverified");
    await env.svc.resolveVerify(verify.id, "passed", "alice");
    expect(env.store.devTickets.getDevTicket(cli.id)?.deploy_status).toBe("verified");
  }, 20_000);

  it("adopts a CLI report projected by the new process into the active deploy", async () => {
    const env = await makeEnv();
    const intent = await env.svc.trigger("alice");

    // The old process created the intent before it knew how to project CLI
    // reports. The restarted process imports this row from the target commit.
    const cli = env.store.devTickets.createCliDeliveryTicket(normalizeCliDeliveryTicketInput({
      title: "Late CLI report",
      body: "summary",
      spec: "## 验收标准\n- 出现在本次验收单",
      requester: "alice",
      branch: "trunk",
      commit_sha: env.v2,
    }));
    expect(env.store.devTickets.getDevTicket(cli.id)?.deploy_status).toBe("pending");

    await expect(env.svc.reconcilePendingTicketsForActiveDeploy()).resolves.toEqual([cli.id]);
    expect(env.store.devTickets.getDevTicket(cli.id)?.deploy_status).toBe("deploying");

    env.store.devTickets.updateDeployIntent(intent.id, { status: "succeeded", base_sha: env.v1 });
    await env.svc.pollOnce();
    const verify = (env.events.find((event) => event.kind === "deploy_result") as Extract<DeployEvent, { kind: "deploy_result" }>).verify!;
    expect(JSON.parse(verify.ticket_ids)).toContain(cli.id);
    expect(env.store.devTickets.getDevTicket(cli.id)?.deploy_status).toBe("live_unverified");
  }, 20_000);

  it("product acceptance does not forge a CI green; rollback returns tickets to pending", async () => {
    const env = await makeEnv();
    const intent = await env.svc.trigger("alice");
    env.store.devTickets.updateDeployIntent(intent.id, { status: "confirm_wait", base_sha: env.v1 });
    env.store.devTickets.updateDeployIntent(intent.id, { status: "succeeded" });
    await env.svc.pollOnce();
    const verify = (env.events.find((e) => e.kind === "deploy_result") as Extract<DeployEvent, { kind: "deploy_result" }>).verify!;
    await env.svc.resolveVerify(verify.id, "passed", "alice");
    expect(await gitOrThrow(env.repo, ["rev-parse", "stable"])).toBe(env.v1);
    await expect(env.svc.resolveVerify(verify.id, "failed", "bob")).rejects.toThrow(/已判定/);

    // Second deploy that rolls back: ticket axis returns to pending.
    const t2 = env.store.devTickets.createDevTicket(normalizeDevTicketInput({ title: "T2", body: "b", requester: "alice" }));
    env.store.devTickets.updateDevTicket(t2.id, { dev_status: "landed", deploy_status: "pending" });
    const intent2 = await env.svc.trigger("alice");
    expect(env.store.devTickets.getDevTicket(t2.id)!.deploy_status).toBe("deploying");
    env.store.devTickets.updateDeployIntent(intent2.id, { status: "rolled_back", detail: "confirm_timeout" });
    await env.svc.pollOnce();
    expect(env.store.devTickets.getDevTicket(t2.id)!.deploy_status).toBe("pending");
  }, 20_000);

  it("one acceptance resolves all deployments visible in its aggregate snapshot", async () => {
    const env = await makeEnv();
    env.store.saveUser({ username: "bob", uid: 2, home_dir: "/x", created_at: "2026-07-25T00:00:00.000Z" });
    const older = env.store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "Older live change", body: "old", requester: "bob",
    }));
    env.store.devTickets.updateDevTicket(older.id, { dev_status: "landed", deploy_status: "live_unverified" });
    const oldIntent = env.store.devTickets.createDeployIntent({ target_sha: env.v1, triggered_by: "bob" });
    env.store.devTickets.updateDeployIntent(oldIntent.id, { status: "succeeded", notified: 1 });
    const oldVerify = env.store.devTickets.createVerifyTicket({
      intent_id: oldIntent.id,
      target_sha: env.v1,
      ticket_ids: [older.id],
      modules_touched: ["packages/older"],
      checklist: [{ ticket_id: older.id, title: older.title, criteria: "old works" }],
      assignees: ["bob"],
    });

    const intent = await env.svc.trigger("alice");
    env.store.devTickets.updateDeployIntent(intent.id, { status: "succeeded", base_sha: env.v1 });
    await env.svc.pollOnce();
    const block = env.store.devTickets.getOpenVerifyBlock()!;
    expect(block.id).toBeGreaterThan(oldVerify.id);
    expect(block.deployment_count).toBe(2);

    const resolved = await env.svc.resolveVerify(block.id, "passed", "alice");
    expect(resolved.deployment_count).toBe(2);
    expect(env.store.devTickets.getVerifyTicket(oldVerify.id)?.status).toBe("passed");
    expect(env.store.devTickets.getDevTicket(older.id)?.deploy_status).toBe("verified");
    expect(env.store.devTickets.getDevTicket(env.ticket.id)?.deploy_status).toBe("verified");
  }, 20_000);

  it("deploy rights must be granted — config list or /admin, never by default", async () => {
    const { store } = await makeEnv();
    const svc = new DeployService({ store, repoDir: "/nowhere", baseBranch: "trunk", deployers: ["alice"] });
    expect(svc.mayDeploy("alice", false)).toBe(true);
    expect(svc.mayDeploy("bob", false)).toBe(false);
    expect(svc.mayDeploy("bob", true)).toBe(true);

    // Ticket #15: an empty list used to mean "everyone", so a host that never
    // configured deployers let any registered user restart production and
    // fast-forward the base branch. It now means what it says: nobody.
    const unset = new DeployService({ store, repoDir: "/nowhere", baseBranch: "trunk" });
    expect(unset.mayDeploy("bob", false)).toBe(false);

    // Web grants reach the Feishu door too, so the two cannot disagree.
    store.grantCapability("bob", "deploy", "lht", new Date().toISOString());
    expect(unset.mayDeploy("bob", false)).toBe(true);
    store.revokeCapability("bob", "deploy");
    expect(unset.mayDeploy("bob", false)).toBe(false);
  });
});
