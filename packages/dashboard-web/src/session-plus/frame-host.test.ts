/**
 * The trusted transport's decisions, driven directly.
 *
 * This used to evaluate a shipped template string, because that is what the
 * transport was. It is now an ordinary module in the browser bundle, so the test
 * imports it — the same cases, one less indirection, and the compiler checking
 * the thing under test. What it buys over the browser suite is determinism on
 * the cases a browser makes awkward to stage: a message from a window we never
 * created, a second handshake, and a port that belonged to a frame that no
 * longer exists.
 *
 * The browser suite proves the properties the browser itself enforces (cookies,
 * cross-origin DOM, CSP). Neither replaces the other.
 */

import { describe, expect, it, vi } from "vitest";
import { uiValue, type UiMessage } from "../i18n/ui-text.js";
import {
  APPEARANCE_CONTRACT,
  MSG,
  PORT_MESSAGE_BYTES,
  SESSION_PLUS_PROTOCOL,
  VIEW_HELLO,
  VIEW_RECONNECT,
  VIEW_RECOVERY_BYTES,
  WAKE_WINDOW_MESSAGES,
  type AppearanceSpec,
} from "@claude-bot/web-trust/frame-protocol";
import {
  createSessionPlusHost,
  type HostDeps,
  type HostDraftRecord,
  type HostDraftStore,
} from "./frame-host.js";

const APP_ORIGIN = "https://app-0123456789abcdef0123.apps.example.org";

interface FakeElement {
  tag: string;
  attrs: Record<string, string>;
  style: Record<string, string>;
  className: string;
  parentNode: FakeElement | null;
  children: FakeElement[];
  listeners: Record<string, Array<() => void>>;
  contentWindow: {
    posted: Array<{ data: unknown; targetOrigin: string; transfer: unknown[] }>;
    postMessage(data: unknown, targetOrigin: string, transfer?: unknown[]): void;
  };
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | undefined;
  addEventListener(kind: string, listener: () => void): void;
  removeEventListener(kind: string, listener: () => void): void;
  dispatch(kind: string): void;
  appendChild(child: FakeElement): void;
  removeChild(child: FakeElement): void;
}

function element(tag: string): FakeElement {
  const posted: Array<{ data: unknown; targetOrigin: string; transfer: unknown[] }> = [];
  const el: FakeElement = {
    tag,
    attrs: {},
    style: {},
    className: "",
    parentNode: null,
    children: [],
    listeners: {},
    contentWindow: {
      posted,
      postMessage(data, targetOrigin, transfer) {
        posted.push({ data, targetOrigin, transfer: transfer ?? [] });
        // The real browser delivers the transferred port to the frame; here the
        // test drives the view side itself, so nothing else happens.
      },
    },
    setAttribute(name, value) {
      el.attrs[name] = value;
    },
    getAttribute(name) {
      return el.attrs[name];
    },
    addEventListener(kind, listener) {
      (el.listeners[kind] ??= []).push(listener);
    },
    removeEventListener(kind, listener) {
      el.listeners[kind] = (el.listeners[kind] ?? []).filter((candidate) => candidate !== listener);
    },
    dispatch(kind) {
      for (const listener of [...(el.listeners[kind] ?? [])]) listener();
    },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
    },
    removeChild(child) {
      el.children = el.children.filter((c) => c !== child);
      child.parentNode = null;
    },
  };
  return el;
}

interface Harness {
  host: {
    mount(): void;
    destroy(why?: string): void;
    reconstruct(): Promise<void>;
    dispose(why?: string): void;
    update(next: unknown, revision?: number): void;
    operation(next: unknown): void;
    wake(next: { binding: string; ref: string }): void;
    updateAppearance(next: AppearanceSpec): void;
    snapshot(): Snapshot;
  };
  slot: FakeElement;
  /**
   * Deliver a window `message` event, as the browser would. `origin` defaults
   * to "null" because that is what a sandboxed frame's opaque origin
   * serialises to — passing anything else is the "somebody removed the sandbox
   * attribute" case.
   */
  windowMessage(data: unknown, source: unknown, origin?: string): void;
  /** The view side of the current channel, or null before a handshake. */
  viewPort(): MessagePort | null;
  /** Ports handed out so far, oldest first — for the stale-generation case. */
  ports: MessagePort[];
  dispatched: Array<{ action: string; params: Record<string, unknown> }>;
  frame(): FakeElement | null;
  fireTimers(): void;
  snapshot(): Snapshot;
  listenerCount(): number;
  resourceResets(): number;
}

interface Snapshot {
  state: string;
  detail: string;
  notice?: UiMessage;
  generation: number;
  handshakes: number;
  ports: number;
  accepted: number;
  refused: number;
  ignored: number;
  lastProposal: { action: string; params: Record<string, unknown> } | null;
  lastAnswer: Record<string, unknown> | null;
}

/**
 * Instantiate the shipped source against fakes.
 *
 * The MessageChannel is real (Node has one), but messages are delivered by
 * calling `port.onmessage` directly: the point of these tests is which messages
 * the Host ACTS on, and an async transport would only add scheduling noise to
 * that question.
 */
