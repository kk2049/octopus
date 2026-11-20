/**
 * The facts about Hardened JavaScript that the app runtime's security argument
 * rests on.
 *
 * `sandbox.test.ts` asserts what app code cannot do through the real boundary.
 * This file asserts *why*, one library behaviour at a time, so that a `ses`
 * upgrade which changes one of them fails here — next to the reason it matters
 * — instead of silently widening what generated code can reach.
 *
 * It also keeps the counterfactual: the case that made Compartment reuse
 * unsafe is reproduced here deliberately, because a property nobody has seen
 * fail is a property people optimise away.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import "ses";
import { ModuleSource } from "@endo/module-source";
import { stripTypeScriptTypes } from "node:module";

/**
 * `lockdown()` is process-wide and irreversible, which is the whole reason app
 * code still gets a child process — see the header of `sandbox.ts`. Here it
 * runs inside the vitest worker, so keep it to this one file's worker and use
 * the same options the child does.
 */
lockdown({ errorTaming: "unsafe" });

type Globals = Record<string, unknown>;

function load(source: string, globals: Globals = {}, modules: Record<string, string> = {}): Promise<Globals> {
  const sources = new Map<string, unknown>();
  const compile = (text: string, name: string): unknown => {
    if (!sources.has(name)) sources.set(name, new ModuleSource(stripTypeScriptTypes(text, { mode: "strip" }), name));
    return sources.get(name);
  };
  const c = new Compartment({
    name: "facts",
    globals: harden(globals),
    resolveHook: (specifier: string) => specifier,
    importHook: async (specifier: string) => {
      if (specifier === "main") return { source: compile(source, "main") };
      const extra = modules[specifier];
      if (extra === undefined) throw new Error(`module not available: ${specifier}`);
      return { source: compile(extra, specifier) };
    },
    __options__: true,
  });
  return c.import("main").then((m: { namespace: Globals }) => m.namespace);
}

