import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runnerBundleProtocolBanner } from "@claude-bot/runner/gateway-protocol";
import { RunnerBundleRegistry } from "./bundle-registry.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

let dir: string;
let root: string;

function artifact(body: string): Buffer {
  return Buffer.from(`${runnerBundleProtocolBanner()}\n${body}`, "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "runner-bundles-"));
  root = path.join(dir, "registry");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("RunnerBundleRegistry", () => {
  it("keeps atomic active and previous pointers and observes external activation", () => {
    const serving = new RunnerBundleRegistry(root);
    const first = serving.activate(artifact("first"), "test:first", new Date("2026-08-27T10:00:00.000Z"));
    expect(first).toMatchObject({ ok: true, previousSha: null, activatedBy: "test:first" });

    const operator = new RunnerBundleRegistry(root);
    const second = operator.activate(artifact("second"), "test:second", new Date("2026-08-27T11:00:00.000Z"));
    expect(second).toMatchObject({ ok: true, previousSha: first.activeSha, activatedBy: "test:second" });
    expect(serving.active()?.sha).toBe(second.activeSha);

    const rolledBack = operator.rollback("test:rollback", new Date("2026-08-27T12:00:00.000Z"));
    expect(rolledBack).toMatchObject({
      ok: true,
      activeSha: first.activeSha,
      previousSha: second.activeSha,
      activatedBy: "test:rollback",
    });
    expect(serving.active()?.bytes.equals(artifact("first"))).toBe(true);
  });

  it("rejects a candidate without the exact gateway protocol marker", () => {
    const registry = new RunnerBundleRegistry(root);
    const active = registry.activate(artifact("compatible"), "test").activeSha;
    expect(() => registry.activate(Buffer.from("console.log('unversioned')"), "test"))
      .toThrow(/gateway protocol is incompatible/);
    expect(registry.active()?.sha).toBe(active);
  });

  it("rejects syntactically invalid JavaScript without moving active", () => {
    const registry = new RunnerBundleRegistry(root);
    const active = registry.activate(artifact("const healthy = true;"), "test").activeSha;
    expect(() => registry.activate(artifact("const = ;"), "test")).toThrow(/syntax check failed/);
    expect(registry.active()?.sha).toBe(active);
  });

  it("automatically rolls back when the active digest fails health validation", () => {
    const registry = new RunnerBundleRegistry(root);
    const first = registry.activate(artifact("healthy"), "test:first").activeSha!;
    const broken = registry.activate(artifact("later"), "test:later").activeSha!;
    writeFileSync(path.join(root, "objects", `${broken}.js`), artifact("corrupted after activation"));

    expect(registry.active()?.sha).toBe(first);
    expect(registry.health()).toMatchObject({
      ok: true,
      activeSha: first,
      previousSha: broken,
      activatedBy: "automatic:health-rollback",
      lastFailure: { sha: broken },
    });
  });

  it.each(["ETIMEDOUT", "EAGAIN", "SIGKILL", "no_exit"] as const)(
    "preserves the publication and retries health after checker failure: %s",
    (failure) => {
      const registry = new RunnerBundleRegistry(root);
      const previous = registry.activate(artifact("old"), "test:old").activeSha;
      const current = registry.activate(artifact("current"), "test:current").activeSha;
      const statePath = path.join(root, "state.json");
      const before = readFileSync(statePath, "utf8");
      vi.mocked(spawnSync).mockReturnValueOnce({
        pid: 0, output: [], stdout: "", stderr: "", status: null,
        signal: failure === "SIGKILL" ? "SIGKILL" : null,
        ...(["ETIMEDOUT", "EAGAIN"].includes(failure)
          ? { error: Object.assign(new Error(`spawnSync node ${failure}`), { code: failure }) }
          : {}),
      });

      expect(registry.health()).toMatchObject({
        ok: false, activeSha: current, previousSha: previous,
        activatedBy: "test:current", error: expect.stringContaining("syntax check unavailable"),
      });
      expect(readFileSync(statePath, "utf8")).toBe(before);
      expect(registry.health()).toMatchObject({ ok: true, activeSha: current, previousSha: previous });
      expect(registry.active()?.sha).toBe(current);
    },
  );

  it("refuses activation when the syntax checker times out without replacing the publication", () => {
    const registry = new RunnerBundleRegistry(root);
    const active = registry.activate(artifact("old"), "test:old").activeSha;
    const statePath = path.join(root, "state.json");
    const before = readFileSync(statePath, "utf8");
    vi.mocked(spawnSync).mockReturnValueOnce({
      pid: 0, output: [], stdout: "", stderr: "", status: null, signal: "SIGTERM",
      error: Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" }),
    });
    expect(() => registry.activate(artifact("new"), "test:new")).toThrow(/syntax check unavailable/);
    expect(readFileSync(statePath, "utf8")).toBe(before);
    expect(registry.health()).toMatchObject({ ok: true, activeSha: active });
  });

  it("reuses successful syntax checks by digest while still detecting changed bytes", () => {
    const registry = new RunnerBundleRegistry(root);
    const previous = registry.activate(artifact("old"), "test:old").activeSha;
    const current = registry.activate(artifact("current"), "test:current").activeSha!;
    expect(registry.health()).toMatchObject({ ok: true, activeSha: current });
    const checks = vi.mocked(spawnSync).mock.calls.length;
    expect(registry.health()).toMatchObject({ ok: true, activeSha: current });
    expect(vi.mocked(spawnSync).mock.calls.length).toBe(checks);

    // Same-size bytes and a cached syntax verdict must not hide corruption.
    writeFileSync(path.join(root, "objects", `${current}.js`), artifact("changed"));
    expect(registry.health()).toMatchObject({
      ok: true, activeSha: previous, activatedBy: "automatic:health-rollback",
      lastFailure: { sha: current },
    });
  });

  it("imports the checkout seed only when no active pointer exists", () => {
    const seed = path.join(dir, "standalone.js");
    writeFileSync(seed, artifact("console.log('deployed once')"));
    const first = new RunnerBundleRegistry(root);
    const initialSha = first.initialize(seed).activeSha;

    writeFileSync(seed, artifact("console.log('new checkout must stay pending')"));
    const restarted = new RunnerBundleRegistry(root);
    expect(restarted.initialize(seed).activeSha).toBe(initialSha);
    expect(restarted.active()?.bytes.equals(artifact("console.log('deployed once')"))).toBe(true);
  });
});
