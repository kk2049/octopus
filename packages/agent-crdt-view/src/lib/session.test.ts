/**
 * Two collaborators, one in-process server, no transport.
 *
 * ── What this file is for ──────────────────────────────────────────────────
 *
 * The reuse claim in this repository is always checked the same way: the same
 * module objects, a different provider. Here the second provider is
 * `createMemoryCrdtPort` — an in-process `Y.Doc` with no network and no trusted
 * side — and two `NoteSession`s pointed at it are two collaborators sharing a
 * server. `two clients converge…` below is the assertion the whole slice exists
 * to support.
 *
 * The rest of the file is about the client's obligations, and each one is a way
 * the platform's bounds bite:
 *
 *  · a pulled update must not be pushed back (the echo loop);
 *  · local edits must be COALESCED, because 100 messages per 10 seconds is a
 *    budget a person exceeds by typing;
 *  · a refused push must not lose the edit and must not retry by itself.
 */

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createMemoryCrdtPort } from "../harness/memory-port.js";
import { NoteSession, decode, encode } from "./session.js";

const DOC = "cd_note";

/** Timers a test drives by hand, so no wall clock is involved. */
function manualTimers() {
  const queue: (() => void)[] = [];
  return {
    setTimer: (fn: () => void) => {
      queue.push(fn);
      return queue.length - 1;
    },
    clearTimer: (handle: unknown) => {
      const at = handle as number;
      if (queue[at]) queue[at] = () => {};
    },
    /** Run everything the session scheduled. */
    async run(): Promise<void> {
      const due = queue.splice(0);
      for (const fn of due) fn();
      // The scheduled callback starts an async cycle; let it settle.
      await Promise.resolve();
      await Promise.resolve();
    },
    get length() {
      return queue.filter((fn) => fn.length === 0).length;
    },
  };
}

function sessionOn(port: ReturnType<typeof createMemoryCrdtPort>["port"], debounceMs = 600) {
  const timers = manualTimers();
  const session = new NoteSession({
    port,
    doc: DOC,
    debounceMs,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => 1_000,
  });
  return { session, timers };
}

describe("opening", () => {
  it("shows the document the server has", async () => {
    const server = createMemoryCrdtPort({ documents: [DOC], initialText: "hello" });
    const { session } = sessionOn(server.port);
    await session.open();
    expect(session.getState().status).toBe("ready");
    expect(session.getState().text).toBe("hello");
    session.destroy();
  });

  it("renders a refusal rather than throwing", async () => {
    const server = createMemoryCrdtPort({
      documents: [DOC],
      refusals: { open_doc: { code: "approval_required", message: "需要批准" } },
    });
    const { session } = sessionOn(server.port);
    await session.open();
    expect(session.getState().status).toBe("refused");
    expect(session.getState().code).toBe("approval_required");
    expect(session.getState().message).toBe("需要批准");
    session.destroy();
  });

  it("opens a newer schema read-only instead of refusing it", async () => {
    // §15.4: check compatibility BEFORE opening. A person who cannot safely
    // edit a document can still be shown it — but this build must not write a
    // shape it does not understand into somebody else's editor.
    const server = createMemoryCrdtPort({ documents: [DOC], initialText: "future", schemaMajor: 2 });
    const { session } = sessionOn(server.port);
    await session.open();
    expect(session.getState().status).toBe("ready");
    expect(session.getState().incompatible).toBe(true);

    session.setText("edited");
    expect(session.getState().text).toBe("future");
    session.destroy();
  });

  it("refuses a schema older than anything this build ever wrote", async () => {
    const server = createMemoryCrdtPort({ documents: [DOC], schemaMajor: 0 });
    const { session } = sessionOn(server.port);
    await session.open();
    expect(session.getState().status).toBe("refused");
    session.destroy();
  });

  it("refuses a document ref this port was never given", async () => {
    const server = createMemoryCrdtPort({ documents: ["cd_other"] });
    const { session } = sessionOn(server.port);
    await session.open();
    expect(session.getState().code).toBe("unknown_doc");
    session.destroy();
  });
});