describe("a Compartment inherits the language and nothing else", () => {
  it("has no host objects at all — the endowment table is the whole surface", async () => {
    const ns = await load(`
      export function probe() {
        const names = ["fetch", "process", "require", "setTimeout", "setInterval", "queueMicrotask",
                       "structuredClone", "XMLHttpRequest", "WebSocket", "EventSource", "navigator",
                       "console", "TextEncoder", "URL", "Buffer", "global", "globalThis.process"];
        return names.filter((n) => typeof (globalThis as any)[n] !== "undefined");
      }
    `);
    expect((ns.probe as () => string[])()).toEqual([]);
  });

  it("still has the intrinsics real code needs", async () => {
    const ns = await load(`
      export function probe() {
        return ["Promise", "JSON", "Map", "Set", "Object", "Array", "RegExp", "Error", "Symbol", "BigInt",
                "Proxy", "Reflect", "WeakMap"].filter((n) => typeof (globalThis as any)[n] === "undefined");
      }
    `);
    expect((ns.probe as () => string[])()).toEqual([]);
  });

  it("cannot escape through its own evaluators", async () => {
    // The Function constructor inside a Compartment is the Compartment's, so
    // it compiles in the Compartment's scope. This is the property that makes
    // "no host objects" mean something.
    const ns = await load(`
      export function probe() {
        return String(Function("return typeof process")()) + "/"
             + String(Function("return typeof fetch")());
      }
    `);
    expect((ns.probe as () => string)()).toBe("undefined/undefined");
  });

  it("refuses to compile a module that could reach the host loader", async () => {
    // SES censors source that might contain a dynamic import or a direct eval
    // inside an evaluator, because either could resolve against the host realm.
    // Fail-closed at compile time, so a module cannot half-load.
    await expect(load(`export function f() { return new Function("return import('node:fs')"); }`))
      .rejects.toThrow(/SES_IMPORT_REJECTED/);
    await expect(load(`export function f() { return eval("1"); }`)).rejects.toThrow(/SES_EVAL_REJECTED/);
  });

  it("routes every import — static and dynamic — through the module map", async () => {
    const ns = await load(`
      export async function probe() {
        const out: string[] = [];
        for (const spec of ["node:fs", "node:net", "/etc/passwd", "./sibling.ts", "ses"]) {
          try { await import(spec); out.push("GOT:" + spec); } catch { out.push("NO:" + spec); }
        }
        return out;
      }
    `);
    expect(await (ns.probe as () => Promise<string[]>)()).toEqual([
      "NO:node:fs",
      "NO:node:net",
      "NO:/etc/passwd",
      "NO:./sibling.ts",
      "NO:ses",
    ]);
  });

  it("links the modules the map does provide", async () => {
    // The jail is the map, not a ban on imports: app code may still be split
    // across its own files.
    const ns = await load(`import { two } from "./two.ts"; export function probe() { return two() + 1; }`, {}, {
      "./two.ts": `export function two() { return 2; }`,
    });
    expect((ns.probe as () => number)()).toBe(3);
  });

  it("has no clock or randomness unless one is handed over", async () => {
    // Not a limitation — projections are pure folds and handlers get `ctx.now`.
    // The runtime endows a Date frozen at one instant; nothing endows random.
    const ns = await load(`
      export function probe() {
        const r: string[] = [];
        try { Date.now(); r.push("CLOCK"); } catch { r.push("no clock"); }
        try { Math.random(); r.push("RANDOM"); } catch { r.push("no random"); }
        return r;
      }
    `);
    expect((ns.probe as () => string[])()).toEqual(["no clock", "no random"]);
  });

  it("a frozen clock reads as an ordinary Date", async () => {
    const nowMs = Date.parse("2026-07-30T12:00:00Z");
    const Shared = Date;
    function TamedDate(this: unknown, ...args: unknown[]): unknown {
      if (new.target === undefined) return Reflect.apply(Shared as never, undefined, args as never);
      return Reflect.construct(
        Shared as never,
        (args.length ? args : [nowMs]) as never,
        (new.target === TamedDate ? Shared : new.target) as never,
      );
    }
    TamedDate.prototype = Shared.prototype;
    (TamedDate as unknown as { now: () => number }).now = () => nowMs;
    const ns = await load(
      `export function probe() {
        return { now: Date.now(), iso: new Date().toISOString(), isDate: new Date() instanceof Date };
      }`,
      { Date: TamedDate },
    );
    expect((ns.probe as () => { now: number; iso: string; isDate: boolean })()).toEqual({
      now: nowMs,
      iso: "2026-07-30T12:00:00.000Z",
      isDate: true,
    });
  });

  it("passes error messages out, so a handler's author can debug it", async () => {
    const ns = await load(`export function boom() { throw new Error("boom-with-detail"); }`);
    expect(ns.boom as () => void).toThrow(/boom-with-detail/);
  });

  it("harden makes a facade untamperable from inside", async () => {
    const calls: string[] = [];
    const facade = harden({ request: (op: string) => (calls.push(op), "ok") });
    const ns = await load(
      `export function probe(cap: any) {
        const out: string[] = [String(cap.request("real"))];
        try { cap.request = () => "lie"; out.push("REPLACED"); } catch { out.push("frozen"); }
        try { Object.defineProperty(cap, "request", { value: () => "lie" }); out.push("REDEFINED"); }
        catch { out.push("sealed"); }
        return out;
      }`,
    );
    expect((ns.probe as (c: unknown) => string[])(facade)).toEqual(["ok", "frozen", "sealed"]);
    expect(calls).toEqual(["real"]);
  });
});

