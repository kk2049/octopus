/**
 * T2 material — the declarative layer.
 *
 * `app.yaml` + `pages/*.yaml` are DATA: schema-checked here, hot-reloaded by
 * the host, and forbidden to contain code. Wiring is allowed (`on.select:
 * action:add_item`), computation is not — the moment a page needs an
 * expression, that logic belongs in a pure function (T3) or a widget (T1).
 * This boundary is what licenses gateless hot-plug of everything in this file.
 *
 * Validation errors are collected, not thrown one at a time: the audience is
 * a human or a dev agent editing YAML, and they deserve the whole list.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";
import { WIDGETS } from "./cards/catalog.js";
import type { ActionSpec, ParamSpec } from "./dispatch.js";
import { appAgentAdapterVerdict } from "./runtime/deployment.js";
import { PREDICATES, type Predicate } from "./types.js";

export interface AgentDef {
  name: string;
  /** Which loop runs underneath. Runtime-overridable per agent (config.json). */
  adapter: "openai-loop" | "claude-code" | "codex";
  /** Path (relative to app dir) of the system prompt file. */
  prompt?: string;
  model?: string;
  /** Reasoning effort passed to the underlying loop (minimal|low|medium|high|xhigh). */
  effort?: string;
  /** "HH:MM" host-local daily seed, probe-grade scheduling. */
  daily?: string;
  /** Seed message sent on the daily schedule. */
  dailyPrompt?: string;
}

export interface PageNode {
  widget: string;
  bind?: string;
  props?: Record<string, unknown>;
  on?: Record<string, string>;
  agent?: string;
  /** Container widgets only (catalog `container: true`). */
  children?: PageNode[];
}

/** A node and all its descendants, for cross-checks that must see everything. */
export function walkNodes(node: PageNode): PageNode[] {
  return [node, ...(node.children ?? []).flatMap(walkNodes)];
}

export interface PageDef {
  name: string;
  title?: string;
  /** Columns; each column stacks one or more slots. YAML accepts `slot` or `[a, b]` per entry. */
  layout: string[][];
  /** Optional flex weights, same length as layout. */
  widths?: number[];
  slots: Record<string, PageNode>;
  /**
   * Client-local state vocabulary (iteration 2, born from the reports app's
   * selection problem): values that are neither domain facts nor projection
   * output — which item the viewer highlighted. Still data: declared here,
   * set only by `local:<key>` wiring, read via `$key` segments in binds, and
   * gone on refresh unless a default_bind re-derives it from the view.
   */
  locals?: Record<string, { default_bind?: string }>;
}

export interface AppManifest {
  app: string;
  title: string;
  scope: "per-user" | "shared";
  dir: string;
  actions: Record<string, ActionSpec>;
  agents: Record<string, AgentDef>;
  pages: Record<string, PageDef>;
  /** Page names opted into feishu card projection (card-grade widgets only). */
  feishuCards: string[];
  /** Declared clocks (engine appends `emit` as system:deadline when due). */
  deadlines: import("./deadlines.js").DeadlineDef[];
  /** Purely descriptive state machines, rendered by the factory page. */
  flows: Array<{ name: string; states: string[]; transitions: Array<{ from: string; to: string; via: string }> }>;
}

export class ManifestError extends Error {
  constructor(
    readonly file: string,
    readonly problems: string[],
  ) {
    super(`${file}:\n  - ${problems.join("\n  - ")}`);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const PARAM_TYPES = ["string", "number", "boolean", "object"];

function parseParams(raw: unknown, where: string, problems: string[]): Record<string, ParamSpec> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    problems.push(`${where}: params must be a map`);
    return {};
  }
  const out: Record<string, ParamSpec> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!isRecord(val)) {
      problems.push(`${where}.${key}: must be a map like {type: string, required: true}`);
      continue;
    }
    const type = val.type;
    if (typeof type !== "string" || !PARAM_TYPES.includes(type)) {
      problems.push(`${where}.${key}.type: must be one of ${PARAM_TYPES.join("/")}`);
      continue;
    }
    const enumBind = val.enum_bind;
    if (enumBind !== undefined && (typeof enumBind !== "string" || !/^view(\.[\w-]+)*$/.test(enumBind))) {
      problems.push(`${where}.${key}.enum_bind: must be a plain "view.…" path`);
    }
    out[key] = {
      type: type as ParamSpec["type"],
      required: val.required === true,
      enum: Array.isArray(val.enum) ? val.enum.map(String) : undefined,
      enumBind: typeof enumBind === "string" ? enumBind : undefined,
      description: typeof val.description === "string" ? val.description : undefined,
    };
  }
  return out;
}

