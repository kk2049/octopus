import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Host } from "../host/server.js";
import { setSecureMode } from "../runtime/secure-mode.js";
import { resetDeploymentProfile, setDeploymentProfile } from "../runtime/deployment.js";
import { AgentPlane, grantableToCli, type LoopAdapter, type McpCatalogEntry, type TurnRequest } from "./plane.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpRoot = path.join(pkgRoot, ".test-tmp");

let dir: string;
let plane: AgentPlane | null = null;

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  dir = fs.mkdtempSync(path.join(tmpRoot, "plane-"));
  const appDir = path.join(dir, "apps", "counter");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "app.yaml"),
    `
app: counter
title: 计数器
scope: per-user
actions:
  add: { title: 加一, predicate: owner }
  wipe: { title: 清空, predicate: owner, human_only: true }
agents:
  page: { adapter: openai-loop }
pages:
  main:
    layout: [a]
    slots:
      a: { widget: kv, bind: view }
`,
  );
  fs.writeFileSync(
    path.join(appDir, "projection.ts"),
    `export function project(events: Array<{type: string}>) { return { count: events.filter(e => e.type === "add").length }; }`,
  );
  fs.writeFileSync(
    path.join(appDir, "actions.ts"),
    `export function add() { return { events: [{ type: "add", data: null }], reply: "加了" }; }
export function wipe() { return { events: [{ type: "wiped", data: null }] }; }`,
  );
});

afterEach(() => {
  setSecureMode(true);
  resetDeploymentProfile();
  plane?.stop();
  plane = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeHost(): Host {
  const host = new Host({
    port: 0,
    appsDir: path.join(dir, "apps"),
    dataDir: path.join(dir, "data"),
    users: { lht: { token: "t1", admin: true }, bob: { token: "t2" } },
  });
  host.reload();
  return host;
}

// A cold SES action sandbox takes 4–5s on the 4 GiB deployment host; keep this
// assertion above that startup cost while the suite-level timeout stays 30s.
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 40));
  }
}