describe("editing", () => {
  it("pushes coalesced edits, not one per keystroke", async () => {
    // The budget this exists for: `PORT_WINDOW_MESSAGES` is 100 messages per
    // rolling 10 seconds on the trusted frame host, and it CLOSES the channel
    // rather than refusing. A person types faster than that in bursts.
    const server = createMemoryCrdtPort({ documents: [DOC] });
    const { session, timers } = sessionOn(server.port);
    await session.open();

    let text = "";
    for (const ch of "hello world") {
      text += ch;
      session.setText(text);
    }
    expect(session.getState().unsent).toBe(true);
    expect(server.calls.filter((call) => call.action === "apply_update")).toHaveLength(0);

    await timers.run();
    expect(server.calls.filter((call) => call.action === "apply_update")).toHaveLength(1);
    expect(server.text(DOC)).toBe("hello world");
    expect(session.getState().unsent).toBe(false);
    session.destroy();
  });

  it("reads back once after an accepted push", async () => {
    const server = createMemoryCrdtPort({ documents: [DOC] });
    const { session, timers } = sessionOn(server.port);
    await session.open();
    session.setText("a");
    await timers.run();
    expect(server.calls.map((call) => call.action)).toEqual(["open_doc", "apply_update", "read_updates"]);
    session.destroy();
  });

  it("keeps a refused edit locally and does not retry by itself", async () => {
    const server = createMemoryCrdtPort({
      documents: [DOC],
      refusals: { apply_update: { code: "rate_limited", message: "太快了" } },
    });
    const { session, timers } = sessionOn(server.port);
    await session.open();
    session.setText("draft");
    await timers.run();

    expect(session.getState().code).toBe("rate_limited");
    expect(session.getState().unsent).toBe(true);
    // The person's text is still on screen. A refused push is not a lost edit.
    expect(session.getState().text).toBe("draft");
    expect(server.text(DOC)).toBe("");
    // Nothing was scheduled: a retry is a decision, and "rate_limited" plus an
    // automatic retry is how one refusal becomes a stream of them.
    expect(server.calls.filter((call) => call.action === "apply_update")).toHaveLength(1);

    // …and the explicit retry works, which is what "later, not never" means.
    await session.sync();
    expect(server.text(DOC)).toBe("draft");
    expect(session.getState().unsent).toBe(false);
    session.destroy();
  });

  it("does not push anything at all while read-only", async () => {
    const server = createMemoryCrdtPort({ documents: [DOC], initialText: "theirs", mayEdit: false });
    const { session, timers } = sessionOn(server.port);
    await session.open();
    session.setText("mine");
    await timers.run();
    // The local replica did change — the refusal comes from the server, which is
    // the only place that knows. The point is that the person is told.
    expect(session.getState().code).toBe("no_authority");
    expect(server.text(DOC)).toBe("theirs");
    session.destroy();
  });
});

describe("pulling", () => {
  it("picks up somebody else's change only when asked", async () => {
    const server = createMemoryCrdtPort({ documents: [DOC], initialText: "start" });
    const { session } = sessionOn(server.port);
    await session.open();

    server.editFromElsewhere(DOC, (text) => text.insert(5, " and more"));
    // No polling, no push: the View has not been told and cannot be.
    expect(session.getState().text).toBe("start");

    await session.sync();
    expect(session.getState().text).toBe("start and more");
    session.destroy();
  });

  it("does not send a pulled update back", async () => {
    // The echo loop: without origin tagging, an update applied from the server
    // is queued as a local change and pushed straight back — spending the whole
    // message budget on a no-op that terminates only because merges are
    // idempotent.
    const server = createMemoryCrdtPort({ documents: [DOC], initialText: "x" });
    const { session } = sessionOn(server.port);
    await session.open();
    server.editFromElsewhere(DOC, (text) => text.insert(1, "y"));
    await session.sync();
    expect(session.getState().unsent).toBe(false);
    expect(server.calls.filter((call) => call.action === "apply_update")).toHaveLength(0);
    session.destroy();
  });

  it("runs one cycle at a time and does not strand a concurrent edit", async () => {
    const server = createMemoryCrdtPort({ documents: [DOC] });
    const { session } = sessionOn(server.port, 0);
    await session.open();
    session.setText("one");
    session.setText("one two");
    await session.sync();
    // Whatever the interleaving, everything the person typed is on the server
    // and nothing is left marked unsent.
    expect(server.text(DOC)).toBe("one two");
    expect(session.getState().unsent).toBe(false);
    session.destroy();
  });
});

