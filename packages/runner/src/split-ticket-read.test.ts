import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRpc, type RpcOptions } from "./core.js";
import { RunnerSessionProjector } from "./session-projector.js";
import { RUNNER_SESSION_PROJECTION_SCHEMA, type RunnerSessionProjection } from "./session-projection.js";
import { LaunchJournal } from "./launch-journal.js";

const SID = "01a0a3e3-6ca2-7541-b2a6-4f1af6106586";
const OTHER_SID = "01a0a3e3-6ca2-7541-b2a6-4f1af6106587";
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture(placement: "v1" | "v2" | "none" = "v1") {
  const home = await mkdtemp(path.join(tmpdir(), "split-ticket-read-"));
  homes.push(home);
  const ordinary = path.join(home, ".codex");
  const split = path.join(home, ".octopus", "codex-split-home");
  const writeTranscript = async (codexHome: string, id: string, label: string) => {
    const file = path.join(codexHome, "sessions", "2026", "09", "15", "rollout-2026-09-15T03-26-23-" + id + ".jsonl");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, [
      { type: "session_meta", payload: { id, cwd: home } },
      { type: "event_msg", payload: { type: "user_message", message: label + " request" } },
      { type: "event_msg", payload: { type: "agent_message", message: label + " progress" } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    return file;
  };
  const splitPath = await writeTranscript(split, SID, "split");
  const otherPath = await writeTranscript(split, OTHER_SID, "unrelated");
  if (placement !== "none") {
    const launches = new LaunchJournal(home);
    await launches.begin({
      client_request_id: "op_ticket_transcript_launch",
      workspace_id: "ws_0123456789abcdef01234567",
      source: "codex",
      remote_execution: true,
      execution_device: "exec-b",
      prompt_hash: "a".repeat(64),
    });
    await launches.markManagedStarted("op_ticket_transcript_launch", SID, "app-server",
      placement === "v2" ? "spc_" + "b".repeat(64) : undefined);
  }
  const options: RpcOptions = {
    sessionScanRoot: { home, codexHome: ordinary },
    sessionPlusSessionScanRoot: { home, codexHome: split },
  };
  const read = (extra: Record<string, unknown> = {}, opts = options) => handleRpc(home, {
    id: "ticket-read", method: "read_session",
    args: { id: SID, source: "codex", rich: true, _octopus_include_session_plus: true, ...extra },
  }, opts);
  return { home, ordinary, splitPath, otherPath, writeTranscript, options, read };
}

describe("ticket transcript RPC split root selection", () => {
  it.each(["v1", "v2"] as const)("reads the exact %s launch's native transcript with real history paging", async (placement) => {
    const f = await fixture(placement);
    expect(await f.read({ max_messages: 1 })).toMatchObject({
      ok: true, result: {
        meta: { id: SID, source: "codex", path: f.splitPath },
        total_messages: 2, returned_messages: 1, offset: 1,
        messages: [{ role: "assistant", blocks: [{ type: "text", text: "split progress" }] }],
      },
    });
    expect(await f.read({ max_messages: 1, offset: 0 })).toMatchObject({
      ok: true, result: {
        total_messages: 2, returned_messages: 1, offset: 0,
        messages: [{ role: "user", blocks: [{ type: "text", text: "split request" }] }],
      },
    });
  });

  it("requires explicit opt-in and an exact durable placement without exposing split discovery", async () => {
    const f = await fixture();
    for (const include of [undefined, false, "true"]) {
      expect(await f.read({ _octopus_include_session_plus: include })).toMatchObject({
        ok: false, error: "session not found for id: " + SID,
      });
    }
    for (const id of [SID.slice(0, 12), OTHER_SID]) {
      expect(await f.read({ id })).toMatchObject({ ok: false, error: "session not found for id: " + id });
    }
    expect(await f.read({ source: "claude" })).toMatchObject({ ok: false });
    const unplaced = await fixture("none");
    expect(await unplaced.read()).toMatchObject({ ok: false, error: "session not found for id: " + SID });
    expect(await unplaced.read({ path: unplaced.splitPath, codex_home: path.dirname(unplaced.splitPath) }))
      .toMatchObject({ ok: false });
  });

  it("keeps ordinary reads separate and ignores caller paths when selecting a journaled split identity", async () => {
    const f = await fixture();
    const ordinaryPath = await f.writeTranscript(f.ordinary, SID, "ordinary");
    expect(await f.read({ _octopus_include_session_plus: false })).toMatchObject({
      ok: true, result: { meta: { path: ordinaryPath }, messages: [
        { blocks: [{ text: "ordinary request" }] }, { blocks: [{ text: "ordinary progress" }] },
      ] },
    });
    expect(await f.read({ path: f.otherPath })).toMatchObject({
      ok: true, result: { meta: { id: SID, path: f.splitPath }, messages: [
        { blocks: [{ text: "split request" }] }, { blocks: [{ text: "split progress" }] },
      ] },
    });
    expect(await f.read({}, { ...f.options, sessionPlusSessionScanRoot: undefined })).toMatchObject({
      ok: false, error: "Sessions+ split transcript root is unavailable on this Runner",
    });
  });
});


describe("managed split transcript subscription", () => {
  it("publishes recovery and its cleared state from the same journaled root as the initial read", async () => {
    const f = await fixture();
    let waiting = true;
    const control = { discover: async () => {}, publicRuntime: async () => ({
      process_state: "unknown", turn_state: waiting ? "unknown" : "idle",
      observed_at: new Date().toISOString(), capabilities: { interrupt: waiting },
      ...(waiting ? { recovery: { state: "waiting_resource" } } : {}),
    }) };
    const frames: RunnerSessionProjection[] = [];
    const projector = new RunnerSessionProjector({
      dispatcher: { handle: request => handleRpc(f.home, request, { ...f.options, agentControlPlane: control as never }) },
      send: frame => frames.push(frame),
    });
    try {
      projector.handleCommand({ schema: RUNNER_SESSION_PROJECTION_SCHEMA, kind: "transcript_subscribe",
        source: "codex", session_id: SID, max_messages: 20 });
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(frames[0]).toMatchObject({ kind: "transcript", session_id: SID,
        transcript: { meta: { runtime: { recovery: { state: "waiting_resource" } } }, total_messages: 2 } });
      waiting = false; projector.notifyTranscriptChanged("codex", SID);
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      expect(frames[1]).toMatchObject({ transcript: { meta: { runtime: { turn_state: "idle" } } } });
      expect(JSON.stringify(frames[1])).not.toContain("waiting_resource");
    } finally { projector.close(); }
  });
});
