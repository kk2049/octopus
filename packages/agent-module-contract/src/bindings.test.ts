/**
 * `agent-resource-bindings`, both schemas, and the refusals that make a plan.
 *
 * The interesting cases are all the ones where a document is *nearly* right: a
 * binding declared twice, a connection naming a binding that does not exist, a
 * module wired to a port it never asked for, a plan for one App linked against
 * another's composition. Each of those, accepted, would silently hand a module a
 * provider somebody else chose.
 */

import { describe, expect, it } from "vitest";
import {
  RESOURCE_BINDINGS_SCHEMA,
  RESOURCE_BINDINGS_SCHEMA_V2,
  RESOURCE_TEMPLATE_MAX_INSTANCES,
  bindingContract,
  connectionFor,
  encodeResourceBindings,
  linkResourceBindings,
  parseResourceBindings,
  planTemplates,
  readResourceBindings,
  templateFor,
  type AgentResourceBindingsV2,
  type ResourceBindingPlan,
} from "./bindings.js";
import { readComposition, type AgentComposition } from "./composition.js";
import { readModuleManifest, type AgentModuleManifest } from "./manifest.js";

const PLAN = {
  schema: RESOURCE_BINDINGS_SCHEMA,
  app: "super-workspace",
  bindings: [{ binding: "workspace", contract: "workspace-files/v1" }],
  connections: [{ instance: "files", port: "workspace-files/v1", binding: "workspace" }],
};

const COMPOSITION_DOC = {
  schema: "agent-composition/v1",
  app: "super-workspace",
  instances: [
    { instance: "files", module: "workspace.tree/v1", slot: "navigation" },
    { instance: "chat", module: "agent.chat/v1", slot: "primary" },
  ],
  open: [],
};

const MANIFEST_DOC = {
  id: "workspace.tree/v1",
  version: "1.0.0",
  implementation: "@claude-bot/workspace-view#tree",
  title: "文件",
  slots: ["navigation"],
  ports: ["workspace-files/v1"],
  opens: ["file"],
};

function plan(overrides: Record<string, unknown> = {}): unknown {
  return { ...PLAN, ...overrides };
}

