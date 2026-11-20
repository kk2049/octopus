/**
 * The ABI's refusals, one per way a release could be wrong.
 *
 * Round-tripping is asserted as byte equality rather than deep equality: these
 * documents are release ASSETS, so their bytes decide `packageDigest` and
 * therefore the hostname. A normaliser that produced equal objects but different
 * bytes would make the same plan mint two identities.
 */

import { describe, expect, it } from "vitest";
import {
  COMPOSITION_SCHEMA,
  MODULE_LOCK_SCHEMA,
  OPEN_RESOURCE_INTENT,
  WORKSPACE_SLOTS,
  encodeComposition,
  encodeModuleLock,
  linkComposition,
  moduleLockOf,
  openResource,
  parseComposition,
  parseModuleLock,
  readComposition,
  readModuleBundle,
  readModuleLock,
  readModuleManifest,
  readOpenResourceIntent,
  type AgentComposition,
  type AgentModuleManifest,
  type ContractIssueCode,
} from "./index.js";

const ROSTER: AgentModuleManifest = {
  id: "session.roster-tree/v1",
  version: "1.0.0",
  implementation: "@claude-bot/agent-sessions-view#SessionRoster",
  title: "会话",
  slots: ["navigation"],
  ports: ["agent-sessions/v1"],
  opens: [],
};

const CHAT: AgentModuleManifest = {
  id: "agent.chat/v1",
  version: "1.0.0",
  implementation: "@claude-bot/agent-sessions-view#AgentChat",
  title: "会话正文",
  slots: ["primary", "secondary"],
  ports: ["agent-sessions/v1"],
  opens: ["session"],
};

const LOCK = moduleLockOf([CHAT, ROSTER]);

const COMPOSITION: AgentComposition = {
  schema: COMPOSITION_SCHEMA,
  app: "session-plus",
  instances: [
    { instance: "roster", module: ROSTER.id, slot: "navigation" },
    { instance: "chat", module: CHAT.id, slot: "primary" },
  ],
  open: [{ resource: "session", module: CHAT.id, slot: "primary", mode: "reuse" }],
};

function codes(result: { ok: boolean; issues?: Array<{ code: ContractIssueCode }> }): ContractIssueCode[] {
  return (result.issues ?? []).map((issue) => issue.code);
}

describe("module manifest", () => {
  it("normalises slot order so equal declarations encode alike", () => {
    const a = readModuleManifest({ ...CHAT, slots: ["secondary", "primary"] });
    const b = readModuleManifest(CHAT);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.slots).toEqual(["primary", "secondary"]);
    expect(a.value).toEqual(b.value);
  });

  it("refuses a repeated slot or port instead of quietly de-duplicating it", () => {
    expect(codes(readModuleManifest({ ...CHAT, slots: ["primary", "primary"] }))).toContain("duplicate");
    expect(codes(readModuleManifest({ ...CHAT, ports: ["agent-sessions/v1", "agent-sessions/v1"] })))
      .toContain("duplicate");
  });

  it("refuses an unknown field rather than ignoring it", () => {
    const result = readModuleManifest({ ...CHAT, endpoint: "https://example.test" });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("unknown_field");
  });

  it("refuses a version range, an odd module id and an empty slot list", () => {
    expect(codes(readModuleManifest({ ...CHAT, version: "^1.0.0" }))).toContain("version");
    expect(codes(readModuleManifest({ ...CHAT, id: "AgentChat" }))).toContain("identifier");
    expect(codes(readModuleManifest({ ...CHAT, slots: [] }))).toContain("empty");
    expect(codes(readModuleManifest({ ...CHAT, slots: ["sidebar"] }))).toContain("slot");
  });

  it("refuses an implementation that looks like a URL to fetch", () => {
    expect(codes(readModuleManifest({ ...CHAT, implementation: "https://cdn.example/x.js?a=1" }))).toContain(
      "identifier",
    );
  });
});

