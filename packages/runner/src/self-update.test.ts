import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  UPDATE_EXIT_CODE,
  bundleFrameFrom,
  fileSha256,
  managedBundlePath,
  previousBundlePath,
  selfUpdateSettings,
  sha256Hex,
  stageBundle,
  superviseManagedRunner,
} from "./self-update.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "runner-update-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function frameFor(text: string) {
  const bytes = Buffer.from(text, "utf8");
  return { sha: sha256Hex(bytes), size: bytes.length, data: bytes.toString("base64") };
}

describe("self-update settings", () => {
  it("defaults to enabled and unsupervised", () => {
    expect(selfUpdateSettings({})).toEqual({ enabled: true, supervised: false });
  });
  it("honours the opt-out and the supervised flag", () => {
    expect(selfUpdateSettings({ RUNNER_SELF_UPDATE: "0", OCTOPUS_RUNNER_SUPERVISED: "1" }))
      .toEqual({ enabled: false, supervised: true });
  });
});

describe("bundle frames", () => {
  it("accepts a well-formed frame and rejects malformed ones", () => {
    const good = frameFor("console.log('hi')");
    expect(bundleFrameFrom(good)).toEqual(good);
    expect(bundleFrameFrom({ ...good, sha: "nothex" })).toBeNull();
    expect(bundleFrameFrom({ ...good, size: 0 })).toBeNull();
    expect(bundleFrameFrom({ ...good, data: "" })).toBeNull();
  });
});

describe("stageBundle", () => {
  it("installs a verified bundle at the managed path and keeps one previous copy", () => {
    const first = stageBundle(home, frameFor("v1"));
    expect(first.path).toBe(managedBundlePath(home));
    expect(readFileSync(first.path, "utf8")).toBe("v1");
    expect(fileSha256(first.path)).toBe(first.sha);
    expect(existsSync(previousBundlePath(home))).toBe(false);

    const second = stageBundle(home, frameFor("v2"));
    expect(readFileSync(second.path, "utf8")).toBe("v2");
    expect(readFileSync(previousBundlePath(home), "utf8")).toBe("v1");
  });

  it("refuses a sha mismatch and leaves the managed path untouched", () => {
    stageBundle(home, frameFor("good"));
    const bad = { ...frameFor("evil"), sha: sha256Hex("something else") };
    expect(() => stageBundle(home, bad)).toThrow(/sha mismatch/);
    expect(readFileSync(managedBundlePath(home), "utf8")).toBe("good");
    expect(existsSync(previousBundlePath(home))).toBe(false);
  });

  it("refuses a size mismatch", () => {
    const bad = { ...frameFor("abc"), size: 2 };
    expect(() => stageBundle(home, bad)).toThrow(/size mismatch/);
    expect(existsSync(managedBundlePath(home))).toBe(false);
  });

  it("preserves the installed running file and a fallback already running from previous", () => {
    const installed = stageBundle(home, frameFor("good"));
    const bad = stageBundle(home, frameFor("bad"), { file: installed.path, sha: installed.sha });
    expect(bad.fallback).toBe(previousBundlePath(home));
    expect(readFileSync(bad.fallback!, "utf8")).toBe("good");
    const fixed = stageBundle(home, frameFor("fixed"), { file: bad.fallback!, sha: installed.sha });
    expect(readFileSync(fixed.path, "utf8")).toBe("fixed");
    expect(readFileSync(fixed.fallback!, "utf8")).toBe("good");
  });

  it("refuses a stale running digest before replacing either file", () => {
    const old = stageBundle(home, frameFor("old"));
    writeFileSync(old.path, "externally replaced");
    expect(() => stageBundle(home, frameFor("next"), { file: old.path, sha: old.sha })).toThrow(/safe rollback/);
    expect(readFileSync(old.path, "utf8")).toBe("externally replaced");
  });
});

describe("fileSha256", () => {
  it("returns null for an unreadable file", () => {
    expect(fileSha256(path.join(home, "missing.js"))).toBeNull();
    const f = path.join(home, "x.js");
    writeFileSync(f, "x");
    expect(fileSha256(f)).toBe(sha256Hex("x"));
  });
});