function harness(
  dispatch?: (proposal: { action: string; params: Record<string, unknown> }) => Promise<Record<string, unknown>>,
  reset?: () => Promise<boolean>,
  extra: {
    appUrl?: string;
    appearance?: AppearanceSpec;
    drafts?: HostDraftStore;
    recovery?: string;
    onRecovery?: (checkpoint: string) => void;
    onPerformance?: HostDeps["onPerformance"];
  } = {},
): Harness {
  const slot = element("div");
  const listeners: Array<(ev: { data: unknown; source: unknown; origin: string }) => void> = [];
  const timers: Array<() => void> = [];
  const ports: MessagePort[] = [];
  let created: FakeElement | null = null;
  const changes: Snapshot[] = [];
  const dispatched: Array<{ action: string; params: Record<string, unknown> }> = [];
  let resourceResets = 0;

  const deps = {
    doc: {
      createElement: (tag: string) => {
        const el = element(tag);
        if (tag === "iframe") created = el;
        return el;
      },
    },
    win: {
      addEventListener: (kind: string, fn: (ev: { data: unknown; source: unknown; origin: string }) => void) => {
        if (kind === "message") listeners.push(fn);
      },
      removeEventListener: (kind: string, fn: (ev: { data: unknown; source: unknown; origin: string }) => void) => {
        if (kind !== "message") return;
        const index = listeners.indexOf(fn);
        if (index >= 0) listeners.splice(index, 1);
      },
    },
    slot,
    appOrigin: APP_ORIGIN,
    appUrl: extra.appUrl,
    projection: { notice: "假数据", sessions: [], transcript: {} },
    appearance: extra.appearance,
    drafts: extra.drafts,
    recovery: extra.recovery,
    onRecovery: extra.onRecovery,
    onPerformance: extra.onPerformance,
    dispatch: async (proposal: { action: string; params: Record<string, unknown> }) => {
      dispatched.push(proposal);
      if (dispatch) return await dispatch(proposal);
      if (proposal.action !== "pin_session") {
        return { ok: false, code: "unknown_action", message: "not declared" };
      }
      return { ok: true, result: { accepted: true }, projection: { notice: "updated", sessions: [], transcript: {} } };
    },
    resetResources: async () => {
      resourceResets += 1;
      return reset ? await reset() : true;
    },
    setTimer: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: (h: number) => {
      timers[h - 1] = () => {};
    },
    channel: () => {
      const ch = new MessageChannel();
      ports.push(ch.port2);
      return ch;
    },
    onChange: (s: Snapshot) => {
      changes.push(s);
    },
  };

  const host = createSessionPlusHost(deps as unknown as HostDeps);
  return {
    host,
    slot,
    ports,
    dispatched,
    frame: () => created,
    windowMessage(data, source, origin = "null") {
      for (const fn of listeners) fn({ data, source, origin });
    },
    viewPort: () => ports[ports.length - 1] ?? null,
    fireTimers() {
      const pending = [...timers];
      timers.length = 0;
      for (const fn of pending) fn();
    },
    // Always the host's own account of itself: `onChange` is a notification,
    // and a test that read the last notification would be asserting how often
    // the page repaints rather than what the transport did.
    snapshot: () => host.snapshot(),
    listenerCount: () => listeners.length,
    resourceResets: () => resourceResets,
  };
}

/** Complete a handshake as the real view does, and return its port. */
function connect(h: Harness): MessagePort {
  h.host.mount();
  h.windowMessage(VIEW_HELLO, h.frame()!.contentWindow);
  const port = h.viewPort()!;
  expect(port, "a port was transferred").toBeTruthy();
  return port;
}

describe("the frame the Host creates", () => {
  it("keeps the lifecycle generation diagnostic-only while display notices remain translatable", () => {
    const h = harness();
    h.host.mount();
    const frame = h.frame();
    const snapshot = h.snapshot();
    expect(snapshot).toMatchObject({ detail: "Agent View 加载中", generation: 1 });
    expect(uiValue(snapshot.notice, "en")).toBe("Loading Agent View");
    expect(uiValue(snapshot.notice, "ja-JP")).toBe("Agent View を読み込み中");
    expect(h.frame()).toBe(frame);
    expect(h.snapshot()).toEqual(snapshot);
    h.host.dispose();
  });

  it("is sandboxed to scripts only and points at the configured origin", () => {
    const h = harness();
    h.host.mount();
    const frame = h.frame()!;
    expect(frame.tag).toBe("iframe");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-downloads");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("src")).toBe(`${APP_ORIGIN}/`);
    // No trusted state in the URL: it is the bare origin, so nothing about the
    // session, the viewer or an instance can reach the frame through it.
    expect(frame.getAttribute("src")).not.toContain("?");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(h.slot.children).toHaveLength(1);
  });

  it("keeps waiting without a deadline and accepts a late handshake", async () => {
    const h = harness();
    h.host.mount();
    expect(h.snapshot().state).toBe("loading");
    h.fireTimers();
    expect(h.snapshot().state).toBe("loading");
    expect(h.slot.children).toHaveLength(1);
    const port = connect(h);
    port.postMessage({ t: MSG.ready });
    await until(() => h.snapshot().state === "ready", "the late ready frame");
    expect(h.snapshot().state).toBe("ready");
  });
});

describe("the handshake", () => {
  it("hands exactly one port to the window it created", () => {
    const h = harness();
    connect(h);
    const posted = h.frame()!.contentWindow.posted;
    expect(posted).toHaveLength(1);
    expect(posted[0].transfer).toHaveLength(1);
    expect(posted[0].data).toMatchObject({ t: MSG.port, protocol: SESSION_PLUS_PROTOCOL });
    expect(h.snapshot().ports).toBe(1);
  });

  it("ignores a hello from a window it did not create", () => {
    // The rogue-frame case: a page that acquires a second frame on the App
    // origin — or any other window — announcing itself. A sandboxed frame has
    // an opaque origin, so "the window I am holding" is the only identity
    // available, and it is the one that is checked.
    const h = harness();
    h.host.mount();
    h.windowMessage(VIEW_HELLO, { posted: [] });
    expect(h.viewPort()).toBeNull();
    expect(h.snapshot()).toMatchObject({ handshakes: 1, ports: 0, ignored: 1 });
    expect(h.frame()!.contentWindow.posted).toHaveLength(0);
  });

  it("ignores a second hello from the same frame", () => {
    const h = harness();
    connect(h);
    h.windowMessage(VIEW_HELLO, h.frame()!.contentWindow);
    expect(h.snapshot()).toMatchObject({ handshakes: 2, ports: 1, ignored: 1 });
    expect(h.frame()!.contentWindow.posted).toHaveLength(1);
  });

  it("keeps an early handshake when the initial document finishes loading", () => {
    const h = harness();
    const first = connect(h);
    h.frame()!.dispatch("load");
    expect(h.viewPort()).toBe(first);
    expect(h.snapshot()).toMatchObject({ generation: 1, ports: 1 });
  });

  it("rotates a stale channel when the iframe document reloads", async () => {
    const h = harness();
    const stale = connect(h);
    h.frame()!.dispatch("load");
    h.host.update({ notice: "latest projection" }, 4);

    h.frame()!.dispatch("load");
    expect(h.snapshot()).toMatchObject({
      state: "loading",
      detail: "Agent View 重建中",
      generation: 2,
      ports: 1,
    });
    const posted = h.frame()!.contentWindow.posted;
    expect(posted[posted.length - 1]?.data).toBe(VIEW_RECONNECT);

    stale.postMessage({ t: MSG.propose, rid: "stale", action: "pin_session", params: {} });
    await tick();
    expect(h.dispatched).toHaveLength(0);

    h.windowMessage(VIEW_HELLO, h.frame()!.contentWindow);
    const recovered = h.viewPort()!;
    expect(recovered).not.toBe(stale);
    const seen: Array<Record<string, unknown>> = [];
    recovered.onmessage = (event) => seen.push(event.data as Record<string, unknown>);
    const boot = await until(() => seen.find((message) => message.t === MSG.boot), "the recovery boot");
    expect(boot).toMatchObject({ projection: { notice: "latest projection" }, revision: 4 });
    expect(h.snapshot()).toMatchObject({ generation: 2, ports: 2 });
  });

  it("refuses a frame that is no longer sandboxed — the origin tripwire", () => {
    // A frame reporting a real origin is a frame with `allow-same-origin` (or
    // no sandbox at all). Nothing else about the handshake would notice, so the
    // failure would be silent: a view with powers nobody granted it, talking to
    // us as if it were the one we built.
    const h = harness();
    h.host.mount();
    h.windowMessage(VIEW_HELLO, h.frame()!.contentWindow, APP_ORIGIN);
    expect(h.viewPort()).toBeNull();
    expect(h.snapshot()).toMatchObject({ handshakes: 1, ports: 0, ignored: 1 });
  });

  it("ignores window messages that are not the announcement", () => {
    const h = harness();
    h.host.mount();
    h.windowMessage({ t: MSG.ready }, h.frame()!.contentWindow);
    h.windowMessage("some-other-string", h.frame()!.contentWindow);
    expect(h.snapshot().ports).toBe(0);
  });
});

