/**
 * The two rules the coordinator gained for agents, tested against a REAL
 * Runtime child running a purpose-built App.
 *
 * Both are refusals whose absence would be invisible in normal use, which is
 * exactly why they need an App that tries to break them rather than a mock that
 * agrees to.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppRuntimeService, InProcessRuntimeClient, backendRelease } from "@claude-bot/app-runtime";
import { AppStateService, InProcessStateClient } from "@claude-bot/app-state";
import { SessionPlusAppService } from "./app-service.js";
import { sessionPlusIdentity } from "../app-core/identity.js";
import { loadSessionPlusManifest } from "../app-core/manifest.js";

const closers: Array<() => void | Promise<void>> = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An App whose one action emits whichever event type the caller asks for. */
function appDirEmitting(): string {
  const dir = mkdtempSync(join(tmpdir(), "sp-sys-app-"));
  dirs.push(dir);
  mkdirSync(join(dir, "pages"), { recursive: true });
  writeFileSync(join(dir, "pages", "main.yaml"), "page: {}\n");
  writeFileSync(join(dir, "app.yaml"), `id: session-plus
schema: 2
actions:
  emit:
    binding: runtime
    handler: emit
    params:
      type: { type: string, max: 64, required: true }
agents:
  keeper:
    adapter: openai-loop
    prompt: test
view: { page: pages/main.yaml }
`);
  writeFileSync(join(dir, "actions.ts"), `export function emit(ctx: any, params: any) {
  return { events: [{ type: String(params.type), data: {}, at: "", by: "x" }], result: null };
}
`);
  writeFileSync(join(dir, "projection.ts"), `export function project(events: any[]) {
  return { seen: (Array.isArray(events) ? events : []).map((e) => e?.type) };
}
`);
  return dir;
}

function fixture(appDir: string) {
  const stateDir = mkdtempSync(join(tmpdir(), "sp-sys-state-"));
  dirs.push(stateDir);
  const state = new AppStateService(stateDir);
  const runtime = new AppRuntimeService(appDir);
  closers.push(async () => {
    state.close();
    await runtime.stop();
  });
  const app = new SessionPlusAppService({
    state: new InProcessStateClient(state),
    runtime: new InProcessRuntimeClient(runtime),
    identity: {
      ...sessionPlusIdentity(),
      backendCodeDigest: backendRelease(appDir).backendCodeDigest,
    },
    manifest: loadSessionPlusManifest(appDir),
  });
  closers.push(() => app.stop());
  return app;
}

const ALICE = { owner: "alice", credential: "ws:one", session: true };

describe("the coordinator's agent rules", () => {
  it("fails the WHOLE dispatch when an App emits a reserved system event", async () => {
    // Filtering the one event would be a rewrite nobody was told about, and the
    // App would go on believing it had queued work for its own agent — which is
    // the failure this refusal exists for: a re-entrant tool loop with no
    // person in it, spending the deployment's inference budget.
    const app = fixture(appDirEmitting());
    const tab = await app.open(ALICE);
    expect(await app.dispatch(tab.handle, ALICE, { action: "emit", params: { type: "sys_agent_inbox" } }))
      .toMatchObject({ ok: false, code: "action_rejected" });
    // Nothing was written: not the reserved event, and not a partial commit.
    const again = await app.open({ ...ALICE, credential: "ws:two" });
    expect(again.projection).toMatchObject({ seen: [] });
    // An ordinary event from the same App still commits.
    expect((await app.dispatch(tab.handle, ALICE, { action: "emit", params: { type: "ok_event" } })).ok).toBe(true);
  });

  it("gives an agent turn its own instance, and does not let a browser drive it", async () => {
    const app = fixture(appDirEmitting());
    const turn = await app.openAgentTurn({ owner: "alice", app: "session-plus", agent: "keeper", turnId: "t1" });
    // The credential is a handle nothing issued to a browser, so a login cannot
    // resolve it — and the actor kind is part of the identity, not decoration.
    expect(await app.dispatch(turn.handle, ALICE, { action: "emit", params: { type: "ok_event" } }))
      .toMatchObject({ ok: false, code: "invalid_instance" });
  });

  it("refuses a typed-port proposal from an agent, because that is not its surface", async () => {
    const app = fixture(appDirEmitting());
    const turn = await app.openAgentTurn({ owner: "alice", app: "session-plus", agent: "keeper", turnId: "t1" });
    const principal = {
      owner: "alice",
      credential: "agent:session-plus/keeper#t1",
      session: false,
      actor: { kind: "agent" as const, app: "session-plus", agent: "keeper", turnId: "t1" },
    };
    expect(await app.dispatch(turn.handle, principal, {
      action: "resource.list_directory",
      params: { binding: "workspace", ref: "x" },
    })).toMatchObject({ ok: false, code: "unknown_action" });
  });

  it("ends an agent turn on an account teardown, but not when one login ends", async () => {
    // A turn's lifetime is not a tab's. Logging out must not kill work the
    // account queued; revoking the account must.
    const app = fixture(appDirEmitting());
    await app.openAgentTurn({ owner: "alice", app: "session-plus", agent: "keeper", turnId: "t1" });
    await app.open(ALICE);
    expect(app.releaseCredential("alice", "ws:one")).toBe(1);
    expect(app.releaseOwner("alice")).toBe(1);
  });

  it("signs an agent's events differently from a person's", async () => {
    const app = fixture(appDirEmitting());
    const tab = await app.open(ALICE);
    await app.dispatch(tab.handle, ALICE, { action: "emit", params: { type: "by_human" } });
    const turn = await app.openAgentTurn({ owner: "alice", app: "session-plus", agent: "keeper", turnId: "t1" });
    const principal = {
      owner: "alice",
      credential: "agent:session-plus/keeper#t1",
      session: false,
      actor: { kind: "agent" as const, app: "session-plus", agent: "keeper", turnId: "t1" },
    };
    await app.dispatch(turn.handle, principal, { action: "emit", params: { type: "by_agent" } });
    const read = await app.readAgentInbox("alice", "keeper", 0);
    expect(read.head).toBe(2);
    // The projection cannot see `by`, so read the stream through the same
    // service the plane uses. Two events, two different authors.
    const stream = await (app as unknown as {
      deps: { state: InProcessStateClient };
    }).deps.state.readSince(read.streamId, 0, 16);
    const authors = stream.events.map((event) => event.by);
    expect(authors[0]).toBe("session-plus");
    expect(authors[1]).toBe("agent:session-plus/keeper@alice");
  });
});
