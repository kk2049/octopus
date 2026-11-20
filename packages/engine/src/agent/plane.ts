/**
 * AgentPlane — "an agent is a thing with an inbox", and one pump runs them all.
 *
 * Inbox messages are domain events (`agent_inbox`, engine-reserved type): a
 * user's chat line, a button's refresh request and the daily scheduler all
 * become the same durable fact, and the pump reacts to appends — which is the
 * devpipe turn-pump generalized. Transcript + consume-cursor live BESIDE the
 * domain log (agents/<name>/ under the instance dir), because chatter is not
 * domain truth (the HQ ruling, kept).
 *
 * Semantics carried over from devpipe on purpose, recorded honestly:
 *   - consume-at-start: a failed turn does NOT re-feed its inbox batch; a
 *     failure note lands in the transcript and the human says it again.
 *   - one transient retry, then give up loudly.
 *   - per-agent serial turns; small global concurrency cap.
 *
 * Authorship: the page agent of a per-user scope acts onBehalfOf the scope
 * owner — and ONLY the owner may talk to it (an admin chatting through
 * someone else's agent would be writing as them; ticket #15 forbids that).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { recordConvergenceUsage, type ConvergenceOutcome } from "@claude-bot/convergence-gates";
import type { AppInstance } from "../dispatch.js";
import { appAgentAdapterVerdict } from "../runtime/deployment.js";
import type { AgentDef, AppManifest } from "../manifest.js";
import type { AgentPlaneApi, Host, Viewer } from "../host/server.js";
import { fromPlane, parseSessionFile, type SessionView } from "./session-view.js";
import type { Actor } from "../types.js";

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface TranscriptEntry {
  role: "user" | "assistant" | "tool" | "note" | "elicit";
  text: string;
  at: string;
  /** elicit entries: an action whose form should render inside the card. */
  action?: string;
}

export interface TurnRequest {
  systemPrompt: string;
  transcript: TranscriptEntry[];
  inboxTexts: string[];
  tools: ToolDef[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Per-(instance, agent) private dir — CLI adapters keep state/workdir here. */
  agentDir: string;
  /** Runtime model/effort (manifest default ⊕ per-agent config override). */
  model?: string;
  effort?: string;
  /** Host loopback base for CLI MCP shims (absent when no host is bound). */
  shimBase?: string;
  /** Granted extra MCP servers, already resolved from the host catalog. */
  extraMcp?: Array<{ name: string; command: string; args: string[]; env?: Record<string, string> }>;
}

/** Runs one reasoning turn; returns final assistant text; throws on failure. */
export interface LoopAdapter {
  runTurn(req: TurnRequest): Promise<string>;
}

export type AdapterKind = "openai-loop" | "claude-code" | "codex";
export const ADAPTER_KINDS: readonly AdapterKind[] = ["openai-loop", "claude-code", "codex"];

/**
 * Per-agent runtime override, editable from the UI (owner-only): which loop
 * implementation runs underneath, which model, which effort. Data material —
 * a JSON file beside the transcript, read at every turn, no restart.
 */
export interface AgentRuntimeConfig {
  adapter?: AdapterKind;
  model?: string;
  effort?: string;
  /** Extra MCP servers unlocked for this agent (names from the host catalog). */
  mcp?: string[];
}

export interface McpCatalogEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * Whether this server may be handed DIRECTLY to a CLI agent.
   *
   * `extraMcp` bypasses the engine entirely: the CLI talks to that server over
   * its own stdio, so nothing the Host does can mediate it. A server that
   * reaches a protected resource (a laptop, a shell, a database) therefore
   * cannot be granted this way — it has to come through the brokered shim, or
   * not at all (entry chains: doc/tcb-reading-guide.md §3).
   *
   * Default-deny: an entry that does not SAY it is sandboxed is treated as
   * protected, so adding a powerful server to the catalog cannot silently
   * become a grant.
   */
  trust?: "sandboxed" | "protected";
}

