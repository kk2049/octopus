import { describe, expect, it, vi } from "vitest";
import { readCodexModelsFromAppServer, codexAuthenticationAvailable, CodexAccountRouter, parseRunnerCodexAccounts, readCodexAccountRateLimitsFromAppServer } from "./codex-account-routing.js";

function accountServer(result: unknown) {
  return `
    import readline from "node:readline";
    let initialized = false;
    readline.createInterface({ input: process.stdin }).on("line", line => {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
      } else if (message.method === "initialized") {
        initialized = true;
      } else if (initialized && message.method === "account/read"
        && message.params?.refreshToken === false
        && process.env.CODEX_HOME === "/fixture/codex"
        && process.env.HOME === "/fixture/home") {
        process.stdout.write(JSON.stringify({ id: message.id, result: ${JSON.stringify(result)} }) + "\\n");
      }
    });
  `;
}

describe("native Codex authentication probe", () => {
  it.each([
    [{ account: null, requiresOpenaiAuth: false }, true],
    [{ account: { type: "apiKey" }, requiresOpenaiAuth: true }, true],
    [{ account: { type: "chatgpt", email: "private@example.test" }, requiresOpenaiAuth: true }, true],
    [{ account: null, requiresOpenaiAuth: true }, false],
    [{ account: { type: "unknown" }, requiresOpenaiAuth: true }, false],
    [{ account: { type: "apiKey" } }, false],
    [{ requiresOpenaiAuth: "false" }, false],
    [null, false],
    [[], false],
  ])("projects only availability from %j", async (result, available) => {
    await expect(codexAuthenticationAvailable({
      command: process.execPath,
      args: ["--input-type=module", "-e", accountServer(result)],
      env: { HOME: "/fixture/home", CODEX_HOME: "/wrong/home" },
      codexHome: "/fixture/codex", timeoutMs: 2_000,
    })).resolves.toBe(available);
  });

  it.each([
    ["process.stdout.write('private-invalid-json\\n'); process.stdin.resume()", "invalid JSON"],
    ["process.stdout.write(JSON.stringify({id:1,error:{message:'private-error'}})+'\\n'); process.stdin.resume()", "RPC initialize failed"],
    ["process.stderr.write('private-output'.repeat(1000)); process.stdin.resume()", "output limit"],
    ["process.stdin.resume()", "timed out"],
    ["process.exit(1)", "exited before"],
  ])("bounds failures without returning provider content", async (script, expected) => {
    await expect(codexAuthenticationAvailable({
      command: process.execPath, args: ["-e", script], env: {},
      timeoutMs: expected === "timed out" ? 100 : 2_000, maxOutputBytes: 1024,
    })).rejects.toThrow(new RegExp(`^Codex app-server .*${expected}`));
  });

  it("preserves the quota RPC envelope when sharing the transport", async () => {
    const script = `
      import readline from "node:readline";
      readline.createInterface({ input: process.stdin }).on("line", line => {
        const message = JSON.parse(line);
        if (message.id) process.stdout.write(JSON.stringify({ id: message.id,
          result: message.id === 1 ? {} : { request: message, home: process.env.CODEX_HOME }
        }) + "\\n");
      });
    `;
    await expect(readCodexAccountRateLimitsFromAppServer({
      command: process.execPath, args: ["--input-type=module", "-e", script],
      env: {}, codexHome: "/fixture/codex", timeoutMs: 2_000,
    })).resolves.toEqual({ request: { id: 2, method: "account/rateLimits/read" }, home: "/fixture/codex" });
  });
});

describe("Runner Codex account configuration", () => {
  it("parses only a trusted local JSON account map", () => {
    expect(parseRunnerCodexAccounts('{"one":"/srv/codex/a","two":"/srv/codex/b"}')).toEqual({
      one: "/srv/codex/a",
      two: "/srv/codex/b",
    });
    expect(parseRunnerCodexAccounts(undefined)).toBeUndefined();
    expect(() => parseRunnerCodexAccounts("[]")).toThrow("JSON 对象");
    expect(() => parseRunnerCodexAccounts('{"a":3}')).toThrow("绝对路径字符串");
  });
});

it("keeps account labels tied to the configured account home", () => {
  const router = new CodexAccountRouter({
    accounts: {
      account_a: "/srv/codex/account-b",
      account_b: "/srv/codex/account-c",
      account_c: "/srv/codex/account-d",
    },
    readRateLimits: async () => ({
      rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 3600 } },
    }),
  });
  expect(router.roots().map(({ slot, label }) => ({ slot, label }))).toEqual([
    { slot: "account_a", label: "b" },
    { slot: "account_b", label: "c" },
    { slot: "account_c", label: "d" },
  ]);
});