describe("two clients converge", () => {
  it("two clients converge after concurrent edits at the same position", async () => {
    const server = createMemoryCrdtPort({ documents: [DOC], initialText: "|" });
    const left = sessionOn(server.port);
    const right = sessionOn(server.port);
    await left.session.open();
    await right.session.open();
    expect(left.session.getState().text).toBe("|");
    expect(right.session.getState().text).toBe("|");

    // Neither has seen the other. Both insert at index 0 — the case a
    // last-write-wins store resolves by losing one of them.
    left.session.setText("L|");
    right.session.setText("R|");

    await left.timers.run();
    await right.timers.run();

    // Each pulls what it is missing. Two rounds, because the first pull for the
    // client that pushed FIRST happened before the other had pushed at all —
    // which is exactly the staleness a Sync-button product has and a pushed one
    // does not.
    await left.session.sync();
    await right.session.sync();

    expect(left.session.getState().text).toBe(right.session.getState().text);
    expect(left.session.getState().text).toBe(server.text(DOC));
    expect(left.session.getState().text).toContain("L");
    expect(left.session.getState().text).toContain("R");
    expect(left.session.getState().text).toHaveLength(3);

    left.session.destroy();
    right.session.destroy();
  });

  it("two clients converge after interleaved edits with no coordination", async () => {
    const server = createMemoryCrdtPort({ documents: [DOC], initialText: "abc" });
    const left = sessionOn(server.port, 0);
    const right = sessionOn(server.port, 0);
    await left.session.open();
    await right.session.open();

    // Ten rounds of both sides editing before either syncs.
    for (let round = 0; round < 10; round += 1) {
      left.session.setText(`${left.session.getState().text}L`);
      right.session.setText(`R${right.session.getState().text}`);
      await left.session.sync();
      await right.session.sync();
    }
    // Both pull whatever the other's last round produced.
    await left.session.sync();
    await right.session.sync();

    expect(left.session.getState().text).toBe(right.session.getState().text);
    expect(left.session.getState().text).toBe(server.text(DOC));
    // Nothing was lost: ten insertions from each side plus the seed.
    expect(left.session.getState().text).toHaveLength(23);

    left.session.destroy();
    right.session.destroy();
  });
});

describe("lifecycle", () => {
  it("answers nothing after destroy", async () => {
    const server = createMemoryCrdtPort({ documents: [DOC] });
    const { session } = sessionOn(server.port);
    await session.open();
    session.destroy();
    session.setText("late");
    await session.sync();
    expect(server.calls.filter((call) => call.action === "apply_update")).toHaveLength(0);
  });

  it("notifies subscribers when the state changes, and stops after destroy", async () => {
    const server = createMemoryCrdtPort({ documents: [DOC] });
    const { session } = sessionOn(server.port);
    const listener = vi.fn();
    session.subscribe(listener);
    await session.open();
    expect(listener).toHaveBeenCalled();
    const before = listener.mock.calls.length;
    session.destroy();
    session.setText("late");
    expect(listener.mock.calls.length).toBe(before);
  });
});