function parseActions(raw: unknown, problems: string[]): Record<string, ActionSpec> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    problems.push("actions: must be a map of action name → spec");
    return {};
  }
  const out: Record<string, ActionSpec> = {};
  const ACTION_KEYS = ["title", "description", "predicate", "human_only", "agent_only", "confirm", "feishu", "params"];
  for (const [name, val] of Object.entries(raw)) {
    if (!isRecord(val)) {
      problems.push(`actions.${name}: must be a map`);
      continue;
    }
    for (const k of Object.keys(val)) {
      if (!ACTION_KEYS.includes(k)) {
        problems.push(`actions.${name}: unknown key "${k}" (allowed: ${ACTION_KEYS.join(", ")}) — typos must not pass silently`);
      }
    }
    const predicate = val.predicate;
    if (typeof predicate !== "string" || !PREDICATES.includes(predicate as Predicate)) {
      problems.push(
        `actions.${name}.predicate: required, one of ${PREDICATES.join("/")} (authorization is explicit, never defaulted)`,
      );
      continue;
    }
    out[name] = {
      name,
      title: typeof val.title === "string" ? val.title : undefined,
      description: typeof val.description === "string" ? val.description : undefined,
      predicate: predicate as Predicate,
      humanOnly: val.human_only === true,
      agentOnly: val.agent_only === true,
      confirm: val.confirm === true,
      feishu: val.feishu === true,
      params: parseParams(val.params, `actions.${name}.params`, problems),
    };
  }
  return out;
}

function parseAgents(raw: unknown, problems: string[]): Record<string, AgentDef> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    problems.push("agents: must be a map of agent name → spec");
    return {};
  }
  const out: Record<string, AgentDef> = {};
  for (const [name, val] of Object.entries(raw)) {
    if (!isRecord(val)) {
      problems.push(`agents.${name}: must be a map`);
      continue;
    }
    const adapter = val.adapter;
    if (adapter !== "openai-loop" && adapter !== "claude-code" && adapter !== "codex") {
      problems.push(`agents.${name}.adapter: must be one of openai-loop / claude-code / codex`);
      continue;
    }
    // SEC-06: the ban is enforced at LOAD, not at the first turn. A manifest
    // that names a coding CLI on a cloud-multi-user host is a configuration
    // error the operator must see at boot — waiting until somebody chats with
    // the agent would mean the app looks installed and working until the
    // moment it does not.
    const verdict = appAgentAdapterVerdict(adapter);
    if (!verdict.ok && verdict.code === "profile_forbids_coding_cli") {
      problems.push(`agents.${name}.adapter: ${verdict.reason}`);
      continue;
    }
    const daily = val.daily;
    if (daily !== undefined && !(typeof daily === "string" && /^\d{2}:\d{2}$/.test(daily))) {
      problems.push(`agents.${name}.daily: must be "HH:MM"`);
    }
    out[name] = {
      name,
      adapter,
      prompt: typeof val.prompt === "string" ? val.prompt : undefined,
      model: typeof val.model === "string" ? val.model : undefined,
      effort: typeof val.effort === "string" ? val.effort : undefined,
      daily: typeof daily === "string" ? daily : undefined,
      dailyPrompt: typeof val.daily_prompt === "string" ? val.daily_prompt : undefined,
    };
  }
  return out;
}

function parseDeadlines(raw: unknown, problems: string[]): AppManifest["deadlines"] {
  if (raw === undefined) return [];
  if (!isRecord(raw)) {
    problems.push("deadlines: must be a map of name → {start, cancel, after_s, emit}");
    return [];
  }
  const out: AppManifest["deadlines"] = [];
  for (const [name, val] of Object.entries(raw)) {
    if (!isRecord(val) || typeof val.start !== "string" || typeof val.emit !== "string") {
      problems.push(`deadlines.${name}: needs start (event type) and emit (event type)`);
      continue;
    }
    const afterS = Number(val.after_s);
    if (!Number.isFinite(afterS) || afterS <= 0) {
      problems.push(`deadlines.${name}.after_s: must be a positive number of seconds`);
      continue;
    }
    const cancel = Array.isArray(val.cancel) ? val.cancel.map(String) : [];
    out.push({ name, start: val.start, cancel, afterS, emit: val.emit });
  }
  return out;
}

