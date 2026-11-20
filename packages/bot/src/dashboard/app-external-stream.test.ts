/**
 * The external projection stream's two terminal paths, at the seam where they
 * are hard to get right and impossible to observe from outside.
 *
 * A subscription is created BEFORE the reply is hijacked so that an unusable
 * handle is an ordinary refusal rather than a torn stream. That ordering has a
 * corollary a reader has to be told about: anything the coordinator emits in
 * that window is QUEUED, and a queued `closed` cannot end a response that does
 * not exist yet. The failure it produces is silent and long-lived — a stream
 * that already said goodbye, kept open by a heartbeat, holding a socket for as
 * long as the client tolerates it.
 *
 * The other path is the timer: expiry and an emptied allowlist raise no event,
 * so a held-open stream has to ask, and the first refusal must end it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import type { ExternalAppSession } from "../app-external/service.js";
import type { InstanceEvent, InstanceSubscription } from "../app-core/instance.js";
import type { PanelReply } from "./http.js";
import { streamExternalApp, type AppExternalRoutesContext } from "./routes/app-external.js";

const ORIGIN = "http://127.0.0.1:9931";

/** Just enough `ServerResponse` for an SSE stream to write itself onto. */
function fakeResponse() {
  const written: string[] = [];
  let ended = false;
  let failHeartbeatAsync = false;
  const handlers = new Map<string, Array<() => void>>();
  const emit = (event: string): void => {
    for (const fn of handlers.get(event) ?? []) fn();
  };
  const res = {
    writableEnded: false,
    destroyed: false,
    write(chunk: string) {
      written.push(chunk);
      if (failHeartbeatAsync && chunk === ": ping\n\n") {
        void Promise.resolve().then(() => emit("error"));
      }
      return true;
    },
    writeHead() {
      return res;
    },
    end() {
      ended = true;
      res.writableEnded = true;
      emit("finish");
    },
    destroy() {
      if (res.destroyed) return res;
      res.destroyed = true;
      emit("close");
      return res;
    },
    on(event: string, fn: () => void) {
      handlers.set(event, [...handlers.get(event) ?? [], fn]);
      return res;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    written,
    isEnded: () => ended,
    failNextHeartbeat: () => { failHeartbeatAsync = true; },
  };
}

function fakeReply(res: ServerResponse) {
  const answered: Array<{ status: number; payload: unknown }> = [];
  const reply = {
    raw: res,
    hijack() {},
    code(status: number) {
      answered.push({ status, payload: undefined });
      return reply;
    },
    type() {
      return reply;
    },
    send(payload: unknown) {
      if (answered.length) answered[answered.length - 1]!.payload = payload;
      return reply;
    },
  };
  return { reply: reply as unknown as PanelReply, answered };
}

const SESSION = {
  binding: { username: "alice", credential_id: "xai_one" },
} as unknown as ExternalAppSession;

function context(): AppExternalRoutesContext {
  return { externalAppHost: null, liveStreams: new Map(), eventStreams: new Set() };
}

/** A coordinator whose subscription hands the listener out to the test. */
function coordinator(options: { emitOnSubscribe?: InstanceEvent } = {}) {
  let listener: ((event: InstanceEvent) => void) | null = null;
  let closed = false;
  const revalidations: string[] = [];
  let alive: { ok: boolean; code?: string } = { ok: true };
  return {
    revalidations,
    emit: (event: InstanceEvent) => listener?.(event),
    subscriptionClosed: () => closed,
    fail: (code: string) => { alive = { ok: false, code }; },
    service: {
      subscribe(_session: ExternalAppSession, _handle: string, fn: (event: InstanceEvent) => void): InstanceSubscription | null {
        listener = fn;
        // The window this file exists for: the coordinator may speak while the
        // caller is still holding an un-hijacked reply.
        if (options.emitOnSubscribe) fn(options.emitOnSubscribe);
        return {
          initial: { type: "view", revision: 1, projection: { board: "start" } },
          releaseAvailable: null,
          close() {
            closed = true;
          },
        };
      },
      revalidate(credentialId: string) {
        revalidations.push(credentialId);
        return alive.ok
          ? { ok: true as const, value: SESSION }
          : { ok: false as const, status: 401, code: alive.code as never, message: "gone" };
      },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a `closed` that arrives before the hijack", () => {
  it("is written, ends the response, and starts no heartbeat", () => {
    const { res, written, isEnded } = fakeResponse();
    const { reply } = fakeReply(res);
    const backend = coordinator({ emitOnSubscribe: { type: "closed", reason: "credential_ended" } });
    const ctx = context();

    streamExternalApp(ctx, backend.service, SESSION, "handle-1", reply, ORIGIN);

    const body = written.join("");
    expect(body).toContain("event: closed");
    expect(body).toContain("credential_ended");
    expect(isEnded()).toBe(true);
    expect(backend.subscriptionClosed()).toBe(true);

    // Neither timer was installed: half an hour later nothing has been written
    // and nothing has been re-asked. A heartbeat on a stream that already said
    // goodbye is what keeps a dead connection alive.
    const after = written.length;
    vi.advanceTimersByTime(1_800_000);
    expect(written.length).toBe(after);
    expect(backend.revalidations).toHaveLength(0);
    // The registries do not keep a stream that never lived.
    expect(ctx.eventStreams.size).toBe(0);
    expect(ctx.liveStreams.size).toBe(0);
  });
});

describe("a stream that outlives its binding", () => {
  it("re-asks on a timer and ends on the first refusal", () => {
    const { res, written, isEnded } = fakeResponse();
    const { reply } = fakeReply(res);
    const backend = coordinator();
    streamExternalApp(context(), backend.service, SESSION, "handle-2", reply, ORIGIN);

    expect(written.join("")).toContain("event: view");
    expect(isEnded()).toBe(false);

    // Alive: the timer asks, the stream stays.
    vi.advanceTimersByTime(5_000);
    expect(backend.revalidations).toEqual(["xai_one"]);
    expect(isEnded()).toBe(false);

    backend.fail("invalid_credential");
    vi.advanceTimersByTime(5_000);
    expect(written.join("")).toContain("event: closed");
    expect(written.join("")).toContain("invalid_credential");
    expect(isEnded()).toBe(true);

    // And it stops asking once it is over.
    const asked = backend.revalidations.length;
    vi.advanceTimersByTime(60_000);
    expect(backend.revalidations).toHaveLength(asked);
  });

  it("treats a release change as the end of the binding, not as chrome", () => {
    const { res, written, isEnded } = fakeResponse();
    const { reply } = fakeReply(res);
    const backend = coordinator();
    streamExternalApp(context(), backend.service, SESSION, "handle-3", reply, ORIGIN);

    backend.emit({
      type: "release_available",
      current_package_digest: "old",
      available_package_digest: "new",
      mode: "refresh_required",
    });
    // A browser tab may reload itself onto the new release; a binding pinned to
    // an exact digest has nothing to reload into.
    expect(written.join("")).toContain("event: closed");
    expect(written.join("")).toContain("release_changed");
    expect(written.join("")).not.toContain("release_available");
    expect(isEnded()).toBe(true);
  });

  it("absorbs an asynchronous heartbeat error and tears down both timers", async () => {
    const { res, written, failNextHeartbeat } = fakeResponse();
    const { reply } = fakeReply(res);
    const backend = coordinator();
    const ctx = context();
    streamExternalApp(ctx, backend.service, SESSION, "handle-error", reply, ORIGIN);

    failNextHeartbeat();
    await vi.advanceTimersByTimeAsync(20_000);
    const afterError = written.length;
    const revalidations = backend.revalidations.length;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(written).toHaveLength(afterError);
    expect(backend.revalidations).toHaveLength(revalidations);
    expect(backend.subscriptionClosed()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(ctx.eventStreams.size).toBe(0);
    expect(ctx.liveStreams.size).toBe(0);
  });

  it("refuses without hijacking when the handle resolves to nothing", () => {
    const { res, written } = fakeResponse();
    const { reply, answered } = fakeReply(res);
    const service = {
      subscribe: () => null,
      revalidate: () => ({ ok: true as const, value: SESSION }),
    };
    streamExternalApp(context(), service, SESSION, "handle-4", reply, ORIGIN);
    expect(written).toHaveLength(0);
    expect(answered[0]?.status).toBe(404);
  });
});