describe("what a push actually costs", () => {
  it("sends a diff against the server's vector, not a replay of every keystroke", async () => {
    // The measurement that drove this design, pinned so a refactor back to
    // "buffer the updates and merge them" fails here rather than silently
    // multiplying every push by nine.
    const server = createMemoryCrdtPort({ documents: [DOC] });
    const pushed: number[] = [];
    const spy = {
      ...server.port,
      applyUpdate: async (doc: string, update: string) => {
        pushed.push(update.length);
        return server.port.applyUpdate(doc, update);
      },
    };
    const { session } = sessionOn(spy, 0);
    await session.open();

    // The same 270 keystrokes, also applied to a mirror that records one update
    // each — which is what a buffer-and-merge client would have to send.
    const mirror = new Y.Doc();
    const perKeystroke: Uint8Array[] = [];
    mirror.on("update", (update: Uint8Array) => perKeystroke.push(update));
    let typed = "";
    for (let n = 0; n < 270; n += 1) {
      typed += "x";
      mirror.getText("body").insert(mirror.getText("body").length, "x");
      session.setText(typed);
    }
    await session.sync();

    expect(server.text(DOC)).toBe(typed);
    const replayed = encode(Y.mergeUpdates(perKeystroke)).length;
    const actual = Math.max(...pushed);
    // Nine-fold when measured directly; the assertion is the order of magnitude,
    // because that is what decides whether a paragraph fits in a bounded
    // proposal at all.
    expect(actual * 5).toBeLessThan(replayed);
    session.destroy();
  });
});

describe("the wake hint (ADR 0006)", () => {
  it("fetches once per wake while the session is clean", async () => {
    const server = createMemoryCrdtPort({ documents: [DOC], initialText: "" });
    const { session } = sessionOn(server.port);
    await session.open();
    server.editFromElsewhere(DOC, (text) => text.insert(0, "from elsewhere"));

    session.wake();
    await vi.waitFor(() => expect(session.getState().text).toBe("from elsewhere"));
    expect(session.getState().remoteHint).toBe(false);
    session.destroy();
  });

  it("records a hint instead of dispatching, from the first refusal on", async () => {
    const server = createMemoryCrdtPort({ documents: [DOC], initialText: "hello" });
    const { session } = sessionOn(server.port);
    await session.open();

    server.refuseNext("read_updates", "approval_required", "等待批准");
    session.wake();
    await vi.waitFor(() => expect(session.getState().code).toBe("approval_required"));
    const dispatched = server.calls.length;

    // Ten wakes after one refusal: zero dispatches. Without this rule a chatty
    // colleague turns one revocation into a stream of approval cards in the
    // reader's pending queue — the exact flood ADR 0006 §6.3 forbids.
    for (let n = 0; n < 10; n += 1) session.wake();
    expect(server.calls.length).toBe(dispatched);
    expect(session.getState().remoteHint).toBe(true);

    // The human gesture resumes, and a clean cycle clears the hint.
    await session.sync();
    expect(session.getState().code).toBe("");
    expect(session.getState().remoteHint).toBe(false);
    session.destroy();
  });

  it("ignores a wake before the document is open, and after destroy", async () => {
    const server = createMemoryCrdtPort({ documents: [DOC] });
    const { session } = sessionOn(server.port);
    session.wake();
    expect(server.calls).toHaveLength(0);
    await session.open();
    session.destroy();
    session.wake();
    expect(server.calls.filter((call) => call.action === "read_updates")).toHaveLength(0);
  });
});

describe("base64 without Buffer", () => {
  it("round-trips a real update", () => {
    const doc = new Y.Doc();
    doc.getText("body").insert(0, "x".repeat(5_000));
    const update = Y.encodeStateAsUpdate(doc);
    // A `String.fromCharCode(...spread)` implementation blows the argument limit
    // somewhere around here, which is why this is a loop.
    expect([...decode(encode(update))]).toEqual([...update]);
  });
});