function parseFlows(raw: unknown, problems: string[]): AppManifest["flows"] {
  if (raw === undefined) return [];
  if (!isRecord(raw)) {
    problems.push("flows: must be a map of name → {states, transitions}");
    return [];
  }
  const out: AppManifest["flows"] = [];
  for (const [name, val] of Object.entries(raw)) {
    if (!isRecord(val) || !Array.isArray(val.states) || !val.states.length) {
      problems.push(`flows.${name}: needs states (non-empty list)`);
      continue;
    }
    const states = val.states.map(String);
    const transitions: Array<{ from: string; to: string; via: string }> = [];
    for (const t of Array.isArray(val.transitions) ? val.transitions : []) {
      if (!isRecord(t) || typeof t.from !== "string" || typeof t.to !== "string" || typeof t.via !== "string") {
        problems.push(`flows.${name}.transitions: each needs {from, to, via}`);
        continue;
      }
      if (!states.includes(t.from) || !states.includes(t.to)) {
        problems.push(`flows.${name}: transition ${t.from}→${t.to} references undeclared states`);
        continue;
      }
      transitions.push({ from: t.from, to: t.to, via: t.via });
    }
    out.push({ name, states, transitions });
  }
  return out;
}

function parsePageNode(raw: unknown, where: string, problems: string[]): PageNode | null {
  if (!isRecord(raw)) {
    problems.push(`${where}: must be a map like {widget: list, bind: view.items}`);
    return null;
  }
  for (const k of Object.keys(raw)) {
    if (!["widget", "bind", "props", "on", "agent", "children"].includes(k)) {
      problems.push(`${where}: unknown key "${k}" (allowed: widget, bind, props, on, agent, children)`);
    }
  }
  const widget = raw.widget;
  if (typeof widget !== "string" || !WIDGETS[widget]) {
    problems.push(
      `${where}.widget: unknown widget "${String(widget)}" — catalog: ${Object.keys(WIDGETS).join(", ")}`,
    );
    return null;
  }
  const def = WIDGETS[widget];
  const node: PageNode = { widget };
  if (raw.children !== undefined) {
    if (!def.container) {
      problems.push(`${where}.children: widget "${widget}" is not a container`);
    } else if (!Array.isArray(raw.children) || !raw.children.length) {
      problems.push(`${where}.children: must be a non-empty list of nodes`);
    } else {
      node.children = raw.children
        .map((c, i) => parsePageNode(c, `${where}.children[${i}]`, problems))
        .filter((c): c is PageNode => c !== null);
    }
  } else if (def.container) {
    problems.push(`${where}: container widget "${widget}" needs children`);
  }
  if (raw.bind !== undefined) {
    if (typeof raw.bind !== "string" || !/^view(\.([\w-]+|\$[\w-]+))*$/.test(raw.bind)) {
      problems.push(`${where}.bind: must be a dotted path starting at "view" ($key segments read page locals)`);
    } else node.bind = raw.bind;
  }
  if (raw.props !== undefined) {
    if (!isRecord(raw.props)) problems.push(`${where}.props: must be a map`);
    else node.props = raw.props;
  }
  if (raw.agent !== undefined) {
    if (typeof raw.agent !== "string") problems.push(`${where}.agent: must be an agent name`);
    else node.agent = raw.agent;
  }
  if (raw.on !== undefined) {
    if (!isRecord(raw.on)) {
      problems.push(`${where}.on: must be a map of event → "action:<name>"`);
    } else {
      node.on = {};
      for (const [ev, target] of Object.entries(raw.on)) {
        if (!(def.events ?? []).includes(ev)) {
          problems.push(`${where}.on.${ev}: widget "${widget}" emits no such event (has: ${(def.events ?? []).join(", ") || "none"})`);
          continue;
        }
        if (typeof target !== "string" || !(target.startsWith("action:") || target.startsWith("local:"))) {
          problems.push(
            `${where}.on.${ev}: wiring targets are "action:<name>" or "local:<key>" — pages may wire, never compute`,
          );
          continue;
        }
        node.on[ev] = target;
      }
    }
  }
  return node;
}