describe("Codex picker model discovery", () => {
  const script = (mode: string) => `
    const mode = ${JSON.stringify(mode)};
    require("node:readline").createInterface({input:process.stdin}).on("line", line => {
      const m = JSON.parse(line);
      if (!m.id) return;
      if (m.method === "initialize") return process.stdout.write(JSON.stringify({id:m.id,result:{}})+"\\n");
      if (m.method !== "model/list" || m.params.includeHidden !== false || m.params.limit !== 100
        || process.env.CODEX_HOME !== "/fixture/account") process.exit(2);
      if (mode === "timeout") return;
      const result = mode === "invalid" ? {data: "bad"} : {
        data: m.params.cursor ? [{model:"local-two",displayName:"Second"}] : [
          {model:"local-one",displayName:"First", secret:"private"},
          {model:"hidden-model",displayName:"Hidden",hidden:true}],
        nextCursor: mode === "loop" || !m.params.cursor ? "next" : null};
      process.stdout.write(JSON.stringify(mode === "unsupported" ? {id:m.id,error:{message:"private"}} : {id:m.id,result})+"\\n");
    });`;
  it("reads visible models across pages using the selected account without starting a turn", async () => {
    await expect(readCodexModelsFromAppServer({command:process.execPath, args:["-e",script("ok")],
      codexHome:"/fixture/account",timeoutMs:2000})).resolves.toEqual([
      {value:"local-one",label:"First"},{value:"local-two",label:"Second"}]);
  });
  it.each(["invalid", "loop", "unsupported", "timeout"])("rejects %s so callers can fall back", async mode => {
    await expect(readCodexModelsFromAppServer({command:process.execPath, args:["-e",script(mode)],
      codexHome:"/fixture/account",timeoutMs:mode === "timeout" ? 100 : 2000})).rejects.toThrow("Codex app-server");
  });
});


describe("new-session quota routing", () => {
  const accounts = { a: "/pool/a", b: "/pool/b" };
  const limits = (remaining: number, reset = 100) => ({ rateLimits: {
    primary: { usedPercent: 100 - remaining, windowDurationMins: 300, resetsAt: reset },
  } });
  it("shares inventory probes with launch and preserves reset-first preference", async () => {
    const readRateLimits = vi.fn(async (slot: string) => limits(50, slot === "a" ? 200 : 100));
    const router = new CodexAccountRouter({ accounts, now: () => 0, readRateLimits });
    await Promise.all([router.rateLimitsForHome("/pool/a"), router.selectForNewSession({ allowUnknown: true })]);
    expect(readRateLimits).toHaveBeenCalledTimes(2);
    expect(await router.selectForNewSession({ allowUnknown: true })).toMatchObject({ slot: "b" });
    expect(readRateLimits).toHaveBeenCalledTimes(2);
  });
  it("randomly tries an unknown account without inventing quota facts", async () => {
    const router = new CodexAccountRouter({ accounts, readRateLimits: async () => { throw new Error("offline"); }, random: () => 0.75 });
    expect(await router.selectForNewSession({ allowUnknown: true })).toEqual({ slot: "b", label: "b", codexHome: "/pool/b" });
    await expect(router.selectForFallback("/pool/a")).rejects.toThrow("备用账号");
  });
  it("bounds launch latency while a slow probe continues once", async () => {
    let resolve!: (raw: unknown) => void;
    const readRateLimits = vi.fn(() => new Promise(r => { resolve = r; }));
    const router = new CodexAccountRouter({ accounts: { a: "/pool/a" }, now: () => 0, readRateLimits, selectionTimeoutMs: 5 });
    expect(await router.selectForNewSession({ allowUnknown: true })).toMatchObject({ slot: "a" });
    expect(await router.selectForNewSession({ allowUnknown: true })).toMatchObject({ slot: "a" });
    expect(readRateLimits).toHaveBeenCalledTimes(1);
    resolve(limits(70));
    expect(await router.rateLimitsForHome("/pool/a")).toEqual(limits(70));
  });
  it("never randomly selects a known exhausted account", async () => {
    const router = new CodexAccountRouter({ accounts, now: () => 0,
      readRateLimits: async slot => slot === "a" ? limits(0) : null, random: () => 0 });
    expect(await router.selectForNewSession({ allowUnknown: true })).toMatchObject({ slot: "b" });
    const depleted = new CodexAccountRouter({ accounts, now: () => 0, readRateLimits: async () => limits(0) });
    await expect(depleted.selectForNewSession({ allowUnknown: true })).rejects.toThrow("至少 5%");
  });
});
