/**
 * The three release assets this App ships, checked against the objects the
 * browser actually assembles from.
 *
 * ── Why the binding plan is linked HERE ─────────────────────────────────────
 *
 * The release adapter links a plan against its composition, but it cannot check
 * the `port` half: a module lock records id/version/implementation, not the
 * `ports` a module declares, and the registry that knows them is compiled into
 * this bundle rather than shipped as an asset. So the agreement between "the
 * binding provides `workspace-files/v4`" and "this module asked for
 * `workspace-files/v4`" is pinned in the one place both facts exist.
 *
 * That agreement is the entire reason the document writes both fields out. They
 * are almost always the same string; the time they are not is the mistake.
 */

import { describe, expect, it } from "vitest";
import {
  encodeComposition,
  encodeModuleLock,
  encodeResourceBindings,
  linkComposition,
  linkResourceBindings,
  parseComposition,
  parseModuleLock,
  parseResourceBindings,
  planTemplates,
  RESOURCE_BINDINGS_SCHEMA_V2,
} from "@claude-bot/agent-module-contract";
import { createModuleRegistry } from "@claude-bot/agent-view-react/workspace";
import { SESSIONS_MODULES } from "@claude-bot/agent-sessions-view";
import {
  AGENT_CHAT_MODULE_ID,
  REMOTE_TERMINAL_MODULE_ID,
  REMOTE_TERMINAL_RESOURCE_KIND,
  SESSION_DIRECTORY_INDEX_MODULE_ID,
} from "@claude-bot/agent-sessions-view/manifests";
import { FILE_VIEWER_MODULE_ID, WORKSPACE_FILES_MODULES } from "@claude-bot/agent-workspace-files-view";
import { EDITOR_MODULES, EDITOR_MODULE_ID } from "@claude-bot/agent-editor-view";
import { CRDT_MODULES } from "@claude-bot/agent-crdt-view";
import { CRDT_DOC_LIST_MODULE_ID } from "@claude-bot/agent-crdt-view/manifests";
import { FEISHU_DOCUMENT_MODULE_ID, FEISHU_MODULES } from "@claude-bot/agent-feishu-view";
import { WORKSPACE_FILES_CONTRACT_V4 } from "@claude-bot/workspace-files-contract";
import { CRDT_DOC_CONTRACT_V2 } from "@claude-bot/crdt-doc-contract";
import {
  DOCS_BINDING,
  SESSION_PLUS_COMPOSITION_JSON,
  SESSION_PLUS_MODULE_LOCK_JSON,
  SESSION_PLUS_RESOURCE_BINDINGS,
  SESSION_PLUS_RESOURCE_BINDINGS_JSON,
  WORKSPACE_BINDING,
} from "./plan.js";

const registry = createModuleRegistry([
  ...SESSIONS_MODULES,
  ...WORKSPACE_FILES_MODULES,
  ...EDITOR_MODULES,
  ...CRDT_MODULES,
  ...FEISHU_MODULES,
]);