describe("module lock", () => {
  it("round-trips byte for byte and sorts by module id", () => {
    const text = encodeModuleLock(LOCK);
    const parsed = parseModuleLock(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(encodeModuleLock(parsed.value)).toBe(text);
    expect(parsed.value.modules.map((row) => row.id)).toEqual(["agent.chat/v1", "session.roster-tree/v1"]);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("is derived from manifests, so it cannot disagree with the bundle", () => {
    expect(LOCK.modules).toEqual([
      { id: CHAT.id, version: CHAT.version, implementation: CHAT.implementation },
      { id: ROSTER.id, version: ROSTER.version, implementation: ROSTER.implementation },
    ]);
    expect(() => moduleLockOf([CHAT, CHAT])).toThrow(/twice/);
  });

  it("refuses a wrong schema, a duplicate id, an empty list and a non-object entry", () => {
    expect(codes(readModuleLock({ ...LOCK, schema: "agent-module-lock/v2" }))).toContain("schema");
    expect(codes(readModuleLock({ schema: MODULE_LOCK_SCHEMA, modules: [LOCK.modules[0], LOCK.modules[0]] })))
      .toContain("duplicate");
    expect(codes(readModuleLock({ schema: MODULE_LOCK_SCHEMA, modules: [] }))).toContain("empty");
    expect(codes(readModuleLock({ schema: MODULE_LOCK_SCHEMA, modules: ["agent.chat/v1"] }))).toContain(
      "not_an_object",
    );
  });

  it("reports unparseable bytes as a refusal, not an exception", () => {
    const result = parseModuleLock("{not json");
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["json"]);
  });
});

describe("composition", () => {
  it("round-trips byte for byte, including the optional fields it omits", () => {
    const text = encodeComposition(COMPOSITION);
    const parsed = parseComposition(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(encodeComposition(parsed.value)).toBe(text);
    expect(text).not.toContain("\"title\"");
    expect(JSON.parse(text)).toEqual(JSON.parse(encodeComposition(parsed.value)));
  });

  it("refuses a duplicate instance id — it keys a reader's unsaved draft", () => {
    const result = readComposition({
      ...COMPOSITION,
      instances: [COMPOSITION.instances[0], { ...COMPOSITION.instances[1], instance: "roster" }],
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("duplicate");
  });

  it("refuses an unknown slot, an unknown open mode and an unknown field", () => {
    expect(
      codes(readComposition({ ...COMPOSITION, instances: [{ instance: "x", module: CHAT.id, slot: "sidebar" }] })),
    ).toContain("slot");
    expect(
      codes(readComposition({ ...COMPOSITION, open: [{ resource: "session", module: CHAT.id, slot: "primary", mode: "tab" }] })),
    ).toContain("open_mode");
    expect(codes(readComposition({ ...COMPOSITION, layout: { tree: [] } }))).toContain("unknown_field");
  });

  it("refuses a module the lock does not contain", () => {
    const result = linkComposition(
      { ...COMPOSITION, instances: [{ instance: "files", module: "workspace.files/v1", slot: "secondary" }] },
      LOCK,
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["unknown_module"]);
  });

  it("enforces the manifests' own slot and open declarations when a registry is present", () => {
    const manifests = new Map([
      [CHAT.id, CHAT],
      [ROSTER.id, ROSTER],
    ]);
    const wrongSlot = linkComposition(
      { ...COMPOSITION, instances: [{ instance: "roster", module: ROSTER.id, slot: "bottom" }] },
      LOCK,
      manifests,
    );
    expect(codes(wrongSlot)).toContain("slot");
    const wrongKind = linkComposition(
      { ...COMPOSITION, open: [{ resource: "session", module: ROSTER.id, slot: "navigation" }] },
      LOCK,
      manifests,
    );
    expect(codes(wrongKind)).toContain("identifier");
    expect(linkComposition(COMPOSITION, LOCK, manifests).ok).toBe(true);
  });

  it("requires a supplied registry and lock to name the exact same implementations", () => {
    const manifests = new Map([
      [CHAT.id, CHAT],
      [ROSTER.id, ROSTER],
    ]);
    const changedVersion = {
      ...LOCK,
      modules: LOCK.modules.map((entry) =>
        entry.id === CHAT.id ? { ...entry, version: "9.9.9" } : entry),
    };
    expect(codes(linkComposition(COMPOSITION, changedVersion, manifests))).toContain("module_identity");

    const changedImplementation = {
      ...LOCK,
      modules: LOCK.modules.map((entry) =>
        entry.id === CHAT.id ? { ...entry, implementation: "other-package#Chat" } : entry),
    };
    expect(codes(linkComposition(COMPOSITION, changedImplementation, manifests))).toContain("module_identity");

    const extra: AgentModuleManifest = {
      ...CHAT,
      id: "demo.extra/v1",
      implementation: "test#Extra",
    };
    expect(codes(linkComposition(COMPOSITION, moduleLockOf([CHAT, ROSTER, extra]), manifests)))
      .toContain("unknown_module");
  });

  it("refuses a module MISSING from a supplied registry rather than skipping its checks", () => {
    // The same rule `linkResourceBindings` follows, and the same reason:
    // supplying a registry is a caller saying "these are the modules that
    // exist". Skipping the slot and open checks for one that is not there is the
    // worst of the three outcomes, because it reads as a pass — which is exactly
    // how a release could declare a placement no manifest allows and still
    // activate.
    const partial = new Map([[CHAT.id, CHAT]]);
    const instances = linkComposition(COMPOSITION, LOCK, partial);
    expect(instances.ok).toBe(false);
    expect(codes(instances)).toContain("unknown_module");

    // And with no registry at all it is still only a well-formedness check, so
    // the callers that legitimately have the JSON and no components are not
    // forced to invent manifests.
    expect(linkComposition(COMPOSITION, LOCK).ok).toBe(true);
  });

  it("reads both documents together, and refuses when either one is wrong", () => {
    const good = readModuleBundle({
      lockText: encodeModuleLock(LOCK),
      compositionText: encodeComposition(COMPOSITION),
    });
    expect(good.ok).toBe(true);
    const bad = readModuleBundle({
      lockText: encodeModuleLock(moduleLockOf([ROSTER])),
      compositionText: encodeComposition(COMPOSITION),
    });
    expect(bad.ok).toBe(false);
    expect(codes(bad)).toContain("unknown_module");
  });
});

describe("open-resource/v1", () => {
  const link = { kind: "session", ref: "res-1", label: "Session Plus" };

  it("defaults to nothing: no view, no slot and no mode unless asked for", () => {
    const result = openResource(link);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ intent: OPEN_RESOURCE_INTENT, resource: link });
  });

  it("carries an explicit view, slot and mode", () => {
    const result = openResource(link, { view: CHAT.id, slot: "secondary", mode: "new" });
    expect(result.ok && result.value.mode).toBe("new");
    expect(result.ok && result.value.slot).toBe("secondary");
  });

  it("refuses a made-up slot, a made-up mode and a view that is not a module id", () => {
    expect(codes(openResource(link, { slot: "sidebar" as never }))).toContain("slot");
    expect(codes(openResource(link, { mode: "tab" as never }))).toContain("open_mode");
    expect(codes(openResource(link, { view: "https://cdn.example/chat.js" }))).toContain("identifier");
  });

  it("refuses a resource that is not a bounded printable ref", () => {
    expect(codes(openResource({ ...link, ref: "" }))).toContain("identifier");
    expect(codes(openResource({ ...link, ref: "x".repeat(400) }))).toContain("limit");
    expect(codes(readOpenResourceIntent({ intent: "open-resource/v2", resource: link }))).toContain("schema");
  });
});

describe("slots", () => {
  it("are exactly five, in a fixed order", () => {
    expect(WORKSPACE_SLOTS).toEqual(["navigation", "primary", "secondary", "bottom", "overlay"]);
  });
});

describe("instance config (decision 7)", () => {
  const declaring: AgentModuleManifest = {
    id: "demo.list/v1",
    version: "1.0.0",
    implementation: "demo#List",
    title: "列表",
    slots: ["secondary"],
    ports: [],
    opens: [],
    config: {
      source: { type: "string", required: true, description: "projection 路径" },
      page_size: { type: "number" },
      dense: { type: "boolean" },
    },
  };
  const registry = new Map([[declaring.id, declaring]]);
  const lock = moduleLockOf([declaring]);
  const compositionWith = (config?: Record<string, unknown>): unknown => ({
    schema: COMPOSITION_SCHEMA,
    app: "demo",
    instances: [
      config === undefined
        ? { instance: "inbox", module: declaring.id, slot: "secondary" }
        : { instance: "inbox", module: declaring.id, slot: "secondary", config },
    ],
    open: [],
  });

  it("round-trips a manifest declaration and a configured composition to identical bytes", () => {
    const read = readModuleManifest(declaring);
    expect(read.ok).toBe(true);
    // Declaration keys come back sorted, fields in {type, required?, description?} order.
    if (read.ok) expect(Object.keys(read.value.config!)).toEqual(["dense", "page_size", "source"]);

    const composition = readComposition(compositionWith({ source: "view.inbox", dense: true }));
    expect(composition.ok).toBe(true);
    if (!composition.ok) return;
    const bytes = encodeComposition(composition.value);
    const reparsed = parseComposition(bytes);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(encodeComposition(reparsed.value)).toBe(bytes);
  });

  it("refuses declaration shapes that would blur the one-representation rule", () => {
    expect(codes(readModuleManifest({ ...declaring, config: {} }))).toContain("empty");
    expect(codes(readModuleManifest({ ...declaring, config: { "Bad-Key": { type: "string" } } }))).toContain("identifier");
    expect(codes(readModuleManifest({ ...declaring, config: { a: { type: "json" } } }))).toContain("field_type");
    expect(codes(readModuleManifest({ ...declaring, config: { a: { type: "string", extra: 1 } } }))).toContain("unknown_field");
  });

  it("refuses value shapes on the instance regardless of any registry", () => {
    expect(codes(readComposition(compositionWith({})))).toContain("empty");
    expect(codes(readComposition(compositionWith({ source: { nested: true } })))).toContain("field_type");
    expect(codes(readComposition(compositionWith({ source: "x".repeat(600) })))).toContain("limit");
    expect(codes(readComposition(compositionWith({ page_size: Number.POSITIVE_INFINITY })))).toContain("field_type");
  });

  it("checks values against the module's declaration exactly where a registry is supplied", () => {
    const ok = readComposition(compositionWith({ source: "view.inbox", page_size: 20 }));
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(linkComposition(ok.value, lock, registry).ok).toBe(true);

    const unknownKey = readComposition(compositionWith({ source: "view.inbox", sort: "desc" }));
    if (unknownKey.ok) {
      expect(codes(linkComposition(unknownKey.value, lock, registry))).toContain("unknown_field");
      // Without a registry the same document is merely well-formed — the
      // 2026-08-07 rule: manifest-backed questions only where manifests are
      // honestly the bundle's own.
      expect(linkComposition(unknownKey.value, lock).ok).toBe(true);
    }

    const wrongType = readComposition(compositionWith({ source: 5 }));
    if (wrongType.ok) expect(codes(linkComposition(wrongType.value, lock, registry))).toContain("field_type");

    const missingRequired = readComposition(compositionWith({ dense: true }));
    if (missingRequired.ok) {
      expect(codes(linkComposition(missingRequired.value, lock, registry))).toContain("missing_field");
    }
  });
});

describe("intent context (decision 7)", () => {
  const link = { kind: "workspace-text", ref: "wsf-9", label: "main.ts" };

  it("carries a bounded, sorted string map and survives the reader untouched", () => {
    const intent = openResource(link, { context: { line: "120", column: "4" } });
    expect(intent.ok).toBe(true);
    if (!intent.ok) return;
    expect(intent.value.context).toEqual({ column: "4", line: "120" });
    expect(Object.keys(intent.value.context!)).toEqual(["column", "line"]);
    // Same reader as an intent arriving from anywhere else.
    const reread = readOpenResourceIntent(intent.value);
    expect(reread.ok).toBe(true);
    if (reread.ok) expect(reread.value.context).toEqual(intent.value.context);
  });

  it("refuses what the bounds exist for", () => {
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, "v"]));
    expect(codes(openResource(link, { context: many }))).toContain("limit");
    expect(codes(openResource(link, { context: { line: "x".repeat(600) } }))).toContain("limit");
    expect(codes(openResource(link, { context: { "Bad Key": "v" } }))).toContain("identifier");
    expect(codes(openResource(link, { context: {} }))).toContain("empty");
    expect(codes(openResource(link, { context: { line: 120 as never } }))).toContain("limit");
  });
});