describe("a proposal is not a request", () => {
  it("drops every forged identity field before the same-origin coordinator", async () => {
    const h = harness();
    const port = connect(h);
    const answers: unknown[] = [];
    port.onmessage = (e) => answers.push(e.data);
    port.postMessage({ t: MSG.ready });
    port.postMessage({
      t: MSG.propose,
      rid: "r1",
      action: "pin_session",
      params: { session: "demo-1" },
      // Everything a hostile view would try.
      owner: "root",
      app: "not-session-plus",
      scope: "../../etc",
      instance: "forged-instance-handle",
      approved: true,
      username: "alice",
    });
    const result = await until(
      () =>
        answers.find((a) => (a as { t: string }).t === MSG.result) as
          | { ok: boolean; result: { accepted: boolean } }
          | undefined,
      "the Host's answer to the forged proposal",
    );
    expect(result.ok).toBe(true);
    const text = JSON.stringify(result);
    for (const forged of ["root", "not-session-plus", "../../etc", "forged-instance-handle", "alice"]) {
      expect(text, `the answer must not echo ${forged}`).not.toContain(forged);
    }
    // And what the Host recorded is what was ASKED FOR, never what was claimed —
    // normalized to the bounded primitive schema, so the trusted side holds no
    // reference to the view's object graph.
    expect(h.snapshot().lastProposal).toEqual({
      action: "pin_session",
      params: { session: "demo-1" },
    });
    expect(h.dispatched).toEqual([{ action: "pin_session", params: { session: "demo-1" } }]);
  });

  it("reports the coordinator's refusal for an undeclared action", async () => {
    const h = harness();
    const port = connect(h);
    const answers: unknown[] = [];
    port.onmessage = (e) => answers.push(e.data);
    port.postMessage({ t: MSG.propose, rid: "r9", action: "delete_everything", params: {} });
    await until(() => answers.find((a) => (a as { t: string }).t === MSG.result), "the refusal");
    expect(answers).toContainEqual(
      expect.objectContaining({ t: MSG.result, rid: "r9", ok: false, code: "unknown_action" }),
    );
    expect(h.snapshot()).toMatchObject({ accepted: 0, refused: 1 });
  });

  it("keeps layout Host-owned when a view sends legacy height messages", async () => {
    const h = harness();
    const port = connect(h);
    port.postMessage({ t: MSG.height, px: 10_000_000 });
    await tick();
    expect(h.frame()!.style.height).toBeUndefined();
    port.postMessage({ t: MSG.height, px: -5 });
    await tick();
    expect(h.frame()!.style.height).toBeUndefined();
  });

  it("admits only the closed numeric View performance window", async () => {
    const onPerformance = vi.fn();
    const h = harness(undefined, undefined, { onPerformance });
    const port = connect(h);
    const report = {
      version: 1,
      windowMs: 60_000,
      inputEventCount: 5,
      inputFrameCount: 4,
      inputFrameTotalMs: 55,
      inputFrameMaxMs: 20,
      inputFrameOver50Count: 0,
      projectionCommitCount: 25,
      projectionCommitTotalMs: 125,
      projectionCommitMaxMs: 12,
      projectionFrameCount: 20,
      projectionFrameTotalMs: 240,
      projectionFrameMaxMs: 24,
      longTaskCount: 0,
      longTaskTotalMs: 0,
      longTaskMaxMs: 0,
      timerLagCount: 1,
      timerLagMaxMs: 180,
      domNodes: 9_000,
      content: "drop me",
    };
    port.postMessage({ t: MSG.performance, report });
    await tick();
    const expected: Record<string, unknown> = { ...report };
    delete expected.content;
    expect(onPerformance).toHaveBeenCalledWith(expected);

    port.postMessage({ t: MSG.performance, report: { ...report, domNodes: -1 } });
    await tick();
    expect(onPerformance).toHaveBeenCalledTimes(1);
    expect(h.snapshot().ignored).toBe(1);
  });
});