describe("the release plan this App ships", () => {
  it("round-trips all three documents byte for byte", () => {
    const lock = parseModuleLock(SESSION_PLUS_MODULE_LOCK_JSON);
    const composition = parseComposition(SESSION_PLUS_COMPOSITION_JSON);
    const bindings = parseResourceBindings(SESSION_PLUS_RESOURCE_BINDINGS_JSON);
    expect(lock.ok && composition.ok && bindings.ok).toBe(true);
    if (!lock.ok || !composition.ok || !bindings.ok) return;
    expect(encodeModuleLock(lock.value)).toBe(SESSION_PLUS_MODULE_LOCK_JSON);
    expect(encodeComposition(composition.value)).toBe(SESSION_PLUS_COMPOSITION_JSON);
    expect(encodeResourceBindings(bindings.value)).toBe(SESSION_PLUS_RESOURCE_BINDINGS_JSON);
  });

  it("links against the registry this bundle actually contains", () => {
    const composition = parseComposition(SESSION_PLUS_COMPOSITION_JSON);
    expect(composition.ok).toBe(true);
    if (!composition.ok) return;
    expect(linkComposition(composition.value, registry.lock(), registry.manifests()).ok).toBe(true);
    // With the manifests supplied, the linker enforces that every wired module
    // DECLARED the port it is being handed. Supplying them is what makes the
    // `ports` field mean something rather than decorate a manifest.
    const linked = linkResourceBindings(
      SESSION_PLUS_RESOURCE_BINDINGS,
      composition.value,
      registry.manifests(),
    );
    expect(linked.ok).toBe(true);
  });

  it("wires every port-consuming surface, workspace and documents on separate bindings", () => {
    // A plan that named only the tree would leave the viewer and the editor
    // relying on React context to have inherited a port — which is exactly the
    // implicit wiring this document replaces. ONE binding per contract: the
    // three workspace surfaces read the same workspace through the same
    // contract, while the two document surfaces are a different provider scope
    // with its own refs and its own grant to revoke — hence the second name.
    expect(SESSION_PLUS_RESOURCE_BINDINGS.bindings).toEqual([
      { binding: WORKSPACE_BINDING, contract: WORKSPACE_FILES_CONTRACT_V4 },
      { binding: DOCS_BINDING, contract: CRDT_DOC_CONTRACT_V2 },
    ]);
    expect(SESSION_PLUS_RESOURCE_BINDINGS.connections.map((row) => row.instance).sort())
      .toEqual(["doc", "editor", "file-viewer", "index"]);
    for (const row of SESSION_PLUS_RESOURCE_BINDINGS.connections) {
      if (row.binding === WORKSPACE_BINDING) expect(row.port).toBe(WORKSPACE_FILES_CONTRACT_V4);
      else {
        expect(row.binding).toBe(DOCS_BINDING);
        expect(row.port).toBe(CRDT_DOC_CONTRACT_V2);
      }
    }
  });

  it("templates only the two workspace text document families, with bounded live panels", () => {
    expect(SESSION_PLUS_RESOURCE_BINDINGS.schema).toBe(RESOURCE_BINDINGS_SCHEMA_V2);
    expect(planTemplates(SESSION_PLUS_RESOURCE_BINDINGS)).toEqual([
      { instance: "file-viewer", maxInstances: 8 },
      { instance: "editor", maxInstances: 8 },
    ]);
    // The navigation index is a flow widget and the CRDT note needs its own
    // concurrency/recovery decision; neither may acquire template semantics as
    // an incidental consequence of making workspace text multi-tab.
    expect(planTemplates(SESSION_PLUS_RESOURCE_BINDINGS).map((row) => row.instance))
      .not.toEqual(expect.arrayContaining(["index", "doc"]));
  });

  it("keeps the navigation rail to session and file wayfinding (ticket #181)", () => {
    // The navigation slot is a FLOW region: every panel in it shares one
    // column's height on the desktop and the whole navigation layer on a phone.
    // So a standing rail that this App does no work through is not neutral
    // decoration — it is height taken from the directory index on every
    // viewport, which is why the collaborative-document rail left. This pins
    // the rail's membership rather than a rendered string: a module reaching
    // navigation again should have to say so here.
    const composition = parseComposition(SESSION_PLUS_COMPOSITION_JSON);
    expect(composition.ok).toBe(true);
    if (!composition.ok) return;
    const navigation = composition.value.instances.filter((row) => row.slot === "navigation");
    // One navigator: sessions, files and full-text search are its views.
    expect(navigation.map((row) => row.instance)).toEqual(["index"]);
    expect(navigation.map((row) => row.module)).toEqual([SESSION_DIRECTORY_INDEX_MODULE_ID]);
    expect(navigation.some((row) => row.module === CRDT_DOC_LIST_MODULE_ID)).toBe(false);
    // And nothing else may reach the document plane's list module either: an
    // instance parked in another slot would be the same leftover, moved.
    expect(composition.value.instances.some((row) => row.module === CRDT_DOC_LIST_MODULE_ID)).toBe(false);
  });

  it("gives every workspace module a standing composition instance", () => {
    const composition = parseComposition(SESSION_PLUS_COMPOSITION_JSON);
    expect(composition.ok).toBe(true);
    if (!composition.ok) return;
    const instances = composition.value.instances.map((row) => row.instance);
    // v2 still needs NAMED prototypes: a viewer that existed only as an open
    // rule target would have no connection/config family to inherit.
    expect(instances).toContain("index");
    expect(instances).toContain("file-viewer");
    expect(instances).toContain("editor");
    expect(composition.value.open.some((rule) => rule.resource === "workspace-text")).toBe(true);
  });

  it("removes the bottom flow and routes each physical device to a terminal Dock tab", () => {
    const composition = parseComposition(SESSION_PLUS_COMPOSITION_JSON);
    expect(composition.ok).toBe(true);
    if (!composition.ok) return;
    expect(composition.value.instances.filter((row) => row.slot === "bottom")).toEqual([]);
    expect(composition.value.open.find((rule) => rule.resource === REMOTE_TERMINAL_RESOURCE_KIND)).toEqual({
      resource: REMOTE_TERMINAL_RESOURCE_KIND,
      module: REMOTE_TERMINAL_MODULE_ID,
      slot: "primary",
    });
  });

  it("opens files in the viewer by default and keeps editing explicit", () => {
    // `resolveOpen` takes rules[0] when an intent names no view, so the ORDER of
    // these rules IS the routing policy.
    const composition = parseComposition(SESSION_PLUS_COMPOSITION_JSON);
    expect(composition.ok).toBe(true);
    if (!composition.ok) return;
    const rules = composition.value.open.filter((rule) => rule.resource === "workspace-text");
    expect(rules.map((rule) => rule.module)).toEqual([FILE_VIEWER_MODULE_ID, EDITOR_MODULE_ID]);
    expect(rules.map((rule) => rule.slot)).toEqual(["secondary", "secondary"]);
    const tree = composition.value.instances.find((row) => row.instance === "index");
    expect(tree?.config).toBeUndefined();
    const viewer = composition.value.instances.find((row) => row.instance === "file-viewer");
    expect(viewer?.config).toEqual({ edit_view: EDITOR_MODULE_ID });
    const editor = composition.value.instances.find((row) => row.instance === "editor");
    expect(editor?.config).toEqual({ browse_view: FILE_VIEWER_MODULE_ID });
  });

  it("keeps every opened session in the primary Dock tab group", () => {
    const composition = parseComposition(SESSION_PLUS_COMPOSITION_JSON);
    expect(composition.ok).toBe(true);
    if (!composition.ok) return;
    expect(composition.value.open.find((rule) => rule.resource === "session")).toEqual({
      resource: "session",
      module: AGENT_CHAT_MODULE_ID,
      slot: "primary",
    });
  });

  it("routes Feishu document links to their dedicated Dock module", () => {
    const composition = parseComposition(SESSION_PLUS_COMPOSITION_JSON);
    expect(composition.ok).toBe(true);
    if (!composition.ok) return;
    expect(composition.value.open.find((rule) => rule.resource === "feishu-document")).toEqual({
      resource: "feishu-document",
      module: FEISHU_DOCUMENT_MODULE_ID,
      slot: "secondary",
    });
  });

  it("names no implementation anywhere in the binding plan", () => {
    // A manifest that could name an implementation would be a manifest that
    // could install one.
    const text = SESSION_PLUS_RESOURCE_BINDINGS_JSON;
    for (const forbidden of ["http", "node_modules", "packages/", "import", "@claude-bot", "device", "owner"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});