/** A scripted child: each spawn consumes the next {code, afterMs} and "exits". */
function fakeSpawn(script: Array<{ code: number; afterMs?: number }>, seen: string[][]) {
  return ((cmd: string, args: readonly string[], options: { env?: Record<string, string | undefined> }) => {
    const step = script.shift() ?? { code: 0 };
    seen.push([cmd, ...args, `SUPERVISED=${options.env?.OCTOPUS_RUNNER_SUPERVISED ?? ""}`, `SELF_UPDATE=${options.env?.RUNNER_SELF_UPDATE ?? ""}`]);
    const child = new EventEmitter();
    setTimeout(() => child.emit("exit", step.code, null), step.afterMs ?? 5);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
}

describe("superviseManagedRunner", () => {
  const base = { managed: "/m/standalone.js", fallback: "/orig/index.js", argv: ["--x"], env: { A: "1" }, execPath: "node", log: () => {} };

  it("respawns the managed bundle after an update exit and returns a normal exit code", async () => {
    const seen: string[][] = [];
    const code = await superviseManagedRunner({
      ...base,
      fastFailureMs: 1,
      spawnImpl: fakeSpawn([{ code: UPDATE_EXIT_CODE }, { code: 0 }], seen),
    });
    expect(code).toBe(0);
    expect(seen).toEqual([
      ["node", "/m/standalone.js", "--x", "SUPERVISED=1", "SELF_UPDATE="],
      ["node", "/m/standalone.js", "--x", "SUPERVISED=1", "SELF_UPDATE="],
    ]);
  });

  it("falls back to its own original file, self-update off, when the new bundle dies fast", async () => {
    const seen: string[][] = [];
    const code = await superviseManagedRunner({
      ...base,
      fastFailureMs: 10_000,
      spawnImpl: fakeSpawn([{ code: 1, afterMs: 5 }, { code: 3 }], seen),
    });
    expect(code).toBe(3);
    expect(seen[1]).toEqual(["node", "/orig/index.js", "--x", "SUPERVISED=1", "SELF_UPDATE=0"]);
  });

  it("treats a late failure as the runner's own exit, not a bad bundle", async () => {
    const seen: string[][] = [];
    const code = await superviseManagedRunner({
      ...base,
      fastFailureMs: 1,
      spawnImpl: fakeSpawn([{ code: 2, afterMs: 20 }], seen),
    });
    expect(code).toBe(2);
    expect(seen).toHaveLength(1);
  });

  it.each(["SIGTERM", "SIGINT"])("forwards %s to the owned child without rollback or respawn", async (signal) => {
    const signals = new EventEmitter();
    const killed: string[] = [];
    let spawns = 0;
    const child = Object.assign(new EventEmitter(), {
      kill: (value: string) => {
        killed.push(value);
        queueMicrotask(() => child.emit("exit", null, value));
        return true;
      },
    });
    const running = superviseManagedRunner({
      ...base, signalSource: signals,
      spawnImpl: (() => { spawns++; return child; }) as unknown as typeof import("node:child_process").spawn,
    });
    signals.emit(signal);
    expect(await running).toBe(0);
    expect(killed).toEqual([signal]);
    expect(spawns).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("restores the installed file after a fast crash and quarantines only that digest", async () => {
    stageBundle(home, frameFor("good"));
    const bad = stageBundle(home, frameFor("bad"));
    const seen: Array<{ entry: string; rejected: string | undefined; disabled: string | undefined; shim: string | undefined }> = [];
    const code = await superviseManagedRunner({
      ...base, managed: bad.path, fallback: bad.fallback!,
      spawnImpl: ((_cmd: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        seen.push({ entry: args![0], rejected: options!.env?.RUNNER_SELF_UPDATE_REJECTED_SHA,
          disabled: options!.env?.RUNNER_SELF_UPDATE, shim: options!.env?.OCTOPUS_RUNNER_UPDATE_SHIM });
        const child = new EventEmitter();
        setTimeout(() => child.emit("exit", seen.length === 1 ? 1 : 0, null), 1);
        return child;
      }) as unknown as typeof import("node:child_process").spawn,
    });
    expect(code).toBe(0);
    expect(readFileSync(bad.path, "utf8")).toBe("good");
    expect(seen[1]).toMatchObject({ entry: bad.fallback, rejected: bad.sha, disabled: undefined, shim: "1" });
  });
});