describe("browser-local View drafts", () => {
  it("reads and writes a bounded semantic key without dispatching a server action", async () => {
    let at = Date.now();
    const values = new Map<string, HostDraftRecord>([
      ["session-chat:opaque-1", { text: "刷新前写到这里", updatedAt: at }],
    ]);
    const listeners = new Map<string, Set<(record: HostDraftRecord) => void>>();
    const drafts: HostDraftStore = {
      read: (key) => values.get(key) ?? { text: "", updatedAt: 0 },
      write: (key, text) => {
        const record = { text, updatedAt: ++at };
        values.set(key, record);
        for (const listener of listeners.get(key) ?? []) listener(record);
        return record;
      },
      subscribe: (key, listener) => {
        const set = listeners.get(key) ?? new Set();
        set.add(listener);
        listeners.set(key, set);
        return () => { set.delete(listener); };
      },
    };
    const h = harness(undefined, undefined, { drafts });
    const port = connect(h);
    const answers: Array<Record<string, unknown>> = [];
    port.onmessage = (event) => answers.push(event.data as Record<string, unknown>);

    port.postMessage({ t: MSG.draftRead, key: "session-chat:opaque-1" });
    await until(
      () => answers.find((answer) => answer.t === MSG.draftUpdate),
      "the cached draft",
    );
    expect(answers).toContainEqual({
      t: MSG.draftUpdate,
      key: "session-chat:opaque-1",
      text: "刷新前写到这里",
      updatedAt: at,
    });

    port.postMessage({ t: MSG.draftWrite, key: "session-chat:opaque-1", text: "继续写" });
    await until(() => values.get("session-chat:opaque-1")?.text === "继续写", "the local draft write");
    expect(h.dispatched).toEqual([]);
    expect(h.snapshot()).toMatchObject({ accepted: 0, refused: 0, lastProposal: null });
  });
});

describe("reconstruction", () => {
  it("replaces the frame, opens a fresh channel and reaches ready again", async () => {
    const h = harness();
    const first = connect(h);
    first.postMessage({ t: MSG.ready });
    await until(() => h.snapshot().state === "ready", "the first generation to be ready");
    expect(h.snapshot().state).toBe("ready");
    const firstFrame = h.frame();

    await h.host.reconstruct();
    expect(h.frame()).not.toBe(firstFrame);
    expect(h.slot.children).toHaveLength(1);
    expect(h.snapshot()).toMatchObject({ state: "loading", detail: "Agent View 重建中" });

    h.windowMessage(VIEW_HELLO, h.frame()!.contentWindow);
    const second = h.viewPort()!;
    expect(second).not.toBe(first);
    second.postMessage({ t: MSG.ready });
    await until(() => h.snapshot().state === "ready", "the rebuilt generation to be ready");
    expect(h.snapshot()).toMatchObject({
      state: "ready",
      detail: "Agent View 已就绪",
      generation: 3,
      ports: 2,
    });
  });

  it("gives a message from the previous generation no authority", async () => {
    // Both halves matter: the old port is closed (so nothing arrives), and the
    // handler closes over its generation (so nothing would be acted on even if
    // it did). The second is what this asserts, because it is the one that
    // survives a future change of transport.
    const h = harness();
    const stale = connect(h);
    stale.postMessage({ t: MSG.ready });
    await until(() => h.snapshot().state === "ready", "the first generation to be ready");
    const acceptedBefore = h.snapshot().accepted;

    await h.host.reconstruct();
    stale.postMessage({ t: MSG.propose, rid: "ghost", action: "pin_session", params: {} });
    await tick();

    expect(h.snapshot().accepted).toBe(acceptedBefore);
    expect(h.snapshot().lastProposal).toBeNull();
  });

  it("destroying leaves the slot empty and the page intact", () => {
    const h = harness();
    connect(h);
    h.host.destroy("测试");
    expect(h.slot.children).toHaveLength(0);
    expect(h.snapshot()).toMatchObject({ state: "idle", detail: "测试" });
  });

  it("dispose removes the global listener, while reconstruction keeps exactly one", async () => {
    const h = harness();
    expect(h.listenerCount()).toBe(1);
    connect(h);
    await h.host.reconstruct();
    expect(h.listenerCount()).toBe(1);
    h.host.dispose("测试终态");
    expect(h.listenerCount()).toBe(0);
    expect(h.slot.children).toHaveLength(0);
  });

  it("allows a transient resource-reset failure to be retried", async () => {
    let attempts = 0;
    const h = harness(undefined, async () => ++attempts > 1);
    connect(h);

    await h.host.reconstruct();
    expect(h.snapshot().state).toBe("unavailable");
    expect(h.slot.children).toHaveLength(0);
    expect(h.resourceResets()).toBe(1);

    await h.host.reconstruct();
    expect(h.snapshot().state).toBe("loading");
    expect(h.slot.children).toHaveLength(1);
    expect(h.resourceResets()).toBe(2);
  });

});

