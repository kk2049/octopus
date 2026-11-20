import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp, ManifestError } from "./manifest.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoot = path.join(pkgRoot, ".test-tmp");

let dir: string;
beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  dir = fs.mkdtempSync(path.join(tmpRoot, "manifest-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const VALID_APP = `
app: demo
title: 演示应用
scope: per-user
actions:
  add_note:
    title: 记一条
    predicate: owner
    params:
      text: { type: string, required: true }
  ping:
    predicate: any
agents:
  page:
    adapter: openai-loop
    prompt: prompts/page.md
pages:
  main: pages/main.yaml
  digest: pages/digest.yaml
feishu:
  cards: [digest]
`;

const VALID_PAGE = `
title: 主页
layout: [left, right]
slots:
  left:
    widget: list
    bind: view.items
    on: { select: "action:ping" }
  right:
    widget: form
    props: { action: add_note }
`;

const DIGEST_PAGE = `
layout: [top]
slots:
  top: { widget: markdown, bind: view.summary }
`;

function writeApp(appYaml: string, pages: Record<string, string> = {}) {
  fs.writeFileSync(path.join(dir, "app.yaml"), appYaml);
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
  // Runtime files the loader now requires to exist (experiment #5 fix).
  fs.writeFileSync(path.join(dir, "projection.ts"), "export function project(){ return {}; }");
  fs.writeFileSync(path.join(dir, "actions.ts"), "export {};");
  fs.writeFileSync(path.join(dir, "prompts", "page.md"), "prompt");
  for (const [file, body] of Object.entries(pages)) {
    fs.writeFileSync(path.join(dir, "pages", file), body);
  }
}

describe("loadApp", () => {
  it("loads a valid app with external page files", () => {
    writeApp(VALID_APP, {
      "main.yaml": VALID_PAGE,
      "digest.yaml": DIGEST_PAGE,
    });
    const m = loadApp(dir);
    expect(m.app).toBe("demo");
    expect(m.actions.add_note.params?.text.required).toBe(true);
    expect(m.pages.main.slots.left.on).toEqual({ select: "action:ping" });
    expect(m.agents.page.adapter).toBe("openai-loop");
    expect(m.feishuCards).toEqual(["digest"]);
  });

  it("collects ALL problems instead of failing one at a time", () => {
    writeApp(
      `
app: Bad Name
actions:
  broken: {}
pages:
  main:
    layout: [a, b]
    slots:
      a: { widget: no-such-widget }
`,
    );
    let err: ManifestError | null = null;
    try {
      loadApp(dir);
    } catch (e) {
      err = e as ManifestError;
    }
    expect(err).toBeInstanceOf(ManifestError);
    const text = err!.message;
    expect(text).toMatch(/app: required, lowercase slug/);
    expect(text).toMatch(/actions\.broken\.predicate: required/);
    expect(text).toMatch(/unknown widget "no-such-widget"/);
    expect(text).toMatch(/layout references slot "b"/);
    // Experiment #5's cascade lie, fixed: slot "a" IS defined (just broken) —
    // the loader must not also claim it is missing.
    expect(text).not.toMatch(/layout references slot "a"/);
  });

  it("refuses silent passes: typo'd keys, missing prompt files, missing runtime files", () => {
    writeApp(
      `
app: demo
actions:
  ping: { predicate: any, confrim: true }
agents:
  page: { adapter: openai-loop, prompt: prompts/ghost.md }
pages:
  main:
    layout: [a]
    slots:
      a: { widget: markdown, bind: view.x, wdiget: oops }
`,
    );
    let err: ManifestError | null = null;
    try {
      loadApp(dir);
    } catch (e) {
      err = e as ManifestError;
    }
    const text = err!.message;
    expect(text).toMatch(/actions\.ping: unknown key "confrim"/);
    expect(text).toMatch(/unknown key "wdiget"/);
    expect(text).toMatch(/prompts\/ghost\.md" does not exist/);

    fs.rmSync(path.join(dir, "projection.ts"));
    writeApp; // keep helper reference
    let err2: ManifestError | null = null;
    try {
      loadApp(dir);
    } catch (e) {
      err2 = e as ManifestError;
    }
    expect(err2!.message).toMatch(/projection\.ts missing/);
  });

  it("refuses computation in wiring and unknown events", () => {
    writeApp(
      `
app: demo
actions:
  ping: { predicate: any }
pages:
  main:
    layout: [a]
    slots:
      a:
        widget: list
        bind: view.items
        on: { select: "js:doThing()", hover: "action:ping" }
`,
    );
    expect(() => loadApp(dir)).toThrowError(/pages may wire, never compute/);
    expect(() => loadApp(dir)).toThrowError(/emits no such event/);
  });

  it("cross-checks wiring, forms and feishu card grade", () => {
    writeApp(
      `
app: demo
actions:
  ping: { predicate: any }
agents:
  page: { adapter: openai-loop }
pages:
  main:
    layout: [a, b, c]
    slots:
      a: { widget: list, bind: view.items, on: { select: "action:missing" } }
      b: { widget: form, props: { action: nope } }
      c: { widget: agent-chat, agent: ghost }
  digest:
    layout: [t]
    slots:
      t: { widget: timeline, bind: view.t }
feishu:
  cards: [digest, unknown_page]
`,
    );
    let err: ManifestError | null = null;
    try {
      loadApp(dir);
    } catch (e) {
      err = e as ManifestError;
    }
    const text = err!.message;
    expect(text).toMatch(/wired to unknown action "missing"/);
    expect(text).toMatch(/form props\.action must name a declared action/);
    expect(text).toMatch(/agent-chat must bind a declared agent/);
    expect(text).toMatch(/rich widget "timeline" — card pages may use card-grade widgets only/);
    expect(text).toMatch(/unknown page "unknown_page"/);
  });

  it("locals vocabulary: $binds need a declaration or a local: wiring; enum_bind is view-path checked", () => {
    writeApp(
      `
app: demo
actions:
  pick: { predicate: any, params: { p: { type: string, enum_bind: "process.env" } } }
pages:
  main:
    layout: [a, b]
    slots:
      a: { widget: list, bind: view.items, on: { select: "local:sel" } }
      b: { widget: markdown, bind: view.byId.$sel }
  other:
    layout: [c]
    slots:
      c: { widget: markdown, bind: view.byId.$ghost }
`,
    );
    let err: ManifestError | null = null;
    try {
      loadApp(dir);
    } catch (e) {
      err = e as ManifestError;
    }
    const text = err!.message;
    // page "main": $sel is fine because a local: wiring sets it — no complaint
    expect(text).not.toMatch(/\$sel/);
    expect(text).toMatch(/\$ghost but no locals declaration/);
    expect(text).toMatch(/enum_bind: must be a plain "view/);

    // declared locals with default_bind pass
    writeApp(
      `
app: demo
pages:
  main:
    locals:
      sel: { default_bind: view.latestId }
    layout: [b]
    slots:
      b: { widget: markdown, bind: view.byId.$sel }
`,
    );
    const m = loadApp(dir);
    expect(m.pages.main.locals?.sel.default_bind).toBe("view.latestId");
  });

  it("rejects bind paths that do not start at view", () => {
    writeApp(
      `
app: demo
pages:
  main:
    layout: [a]
    slots:
      a: { widget: markdown, bind: "process.env.SECRET" }
`,
    );
    expect(() => loadApp(dir)).toThrowError(/dotted path starting at "view"/);
  });
});
