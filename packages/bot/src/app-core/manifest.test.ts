import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetDeploymentProfile, setDeploymentProfile } from "@claude-bot/engine";
import { WIRE_PARAM_LIMITS } from "@claude-bot/typed-port-kit";
import {
  appActionTool,
  loadSessionPlusManifest,
  normalizeSessionPlusAction,
  sessionPlusActionsFor,
} from "./manifest.js";

const dirs: string[] = [];

/** A throwaway app directory, so a declaration can be tested as bytes. */
function appDir(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sp-manifest-"));
  dirs.push(dir);
  mkdirSync(join(dir, "pages"), { recursive: true });
  writeFileSync(join(dir, "pages", "main.yaml"), "page: {}\n");
  writeFileSync(join(dir, "app.yaml"), yaml);
  return dir;
}

const SCHEMA1 = `id: session-plus
schema: 1
actions:
  pin_session: { binding: runtime, handler: pin_session, params: { session: { type: string, max: 8 } } }
  refresh_sessions: { binding: resource, params: {} }
  open_session: { binding: resource, params: {} }
  search_sessions: { binding: resource, params: {} }
  refresh_workspaces: { binding: resource, params: {} }
  start_session: { binding: resource, params: {} }
  append_session: { binding: resource, params: {} }
  resume_session: { binding: resource, params: {} }
view: { page: pages/main.yaml }
`;

function schema2(body: string): string {
  return `id: session-plus\nschema: 2\n${body}\nview: { page: pages/main.yaml }\n`;
}