describe("the boot payload", () => {
  it("carries a projection and nothing that could authenticate anything", async () => {
    const h = harness();
    const port = connect(h);
    const seen: Array<Record<string, unknown>> = [];
    port.onmessage = (e) => seen.push(e.data as Record<string, unknown>);
    await tick();
    const boot = await until(() => seen.find((m) => m.t === MSG.boot), "the boot payload");
    expect(boot).toBeTruthy();
    // When the outer shell does NOT supply an appearance the boot payload is
    // still exactly {projection, protocol, t}. This asymmetry with the
    // "appearance included" case below is what makes "no appearance" and
    // "appearance == classic" observably distinct on the wire.
    expect(Object.keys(boot).sort()).toEqual(["projection", "protocol", "t"]);
    // And no key anywhere inside it is credential-shaped. (`projection.sessions`
    // is data about fake sessions, which is the whole payload's purpose — so the
    // check is on key NAMES, not on substrings of the demo content.)
    const forbidden = /^(csrf|sessionid|session_id|token|handle|instance|owner|username|user|scope|secret|cookie|auth)$/i;
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        expect(forbidden.test(k), `boot payload must not carry a "${k}" field`).toBe(false);
        walk(v);
      }
    };
    walk(boot);
  });

  it("adds an appearance field when the outer shell supplies one (ticket #45)", async () => {
    // A boot with an initial theme means the view has classic/aurora/ink in
    // hand for its first paint: no one-frame classic flash before a later
    // MSG.appearance arrives. The keys are exactly {appearance, projection,
    // protocol, t} — no other field creeps in, no identity-shaped key.
    const h = harness(undefined, undefined, {
      appearance: { contract: APPEARANCE_CONTRACT, theme: "aurora" },
    });
    const port = connect(h);
    const seen: Array<Record<string, unknown>> = [];
    port.onmessage = (e) => seen.push(e.data as Record<string, unknown>);
    await tick();
    const boot = await until(() => seen.find((m) => m.t === MSG.boot), "the boot payload");
    expect(Object.keys(boot).sort()).toEqual(["appearance", "projection", "protocol", "t"]);
    expect(boot.appearance).toEqual({ contract: APPEARANCE_CONTRACT, theme: "aurora" });
  });

  it("emits an appearance frame on live theme changes and stays quiet before a port exists (ticket #45)", async () => {
    // Calling updateAppearance before mount / handshake must not throw and
    // must not send a live frame: there is no channel to send on. What it
    // DOES do — retention — is the subject of the four cases below.
    const h = harness();
    h.host.updateAppearance({ contract: APPEARANCE_CONTRACT, theme: "aurora" });
    expect(h.snapshot().state).toBe("idle");

    const port = connect(h);
    const seen: Array<Record<string, unknown>> = [];
    port.onmessage = (e) => seen.push(e.data as Record<string, unknown>);
    await tick();
    h.host.updateAppearance({ contract: APPEARANCE_CONTRACT, theme: "ink" });
    const frame = await until(() => seen.find((m) => m.t === MSG.appearance), "the appearance frame");
    expect(Object.keys(frame).sort()).toEqual(["appearance", "t"]);
    expect(frame.appearance).toEqual({ contract: APPEARANCE_CONTRACT, theme: "ink" });
  });

  it("retains an appearance chosen before the handshake and delivers it on boot (ticket #45)", async () => {
    // The moment between `mount()` and the View's hello is a real window
    // (several tens of ms). A theme picked in that window used to be lost —
    // `updateAppearance` had no port to send on AND boot read the immutable
    // `deps.appearance` value captured at construction. Now the retained
    // value is what boot reads.
    const h = harness();
    h.host.mount();
    h.host.updateAppearance({ contract: APPEARANCE_CONTRACT, theme: "aurora" });
    const port = (() => {
      h.windowMessage(VIEW_HELLO, h.frame()!.contentWindow);
      const p = h.viewPort();
      if (!p) throw new Error("expected a port after hello");
      return p;
    })();
    const seen: Array<Record<string, unknown>> = [];
    port.onmessage = (e) => seen.push(e.data as Record<string, unknown>);
    await tick();
    const boot = await until(() => seen.find((m) => m.t === MSG.boot), "the boot payload");
    // The pre-handshake update rides on boot, not as a separate frame.
    expect(boot.appearance).toEqual({ contract: APPEARANCE_CONTRACT, theme: "aurora" });
    expect(seen.find((m) => m.t === MSG.appearance)).toBeUndefined();
  });

  it("carries the retained appearance on the next boot after reconstruct (ticket #45)", async () => {
    // A rebuilt view is still the same outer-shell theme choice as before.
    // The retained value must survive destroy/reconstruct: the new boot
    // must not fall back to `deps.appearance` (which may be undefined or
    // stale) or, worse, to no appearance at all.
    const h = harness();
    connect(h);
    h.host.updateAppearance({ contract: APPEARANCE_CONTRACT, theme: "ink" });
    await tick();
    await h.host.reconstruct();

    h.windowMessage(VIEW_HELLO, h.frame()!.contentWindow);
    const port2 = h.viewPort()!;
    const seen: Array<Record<string, unknown>> = [];
    port2.onmessage = (e) => seen.push(e.data as Record<string, unknown>);
    await tick();
    const boot = await until(() => seen.find((m) => m.t === MSG.boot), "the rebuilt boot payload");
    expect(boot.appearance).toEqual({ contract: APPEARANCE_CONTRACT, theme: "ink" });
  });

  it("still omits `appearance` on boot when no appearance was ever provided (ticket #45)", async () => {
    // A legacy caller — a page or test that predates ticket #45 — never
    // supplies an initial appearance and never calls `updateAppearance`.
    // The retained value is `undefined`, and boot must keep its old
    // exact-keys shape `{projection, protocol, t}` so `no appearance` and
    // `appearance == classic` stay observably distinct on the wire.
    const h = harness();
    const port = connect(h);
    const seen: Array<Record<string, unknown>> = [];
    port.onmessage = (e) => seen.push(e.data as Record<string, unknown>);
    await tick();
    const boot = await until(() => seen.find((m) => m.t === MSG.boot), "the legacy boot payload");
    expect(Object.keys(boot).sort()).toEqual(["projection", "protocol", "t"]);
  });

  it("retains a bounded browser recovery checkpoint across View reconstruction", async () => {
    const persisted: string[] = [];
    const initial = JSON.stringify({ version: 1, sessions: ["res-1"] });
    const h = harness(undefined, undefined, {
      recovery: initial,
      onRecovery: (checkpoint) => persisted.push(checkpoint),
    });
    const first = connect(h);
    const seen: Array<Record<string, unknown>> = [];
    first.onmessage = (event) => seen.push(event.data as Record<string, unknown>);
    const boot = await until(() => seen.find((message) => message.t === MSG.boot), "the recovery boot payload");
    expect(boot.recovery).toBe(initial);

    const next = JSON.stringify({ version: 1, sessions: ["res-2"] });
    first.postMessage({ t: MSG.recovery, checkpoint: next });
    await until(() => persisted.length === 1, "the retained recovery checkpoint");
    expect(persisted).toEqual([next]);

    await h.host.reconstruct();
    h.windowMessage(VIEW_HELLO, h.frame()!.contentWindow);
    const rebuilt = h.viewPort()!;
    const after: Array<Record<string, unknown>> = [];
    rebuilt.onmessage = (event) => after.push(event.data as Record<string, unknown>);
    const rebuiltBoot = await until(
      () => after.find((message) => message.t === MSG.boot),
      "the rebuilt recovery boot payload",
    );
    expect(rebuiltBoot.recovery).toBe(next);
  });

  it("drops malformed and oversized recovery checkpoints without disturbing the channel", async () => {
    const persisted: string[] = [];
    const h = harness(undefined, undefined, {
      recovery: "x".repeat(VIEW_RECOVERY_BYTES + 1),
      onRecovery: (checkpoint) => persisted.push(checkpoint),
    });
    const port = connect(h);
    const seen: Array<Record<string, unknown>> = [];
    port.onmessage = (event) => seen.push(event.data as Record<string, unknown>);
    const boot = await until(() => seen.find((message) => message.t === MSG.boot), "the boot payload");
    expect(boot).not.toHaveProperty("recovery");
    port.postMessage({ t: MSG.recovery, checkpoint: 42 });
    port.postMessage({ t: MSG.recovery, checkpoint: "x".repeat(VIEW_RECOVERY_BYTES + 1) });
    await tick();
    expect(persisted).toEqual([]);
    expect(h.snapshot().state).not.toBe("degraded");
  });

  it("keeps a newer SSE projection when an older HTTP reply arrives later, live and after reconstruct", async () => {
    let finishDispatch: ((reply: Record<string, unknown>) => void) | undefined;
    const h = harness(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          finishDispatch = resolve;
        }),
    );
    const first = connect(h);
    const live: Array<Record<string, unknown>> = [];
    first.onmessage = (event) => live.push(event.data as Record<string, unknown>);
    await until(() => live.find((message) => message.t === MSG.boot), "the first boot payload");

    first.postMessage({ t: MSG.propose, rid: "refresh-1", action: "refresh_sessions", params: {} });
    await until(() => h.dispatched.length === 1, "the pending HTTP dispatch");

    const fromStream = { notice: "SSE revision 2", sessions: ["new"] };
    h.host.update(fromStream, 2);
    const revisionTwo = await until(
      () => live.find((message) => message.t === MSG.view && message.revision === 2),
      "the revision 2 live frame",
    );
    expect(revisionTwo.projection).toEqual(fromStream);

    // Equal revisions are duplicates too. They must neither replace retention
    // nor emit a second live frame with different content.
    h.host.update({ notice: "duplicate revision with stale content" }, 2);
    await tick();
    expect(live.filter((message) => message.t === MSG.view)).toHaveLength(1);

    finishDispatch?.({
      ok: true,
      result: { refreshed: true },
      projection: { notice: "late HTTP revision 1", sessions: ["old"] },
      revision: 1,
    });
    await until(() => live.find((message) => message.t === MSG.result), "the late HTTP result");
    expect(live.filter((message) => message.t === MSG.view)).toEqual([revisionTwo]);

    await h.host.reconstruct();
    h.windowMessage(VIEW_HELLO, h.frame()!.contentWindow);
    const rebuilt = h.viewPort()!;
    const afterRebuild: Array<Record<string, unknown>> = [];
    rebuilt.onmessage = (event) => afterRebuild.push(event.data as Record<string, unknown>);
    const boot = await until(
      () => afterRebuild.find((message) => message.t === MSG.boot),
      "the rebuilt boot payload",
    );
    expect(boot).toMatchObject({ projection: fromStream, revision: 2 });
  });

  it("applies a legacy unnumbered update and clears the retained numbered revision", async () => {
    const h = harness();
    const first = connect(h);
    const live: Array<Record<string, unknown>> = [];
    first.onmessage = (event) => live.push(event.data as Record<string, unknown>);
    await until(() => live.find((message) => message.t === MSG.boot), "the first boot payload");

    h.host.update({ notice: "numbered" }, 7);
    await until(
      () => live.find((message) => message.t === MSG.view && message.revision === 7),
      "the numbered view frame",
    );

    const legacyProjection = { notice: "legacy without revision" };
    h.host.update(legacyProjection);
    const legacy = await until(
      () =>
        live.find(
          (message) =>
            message.t === MSG.view &&
            (message.projection as { notice?: string } | undefined)?.notice === legacyProjection.notice,
        ),
      "the legacy view frame",
    );
    expect(legacy).toEqual({ t: MSG.view, projection: legacyProjection });

    await h.host.reconstruct();
    h.windowMessage(VIEW_HELLO, h.frame()!.contentWindow);
    const rebuilt = h.viewPort()!;
    const afterRebuild: Array<Record<string, unknown>> = [];
    rebuilt.onmessage = (event) => afterRebuild.push(event.data as Record<string, unknown>);
    const boot = await until(
      () => afterRebuild.find((message) => message.t === MSG.boot),
      "the rebuilt legacy boot payload",
    );
    expect(boot.projection).toEqual(legacyProjection);
    expect(boot).not.toHaveProperty("revision");
  });

  it("does not send an appearance frame across a torn-down generation, but does retain the value (ticket #45)", async () => {
    // reconstruct() closes the previous port and bumps generation. A late
    // updateAppearance() on the OLD port would let a stale theme leak into a
    // rebuilt view — but the port is null between destroy and re-handshake,
    // so no live frame reaches the previous MessagePort pair. The retained
    // value is what the NEXT boot will carry (proven above).
    const h = harness();
    const port = connect(h);
    const seenOld: Array<Record<string, unknown>> = [];
    port.onmessage = (e) => seenOld.push(e.data as Record<string, unknown>);
    await tick();

    const rebuild = h.host.reconstruct();
    h.host.updateAppearance({ contract: APPEARANCE_CONTRACT, theme: "aurora" });
    await rebuild;
    await tick();

    // Nothing new arrived on the OLD port after the mid-rebuild update.
    expect(seenOld.find((m) => m.t === MSG.appearance)).toBeUndefined();
  });

  it("does not consume the View->Host rate window for outbound appearance frames (ticket #45)", async () => {
    // The 100/10s fuse counts INBOUND messages (View->Host). A theme switch
    // is Host->View outbound and must not eat the View's budget for
    // proposals; a bug that plumbed it through admitMessage would slowly
    // silence a chatty user's edits after enough theme flips.
    const h = harness();
    const port = connect(h);
    const seen: Array<Record<string, unknown>> = [];
    port.onmessage = (e) => seen.push(e.data as Record<string, unknown>);
    await tick();

    for (let i = 0; i < 500; i++) {
      h.host.updateAppearance({
        contract: APPEARANCE_CONTRACT,
        theme: i % 2 === 0 ? "aurora" : "ink",
      });
    }
    await tick();
    // Every outbound frame reached the port (nothing was "fused" away), and
    // the channel is still healthy for View->Host traffic.
    const appearanceFrames = seen.filter((m) => m.t === MSG.appearance);
    expect(appearanceFrames).toHaveLength(500);
    expect(h.snapshot().state).not.toBe("degraded");
  });

  it("relays only the server-authored public operation projection", async () => {
    const h = harness();
    const port = connect(h);
    const seen: Array<Record<string, unknown>> = [];
    port.onmessage = (e) => seen.push(e.data as Record<string, unknown>);
    const operation = {
      id: "op_public",
      operation: "start_session",
      status: "waiting_approval",
      message: "等待你批准",
    };
    h.host.operation(operation);
    const message = await until(() => seen.find((entry) => entry.t === MSG.op), "the operation update");
    expect(message).toEqual({ t: MSG.op, operation });
  });
});