function readOk(value: unknown): ResourceBindingPlan {
  const result = readResourceBindings(value);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.issues)}`);
  return result.value;
}

function composition(overrides: Record<string, unknown> = {}): AgentComposition {
  const result = readComposition({ ...COMPOSITION_DOC, ...overrides });
  if (!result.ok) throw new Error(`bad fixture: ${JSON.stringify(result.issues)}`);
  return result.value;
}

function manifests(overrides: Record<string, unknown> = {}): Map<string, AgentModuleManifest> {
  const result = readModuleManifest({ ...MANIFEST_DOC, ...overrides });
  if (!result.ok) throw new Error(`bad fixture: ${JSON.stringify(result.issues)}`);
  const chat = readModuleManifest({
    id: "agent.chat/v1",
    version: "1.0.0",
    implementation: "@claude-bot/agent-view#chat",
    title: "Chat",
    slots: ["primary"],
    ports: ["agent-sessions/v1"],
    opens: ["session"],
  });
  if (!chat.ok) throw new Error(`bad fixture: ${JSON.stringify(chat.issues)}`);
  return new Map([[result.value.id, result.value], [chat.value.id, chat.value]]);
}

function codes(value: unknown): string[] {
  const result = readResourceBindings(value);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe("reading a plan", () => {
  it("accepts the documented shape and exposes what it declares", () => {
    const read = readOk(PLAN);
    expect(read.app).toBe("super-workspace");
    expect(bindingContract(read, "workspace")).toBe("workspace-files/v1");
    expect(bindingContract(read, "nope")).toBeUndefined();
    expect(connectionFor(read, "files", "workspace-files/v1")?.binding).toBe("workspace");
    expect(connectionFor(read, "files", "agent-sessions/v1")).toBeUndefined();
  });

  it("allows an App to declare a dependency it has not wired to anything yet", () => {
    // Bindings without connections is a real state: the deployment must provide
    // the port before a module can be added that consumes it.
    const read = readOk(plan({ connections: [] }));
    expect(read.bindings).toHaveLength(1);
    expect(read.connections).toEqual([]);
  });

  it("lets one instance hold two different ports, and refuses the same one twice", () => {
    const two = readOk(plan({
      bindings: [
        { binding: "workspace", contract: "workspace-files/v1" },
        { binding: "sessions", contract: "agent-sessions/v1" },
      ],
      connections: [
        { instance: "files", port: "workspace-files/v1", binding: "workspace" },
        { instance: "files", port: "agent-sessions/v1", binding: "sessions" },
      ],
    }));
    expect(two.connections).toHaveLength(2);

    expect(codes(plan({
      connections: [
        { instance: "files", port: "workspace-files/v1", binding: "workspace" },
        { instance: "files", port: "workspace-files/v1", binding: "workspace" },
      ],
    }))).toContain("duplicate");
  });

  it("refuses an unknown field rather than ignoring it", () => {
    expect(codes(plan({ provider: "@evil/files" }))).toEqual(["unknown_field"]);
    expect(codes(plan({
      bindings: [{ binding: "workspace", contract: "workspace-files/v1", module: "x" }],
    }))).toEqual(["unknown_field"]);
    expect(codes(plan({
      connections: [{ instance: "files", port: "workspace-files/v1", binding: "workspace", owner: "alice" }],
    }))).toEqual(["unknown_field"]);
  });

  it("refuses a duplicate binding, a dangling binding and a contract mismatch", () => {
    expect(codes(plan({
      bindings: [
        { binding: "workspace", contract: "workspace-files/v1" },
        { binding: "workspace", contract: "agent-sessions/v1" },
      ],
    }))).toContain("duplicate");

    expect(codes(plan({
      connections: [{ instance: "files", port: "workspace-files/v1", binding: "nowhere" }],
    }))).toContain("unknown_module");

    // The binding provides one thing; the connection claims another. Deriving
    // either from the other would remove the only place this can be seen.
    expect(codes(plan({
      connections: [{ instance: "files", port: "agent-sessions/v1", binding: "workspace" }],
    }))).toContain("schema");
  });

  it("refuses identifiers that are not the bounded grammars", () => {
    expect(codes(plan({ bindings: [{ binding: "Workspace", contract: "workspace-files/v1" }] })))
      .toContain("identifier");
    expect(codes(plan({ bindings: [{ binding: "workspace", contract: "https://evil/files" }] })))
      .toContain("identifier");
    expect(codes(plan({
      connections: [{ instance: "../files", port: "workspace-files/v1", binding: "workspace" }],
    }))).toContain("identifier");
    // A schema this build does not read lands in the v1 branch and is refused
    // by name. `agent-resource-bindings/v3` is not "newer", it is a document
    // nothing here can interpret.
    expect(codes(plan({ schema: "agent-resource-bindings/v3" }))).toContain("schema");
    expect(codes(plan({ app: "   " }))).toContain("empty");
  });

  it("refuses text that is not JSON, without throwing", () => {
    expect(parseResourceBindings("{").ok).toBe(false);
    expect(parseResourceBindings(JSON.stringify(PLAN)).ok).toBe(true);
  });
});

describe("canonical encoding", () => {
  it("round-trips byte for byte, and normalises order", () => {
    const encoded = encodeResourceBindings(readOk(PLAN));
    const again = parseResourceBindings(encoded);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(encodeResourceBindings(again.value)).toBe(encoded);

    // Order is not content: two documents that say the same thing encode the
    // same bytes, which is what lets a release asset be compared.
    const shuffled = readOk(plan({
      bindings: [
        { binding: "sessions", contract: "agent-sessions/v1" },
        { binding: "workspace", contract: "workspace-files/v1" },
      ],
      connections: [
        { instance: "files", port: "workspace-files/v1", binding: "workspace" },
        { instance: "chat", port: "agent-sessions/v1", binding: "sessions" },
      ],
    }));
    expect(encodeResourceBindings(shuffled)).toBe(encodeResourceBindings(readOk(plan({
      bindings: [
        { binding: "workspace", contract: "workspace-files/v1" },
        { binding: "sessions", contract: "agent-sessions/v1" },
      ],
      connections: [
        { instance: "chat", port: "agent-sessions/v1", binding: "sessions" },
        { instance: "files", port: "workspace-files/v1", binding: "workspace" },
      ],
    }))));
  });
});

describe("linking against a composition", () => {
  it("accepts a plan whose instances exist and whose modules declare the port", () => {
    const linked = linkResourceBindings(readOk(PLAN), composition(), manifests());
    expect(linked.ok).toBe(true);
  });

  it("validates the shape without manifests, and says so by not checking ports", () => {
    // A release adapter has the JSON and no components. It still learns that an
    // instance is missing; it simply has not performed the port check yet.
    expect(linkResourceBindings(readOk(PLAN), composition()).ok).toBe(true);
    expect(linkResourceBindings(readOk(PLAN), composition(), manifests({ ports: [] })).ok).toBe(false);
  });

  it("refuses a module that is missing from a registry that WAS supplied", () => {
    // Supplying a registry is a caller saying "these are the modules that
    // exist". Skipping the check for one that is not there is the worst of the
    // three outcomes: it reads as a pass.
    const linked = linkResourceBindings(readOk(PLAN), composition(), new Map());
    expect(linked.ok).toBe(false);
    if (linked.ok) return;
    expect(linked.issues.map((issue) => issue.code)).toContain("unknown_module");
    expect(linked.issues[0].message).toContain("workspace.tree/v1");
  });

  it("refuses a connection to an instance the composition does not mount", () => {
    const linked = linkResourceBindings(
      readOk(plan({ connections: [{ instance: "ghost", port: "workspace-files/v1", binding: "workspace" }] })),
      composition(),
      manifests(),
    );
    expect(linked.ok).toBe(false);
    if (linked.ok) return;
    expect(linked.issues.map((issue) => issue.code)).toContain("unknown_module");
  });

  it("refuses a module that never declared the port it is being handed", () => {
    const linked = linkResourceBindings(readOk(PLAN), composition(), manifests({ ports: ["agent-sessions/v1"] }));
    expect(linked.ok).toBe(false);
    if (linked.ok) return;
    expect(linked.issues.map((issue) => issue.at)).toContain("bindings.connections[0].port");
  });

  it("refuses a standing consumer that the App forgot to connect", () => {
    const linked = linkResourceBindings(
      readOk(plan({ connections: [] })),
      composition(),
      manifests(),
    );
    expect(linked.ok).toBe(false);
    if (linked.ok) return;
    expect(linked.issues.map((issue) => issue.code)).toContain("unconnected");
    expect(linked.issues.some((issue) => issue.message.includes("files"))).toBe(true);
  });

  it("refuses an open-only resource consumer because v1 cannot wire its runtime panel", () => {
    const viewer = readModuleManifest({
      id: "workspace.viewer/v1",
      version: "1.0.0",
      implementation: "@claude-bot/workspace-view#viewer",
      title: "Viewer",
      slots: ["secondary"],
      ports: ["workspace-files/v1"],
      opens: ["workspace-text"],
    });
    if (!viewer.ok) throw new Error(`bad fixture: ${JSON.stringify(viewer.issues)}`);
    const registry = manifests();
    registry.set(viewer.value.id, viewer.value);
    const linked = linkResourceBindings(
      readOk(PLAN),
      composition({
        open: [{ resource: "workspace-text", module: viewer.value.id, slot: "secondary" }],
      }),
      registry,
    );
    expect(linked.ok).toBe(false);
    if (linked.ok) return;
    expect(linked.issues.map((issue) => issue.code)).toContain("unconnected");
  });

  it("refuses a plan for a different App outright", () => {
    const linked = linkResourceBindings(readOk(plan({ app: "other-app" })), composition(), manifests());
    expect(linked.ok).toBe(false);
    if (linked.ok) return;
    expect(linked.issues[0].at).toBe("bindings.app");
  });
});

/**
 * v1's answers, frozen.
 *
 * v2 arrived as a second schema beside this one rather than as a widening of it,
 * and the whole value of that decision is that historical releases keep being
 * read by code that did not change. A claim like that is worth exactly as much
 * as the test that pins it, so these assert the WHOLE result — every issue, its
 * code, its message and its field path, in order — rather than "contains".
 *
 * If one of these has to be edited, the edit is the finding: some v1 document
 * that used to be accepted is now refused, or the reverse, or a refusal now says
 * something different to whoever has to act on it.
 */
describe("v1 outcomes are frozen", () => {
  it("accepts the canonical plan and normalises it to exactly this value", () => {
    expect(readResourceBindings(PLAN)).toEqual({
      ok: true,
      value: {
        schema: "agent-resource-bindings/v1",
        app: "super-workspace",
        bindings: [{ binding: "workspace", contract: "workspace-files/v1" }],
        connections: [{ instance: "files", port: "workspace-files/v1", binding: "workspace" }],
      },
    });
  });

  const frozen: ReadonlyArray<{ name: string; value: unknown; issues: unknown[] }> = [
    {
      name: "a value that is not a JSON object",
      value: [PLAN],
      issues: [{ code: "not_an_object", message: "expected a JSON object", at: "bindings" }],
    },
    {
      name: "a schema this build does not read",
      value: plan({ schema: "agent-resource-bindings/v3" }),
      issues: [{
        code: "schema",
        message: "bindings.schema must be agent-resource-bindings/v1",
        at: "bindings.schema",
      }],
    },
    {
      name: "an unknown top-level field",
      value: plan({ provider: "@evil/files" }),
      issues: [{ code: "unknown_field", message: "unknown field provider", at: "bindings" }],
    },
    {
      name: "a v1 document carrying templates",
      value: plan({ templates: [{ instance: "files", maxInstances: 4 }] }),
      issues: [{ code: "unknown_field", message: "unknown field templates", at: "bindings" }],
    },
    {
      name: "a blank app",
      value: plan({ app: "   " }),
      issues: [{ code: "empty", message: "app must not be blank", at: "bindings.app" }],
    },
    {
      name: "a binding declared twice",
      value: plan({
        bindings: [
          { binding: "workspace", contract: "workspace-files/v1" },
          { binding: "workspace", contract: "agent-sessions/v1" },
        ],
      }),
      issues: [{
        code: "duplicate",
        message: "binding workspace is declared twice",
        at: "bindings.bindings[1]",
      }],
    },
    {
      name: "a connection naming a binding nothing declares",
      value: plan({ connections: [{ instance: "files", port: "workspace-files/v1", binding: "nowhere" }] }),
      issues: [{
        code: "unknown_module",
        message: "connection names binding nowhere, which is not declared",
        at: "bindings.connections[0]",
      }],
    },
    {
      name: "a port that is not what the binding provides",
      value: plan({ connections: [{ instance: "files", port: "agent-sessions/v1", binding: "workspace" }] }),
      issues: [{
        code: "schema",
        message: "binding workspace provides workspace-files/v1, not agent-sessions/v1",
        at: "bindings.connections[0].port",
      }],
    },
    {
      name: "an identifier outside the grammar, and everything that then dangles",
      value: plan({ bindings: [{ binding: "Workspace", contract: "workspace-files/v1" }] }),
      issues: [
        {
          code: "identifier",
          message: "binding must be a short lower-case key",
          at: "bindings.bindings[0].binding",
        },
        {
          code: "unknown_module",
          message: "connection names binding workspace, which is not declared",
          at: "bindings.connections[0]",
        },
      ],
    },
  ];

  for (const row of frozen) {
    it(`refuses ${row.name} with exactly the issues it always did`, () => {
      expect(readResourceBindings(row.value)).toEqual({ ok: false, issues: row.issues });
    });
  }

  it("keeps the linker's v1 refusals word for word", () => {
    expect(linkResourceBindings(readOk(plan({ app: "other-app" })), composition(), manifests())).toEqual({
      ok: false,
      issues: [{
        code: "schema",
        message: "plan is for app other-app, composition is for super-workspace",
        at: "bindings.app",
      }],
    });

    expect(linkResourceBindings(readOk(plan({ connections: [] })), composition(), manifests())).toEqual({
      ok: false,
      issues: [{
        code: "unconnected",
        message: "files needs workspace-files/v1 but has no resource connection",
        at: "bindings.connections",
      }],
    });

    // The rule v2 exists to relax, still exactly as strict for a v1 plan.
    const registry = manifests();
    registry.set(VIEWER.id, VIEWER);
    expect(linkResourceBindings(
      readOk(PLAN),
      composition({ open: [{ resource: "workspace-text", module: VIEWER.id, slot: "secondary" }] }),
      registry,
    )).toEqual({
      ok: false,
      issues: [{
        code: "unconnected",
        message:
          "workspace.viewer/v1 opens resources through workspace-files/v1"
          + " but v1 needs exactly one connected standing instance",
        at: "composition.open",
      }],
    });
  });

  it("reports v1 plans as having no templates, rather than as not having the concept", () => {
    // `planTemplates` is what keeps consumers from branching on `schema` — the
    // branch that goes stale the day a v3 arrives.
    expect(planTemplates(readOk(PLAN))).toEqual([]);
    expect(templateFor(readOk(PLAN), "files")).toBeUndefined();
  });
});

// ── v2 ──────────────────────────────────────────────────────────────────────

function manifest(doc: Record<string, unknown>): AgentModuleManifest {
  const result = readModuleManifest(doc);
  if (!result.ok) throw new Error(`bad fixture: ${JSON.stringify(result.issues)}`);
  return result.value;
}

const VIEWER = manifest({
  id: "workspace.viewer/v1",
  version: "1.0.0",
  implementation: "@claude-bot/workspace-view#viewer",
  title: "Viewer",
  slots: ["secondary", "overlay"],
  ports: ["workspace-files/v1"],
  opens: ["workspace-text"],
});

/** A prototype that consumes two contracts — the connection-family case. */
const DUAL = manifest({
  id: "workspace.dual/v1",
  version: "1.0.0",
  implementation: "@claude-bot/workspace-view#dual",
  title: "Dual",
  slots: ["secondary"],
  ports: ["workspace-files/v1", "agent-sessions/v1"],
  opens: ["workspace-text"],
});

const V2_PLAN = {
  schema: RESOURCE_BINDINGS_SCHEMA_V2,
  app: "super-workspace",
  bindings: [{ binding: "workspace", contract: "workspace-files/v1" }],
  connections: [
    { instance: "files", port: "workspace-files/v1", binding: "workspace" },
    { instance: "viewer", port: "workspace-files/v1", binding: "workspace" },
  ],
  templates: [{ instance: "viewer", maxInstances: 12 }],
};

function v2(overrides: Record<string, unknown> = {}): unknown {
  return { ...V2_PLAN, ...overrides };
}

function readOkV2(value: unknown = V2_PLAN): AgentResourceBindingsV2 {
  const result = readResourceBindings(value);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.issues)}`);
  const read = result.value;
  if (read.schema !== RESOURCE_BINDINGS_SCHEMA_V2) throw new Error("expected a v2 plan");
  return read;
}