afterEach(() => {
  resetDeploymentProfile();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("Session Plus declarative manifest", () => {
  it("exposes the durable pin plus the bounded resource and terminal actions", () => {
    const manifest = loadSessionPlusManifest();
    expect(manifest.id).toBe("session-plus");
    expect(manifest.schema).toBe(2);
    expect(manifest.stateEpoch).toBe(0);
    expect(manifest.stateEpochDeclared).toBe(false);
    expect(Object.keys(manifest.actions)).toEqual([
      "read_codex_continuation",
      "save_codex_continuation",
      "open_shared_session",
      "pin_session",
      "save_session_folder",
      "delete_session_folder",
      "file_sessions",
      "set_session_title",
      "review_session",
      "set_file_annotations",
      "attach_file",
      "close_session",
      "refresh_sessions",
      "open_session",
      "search_sessions",
      "refresh_workspaces",
      "open_terminal",
      "read_terminal",
      "send_terminal",
      "close_terminal",
      "start_session",
      "append_session",
      "resume_session",
      "takeover_session",
      "fallback_session",
      "interrupt_session",
      "release_session_control",
      "respond_agent_interaction",
    ]);
    expect(manifest.actions.open_shared_session).toMatchObject({
      binding: "resource",
      humanOnly: true,
      params: { share_id: { max: 64, required: true } },
    });
    expect(manifest.actions.pin_session.binding).toBe("runtime");
    // Favorites and folders are App-owned navigation state: runtime actions,
    // never a Gate operation. Only deleting a folder is reserved for a person.
    expect(manifest.actions.pin_session.params.pinned).toMatchObject({ type: "boolean", required: false });
    for (const action of ["save_session_folder", "delete_session_folder", "file_sessions"]) {
      expect(manifest.actions[action]!.binding).toBe("runtime");
    }
    expect(manifest.actions.delete_session_folder!.humanOnly).toBe(true);
    expect(manifest.actions.save_session_folder!.humanOnly).toBe(false);
    expect(manifest.actions.file_sessions!.params.sessions).toMatchObject({ max: 66000, required: true });
    expect(manifest.actions.set_session_title).toMatchObject({
      binding: "runtime",
      humanOnly: true,
      params: {
        session: { max: 1024, required: true },
        title: { max: 96, required: false },
      },
    });
    expect(manifest.actions.review_session).toMatchObject({
      binding: "runtime",
      humanOnly: true,
      params: {
        session: { max: 1024, required: true },
        completed_at: { max: 64, required: true },
      },
    });
    expect(manifest.actions.set_file_annotations).toMatchObject({
      binding: "runtime",
      humanOnly: true,
      params: {
        payload: { max: 100_352, required: true },
      },
    });
    expect(manifest.actions.attach_file).toMatchObject({
      binding: "resource",
      humanOnly: true,
      params: {
        // Existing chats use resource; launch drafts have no session yet.
        // The trusted provider validates the exclusive target and its rights.
        resource: { max: 1024, required: false },
        device: { max: 200, required: false },
        workspace_id: { max: 200, required: false },
        name: { max: 200, required: true },
        media_type: { max: 128, required: true },
        // Same numeric representation bound as the Runner (#645): no hidden file-size cap.
        chunk_index: { max: 16, required: true },
        chunk_count: { max: 16, required: true },
        upload_id: { max: 24, required: false },
        data: { max: 349_528, required: true },
      },
    });
    for (const action of ["open_terminal", "read_terminal", "send_terminal", "close_terminal"] as const) {
      expect(manifest.actions[action]).toMatchObject({ binding: "resource", humanOnly: true });
    }
    expect(manifest.actions.open_session.binding).toBe("resource");
    expect(manifest.actions.start_session.binding).toBe("resource");
    expect(manifest.actions.start_session.params.runtime_device).toMatchObject({
      max: 64,
      required: false,
    });
    expect(manifest.actions.start_session.params.prompt.max)
      .toBe(WIRE_PARAM_LIMITS.maxDeclaredValueLength);
    expect(manifest.actions.respond_agent_interaction).toMatchObject({
      binding: "resource",
      humanOnly: true,
    });
    expect(manifest.actions.interrupt_session).toMatchObject({ binding: "resource", humanOnly: true });
    expect(manifest.actions.release_session_control).toMatchObject({ binding: "resource", humanOnly: true });
    expect(manifest.actions.start_session.params.permission_profile?.enum)
      .toEqual(["full_access", "manual"]);
    expect(manifest.actions.append_session.params.permission_profile?.enum)
      .toEqual(["full_access", "manual"]);
    expect(normalizeSessionPlusAction(manifest, "start_session", {
      device: "laptop",
      source: "codex",
      prompt: "go",
      permission_profile: "root",
    })).toMatchObject({ ok: false, code: "invalid_params" });
  });

  it("keeps continuation settings human-only and preserves custom text exactly", () => {
    const manifest = loadSessionPlusManifest();
    for (const action of ["read_codex_continuation", "save_codex_continuation"]) {
      expect(manifest.actions[action]).toMatchObject({ binding: "resource", humanOnly: true });
      expect(normalizeSessionPlusAction(manifest, action, { resource: "session", revision: "0" }, "agent").ok).toBe(false);
    }
    const params = { resource: "session", prompt: "  Please continue.\n繼續執行  ", revision: "0" };
    expect(normalizeSessionPlusAction(manifest, "save_codex_continuation", params))
      .toEqual({ ok: true, action: "save_codex_continuation", params });
    expect(normalizeSessionPlusAction(manifest, "save_codex_continuation", { ...params, prompt: "x".repeat(4001) }).ok).toBe(false);
    expect(normalizeSessionPlusAction(manifest, "save_codex_continuation", { ...params, prompt: "" }).ok).toBe(true);
  });

  it.each([
    { resource: "session-resource", device: "", workspace_id: "" },
    { resource: "", device: "laptop", workspace_id: "" },
    { resource: "", device: "laptop", workspace_id: "ws_0123456789abcdef01234567" },
  ])("preserves attachment target $resource/$device/$workspace_id through normalization", (target) => {
    const manifest = loadSessionPlusManifest();
    const chunk = {
      name: "notes.txt",
      media_type: "text/plain",
      chunk_index: "0",
      chunk_count: "1",
      data: "aGVsbG8=",
    };
    const suppliedTarget = Object.fromEntries(Object.entries(target).filter(([, value]) => value !== ""));
    expect(normalizeSessionPlusAction(manifest, "attach_file", { ...suppliedTarget, ...chunk })).toEqual({
      ok: true,
      action: "attach_file",
      params: { ...target, ...chunk, upload_id: "" },
    });
  });

  it("preserves the advanced placement runtime device through normalization", () => {
    const manifest = loadSessionPlusManifest();
    expect(normalizeSessionPlusAction(manifest, "start_session", {
      device: "val15",
      runtime_device: "runner1",
      workspace_id: "ws_0123456789abcdef01234567",
      source: "codex",
      prompt: "开始",
    })).toEqual({
      ok: true,
      action: "start_session",
      params: {
        device: "val15",
        runtime_device: "runner1",
        workspace_id: "ws_0123456789abcdef01234567",
        directory: "",
        source: "codex",
        codex_account: "",
        model: "",
        effort: "",
        permission_profile: "",
        prompt: "开始",
      },
    });
  });

  it("preserves a launch prompt beyond the old 4096-character door", () => {
    const manifest = loadSessionPlusManifest();
    const prompt = "x".repeat(8_001);
    expect(normalizeSessionPlusAction(manifest, "start_session", {
      device: "laptop",
      directory: "~/project",
      source: "codex",
      prompt,
    })).toMatchObject({ ok: true, params: { prompt } });
  });

  it("copies declared bounded primitives and drops identity-shaped extras", () => {
    const manifest = loadSessionPlusManifest();
    expect(normalizeSessionPlusAction(manifest, "pin_session", {
      session: "x".repeat(300),
      owner: "alice",
      instance: "forged",
      approved: true,
    })).toEqual({ ok: true, action: "pin_session", params: { session: "x".repeat(300), pinned: "" } });
    expect(normalizeSessionPlusAction(manifest, "pin_session", { session: "s", pinned: true }))
      .toEqual({ ok: true, action: "pin_session", params: { session: "s", pinned: "true" } });
    expect(normalizeSessionPlusAction(manifest, "delete_everything", {}))
      .toMatchObject({ ok: false, code: "unknown_action" });
    expect(normalizeSessionPlusAction(manifest, "set_session_title", {
      session: "demo-codex",
      title: "",
    })).toEqual({
      ok: true,
      action: "set_session_title",
      params: { session: "demo-codex", title: "" },
    });
  });

  it("refuses an over-long parameter instead of silently truncating it (schema 2)", () => {
    // Schema 1 sliced. Schema 2 refuses, and the difference is deliberate: a
    // silently shortened opaque id addresses something else, and the caller who
    // would have to notice is a model.
    const manifest = loadSessionPlusManifest();
    expect(normalizeSessionPlusAction(manifest, "open_session", { resource: "r".repeat(1200) }))
      .toMatchObject({ ok: false, code: "invalid_params" });
  });

  it("refuses a missing required parameter with a sentence a model can act on", () => {
    const manifest = loadSessionPlusManifest();
    const answer = normalizeSessionPlusAction(manifest, "pin_session", {});
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.code).toBe("invalid_params");
    expect(answer.ok === false && answer.message).toContain("session");
  });

  it("keeps optional parameters normalising to the empty string", () => {
    const manifest = loadSessionPlusManifest();
    expect(normalizeSessionPlusAction(manifest, "open_session", { resource: "r1" })).toEqual({
      ok: true,
      action: "open_session",
      params: { resource: "r1", limit: "", offset: "", block: "", field: "", char_offset: "" },
    });
  });

  it("hides a human_only action from the agent surface AND refuses it at the door", () => {
    // Both halves. Filtering alone leaves a model free to name the action;
    // refusing alone leaves it retrying a tool it can see.
    const manifest = loadSessionPlusManifest();
    expect(manifest.actions.start_session.humanOnly).toBe(true);
    const agentTools = sessionPlusActionsFor(manifest, "agent").map((row) => row.name);
    expect(agentTools).not.toContain("start_session");
    expect(sessionPlusActionsFor(manifest, "user").map((row) => row.name)).toContain("start_session");
    expect(normalizeSessionPlusAction(manifest, "start_session", { device: "laptop" }, "agent"))
      .toMatchObject({ ok: false, code: "unknown_action" });
    // …and the same call from a person is fine.
    expect(normalizeSessionPlusAction(manifest, "start_session", { device: "laptop" }, "user").ok).toBe(true);
  });

  it("declares one agent whose prompt travels inside the release declaration", () => {
    const manifest = loadSessionPlusManifest();
    expect(Object.keys(manifest.agents)).toEqual(["keeper"]);
    expect(manifest.agents.keeper.adapter).toBe("openai-loop");
    expect(manifest.agents.keeper.prompt).toContain("{{user}}");
  });

  it("derives a tool schema from the same declaration the button face reads", () => {
    const manifest = loadSessionPlusManifest();
    const tool = appActionTool("pin_session", manifest.actions.pin_session);
    expect(tool.name).toBe("pin_session");
    expect(tool.description).toContain("收藏会话");
    expect(tool.parameters.required).toEqual(["session"]);
    expect(tool.parameters.properties.session).toMatchObject({ type: "string", maxLength: 1024 });
    expect(tool.parameters.additionalProperties).toBe(false);
  });

  // ── schema 1 is frozen ──

  it("reads a schema 1 declaration exactly as before: slicing, no required, no agents", () => {
    const manifest = loadSessionPlusManifest(appDir(SCHEMA1));
    expect(manifest.schema).toBe(1);
    expect(manifest.stateEpochDeclared).toBe(false);
    expect(manifest.agents).toEqual({});
    expect(normalizeSessionPlusAction(manifest, "pin_session", { session: "x".repeat(50) })).toEqual({
      ok: true,
      action: "pin_session",
      params: { session: "x".repeat(8) },
    });
    // Absent stays "" rather than becoming a refusal.
    expect(normalizeSessionPlusAction(manifest, "pin_session", {})).toEqual({
      ok: true,
      action: "pin_session",
      params: { session: "" },
    });
  });

  it("still pins a schema 1 declaration to the M4 action surface", () => {
    expect(() => loadSessionPlusManifest(appDir(SCHEMA1.replace("  resume_session: { binding: resource, params: {} }\n", ""))))
      .toThrow(/M4 operation surface/);
  });

  it("does not read a schema 1 declaration as a subset of schema 2", () => {
    // `agents:` in a schema 1 file is not "an optional field it happens not to
    // use" — it is a declaration this build refuses to guess about.
    expect(() => loadSessionPlusManifest(appDir(`${SCHEMA1}agents: { keeper: { adapter: openai-loop, prompt: hi } }\n`)))
      .toThrow();
    expect(() => loadSessionPlusManifest(appDir(`${SCHEMA1}state_epoch: 1\n`)))
      .toThrow(/state_epoch.*schema: 1/);
  });

  it("reads a schema 2 state_epoch and validates its integer domain", () => {
    expect(loadSessionPlusManifest(appDir(schema2("state_epoch: 7\nactions: {}")))).toMatchObject({
      stateEpoch: 7,
      stateEpochDeclared: true,
    });
    for (const value of ["-1", "1.5", "9007199254740992", "unsafe"]) {
      expect(() => loadSessionPlusManifest(appDir(schema2(`state_epoch: ${value}\nactions: {}`))))
        .toThrow(/non-negative safe integer/);
    }
  });

  // ── schema 2 refusals ──

  it("refuses an unknown key rather than ignoring it", () => {
    expect(() => loadSessionPlusManifest(appDir(schema2("actions: {}\nagants: {}"))))
      .toThrow(/unknown key/);
    expect(() => loadSessionPlusManifest(appDir(schema2(
      "actions:\n  ping: { binding: runtime, handler: ping, humanOnly: true, params: {} }",
    )))).toThrow(/unknown key/);
  });

  it("refuses an unknown adapter by name, and a coding CLI by SEC-06 reason", () => {
    expect(() => loadSessionPlusManifest(appDir(schema2(
      "actions:\n  ping: { binding: runtime, handler: ping, params: {} }\nagents:\n  a: { adapter: gpt-loop, prompt: hi }",
    )))).toThrow(/unknown adapter/);

    setDeploymentProfile("cloud-multi-user");
    expect(() => loadSessionPlusManifest(appDir(schema2(
      "actions:\n  ping: { binding: runtime, handler: ping, params: {} }\nagents:\n  a: { adapter: claude-code, prompt: hi }",
    )))).toThrow(/cloud-multi-user/);
  });

  it("keeps the profile ban and secure mode as two composed answers, in order", () => {
    // The order IS the safety content: on a shared host the profile answers on
    // its own, so no secure-mode setting can reach past it. On `local-owner`
    // the profile steps aside and secure mode gets its say — a different
    // refusal, with a different reason, because only that one has a switch.
    const yaml = schema2(
      "actions:\n  ping: { binding: runtime, handler: ping, params: {} }\nagents:\n  a: { adapter: codex, prompt: hi }",
    );
    setDeploymentProfile("cloud-multi-user");
    expect(() => loadSessionPlusManifest(appDir(yaml))).toThrow(/cloud-multi-user/);
    setDeploymentProfile("local-owner");
    expect(() => loadSessionPlusManifest(appDir(yaml))).toThrow(/安全模式/);
  });

  it("refuses a model this deployment does not serve", () => {
    const dir = appDir(schema2(
      "actions:\n  ping: { binding: runtime, handler: ping, params: {} }\nagents:\n  a: { adapter: openai-loop, prompt: hi, model: expensive-1 }",
    ));
    expect(() => loadSessionPlusManifest(dir, { allowedModels: ["cheap-1"] })).toThrow(/does not serve/);
    expect(loadSessionPlusManifest(dir, { allowedModels: ["expensive-1"] }).agents.a.model).toBe("expensive-1");
    // Not adjudicating models is a valid deployment stance.
    expect(loadSessionPlusManifest(dir).agents.a.model).toBe("expensive-1");
  });

  it("refuses an unusable daily time, a daily_prompt with no daily, and an unknown effort", () => {
    const base = "actions:\n  ping: { binding: runtime, handler: ping, params: {} }\nagents:\n  a: ";
    expect(() => loadSessionPlusManifest(appDir(schema2(`${base}{ adapter: openai-loop, prompt: hi, daily: "25:00" }`))))
      .toThrow(/daily time/);
    expect(() => loadSessionPlusManifest(appDir(schema2(`${base}{ adapter: openai-loop, prompt: hi, daily_prompt: go }`))))
      .toThrow(/daily_prompt without daily/);
    expect(() => loadSessionPlusManifest(appDir(schema2(`${base}{ adapter: openai-loop, prompt: hi, effort: xhigh }`))))
      .toThrow(/unknown effort/);
  });

  it("accepts max effort without weakening the deployment model allowlist", () => {
    const dir = appDir(schema2(
      "actions:\n  ping: { binding: runtime, handler: ping, params: {} }\nagents:\n  a: { adapter: openai-loop, prompt: hi, model: gpt-5.6-luna, effort: max }",
    ));
    expect(loadSessionPlusManifest(dir, { allowedModels: ["gpt-5.6-luna"] }).agents.a)
      .toMatchObject({ model: "gpt-5.6-luna", effort: "max" });
    expect(() => loadSessionPlusManifest(dir, { allowedModels: ["other"] })).toThrow(/does not serve/);
  });

  it("refuses an agent declaration that can reach nothing", () => {
    expect(() => loadSessionPlusManifest(appDir(schema2(
      "actions:\n  ping: { binding: runtime, handler: ping, human_only: true, params: {} }\nagents:\n  a: { adapter: openai-loop, prompt: hi }",
    )))).toThrow(/every action is human_only/);
  });

  it("refuses an action that is both human_only and agent_only", () => {
    expect(() => loadSessionPlusManifest(appDir(schema2(
      "actions:\n  ping: { binding: runtime, handler: ping, human_only: true, agent_only: true, params: {} }",
    )))).toThrow(/both human_only and agent_only/);
  });

  it("binds a human prompt to one declared App agent and hides the enqueue action from agents", () => {
    const manifest = loadSessionPlusManifest(appDir(schema2(
      "actions:\n"
      + "  ask:\n    binding: agent\n    agent: maker\n    human_only: true\n"
      + "    params:\n      prompt: { type: string, max: 2000, required: true }\n"
      + "  apply:\n    binding: runtime\n    handler: apply\n    agent_only: true\n    params: {}\n"
      + "agents:\n  maker: { adapter: openai-loop, prompt: make it }",
    )));
    expect(manifest.actions.ask).toMatchObject({ binding: "agent", agent: "maker", humanOnly: true });
    expect(sessionPlusActionsFor(manifest, "agent").map((row) => row.name)).toEqual(["apply"]);
    expect(normalizeSessionPlusAction(manifest, "ask", { prompt: "做一份发布稿" }, "user"))
      .toEqual({ ok: true, action: "ask", params: { prompt: "做一份发布稿" } });
  });

  it("refuses ambiguous or self-feeding agent bindings", () => {
    const declaration = (ask: string) => schema2(
      `actions:\n${ask}\n  apply: { binding: runtime, handler: apply, agent_only: true, params: {} }\n`
      + "agents:\n  maker: { adapter: openai-loop, prompt: make it }",
    );
    expect(() => loadSessionPlusManifest(appDir(declaration(
      "  ask: { binding: agent, agent: missing, human_only: true, params: { prompt: { type: string, required: true } } }",
    )))).toThrow(/undeclared agent/);
    expect(() => loadSessionPlusManifest(appDir(declaration(
      "  ask: { binding: agent, agent: maker, params: { prompt: { type: string, required: true } } }",
    )))).toThrow(/must be human_only/);
    expect(() => loadSessionPlusManifest(appDir(declaration(
      "  ask: { binding: agent, agent: maker, human_only: true, params: { text: { type: string, required: true } } }",
    )))).toThrow(/exactly one required string parameter named prompt/);
  });

  it("refuses unknown binding spellings in strict schemas", () => {
    expect(() => loadSessionPlusManifest(appDir(schema2(
      "actions:\n  ping: { binding: agnet, params: {} }",
    )))).toThrow(/unknown binding/);
  });

  it("checks a typed parameter and its enum on the server side", () => {
    const manifest = loadSessionPlusManifest(appDir(schema2(
      "actions:\n  ping:\n    binding: runtime\n    handler: ping\n    params:\n"
      + "      n: { type: number, max: 6 }\n      b: { type: boolean }\n      m: { type: string, max: 8, enum: [a, b] }",
    )));
    expect(normalizeSessionPlusAction(manifest, "ping", { n: 12, b: true, m: "a" })).toEqual({
      ok: true,
      action: "ping",
      params: { n: "12", b: "true", m: "a" },
    });
    expect(normalizeSessionPlusAction(manifest, "ping", { n: "not-a-number" }))
      .toMatchObject({ ok: false, code: "invalid_params" });
    expect(normalizeSessionPlusAction(manifest, "ping", { m: "c" }))
      .toMatchObject({ ok: false, code: "invalid_params" });
  });
});