describe("AgentPlane", () => {
  it("runs a turn off the inbox: tools filtered, dispatch stamped, transcript grows", async () => {
    const host = makeHost();
    const seen: TurnRequest[] = [];
    const fake: LoopAdapter = {
      async runTurn(req) {
        seen.push(req);
        const out = await req.callTool("add", {});
        expect(JSON.parse(out).ok).toBe(true);
        return "已为你加一。";
      },
    };
    plane = new AgentPlane(host, { adapters: { "openai-loop": fake }, dataDir: path.join(dir, "data") });
    plane.attach();

    const out = await plane.send("counter", "lht", "page", { username: "lht", admin: true }, "帮我加一");
    expect(out.ok).toBe(true);

    const inst = host.instance("counter", "lht");
    await until(() => inst.log.read().some((e) => e.type === "add"));

    const added = inst.log.read().find((e) => e.type === "add")!;
    expect(added.by).toBe("agent:counter/page@lht"); // authorship stamped, not forged
    const names = seen[0].tools.map((t) => t.name);
    expect(names).toContain("read_state");
    expect(names).toContain("add");
    expect(names).not.toContain("wipe"); // human_only never becomes an agent tool

    const tr = await plane.transcript("counter", "lht", "page", { username: "lht", admin: true });
    if (!tr.ok) throw new Error(tr.message);
    const roles = tr.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "tool", "assistant"]);
    expect(tr.messages[2].text).toBe("已为你加一。");
  });

  it("refuses chat with someone else's per-user agent (admin included)", async () => {
    const host = makeHost();
    plane = new AgentPlane(host, {
      adapters: { "openai-loop": { runTurn: async () => "x" } },
      dataDir: path.join(dir, "data"),
    });
    plane.attach();
    const out = await plane.send("counter", "bob", "page", { username: "lht", admin: true }, "以 bob 的名义做事");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/只与工作台主人对话/);
  });

  it("consume-at-start: a failing turn leaves a note and does not loop", async () => {
    const host = makeHost();
    let calls = 0;
    plane = new AgentPlane(host, {
      adapters: {
        "openai-loop": {
          async runTurn() {
            calls++;
            throw new Error("LLM down");
          },
        },
      },
      dataDir: path.join(dir, "data"),
      retryDelayMs: 30,
    });
    plane.attach();
    await plane.send("counter", "lht", "page", { username: "lht", admin: false }, "hi");
    await until(() => calls === 2, 4000); // one transient retry, then loud failure

    let notes = 0;
    for (let i = 0; i < 50 && notes < 2; i++) {
      const tr = await plane.transcript("counter", "lht", "page", { username: "lht", admin: false });
      notes = tr.ok ? tr.messages.filter((m) => m.role === "note").length : 0;
      if (notes < 2) await new Promise((r) => setTimeout(r, 40));
    }
    expect(notes).toBeGreaterThanOrEqual(2); // retry note + failure note
    expect(calls).toBe(2);
  });

  it("recovers unread inbox left from before attach (restart semantics)", async () => {
    const host = makeHost();
    const inst = host.instance("counter", "lht");
    await inst.log.append(
      [{ type: "agent_inbox", data: { to: "page", text: "重启前留的消息" } }],
      { kind: "user", username: "lht" },
    );
    let got = "";
    plane = new AgentPlane(host, {
      adapters: {
        "openai-loop": {
          async runTurn(req) {
            got = req.inboxTexts.join("|");
            return "捡起来了";
          },
        },
      },
      dataDir: path.join(dir, "data"),
    });
    plane.attach();
    await until(() => got.includes("重启前留的消息"));
  });

  it("fireDaily seeds every existing scope's inbox as system:daily and turns run", async () => {
    const host = makeHost();
    let turns = 0;
    plane = new AgentPlane(host, {
      adapters: { "openai-loop": { runTurn: async () => (turns++, "巡检完毕") } },
      dataDir: path.join(dir, "data"),
    });
    plane.attach();
    // Two scopes exist once their logs exist.
    await host.instance("counter", "lht").log.append([{ type: "x", data: null }], { kind: "user", username: "lht" });
    await host.instance("counter", "bob").log.append([{ type: "x", data: null }], { kind: "user", username: "bob" });

    const seeded = plane.fireDaily("counter", "page");
    expect(seeded).toBe(2);
    await until(() => turns === 2, 4000);
    const inboxEvent = host.instance("counter", "lht").log.read().find((e) => e.type === "agent_inbox");
    expect(inboxEvent!.by).toBe("system:daily");
    expect(plane.fireDaily("counter", "nope")).toBe(0);
  });

  it("per-agent runtime config: missing adapter refuses with words; override reroutes the turn", async () => {
    // This case is about SECURE MODE, so it needs a deployment where secure
    // mode is the thing that decides. On the default `cloud-multi-user`
    // profile the coding CLIs are refused before secure mode is consulted
    // (SEC-06) — which is its own test, in runtime/deployment.test.ts.
    setDeploymentProfile("local-owner");
    const host = makeHost();
    let hits = 0;
    const fakeCli: import("./plane.js").LoopAdapter = {
      async runTurn(req) {
        hits++;
        expect(req.agentDir).toContain(path.join("counter", "lht", "agents", "page"));
        expect(req.model).toBe("claude-opus-5");
        return "cli 面跑的";
      },
    };
    plane = new AgentPlane(host, {
      adapters: { "claude-code": fakeCli }, // openai-loop deliberately absent
      dataDir: path.join(dir, "data"),
    });
    plane.attach();

    // Manifest says openai-loop, which is not wired → refusal names the kind.
    const refused = await plane.send("counter", "lht", "page", { username: "lht", admin: false }, "hi");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toMatch(/openai-loop 未配置/);

    // In secure mode the owner cannot even SELECT an unisolated adapter.
    const refusedCfg = await plane.setAgentConfig("counter", "lht", "page", { username: "lht", admin: false }, {
      adapter: "claude-code",
    });
    expect(refusedCfg.ok).toBe(false);
    if (!refusedCfg.ok) expect(refusedCfg.message).toMatch(/安全模式/);

    // With secure mode explicitly off, the same flip works and reroutes.
    setSecureMode(false);
    const set = await plane.setAgentConfig("counter", "lht", "page", { username: "lht", admin: false }, {
      adapter: "claude-code",
      model: "claude-opus-5",
    });
    expect(set.ok).toBe(true);
    const sent = await plane.send("counter", "lht", "page", { username: "lht", admin: false }, "走 cli");
    expect(sent.ok).toBe(true);
    await until(() => hits === 1);

    const tr = await plane.transcript("counter", "lht", "page", { username: "lht", admin: false });
    if (!tr.ok) throw new Error(tr.message);
    expect(tr.adapter).toBe("claude-code");
    expect(tr.model).toBe("claude-opus-5");

    // A stranger (even admin) cannot reconfigure someone else's page agent.
    const denied = await plane.setAgentConfig("counter", "lht", "page", { username: "root", admin: true }, {
      adapter: "openai-loop",
    });
    expect(denied.ok).toBe(false);
  });

  it("a turn whose configured adapter is unisolated fails closed and keeps the inbox", async () => {
    setDeploymentProfile("local-owner"); // see the note above: secure mode's own case
    setSecureMode(false);
    const host = makeHost();
    let hits = 0;
    plane = new AgentPlane(host, {
      adapters: { "claude-code": { async runTurn() { hits++; return "ran"; } } },
      dataDir: path.join(dir, "data"),
    });
    plane.attach();
    await plane.setAgentConfig("counter", "lht", "page", { username: "lht", admin: false }, { adapter: "claude-code" });
    setSecureMode(true); // deployment tightened while the config stayed

    // Two doors, both closed, and they close differently on purpose.
    //
    // `send()` refuses up front and does not queue anything: a person typing a
    // message deserves the reason now, not a message that silently waits for a
    // deployment change that may never come.
    const sent = await plane.send("counter", "lht", "page", { username: "lht", admin: false }, "run it");
    expect(sent.ok).toBe(false);
    if (!sent.ok) expect(sent.message).toMatch(/安全模式/);

    // An inbox event that arrived by another route (the daily scheduler, an
    // action, or a message queued before the tightening) still has to fail at
    // the TURN — and keep its place in the inbox.
    await host.instance("counter", "lht").log.append(
      [{ type: "agent_inbox", data: { to: "page", text: "run it" } }],
      { kind: "system", name: "daily" },
    );
    await new Promise((r) => setTimeout(r, 250));
    expect(hits).toBe(0);
    const tr = await plane.transcript("counter", "lht", "page", { username: "lht", admin: false });
    if (!tr.ok) throw new Error(tr.message);
    expect(JSON.stringify(tr.messages)).toMatch(/安全模式/);
    expect(tr.adapterRefusal).toMatch(/安全模式/);
  });
});