function parsePage(name: string, raw: unknown, file: string, problems: string[]): PageDef | null {
  if (!isRecord(raw)) {
    problems.push(`${file}: page must be a map`);
    return null;
  }
  const layoutRaw = raw.layout;
  const okEntry = (s: unknown) =>
    typeof s === "string" || (Array.isArray(s) && s.length > 0 && s.every((x) => typeof x === "string"));
  if (!Array.isArray(layoutRaw) || !layoutRaw.length || !layoutRaw.every(okEntry)) {
    problems.push(`${file}: layout must be a non-empty list of slot names (or [a, b] column stacks)`);
    return null;
  }
  const layout: string[][] = layoutRaw.map((s) => (typeof s === "string" ? [s] : (s as string[])));
  const slotsRaw = raw.slots;
  if (!isRecord(slotsRaw)) {
    problems.push(`${file}: slots must be a map of slot name → widget node`);
    return null;
  }
  const slots: Record<string, PageNode> = {};
  const invalidSlots = new Set<string>();
  for (const [slot, nodeRaw] of Object.entries(slotsRaw)) {
    const node = parsePageNode(nodeRaw, `${file}: slots.${slot}`, problems);
    if (node) slots[slot] = node;
    else invalidSlots.add(slot); // defined but broken — do NOT also claim it's missing
  }
  for (const slot of layout.flat()) {
    if (!slots[slot] && !invalidSlots.has(slot)) {
      problems.push(`${file}: layout references slot "${slot}" which is not defined`);
    }
  }
  const widths = raw.widths;
  if (widths !== undefined && (!Array.isArray(widths) || widths.length !== layout.length)) {
    problems.push(`${file}: widths must match layout length`);
  }
  let locals: PageDef["locals"];
  if (raw.locals !== undefined) {
    if (!isRecord(raw.locals)) {
      problems.push(`${file}: locals must be a map of key → {default_bind?}`);
    } else {
      locals = {};
      for (const [key, val] of Object.entries(raw.locals)) {
        if (!/^[\w-]+$/.test(key) || !isRecord(val)) {
          problems.push(`${file}: locals.${key}: key must be a slug, value a map`);
          continue;
        }
        const db = val.default_bind;
        if (db !== undefined && (typeof db !== "string" || !/^view(\.[\w-]+)*$/.test(db))) {
          problems.push(`${file}: locals.${key}.default_bind: must be a plain "view.…" path`);
          continue;
        }
        locals[key] = { default_bind: typeof db === "string" ? db : undefined };
      }
    }
  }
  return {
    name,
    title: typeof raw.title === "string" ? raw.title : undefined,
    layout,
    widths: Array.isArray(widths) ? widths.map(Number) : undefined,
    slots,
    locals,
  };
}

/** Cross-checks that need the whole manifest: wiring/form/actions targets, agents, feishu grade. */
function crossCheck(m: AppManifest, problems: string[]): void {
  for (const [pageName, page] of Object.entries(m.pages)) {
    // Local keys usable on this page = declared locals ∪ keys some wiring sets.
    const localKeys = new Set<string>(Object.keys(page.locals ?? {}));
    for (const node of Object.values(page.slots)) {
      for (const target of Object.values(node.on ?? {})) {
        if (target.startsWith("local:")) localKeys.add(target.slice("local:".length));
      }
    }
    for (const [slot, root] of Object.entries(page.slots)) {
      for (const node of walkNodes(root)) {
      const where = `pages.${pageName}.slots.${slot}`;
      for (const target of Object.values(node.on ?? {})) {
        if (target.startsWith("local:")) continue;
        const action = target.slice("action:".length);
        if (!m.actions[action]) problems.push(`${where}: wired to unknown action "${action}"`);
      }
      for (const seg of (node.bind ?? "").split(".")) {
        if (seg.startsWith("$") && !localKeys.has(seg.slice(1))) {
          problems.push(
            `${where}: bind uses $${seg.slice(1)} but no locals declaration or "local:${seg.slice(1)}" wiring sets it`,
          );
        }
      }
      if (node.widget === "form") {
        const action = String(node.props?.action ?? "");
        if (!m.actions[action]) problems.push(`${where}: form props.action must name a declared action`);
      }
      if (node.widget === "actions") {
        const items = node.props?.items;
        if (!Array.isArray(items) || !items.length) {
          problems.push(`${where}: actions widget needs props.items = [{action, label?}]`);
        } else {
          for (const it of items) {
            const action = isRecord(it) ? String(it.action ?? "") : "";
            if (!m.actions[action]) problems.push(`${where}: button references unknown action "${action}"`);
          }
        }
      }
      if (node.widget === "agent-chat") {
        const agent = node.agent ?? "";
        if (!m.agents[agent]) problems.push(`${where}: agent-chat must bind a declared agent (agents.${agent || "<name>"})`);
      }
      }
    }
  }
  for (const cardPage of m.feishuCards) {
    const page = m.pages[cardPage];
    if (!page) {
      problems.push(`feishu.cards: unknown page "${cardPage}"`);
      continue;
    }
    for (const [slot, root] of Object.entries(page.slots)) {
      for (const node of walkNodes(root)) {
        if (!WIDGETS[node.widget].cardGrade) {
          problems.push(
            `feishu.cards: page "${cardPage}" slot "${slot}" uses rich widget "${node.widget}" — card pages may use card-grade widgets only`,
          );
        }
      }
    }
  }
}