/** Composition + registry for the v2 cases. Instances are overridable. */
function v2World(overrides: {
  instances?: unknown[];
  open?: unknown[];
  extra?: readonly AgentModuleManifest[];
} = {}): { composition: AgentComposition; registry: Map<string, AgentModuleManifest> } {
  const registry = manifests();
  registry.set(VIEWER.id, VIEWER);
  for (const extra of overrides.extra ?? []) registry.set(extra.id, extra);
  return {
    composition: composition({
      instances: overrides.instances ?? [
        { instance: "files", module: "workspace.tree/v1", slot: "navigation" },
        { instance: "chat", module: "agent.chat/v1", slot: "primary" },
        { instance: "viewer", module: VIEWER.id, slot: "secondary" },
      ],
      open: overrides.open ?? [{ resource: "workspace-text", module: VIEWER.id, slot: "secondary" }],
    }),
    registry,
  };
}

describe("reading a v2 plan", () => {
  it("accepts the documented shape and exposes the ceiling", () => {
    const read = readOkV2();
    expect(read.schema).toBe("agent-resource-bindings/v2");
    expect(read.templates).toEqual([{ instance: "viewer", maxInstances: 12 }]);
    expect(templateFor(read, "viewer")?.maxInstances).toBe(12);
    expect(templateFor(read, "files")).toBeUndefined();
    // Everything v1 answers, answered identically.
    expect(bindingContract(read, "workspace")).toBe("workspace-files/v1");
    expect(connectionFor(read, "viewer", "workspace-files/v1")?.binding).toBe("workspace");
  });

  it("carries no identity, no path, no provider — the same closed record v1 has", () => {
    expect(Object.keys(readOkV2().templates[0]).sort()).toEqual(["instance", "maxInstances"]);
    for (const smuggled of ["provider", "owner", "app", "scope", "path", "url", "grant", "contract"]) {
      expect(codes(v2({ templates: [{ instance: "viewer", maxInstances: 2, [smuggled]: "x" }] })))
        .toEqual(["unknown_field"]);
    }
  });

  it("refuses an empty templates array, because that plan is a v1 plan", () => {
    // Two byte representations of one plan is what canonical encoding exists to
    // prevent; the empty case already has a spelling.
    expect(codes(v2({ templates: [] }))).toEqual(["empty"]);
    expect(codes(v2({ templates: undefined }))).toEqual(["missing_field"]);
  });

  it("bounds the ceiling, and distinguishes 'not a whole number' from 'too many'", () => {
    const ceiling = (maxInstances: unknown) =>
      codes(v2({ templates: [{ instance: "viewer", maxInstances }] }));
    expect(ceiling(1)).toEqual([]);
    expect(ceiling(RESOURCE_TEMPLATE_MAX_INSTANCES)).toEqual([]);
    expect(ceiling(0)).toEqual(["limit"]);
    expect(ceiling(-1)).toEqual(["limit"]);
    expect(ceiling(RESOURCE_TEMPLATE_MAX_INSTANCES + 1)).toEqual(["limit"]);
    expect(ceiling(1.5)).toEqual(["field_type"]);
    expect(ceiling("12")).toEqual(["field_type"]);
    expect(ceiling(Number.NaN)).toEqual(["field_type"]);
    expect(ceiling(undefined)).toEqual(["missing_field"]);
  });

  it("refuses two ceilings for one family, and a prototype wired to nothing", () => {
    expect(codes(v2({
      templates: [{ instance: "viewer", maxInstances: 2 }, { instance: "viewer", maxInstances: 9 }],
    }))).toEqual(["duplicate"]);

    // In-document, so it is caught without a composition: a prototype inherits
    // its own connections, and this one would inherit nothing.
    expect(readResourceBindings(v2({ templates: [{ instance: "chat", maxInstances: 4 }] }))).toEqual({
      ok: false,
      issues: [{
        code: "unconnected",
        message: "template names chat, which this plan connects to no binding",
        at: "bindings.templates[0]",
      }],
    });
  });

  it("round-trips byte for byte and normalises template order", () => {
    const encoded = encodeResourceBindings(readOkV2());
    const again = parseResourceBindings(encoded);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(encodeResourceBindings(again.value)).toBe(encoded);
    expect(encoded.includes('"templates"')).toBe(true);

    const two = [
      { instance: "files", port: "workspace-files/v1", binding: "workspace" },
      { instance: "viewer", port: "workspace-files/v1", binding: "workspace" },
    ];
    expect(encodeResourceBindings(readOkV2(v2({
      connections: two,
      templates: [{ instance: "viewer", maxInstances: 3 }, { instance: "files", maxInstances: 2 }],
    })))).toBe(encodeResourceBindings(readOkV2(v2({
      connections: two,
      templates: [{ instance: "files", maxInstances: 2 }, { instance: "viewer", maxInstances: 3 }],
    }))));
  });

  it("leaves v1 bytes untouched — the whole point of a second schema", () => {
    // A v1 plan encoded by the dispatching encoder is the same document it was
    // before templates existed. Rollback targets depend on this literally: the
    // bytes are covered by a package digest.
    expect(encodeResourceBindings(readOk(PLAN))).toBe(
      `${JSON.stringify(PLAN, null, 2)}\n`,
    );
  });
});

