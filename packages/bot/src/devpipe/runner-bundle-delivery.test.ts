import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runnerBundleProtocolBanner } from "@claude-bot/runner/gateway-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { RunnerBundleRegistry } from "../runner/bundle-registry.js";
import { Store } from "../store/store.js";
import { normalizeDevTicketInput } from "./ticket-models.js";
import { RunnerBundleDelivery, runnerBundleInputsChanged } from "./runner-bundle-delivery.js";
import { gitOrThrow } from "./worktree.js";

function artifact(body: string): Buffer {
  return Buffer.from(`${runnerBundleProtocolBanner()}\n${body}\n`, "utf8");
}

describe("runnerBundleInputsChanged", () => {
  it("tracks bundle sources and dependency resolution without flagging tests/docs", () => {
    expect(runnerBundleInputsChanged(["packages/runner/src/index.ts"])).toBe(true);
    expect(runnerBundleInputsChanged(["plugins/sessions/src/scan.ts"])).toBe(true);
    expect(runnerBundleInputsChanged(["packages/runner/package.json"])).toBe(true);
    expect(runnerBundleInputsChanged(["packages/runner/tsup.config.ts"])).toBe(true);
    expect(runnerBundleInputsChanged(["plugins/sessions/tsup.config.ts"])).toBe(true);
    expect(runnerBundleInputsChanged(["pnpm-lock.yaml"])).toBe(true);
    expect(runnerBundleInputsChanged(["tsconfig.json"])).toBe(true);
    expect(runnerBundleInputsChanged(["packages/agent-sessions-contract/src/providers.ts"])).toBe(true);
    expect(runnerBundleInputsChanged(["packages/agent-sessions-contract/package.json"])).toBe(true);
    expect(runnerBundleInputsChanged(["packages/agent-sessions-contract/src/contract.test.ts"])).toBe(false);
    expect(runnerBundleInputsChanged(["packages/runner/src/index.test.ts", "packages/runner/README.md"])).toBe(false);
    expect(runnerBundleInputsChanged(["packages/bot/src/index.ts"])).toBe(false);
  });
});

describe("RunnerBundleDelivery", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function env(candidate: Buffer) {
    const dir = mkdtempSync(path.join(tmpdir(), "runner-delivery-"));
    cleanups.push(dir);
    const repo = path.join(dir, "repo");
    await gitOrThrow(dir, ["init", "-b", "v4", repo]);
    const bundlePath = path.join(repo, "packages/runner/dist/standalone.js");
    mkdirSync(path.dirname(bundlePath), { recursive: true });
    writeFileSync(bundlePath, candidate);
    await gitOrThrow(repo, ["add", "."]);
    await gitOrThrow(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "runner"]);
    const commit = await gitOrThrow(repo, ["rev-parse", "HEAD"]);
    const store = new Store(path.join(dir, "store.db"));
    store.saveUser({ username: "alice", uid: 1, home_dir: "/x", created_at: "t" });
    const ticket = store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "Runner bundle",
      body: "ship it",
      requester: "alice",
    }));
    store.devTickets.updateDevTicket(ticket.id, {
      dev_status: "landed",
      deploy_status: "deploying",
      commit_sha: commit,
    });
    store.runnerArtifacts.recordPending({
      ticket_id: ticket.id,
      commit_sha: commit,
      requested_by: "test",
      requested_at: "2026-08-29T00:00:00.000Z",
    });
    const registry = new RunnerBundleRegistry(path.join(dir, "registry"));
    registry.activate(artifact("console.log('old')"), "test:seed");
    const delivery = new RunnerBundleDelivery(store, repo, repo, registry);
    return { store, ticket, registry, delivery, commit };
  }

  it("activates the bundle from the deployed tree and clears only covered debt", async () => {
    const e = await env(artifact("console.log('new')"));
    const result = await e.delivery.activateDeployedPending("automatic:test");
    expect(result).toMatchObject({ ok: true, outcome: "activated", coveredTicketIds: [e.ticket.id], remainingTicketIds: [] });
    expect(e.registry.health().activeSha).toBe(result.candidateSha);
    expect(e.store.runnerArtifacts.listPending()).toEqual([]);
    expect(e.store.runnerArtifacts.listAudit(1)[0]).toMatchObject({
      target_commit: e.commit,
      outcome: "activated",
      actor: "automatic:test",
    });
    e.store.close();
  });

  it("keeps debt and records the failure when deployed bytes are invalid", async () => {
    const e = await env(Buffer.from("console.log('missing protocol')\n", "utf8"));
    const result = await e.delivery.activateDeployedPending("automatic:test");
    expect(result.outcome).toBe("failed");
    expect(result.remainingTicketIds).toEqual([e.ticket.id]);
    expect(e.store.runnerArtifacts.listPending()[0]).toMatchObject({
      ticket_id: e.ticket.id,
      last_error: expect.stringMatching(/protocol/i),
    });
    expect(e.store.runnerArtifacts.listAudit(1)[0]?.outcome).toBe("failed");
    e.store.close();
  });

  it("fails closed when the deployed checkout is not the succeeded intent target", async () => {
    const e = await env(artifact("console.log('new')"));
    const before = e.registry.health().activeSha;
    const expectedTarget = "0".repeat(40);

    const result = await e.delivery.activateDeployedPending("automatic:test", expectedTarget);

    expect(result).toMatchObject({
      ok: false,
      outcome: "failed",
      targetCommit: e.commit,
      coveredTicketIds: [e.ticket.id],
      remainingTicketIds: [e.ticket.id],
      error: expect.stringContaining(expectedTarget),
    });
    expect(e.registry.health().activeSha).toBe(before);
    expect(e.store.runnerArtifacts.listPending()[0]?.last_error).toContain(expectedTarget);
    expect(e.store.runnerArtifacts.listAudit(1)[0]).toMatchObject({
      target_commit: e.commit,
      outcome: "failed",
      actor: "automatic:test",
    });
    e.store.close();
  });
});