/**
 * `extraMcp` hands a server straight to the CLI's own stdio, so nothing the
 * Host does can mediate what happens there. A catalog entry therefore has to
 * SAY it is safe to grant that way; the default is "protected", so adding a
 * powerful server to the catalog can never silently become a grant.
 */
describe("direct MCP grants are default-deny", () => {
  const catalog: Record<string, McpCatalogEntry> = {
    echo: { command: "node", args: ["echo.js"], trust: "sandboxed" },
    machines: { command: "node", args: ["machines.js"] }, // no trust ⇒ protected
    ssh: { command: "ssh", args: [], trust: "protected" },
  };

  it("grantableToCli only accepts an explicit sandboxed claim", () => {
    expect(grantableToCli(catalog.echo)).toBe(true);
    expect(grantableToCli(catalog.machines)).toBe(false);
    expect(grantableToCli(catalog.ssh)).toBe(false);
    expect(grantableToCli(undefined)).toBe(false);
  });

  it("refuses to save a protected grant, and drops one that got in anyway", async () => {
    const host = makeHost();
    const p = new AgentPlane(host, { adapters: {}, dataDir: path.join(dir, "data"), mcpCatalog: catalog });
    try {
      const bad = await p.setAgentConfig("counter", "lht", "page", { username: "lht", admin: false }, {
        mcp: ["machines"],
      });
      expect(bad.ok).toBe(false);
      expect((bad as { message: string }).message).toContain("受保护资源");

      const good = await p.setAgentConfig("counter", "lht", "page", { username: "lht", admin: false }, {
        mcp: ["echo"],
      });
      expect(good.ok).toBe(true);

      // A config file written out of band (or by an older build) still cannot
      // smuggle a protected server into a turn.
      const inst = host.instance("counter", "lht");
      const cfgFile = path.join(dir, "data", "apps", "counter", "lht", "agents", "page", "config.json");
      fs.writeFileSync(cfgFile, JSON.stringify({ mcp: ["echo", "machines", "ssh"] }));
      const setup = p.resolveSetup(inst, host.getManifest("counter")!.agents.page);
      expect(setup.mcp).toEqual(["echo"]);
    } finally {
      p.stop();
      host.stop();
    }
  });
});