/**
 * Let the MessagePort round trip complete.
 *
 * One macrotask is enough on an idle machine and is NOT enough when the whole
 * suite is running in parallel: a proposal has to reach the Host, be answered,
 * and be delivered back, which is several turns of a real (Node) port. Polling
 * for the condition removes a flake that only ever appeared under load — the
 * product path is identical either way.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wait until `ready()` is true, or fail with what was actually observed. */
async function until<T>(ready: () => T | undefined | null | false, what: string, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = ready();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}


describe("a hostile proposal cannot crash the trusted side", () => {
  /** Everything the view sends is normalized to the bounded primitive schema. */
  async function propose(params: unknown, action = "pin_session"): Promise<Snapshot> {
    const h = harness();
    const port = connect(h);
    port.postMessage({ t: MSG.propose, rid: "r1", action, params });
    await until(() => h.snapshot().accepted + h.snapshot().refused > 0, "the proposal to be judged");
    return h.snapshot();
  }

  it("survives a CYCLIC params object and keeps the record serialisable", async () => {
    // Structured clone transfers cycles happily; the trusted page then rendered
    // the retained object with JSON.stringify, which throws. Three lines of
    // view code could stop the shell's status rendering, so the boundary now
    // copies out primitives instead of keeping the graph.
    const cyclic: Record<string, unknown> = { session: "demo-1", text: "hi" };
    cyclic.self = cyclic;
    const snap = await propose(cyclic);
    expect(snap.lastProposal).toEqual({ action: "pin_session", params: { session: "demo-1", text: "hi" } });
    expect(() => JSON.stringify(snap.lastProposal)).not.toThrow();
    expect(snap.accepted).toBe(1);
  });

  it("bounds the work an oversized proposal can cause, and refuses it", async () => {
    // Before the editor batch every value was clipped at 4096 characters, which
    // bounded the work AND silently changed the request. Now the bound is the
    // message ceiling and the copy stops as soon as it is exceeded: sixteen
    // fields of a quarter-ceiling each would be 4x the ceiling if all were kept.
    const params: Record<string, string> = {};
    for (let i = 0; i < 16; i++) params[`f${i}`] = "x".repeat(PORT_MESSAGE_BYTES / 4);
    const snap = await propose(params);
    expect(snap.refused).toBe(1);
    expect(snap.lastAnswer).toMatchObject({ ok: false, code: "message_too_large" });
    const kept = JSON.stringify(snap.lastProposal).length;
    expect(kept).toBeGreaterThan(PORT_MESSAGE_BYTES);
    expect(kept).toBeLessThan(PORT_MESSAGE_BYTES * 2 + 1000);
  });

  it("drops unexpected keys and deep graphs entirely", async () => {
    // Deep enough to be a nuisance, shallow enough that structuredClone itself
    // survives it: the claim under test is that the Host drops the graph, not
    // that the browser's clone algorithm has a depth limit.
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 500; i++) deep = { next: deep };
    const snap = await propose({ session: "ok", text: "fine", extra: deep, __proto__: { polluted: 1 } });
    expect(Object.keys(snap.lastProposal!.params).sort()).toEqual(["session", "text"]);
    expect(() => JSON.stringify(snap.lastProposal)).not.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("treats malformed params and a malformed action as empty, not as an exception", async () => {
    for (const params of [null, undefined, 42, "text", [1, 2, 3], true]) {
      const snap = await propose(params);
      expect(snap.lastProposal).toEqual({ action: "pin_session", params: {} });
    }
    // A non-string action is refused by name rather than coerced into one.
    const weird = await propose({}, 12345 as unknown as string);
    expect(weird).toMatchObject({ refused: 1, accepted: 0 });
    expect(weird.lastProposal!.action).toBe("");
  });

  it("bounds the correlation id it echoes back", async () => {
    const h = harness();
    const port = connect(h);
    const seen: Array<Record<string, unknown>> = [];
    port.onmessage = (e) => seen.push(e.data as Record<string, unknown>);
    port.postMessage({ t: MSG.propose, rid: "r".repeat(9000), action: "pin_session", params: {} });
    const result = await until(() => seen.find((m) => m.t === MSG.result), "the echoed result");
    expect(String(result.rid).length).toBeLessThanOrEqual(65);
  });

  it("refuses a normalized proposal above the message ceiling before dispatch", async () => {
    const h = harness();
    const port = connect(h);
    const seen: Array<Record<string, unknown>> = [];
    port.onmessage = (e) => seen.push(e.data as Record<string, unknown>);
    const params: Record<string, string> = {};
    for (let i = 0; i < 16; i++) params[`field_${i}`] = "x".repeat(PORT_MESSAGE_BYTES / 8);
    port.postMessage({ t: MSG.propose, rid: "large", action: "pin_session", params });
    const result = await until(() => seen.find((m) => m.t === MSG.result), "the oversized refusal");
    expect(result).toMatchObject({ ok: false, code: "message_too_large" });
    expect(h.dispatched).toEqual([]);
  });

  it("carries a parameter far bigger than the old per-value clip", async () => {
    // The editor batch's reason for raising this fuse: one proposal parameter is
    // now a whole file body (`workspace-files/v1`'s `replace_text`). 4096
    // characters was the old per-value bound, and it is not a bound any more.
    const h = harness();
    const port = connect(h);
    const text = "字".repeat(60_000);
    port.postMessage({ t: MSG.propose, rid: "big", action: "resource.replace_text", params: { text } });
    await until(() => (h.dispatched.length ? h.dispatched : null), "the dispatched proposal");
    expect(h.dispatched[0]!.params.text).toBe(text);
  });

  it("never dispatches a value it had to clip", async () => {
    // The dangerous shape is not "too big" — it is "quietly shorter". A clipped
    // file body written back under a compare-and-swap is a write of something
    // nobody asked for, so clipping has to IMPLY refusal. It does, because a
    // JSON string of N characters serialises to at least N+2 bytes.
    const h = harness();
    const port = connect(h);
    const seen: Array<Record<string, unknown>> = [];
    port.onmessage = (e) => seen.push(e.data as Record<string, unknown>);
    port.postMessage({
      t: MSG.propose,
      rid: "clipped",
      action: "resource.replace_text",
      params: { text: "x".repeat(PORT_MESSAGE_BYTES + 10) },
    });
    const result = await until(() => seen.find((m) => m.t === MSG.result), "the oversized refusal");
    expect(result).toMatchObject({ ok: false, code: "message_too_large" });
    expect(h.dispatched).toEqual([]);
  });

  it("lets a stream be pulled past 100 chunks without fusing, on credit from each chunk answer", async () => {
    const CHUNKS = 150;
    // A broker in miniature: in-order pulls get chunks, then `end`; anything
    // after that, or out of order, is refused — as the trusted broker does.
    let next = 0;
    const h = harness(async (proposal) => {
      if (proposal.action !== "resource.stream_pull") return { ok: true, result: { accepted: true } };
      const seq = Number(proposal.params.seq);
      if (next > CHUNKS || seq !== next) return { ok: false, code: "closed", message: "stream is over" };
      next += 1;
      return seq < CHUNKS
        ? { ok: true, result: { kind: "chunk", handle: proposal.params.handle, seq } }
        : { ok: true, result: { kind: "end", handle: proposal.params.handle } };
    });
    const port = connect(h);
    const results: Array<Record<string, unknown>> = [];
    port.onmessage = (e) => {
      const data = e.data as Record<string, unknown>;
      if (data.t === MSG.result) results.push(data);
    };
    for (let seq = 0; seq <= CHUNKS; seq++) {
      port.postMessage({ t: MSG.propose, rid: `p${seq}`, action: "resource.stream_pull", params: { handle: "rs_live", seq: String(seq) } });
      await until(() => results.length === seq + 1, `pull ${seq}`);
    }
    expect(h.snapshot().state).not.toBe("degraded");
    expect((results.at(-1)!.result as { kind: string }).kind).toBe("end");
    // The stream ended, so its credit is gone: further pulls are counted again
    // and a flood of them still fuses the channel.
    for (let i = 0; i < 101; i++) {
      port.postMessage({ t: MSG.propose, rid: `x${i}`, action: "resource.stream_pull", params: { handle: "rs_live", seq: "0" } });
    }
    await until(() => h.snapshot().state === "degraded", "the port flood fuse");
  });

  it("counts pulls nobody answered with a chunk, so unknown handles cannot flood", async () => {
    const h = harness(async () => ({ ok: false, code: "expired", message: "gone" }));
    const port = connect(h);
    for (let i = 0; i < 101; i++) {
      port.postMessage({ t: MSG.propose, rid: `r${i}`, action: "resource.stream_pull", params: { handle: `rs_forged_${i}`, seq: "0" } });
    }
    await until(() => h.snapshot().state === "degraded", "the port flood fuse");
  });

  it("fuses a view that sends more than 100 messages in ten seconds", async () => {
    const h = harness();
    const port = connect(h);
    for (let i = 0; i < 101; i++) port.postMessage({ t: MSG.height, px: 200 });
    await until(() => h.snapshot().state === "degraded", "the port flood fuse");
    expect(h.snapshot().detail).toContain("熔断");
    await h.host.reconstruct();
    expect(h.snapshot().state).toBe("loading");
    // The flood already began the server-side reset; reconstruction joins it
    // rather than spending a second generation transition.
    expect(h.resourceResets()).toBe(1);
  });
});

describe("the wake frame (ADR 0006)", () => {
  it("forwards a content-free wake, exactly {t, binding, ref}", async () => {
    const h = harness();
    const port = connect(h);
    const seen: Array<Record<string, unknown>> = [];
    port.onmessage = (e) => seen.push(e.data as Record<string, unknown>);
    await tick();
    h.host.wake({ binding: "docs", ref: "cd_abc123" });
    const frame = await until(() => seen.find((m) => m.t === MSG.wake), "the wake frame");
    // No content, no owner, no device, no path: a wake says "worth asking
    // again" and nothing else — the reply to it still passes the Gate.
    expect(Object.keys(frame).sort()).toEqual(["binding", "ref", "t"]);
    expect(frame).toEqual({ t: MSG.wake, binding: "docs", ref: "cd_abc123" });
  });

  it("stays quiet before a port exists, and drops malformed names", async () => {
    const h = harness();
    // No port yet: nothing to send on, nothing thrown, nothing retained — a
    // wake is a moment, not a state, and the View re-reads on boot anyway.
    h.host.wake({ binding: "docs", ref: "cd_abc123" });
    const port = connect(h);
    const seen: Array<Record<string, unknown>> = [];
    port.onmessage = (e) => seen.push(e.data as Record<string, unknown>);
    await tick();
    h.host.wake({ binding: "", ref: "cd_abc123" });
    h.host.wake({ binding: "docs", ref: "" });
    h.host.wake({ binding: "docs", ref: "x".repeat(300) });
    await until(() => seen.some((m) => m.t === MSG.boot), "the boot payload");
    expect(seen.filter((m) => m.t === MSG.wake)).toEqual([]);
  });

  it("drops wakes past its own window budget, and never advances the view→host fuse", async () => {
    const h = harness();
    const port = connect(h);
    const seen: Array<Record<string, unknown>> = [];
    port.onmessage = (e) => seen.push(e.data as Record<string, unknown>);
    await tick();
    // Far past WAKE_WINDOW_MESSAGES inside one rolling window. The overflow is
    // DROPPED — safe, because a wake carries nothing and the next one means
    // the same — and outbound frames are not admitted through the fuse, so the
    // channel stays healthy for the person's own clicks.
    for (let i = 0; i < 40; i++) h.host.wake({ binding: "docs", ref: "cd_abc123" });
    await until(() => seen.filter((m) => m.t === MSG.wake).length >= WAKE_WINDOW_MESSAGES, "the allowed wakes");
    await tick();
    expect(seen.filter((m) => m.t === MSG.wake)).toHaveLength(WAKE_WINDOW_MESSAGES);
    expect(h.snapshot().state).not.toBe("degraded");
  });
});


describe("shared-origin document paths", () => {
  it("loads and reconstructs the exact path while retaining the opaque sandbox", async () => {
    const appUrl = `${APP_ORIGIN}/__octopus/apps/app-0123456789abcdef0123/`;
    const h = harness(undefined, undefined, { appUrl });
    h.host.mount();
    expect(h.frame()?.getAttribute("src")).toBe(appUrl);
    expect(h.frame()?.getAttribute("sandbox")).toBe("allow-scripts allow-downloads");
    h.host.destroy();
    h.host.mount();
    expect(h.frame()?.getAttribute("src")).toBe(appUrl);
    expect(h.dispatched).toEqual([]);
    h.host.dispose();
  });
});