describe("why one Compartment per invocation is not an optimisation to remove", () => {
  it("REUSING one leaks a live capability to a leftover microtask", async () => {
    // The counterfactual, run for real. Two invocations share one Compartment;
    // the first plants a microtask with no authority, the second stashes its own
    // facade in module scope. Nothing here is exotic — that is the point.
    const source = `
      let stash: any = null;
      export async function weak(cap: any) {
        Promise.resolve().then(async () => {
          for (let i = 0; i < 100; i++) {
            await null;
            if (stash) { try { await stash.request("exec"); } catch {} }
          }
        });
        return "planted";
      }
      export async function strong(cap: any) {
        stash = cap;
        for (let i = 0; i < 30; i++) await null;
        return String(await cap.request("read_file"));
      }
    `;
    const spent: string[] = [];
    const facadeFor = (label: string): { cap: unknown; revoke: () => void } => {
      let live = true;
      return {
        cap: harden({
          request: async (op: string) => {
            if (!live) return "revoked";
            spent.push(`${label}:${op}`);
            return "ok";
          },
        }),
        revoke: () => {
          live = false;
        },
      };
    };

    const shared = await load(source);
    const weak = facadeFor("weak");
    await (shared.weak as (c: unknown) => Promise<string>)(weak.cap);
    weak.revoke();
    const strong = facadeFor("strong");
    await (shared.strong as (c: unknown) => Promise<string>)(strong.cap);
    strong.revoke();
    for (let i = 0; i < 500; i++) await null;

    // Revocation alone did NOT save us: the leftover spent `strong`'s authority
    // while `strong` was still running, through a plain module variable.
    expect(spent.filter((s) => s.endsWith(":exec")).length).toBeGreaterThan(0);
  });

  it("a fresh one per invocation closes it", async () => {
    const source = `
      let stash: any = null;
      export async function weak(cap: any) {
        Promise.resolve().then(async () => {
          for (let i = 0; i < 100; i++) {
            await null;
            if (stash) { try { await stash.request("exec"); } catch {} }
          }
        });
        return "planted";
      }
      export async function strong(cap: any) {
        stash = cap;
        for (let i = 0; i < 30; i++) await null;
        return String(await cap.request("read_file"));
      }
    `;
    const spent: string[] = [];
    const cap = (label: string): unknown =>
      harden({
        request: async (op: string) => {
          spent.push(`${label}:${op}`);
          return "ok";
        },
      });

    await (((await load(source)).weak) as (c: unknown) => Promise<string>)(cap("weak"));
    await (((await load(source)).strong) as (c: unknown) => Promise<string>)(cap("strong"));
    for (let i = 0; i < 500; i++) await null;

    expect(spent).toEqual(["strong:read_file"]);
  });

  it("costs a fraction of a millisecond, with the source parse cached", async () => {
    // The number that made the trade possible. A process spawn was ~35ms, so a
    // per-dispatch Compartment is roughly two orders of magnitude cheaper.
    const text = `export function f() { return 1; }`;
    const source = new ModuleSource(text, "bench");
    const t0 = process.hrtime.bigint();
    const N = 100;
    for (let i = 0; i < N; i++) {
      const c = new Compartment({
        name: "bench",
        globals: harden({}),
        resolveHook: (s: string) => s,
        importHook: async () => ({ source }),
        __options__: true,
      });
      await c.import("bench");
    }
    const each = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    expect(each).toBeLessThan(10);
  });
});

describe("the real apps still load under Hardened JavaScript", () => {
  // A compatibility smoke test, not a security one: the five probe apps are the
  // corpus that tells us whether "no clock, no console, no imports" is a
  // liveable contract for app authors.
  const appsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../v3-host/apps");
  const files = fs.existsSync(appsDir)
    ? fs
        .readdirSync(appsDir)
        .flatMap((app) =>
          ["actions.ts", "projection.ts"]
            .map((f) => path.join(appsDir, app, f))
            .filter((f) => fs.existsSync(f))
            .map((f) => [`${app}/${path.basename(f)}`, f] as const),
        )
    : [];

  it("found the probe apps to check", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const [label, file] of files) {
    it(`${label} compiles and exports functions`, async () => {
      const nowMs = Date.parse("2026-07-30T12:00:00Z");
      const Shared = Date;
      const clock = Object.assign(
        function TamedDate(this: unknown, ...args: unknown[]): unknown {
          if (new.target === undefined) return Reflect.apply(Shared as never, undefined, args as never);
          return Reflect.construct(Shared as never, (args.length ? args : [nowMs]) as never, Shared as never);
        },
        { now: () => nowMs, parse: Shared.parse, UTC: Shared.UTC, prototype: Shared.prototype },
      );
      const ns = await load(fs.readFileSync(file, "utf8"), {
        Date: clock,
        console: harden({ log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
      });
      expect(Object.keys(ns).filter((k) => typeof ns[k] === "function").length).toBeGreaterThan(0);
    });
  }
});