/** A catalog entry may be handed to a CLI only when it says it is safe to. */
export function grantableToCli(entry: McpCatalogEntry | undefined): boolean {
  return entry?.trust === "sandboxed";
}

interface AgentState {
  running: boolean;
  since: number;
  recheck: boolean;
}

const INBOX_TYPE = "agent_inbox";

export class AgentPlane implements AgentPlaneApi {
  private states = new Map<string, AgentState>();
  private active = 0;
  private waiters: Array<() => void> = [];
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private host: Host,
    private opts: {
      /** Loop implementations by kind; an agent picks via manifest/override. */
      adapters: Partial<Record<AdapterKind, LoopAdapter>>;
      dataDir: string;
      /** Host loopback base for CLI shims, resolved lazily (port binds late). */
      shimBase?: () => string | undefined;
      /** Grantable extra MCP servers (per-agent unlock via config.json mcp[]). */
      mcpCatalog?: Record<string, McpCatalogEntry>;
      maxConcurrent?: number;
      transcriptTail?: number;
      retryDelayMs?: number;
    },
  ) {}

  private observe(
    principal: string,
    entry: string,
    effect: "read" | "write" | "execute" | "lifecycle",
    outcome: ConvergenceOutcome,
    reason?: string,
  ): void {
    recordConvergenceUsage({
      candidate: "engine-agent-plane",
      principal,
      entry,
      provider: "v3-agent-plane",
      effect,
      outcome,
      ...(reason ? { reason } : {}),
    });
  }

  /** Call once after host.loadAll: wires pump triggers + daily seeds. */
  attach(): void {
    this.host.onInstanceCreated((inst) => {
      inst.log.onAppend((events) => {
        if (events.some((e) => e.type === INBOX_TYPE)) this.checkInstance(inst);
      });
      this.checkInstance(inst); // recover unread from before a restart
    });
    this.scheduleDaily();
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
  }

  // ── paths & files ──

  private dirFor(inst: AppInstance, agent: string): string {
    return path.join(this.opts.dataDir, "apps", inst.app, inst.scope, "agents", agent);
  }

  private readTranscript(inst: AppInstance, agent: string): TranscriptEntry[] {
    const file = path.join(this.dirFor(inst, agent), "transcript.jsonl");
    if (!fs.existsSync(file)) return [];
    const out: TranscriptEntry[] = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as TranscriptEntry);
      } catch {
        /* torn tail tolerated */
      }
    }
    return out;
  }

  private appendTranscript(inst: AppInstance, agent: string, entries: Array<Omit<TranscriptEntry, "at">>): void {
    if (!entries.length) return;
    const dir = this.dirFor(inst, agent);
    fs.mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    const body = entries.map((e) => JSON.stringify({ ...e, at })).join("\n") + "\n";
    fs.appendFileSync(path.join(dir, "transcript.jsonl"), body);
  }

  private readCursor(inst: AppInstance, agent: string): number {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dirFor(inst, agent), "cursor.json"), "utf8"));
      return Number(raw.upto ?? 0);
    } catch {
      return 0;
    }
  }

  private writeCursor(inst: AppInstance, agent: string, upto: number): void {
    const dir = this.dirFor(inst, agent);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cursor.json"), JSON.stringify({ upto }));
  }

  readAgentConfig(inst: AppInstance, agent: string): AgentRuntimeConfig {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(this.dirFor(inst, agent), "config.json"), "utf8"),
      ) as AgentRuntimeConfig;
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }

  /** The effective (kind, adapter, model, effort) for this agent right now. */
  resolveSetup(
    inst: AppInstance,
    agentDef: AgentDef,
  ): { kind: AdapterKind; adapter: LoopAdapter | null; model?: string; effort?: string; mcp: string[] } {
    const cfg = this.readAgentConfig(inst, agentDef.name);
    const kind = (cfg.adapter && ADAPTER_KINDS.includes(cfg.adapter) ? cfg.adapter : agentDef.adapter) as AdapterKind;
    const catalog = this.opts.mcpCatalog ?? {};
    const granted: string[] = [];
    for (const name of cfg.mcp ?? []) {
      if (!(name in catalog)) continue;
      if (!grantableToCli(catalog[name])) {
        console.warn(`[engine] MCP「${name}」不可直接授予 CLI（未标记 trust: sandboxed），本轮忽略`);
        continue;
      }
      granted.push(name);
    }
    return {
      kind,
      adapter: this.opts.adapters[kind] ?? null,
      model: cfg.model ?? agentDef.model,
      effort: cfg.effort ?? agentDef.effort,
      mcp: granted,
    };
  }

  /** Owner-only (per-user) / admin-only (shared) runtime reconfiguration. */
  async setAgentConfig(
    app: string,
    scope: string,
    agentName: string,
    viewer: Viewer,
    cfg: AgentRuntimeConfig,
  ): Promise<{ ok: true; config: AgentRuntimeConfig } | { ok: false; message: string }> {
    const m = this.host.getManifest(app);
    if (!m?.agents[agentName]) {
      this.observe(viewer.username, "engine-agent.config", "write", "refused", "unknown_agent");
      return { ok: false, message: `应用 ${app} 没有 agent「${agentName}」` };
    }
    if (m.scope === "per-user" && viewer.username !== scope) {
      this.observe(viewer.username, "engine-agent.config", "write", "refused", "wrong_scope");
      return { ok: false, message: "只有工作台主人可以改自己页面秘书的配置" };
    }
    if (m.scope === "shared" && !viewer.admin) {
      this.observe(viewer.username, "engine-agent.config", "write", "refused", "admin_required");
      return { ok: false, message: "共享应用的 agent 配置仅 admin 可改（影响所有人）" };
    }
    if (cfg.adapter !== undefined && !ADAPTER_KINDS.includes(cfg.adapter)) {
      this.observe(viewer.username, "engine-agent.config", "write", "refused", "unknown_adapter");
      return { ok: false, message: `未知 adapter「${String(cfg.adapter)}」（可选：${ADAPTER_KINDS.join(" / ")}）` };
    }
    if (cfg.adapter !== undefined) {
      // The runtime-override door. SEC-06 closes it with the SAME predicate the
      // manifest loader uses, so "declare it" and "switch to it later" cannot
      // disagree — a second, similar-looking check here is exactly how one of
      // the two ends up stale.
      const verdict = appAgentAdapterVerdict(cfg.adapter);
      if (!verdict.ok) {
        this.observe(viewer.username, "engine-agent.config", "write", "refused", verdict.code);
        return { ok: false, message: verdict.reason };
      }
    }
    if (cfg.mcp !== undefined) {
      const catalog = this.opts.mcpCatalog ?? {};
      const names = Object.keys(catalog);
      const bad = cfg.mcp.filter((n) => !names.includes(n));
      if (bad.length) {
        this.observe(viewer.username, "engine-agent.config", "write", "refused", "unknown_mcp");
        return { ok: false, message: `未知 MCP「${bad.join("、")}」（目录里有：${names.join("、") || "（空）"}）` };
      }
      const protectedOnes = cfg.mcp.filter((n) => !grantableToCli(catalog[n]));
      if (protectedOnes.length) {
        this.observe(viewer.username, "engine-agent.config", "write", "refused", "protected_mcp");
        return {
          ok: false,
          message:
            `MCP「${protectedOnes.join("、")}」触及受保护资源，不能直接交给 CLI；` +
            "受保护的能力只能经统一权限门（brokered shim）提供。",
        };
      }
    }
    const inst = this.host.instance(app, scope);
    const dir = this.dirFor(inst, agentName);
    fs.mkdirSync(dir, { recursive: true });
    // MERGE semantics: absent fields keep their current value (the ⚙ panel
    // and the MCP checkboxes are different clients editing different fields —
    // full-replace made one silently wipe the other, live-caught when a
    // grant-only save dropped adapter:claude-code and the turn quietly ran
    // on openai). Empty string clears model/effort; empty array clears mcp.
    const prev = this.readAgentConfig(inst, agentName);
    const clean: AgentRuntimeConfig = { ...prev };
    if (cfg.adapter !== undefined) clean.adapter = cfg.adapter;
    if (cfg.model !== undefined) {
      if (cfg.model.trim()) clean.model = cfg.model.trim();
      else delete clean.model;
    }
    if (cfg.effort !== undefined) {
      if (cfg.effort.trim()) clean.effort = cfg.effort.trim();
      else delete clean.effort;
    }
    if (cfg.mcp !== undefined) {
      if (cfg.mcp.length) clean.mcp = cfg.mcp;
      else delete clean.mcp;
    }
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(clean));
    this.observe(viewer.username, "engine-agent.config", "write", "ok");
    return { ok: true, config: clean };
  }

  // ── pump ──

  private checkInstance(inst: AppInstance): void {
    const m = this.host.getManifest(inst.app);
    if (!m) return;
    for (const agent of Object.values(m.agents)) void this.maybeTurn(inst, m, agent);
  }

  private async maybeTurn(inst: AppInstance, m: AppManifest, agent: AgentDef): Promise<void> {
    const key = `${inst.app}/${inst.scope}/${agent.name}`;
    let st = this.states.get(key);
    if (!st) this.states.set(key, (st = { running: false, since: 0, recheck: false }));
    if (st.running) {
      st.recheck = true;
      return;
    }
    const cursor = this.readCursor(inst, agent.name);
    const unread = inst.log
      .read()
      .filter((e) => e.type === INBOX_TYPE && e.seq > cursor && (e.data as { to?: string }).to === agent.name);
    if (!unread.length) return;
    const setup = this.resolveSetup(inst, agent);
    const verdict = appAgentAdapterVerdict(setup.kind);
    if (!verdict.ok) {
      // Fail closed and say so, once per wake-up. The inbox keeps the message.
      //
      // This is also the HISTORIC-CONFIG path (SEC-06 §10): a `config.json`
      // written when the deployment was `local-owner`, or before the ban
      // existed, reaches here saying `claude-code`. It is refused rather than
      // quietly rewritten to `openai-loop` — silently substituting a different
      // model changes cost, behaviour and output with nobody being told.
      this.appendTranscript(inst, agent.name, [{ role: "note", text: `⛔ ${verdict.reason}` }]);
      this.writeCursor(inst, agent.name, cursor); // do not consume the inbox
      return;
    }
    if (!setup.adapter) return; // durable inbox waits for an adapter

    st.running = true;
    st.since = Date.now();
    // Consume at start (devpipe parity): a dying turn must not loop forever.
    this.writeCursor(inst, agent.name, unread[unread.length - 1].seq);
    const inboxTexts = unread.map((e) => {
      const d = e.data as { text?: string; from?: string };
      return (d.from ? `${d.from}：` : "") + String(d.text ?? "");
    });
    const fromUser = (unread[0].data as { from?: string }).from;
    this.appendTranscript(inst, agent.name, inboxTexts.map((text) => ({ role: "user" as const, text })));

    await this.acquire();
    try {
      await this.runOnce(inst, m, agent, setup, inboxTexts, fromUser);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      this.appendTranscript(inst, agent.name, [
        { role: "note", text: `⚠ 本轮失败：${msg}（这批消息不会重投，需要就再说一句）` },
      ]);
    } finally {
      this.release();
      st.running = false;
      if (st.recheck) {
        st.recheck = false;
        void this.maybeTurn(inst, m, agent);
      }
    }
  }

  private async runOnce(
    inst: AppInstance,
    m: AppManifest,
    agent: AgentDef,
    setup: { kind: AdapterKind; adapter: LoopAdapter | null; model?: string; effort?: string; mcp: string[] },
    inboxTexts: string[],
    fromUser?: string,
  ): Promise<void> {
    // Shared scopes: the agent acts on behalf of whoever spoke to it, so its
    // authorship stays honest (agent:<app>/<agent>@<speaker>).
    const owner = m.scope === "per-user" ? inst.scopeOwner : (fromUser ?? "shared");
    const actor: Actor = { kind: "agent", app: inst.app, agent: agent.name, onBehalfOf: owner };
    const specs = await inst.listActions(actor);
    const tools: ToolDef[] = [
      {
        name: "read_state",
        description: "读当前页面状态（投影视图 JSON）。写任何东西之前先读它。",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "ask_user",
        description:
          "向用户弹出一张问询卡（可附带某个动作的表单）。用户的回应会作为新消息进你的收件箱——调用后请收束本轮，不要空等。",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "要问的问题或说明（markdown）" },
            form_action: { type: "string", description: "可选：随卡展示该动作的输入表单（必须是你可用的动作名）" },
          },
          required: ["prompt"],
        },
      },
      ...specs.map((s) => ({
        name: s.name,
        description:
          `${s.title ?? s.name}${s.description ? ` — ${s.description}` : ""}` +
          `（与页面按钮同一扇门，同一谓词，事件将署名为你）`,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            Object.entries(s.params ?? {}).map(([k, p]) => [
              k,
              {
                type: p.type === "object" ? "object" : p.type,
                ...(p.description ? { description: p.description } : {}),
                ...(p.enum ? { enum: p.enum } : {}),
              },
            ]),
          ),
          required: Object.entries(s.params ?? {})
            .filter(([, p]) => p.required)
            .map(([k]) => k),
        },
      })),
    ];

    // Every turn gets its own AgentRun Context, derived from the App Context
    // the trusted launcher established. A thread is not a Context: the same
    // conversation across two turns gets two Contexts, and stopping a run
    // destroys the one it held (kernel spec §启动 Agent).
    const agentRun = await this.host.openAgentRun(inst.app, inst.scope, owner, agent.name);

    let systemPrompt = "";
    if (agent.prompt) {
      try {
        systemPrompt = fs.readFileSync(path.join(m.dir, agent.prompt), "utf8");
      } catch {
        systemPrompt = "";
      }
    }
    systemPrompt =
      systemPrompt.replaceAll("{{user}}", owner) +
      `\n\n——引擎注入——\n当前用户：${owner}。你的工具即该用户在本页可用的动作（发现性保证）；每次写入都会以 agent:${inst.app}/${agent.name}@${owner} 署名进入事件日志，不可伪装他人。先 read_state 再动手。`;

    const runAdapter = () =>
      setup.adapter!.runTurn({
        systemPrompt,
        transcript: this.readTranscript(inst, agent.name).slice(-(this.opts.transcriptTail ?? 40)),
        inboxTexts,
        tools,
        agentDir: this.dirFor(inst, agent.name),
        model: setup.model,
        effort: setup.effort,
        shimBase: this.opts.shimBase?.(),
        extraMcp: setup.mcp
          .map((n) => ({ name: n, ...this.opts.mcpCatalog![n] }))
          .filter((e) => !!e.command),
        callTool: async (name, args) => {
          if (name === "read_state") return JSON.stringify(await inst.view()).slice(0, 8000);
          if (name === "ask_user") {
            const prompt = String(args.prompt ?? "").trim();
            const formAction = args.form_action ? String(args.form_action) : undefined;
            if (!prompt) return JSON.stringify({ ok: false, error: "prompt 不能为空" });
            if (formAction && !specs.some((s) => s.name === formAction)) {
              return JSON.stringify({ ok: false, error: `form_action「${formAction}」不在你的可用动作里` });
            }
            this.appendTranscript(inst, agent.name, [
              { role: "elicit", text: prompt, ...(formAction ? { action: formAction } : {}) },
            ]);
            return JSON.stringify({ ok: true, note: "已展示给用户；回应会成为新消息，本轮请就此收束。" });
          }
          // The tool call runs as a ControllerRun derived from THIS run's
          // Context — not from the app's, and never from anything the model
          // said. No context id crosses the model.
          const out = await inst.dispatch(name, args, actor, agentRun?.contextId);
          this.appendTranscript(inst, agent.name, [
            {
              role: "tool",
              text: `${name}(${JSON.stringify(args).slice(0, 120)}) → ${out.ok ? (out.reply ?? "ok") : `✖ ${out.message}`}`,
            },
          ]);
          return JSON.stringify(out.ok ? { ok: true, reply: out.reply } : { ok: false, error: out.message });
        },
      });

    let text: string;
    try {
      try {
        text = await runAdapter();
      } catch (err) {
        // One transient retry (ticket #20 parity), then fail loudly.
        this.appendTranscript(inst, agent.name, [
          { role: "note", text: `瞬时失败，稍后自动重试一次：${String((err as Error)?.message ?? err).slice(0, 200)}` },
        ]);
        await new Promise((r) => setTimeout(r, this.opts.retryDelayMs ?? 3000));
        text = await runAdapter();
      }
    } finally {
      // The run is over whether it succeeded, failed or was abandoned: its
      // Context dies here, and with it every capability derived from it.
      agentRun?.close();
    }
    this.appendTranscript(inst, agent.name, [{ role: "assistant", text }]);
  }

  private acquire(): Promise<void> {
    const max = this.opts.maxConcurrent ?? 2;
    if (this.active < max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(() => resolve()));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  // ── daily seeds (probe-grade scheduler: host-local clock) ──

  /**
   * Seed the agent's daily prompt into every existing scope of the app NOW.
   * Public so it is manually triggerable (and thus actually testable — the
   * 04:00 timer used to be the only path, which meant "never live-verified").
   * Returns the number of scopes seeded.
   */
  fireDaily(appName: string, agentName: string): number {
    const m = this.host.getManifest(appName);
    const agent = m?.agents[agentName];
    if (!m || !agent) return 0;
    const scopesDir = path.join(this.opts.dataDir, "apps", appName);
    if (!fs.existsSync(scopesDir)) return 0;
    let n = 0;
    for (const scope of fs.readdirSync(scopesDir)) {
      if (!fs.existsSync(path.join(scopesDir, scope, "log.jsonl"))) continue;
      const inst = this.host.instance(appName, scope);
      void inst.log.append(
        [{ type: INBOX_TYPE, data: { to: agent.name, text: agent.dailyPrompt ?? "每日例行巡检。" } }],
        { kind: "system", name: "daily" },
      );
      this.observe(scope, "engine-agent.daily", "execute", "observed");
      n++;
    }
    return n;
  }

  private scheduleDaily(): void {
    for (const m of this.host.listManifests()) {
      for (const agent of Object.values(m.agents)) {
        if (!agent.daily) continue;
        const fire = () => {
          this.fireDaily(m.app, agent.name);
          this.timers.push(setTimeout(fire, msUntil(agent.daily!)).unref());
        };
        this.timers.push(setTimeout(fire, msUntil(agent.daily)).unref());
      }
    }
  }

  // ── host-facing API ──

  async transcript(
    app: string,
    scope: string,
    agentName: string,
    viewer: Viewer,
  ): Promise<
    | {
        ok: true;
        messages: Array<{ role: string; text: string; at?: string }>;
        running: boolean;
        since?: number;
        adapter?: string;
        adapterReady?: boolean;
        /** Set when this adapter is refused here; the panel shows it verbatim. */
        adapterRefusal?: string;
        model?: string;
        effort?: string;
        session?: { kind: string; id?: string; file?: string };
        rich?: SessionView;
        mcp?: string[];
      }
    | { ok: false; message: string }
  > {
    const m = this.host.getManifest(app);
    if (!m?.agents[agentName]) {
      this.observe(viewer.username, "engine-agent.transcript", "read", "refused", "unknown_agent");
      return { ok: false, message: `应用 ${app} 没有 agent「${agentName}」` };
    }
    const inst = this.host.instance(app, scope);
    const st = this.states.get(`${app}/${scope}/${agentName}`);
    const setup = this.resolveSetup(inst, m.agents[agentName]);
    let session: { kind: string; id?: string; file?: string } | undefined;
    try {
      const cli = JSON.parse(
        fs.readFileSync(path.join(this.dirFor(inst, agentName), "cli.json"), "utf8"),
      ) as { kind: string; sessionId?: string; transcriptPath?: string };
      if (cli.sessionId) session = { kind: cli.kind, id: cli.sessionId, file: cli.transcriptPath };
    } catch {
      /* no CLI session yet */
    }
    const messages = this.readTranscript(inst, agentName).slice(-80);
    // The unified middle layer: CLI agents get their session file parsed into
    // the shared ViewEntry vocabulary; openai agents derive it from our own
    // transcript. Presentation modes upstairs never know which loop ran.
    let rich: SessionView | undefined;
    // The session file is authoritative only while the SAME adapter is active;
    // after a runtime switch the old CLI session is history, not the present.
    if (session?.file && session.kind === setup.kind && (session.kind === "claude-code" || session.kind === "codex")) {
      rich = parseSessionFile(session.kind, session.file) ?? undefined;
      if (rich) {
        // Elicit cards live only in the plane transcript — merge them in so
        // the rich view keeps interactive cards.
        const elicits = messages.filter((m) => m.role === "elicit");
        if (elicits.length) {
          rich = {
            ...rich,
            entries: [...rich.entries, ...fromPlane(elicits).entries],
          };
        }
      }
    }
    if (!rich) rich = fromPlane(messages);
    const verdict = appAgentAdapterVerdict(setup.kind);
    this.observe(viewer.username, "engine-agent.transcript", "read", "ok");
    return {
      ok: true,
      messages,
      running: st?.running ?? false,
      since: st?.since,
      adapter: setup.kind,
      adapterReady: !!setup.adapter && verdict.ok,
      ...(verdict.ok ? {} : { adapterRefusal: verdict.reason }),
      model: setup.model,
      effort: setup.effort,
      mcp: setup.mcp,
      session,
      rich,
    };
  }

  async send(
    app: string,
    scope: string,
    agentName: string,
    viewer: Viewer,
    text: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const m = this.host.getManifest(app);
    if (!m?.agents[agentName]) {
      this.observe(viewer.username, "engine-agent.send", "execute", "refused", "unknown_agent");
      return { ok: false, message: `应用 ${app} 没有 agent「${agentName}」` };
    }
    if (!text.trim()) {
      this.observe(viewer.username, "engine-agent.send", "execute", "refused", "empty_input");
      return { ok: false, message: "空消息" };
    }
    if (m.scope === "per-user" && viewer.username !== scope) {
      this.observe(viewer.username, "engine-agent.send", "execute", "refused", "wrong_scope");
      return { ok: false, message: "页面秘书只与工作台主人对话（admin 是只读透镜，代聊=以他人名义写入）" };
    }
    const setup = this.resolveSetup(this.host.instance(app, scope), m.agents[agentName]);
    // Refuse with the REASON rather than with "not wired up". On a cloud host
    // the coding-CLI adapters are absent precisely because they are banned, and
    // "在宿主未接入" would send the operator looking for a missing dependency.
    const verdict = appAgentAdapterVerdict(setup.kind);
    if (!verdict.ok) {
      this.observe(viewer.username, "engine-agent.send", "execute", "refused", verdict.code);
      return { ok: false, message: verdict.reason };
    }
    if (!setup.adapter) {
      this.observe(viewer.username, "engine-agent.send", "execute", "failed", "adapter_unavailable");
      return {
        ok: false,
        message:
          setup.kind === "openai-loop"
            ? "openai-loop 未配置（设 V3_LLM_BASE_URL / V3_LLM_API_KEY / V3_LLM_MODEL）"
            : `adapter「${setup.kind}」在宿主未接入`,
      };
    }
    const inst = this.host.instance(app, scope);
    await inst.log.append(
      [{ type: INBOX_TYPE, data: { to: agentName, text, from: viewer.username } }],
      { kind: "user", username: viewer.username },
    );
    this.observe(viewer.username, "engine-agent.send", "execute", "ok");
    return { ok: true };
  }
}

function msUntil(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}