export function loadApp(dir: string): AppManifest {
  const appFile = path.join(dir, "app.yaml");
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(appFile, "utf8"));
  } catch (err) {
    throw new ManifestError(appFile, [String((err as Error).message ?? err)]);
  }
  if (!isRecord(raw)) throw new ManifestError(appFile, ["app.yaml must be a map"]);

  const app = typeof raw.app === "string" ? raw.app : "";
  if (!/^[a-z][a-z0-9_-]*$/.test(app)) problems.push('app: required, lowercase slug (e.g. "hq")');
  const scope = raw.scope ?? "per-user";
  if (scope !== "per-user" && scope !== "shared") problems.push("scope: must be per-user or shared");

  const manifest: AppManifest = {
    app,
    title: typeof raw.title === "string" ? raw.title : app,
    scope: scope as "per-user" | "shared",
    dir,
    actions: parseActions(raw.actions, problems),
    agents: parseAgents(raw.agents, problems),
    pages: {},
    feishuCards: [],
    deadlines: parseDeadlines(raw.deadlines, problems),
    flows: parseFlows(raw.flows, problems),
  };

  const pagesRaw = raw.pages;
  if (pagesRaw !== undefined) {
    if (!isRecord(pagesRaw)) {
      problems.push("pages: must be a map of page name → yaml path or inline map");
    } else {
      for (const [name, val] of Object.entries(pagesRaw)) {
        let pageRaw: unknown = val;
        let file = `pages.${name}`;
        if (typeof val === "string") {
          const pageFile = path.join(dir, val);
          file = val;
          try {
            pageRaw = yaml.load(fs.readFileSync(pageFile, "utf8"));
          } catch (err) {
            problems.push(`${val}: ${String((err as Error).message ?? err)}`);
            continue;
          }
        }
        const page = parsePage(name, pageRaw, file, problems);
        if (page) manifest.pages[name] = page;
      }
    }
  }

  const feishu = raw.feishu;
  if (feishu !== undefined) {
    if (!isRecord(feishu) || (feishu.cards !== undefined && !Array.isArray(feishu.cards))) {
      problems.push("feishu: must be a map, feishu.cards a list of page names");
    } else {
      manifest.feishuCards = ((feishu.cards ?? []) as unknown[]).map(String);
    }
  }

  // Files the runtime will need must exist NOW, not at first dispatch: a
  // silent pass here is a runtime surprise later (probe experiment #5's
  // finding — missing prompt files and handlers sailed through).
  if (!fs.existsSync(path.join(dir, "projection.ts"))) {
    problems.push("projection.ts missing — every app is a fold over its log");
  }
  if (Object.keys(manifest.actions).length && !fs.existsSync(path.join(dir, "actions.ts"))) {
    problems.push("actions.ts missing but actions are declared");
  }
  for (const agent of Object.values(manifest.agents)) {
    if (agent.prompt && !fs.existsSync(path.join(dir, agent.prompt))) {
      problems.push(`agents.${agent.name}.prompt: file "${agent.prompt}" does not exist`);
    }
  }

  crossCheck(manifest, problems);
  if (problems.length) throw new ManifestError(appFile, problems);
  return manifest;
}

/** Load every subdirectory of `appsDir` that contains an app.yaml. */
export function loadAppsDir(appsDir: string): AppManifest[] {
  if (!fs.existsSync(appsDir)) return [];
  const out: AppManifest[] = [];
  for (const entry of fs.readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(appsDir, entry.name);
    if (!fs.existsSync(path.join(dir, "app.yaml"))) continue;
    out.push(loadApp(dir));
  }
  return out.sort((a, b) => a.app.localeCompare(b.app));
}