describe("linking a v2 plan", () => {
  it("accepts a template on a connected prototype the composition opens into", () => {
    const world = v2World();
    expect(linkResourceBindings(readOkV2(), world.composition, world.registry).ok).toBe(true);
  });

  it("checks templates with no registry at all, which is the install path", () => {
    // `prepare()` deliberately supplies no manifests. A dangling or mis-slotted
    // template must still be refused there — otherwise the only build that would
    // catch it is the one that packed the release.
    const world = v2World();
    expect(linkResourceBindings(readOkV2(), world.composition).ok).toBe(true);
    const dangling = linkResourceBindings(
      readOkV2(v2({
        connections: [
          ...V2_PLAN.connections,
          { instance: "ghost", port: "workspace-files/v1", binding: "workspace" },
        ],
        templates: [{ instance: "ghost", maxInstances: 3 }],
      })),
      world.composition,
    );
    expect(dangling.ok).toBe(false);
    if (dangling.ok) return;
    expect(dangling.issues.some((issue) => issue.at === "bindings.templates[0]")).toBe(true);
  });

  it("refuses a prototype in a slot that holds widgets rather than documents", () => {
    const world = v2World();
    const linked = linkResourceBindings(
      readOkV2(v2({ templates: [{ instance: "files", maxInstances: 3 }] })),
      world.composition,
      world.registry,
    );
    expect(linked.ok).toBe(false);
    if (linked.ok) return;
    const issue = linked.issues.find((row) => row.at === "bindings.templates[0]");
    expect(issue?.code).toBe("slot");
    expect(issue?.message).toContain("navigation");
  });

  it("refuses a prototype whose module nothing opens into", () => {
    const world = v2World({ open: [] });
    const linked = linkResourceBindings(readOkV2(), world.composition, world.registry);
    expect(linked.ok).toBe(false);
    if (linked.ok) return;
    expect(linked.issues.some((row) => row.code === "unconnected" && row.message.includes("open target")))
      .toBe(true);
  });

  it("refuses a prototype sitting where its module is never opened", () => {
    // The load-bearing one. A resolver is handed a module and a slot; a
    // prototype in a slot no rule targets describes a family no route reaches.
    const world = v2World({
      instances: [
        { instance: "files", module: "workspace.tree/v1", slot: "navigation" },
        { instance: "chat", module: "agent.chat/v1", slot: "primary" },
        { instance: "viewer", module: VIEWER.id, slot: "overlay" },
      ],
      open: [{ resource: "workspace-text", module: VIEWER.id, slot: "secondary" }],
    });
    const linked = linkResourceBindings(readOkV2(), world.composition, world.registry);
    expect(linked.ok).toBe(false);
    if (linked.ok) return;
    expect(linked.issues).toEqual([{
      code: "slot",
      message: "viewer sits in overlay, but workspace.viewer/v1 is only opened into secondary",
      at: "bindings.templates[0]",
    }]);
  });

  it("refuses two templates on one (module, slot, port) route", () => {
    const world = v2World({
      instances: [
        { instance: "files", module: "workspace.tree/v1", slot: "navigation" },
        { instance: "chat", module: "agent.chat/v1", slot: "primary" },
        { instance: "viewer", module: VIEWER.id, slot: "secondary" },
        { instance: "viewer-b", module: VIEWER.id, slot: "secondary" },
      ],
    });
    const linked = linkResourceBindings(
      readOkV2(v2({
        connections: [
          ...V2_PLAN.connections,
          { instance: "viewer-b", port: "workspace-files/v1", binding: "workspace" },
        ],
        templates: [{ instance: "viewer", maxInstances: 4 }, { instance: "viewer-b", maxInstances: 4 }],
      })),
      world.composition,
      world.registry,
    );
    expect(linked.ok).toBe(false);
    if (linked.ok) return;
    expect(linked.issues).toEqual([{
      code: "duplicate",
      message:
        "workspace.viewer/v1 opens workspace-files/v1 in secondary through 2 templates (viewer, viewer-b)",
      at: "bindings.templates",
    }]);
  });

  it("refuses a template beside a connected direct surface on the same route", () => {
    // The resolver would have to choose between a family and a single panel with
    // nothing but array order to go on — and the choice decides which instance's
    // config and connections a new panel inherits.
    const world = v2World({
      instances: [
        { instance: "files", module: "workspace.tree/v1", slot: "navigation" },
        { instance: "chat", module: "agent.chat/v1", slot: "primary" },
        { instance: "viewer", module: VIEWER.id, slot: "secondary" },
        { instance: "viewer-b", module: VIEWER.id, slot: "secondary" },
      ],
    });
    const linked = linkResourceBindings(
      readOkV2(v2({
        connections: [
          ...V2_PLAN.connections,
          { instance: "viewer-b", port: "workspace-files/v1", binding: "workspace" },
        ],
      })),
      world.composition,
      world.registry,
    );
    expect(linked.ok).toBe(false);
    if (linked.ok) return;
    expect(linked.issues).toEqual([{
      code: "duplicate",
      message:
        "workspace.viewer/v1 opens workspace-files/v1 in secondary"
        + " through template viewer and also through viewer-b",
      at: "bindings.templates",
    }]);
  });

  it("keeps v1's exactly-one rule for every route no template owns", () => {
    // Converting a plan to v2 without adding a template must not make a
    // previously refused wiring pass. Here a second openable module has no
    // connected standing instance at all.
    const other = manifest({
      id: "workspace.other/v1",
      version: "1.0.0",
      implementation: "@claude-bot/workspace-view#other",
      title: "Other",
      slots: ["primary"],
      ports: ["workspace-files/v1"],
      opens: ["workspace-text"],
    });
    const world = v2World({
      open: [
        { resource: "workspace-text", module: VIEWER.id, slot: "secondary" },
        { resource: "workspace-text", module: other.id, slot: "primary" },
      ],
      extra: [other],
    });
    const linked = linkResourceBindings(readOkV2(), world.composition, world.registry);
    expect(linked.ok).toBe(false);
    if (linked.ok) return;
    expect(linked.issues).toEqual([{
      code: "unconnected",
      message:
        "workspace.other/v1 opens workspace-files/v1 in primary with no template,"
        + " so that route needs exactly one connected standing instance",
      at: "composition.open",
    }]);
  });

  it("requires a multi-port prototype to have its whole connection family wired", () => {
    // A derived panel inherits the prototype's connections. The existing
    // per-instance completeness check is what makes "the whole family" a
    // well-defined set: half a family would be an inheritance with a hole.
    const world = v2World({
      instances: [
        { instance: "files", module: "workspace.tree/v1", slot: "navigation" },
        { instance: "chat", module: "agent.chat/v1", slot: "primary" },
        { instance: "viewer", module: DUAL.id, slot: "secondary" },
      ],
      open: [{ resource: "workspace-text", module: DUAL.id, slot: "secondary" }],
      extra: [DUAL],
    });
    const both = {
      bindings: [
        { binding: "workspace", contract: "workspace-files/v1" },
        { binding: "sessions", contract: "agent-sessions/v1" },
      ],
    };
    const whole = linkResourceBindings(
      readOkV2(v2({
        ...both,
        connections: [
          ...V2_PLAN.connections,
          { instance: "viewer", port: "agent-sessions/v1", binding: "sessions" },
          { instance: "chat", port: "agent-sessions/v1", binding: "sessions" },
        ],
      })),
      world.composition,
      world.registry,
    );
    expect(whole.ok).toBe(true);

    const half = linkResourceBindings(
      readOkV2(v2({
        ...both,
        connections: [
          ...V2_PLAN.connections,
          { instance: "chat", port: "agent-sessions/v1", binding: "sessions" },
        ],
      })),
      world.composition,
      world.registry,
    );
    expect(half.ok).toBe(false);
    if (half.ok) return;
    // The completeness check speaks first, and it is the one that names what to
    // fix. (The open-surface rule then also reports the route, because a port
    // with no connected instance is no longer owned by the template — a
    // consequence of the same hole, not a second finding.)
    expect(half.issues[0]).toEqual({
      code: "unconnected",
      message: "viewer needs agent-sessions/v1 but has no resource connection",
      at: "bindings.connections",
    });
  });

  it("refuses a v2 plan written for another App, before it looks at anything else", () => {
    const world = v2World();
    const linked = linkResourceBindings(readOkV2(v2({ app: "other-app" })), world.composition, world.registry);
    expect(linked.ok).toBe(false);
    if (linked.ok) return;
    expect(linked.issues).toHaveLength(1);
    expect(linked.issues[0].at).toBe("bindings.app");
  });
});
