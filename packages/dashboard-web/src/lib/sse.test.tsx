/**
 * One subscription per stream, even under StrictMode.
 *
 * React 19's StrictMode mounts, cleans up and mounts again in development. A
 * naive effect opens two `EventSource`s and every transcript delta is applied
 * twice — which on this panel means a duplicated message list and a second
 * server-side tailer pinned to a session nobody is watching. This is the test
 * that says the hook survives it.
 */

import { StrictMode } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SSE_RECONNECT_MAX_MS, useEventSource } from "./sse.js";

const created: FakeEventSource[] = [];

class FakeEventSource {
  readonly url: string;
  closed = false;
  /** 0 CONNECTING, 1 OPEN, 2 CLOSED — as the browser reports it. */
  readyState = 0;
  readonly listeners: Record<string, Array<(ev: MessageEvent) => void>> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    created.push(this);
  }

  addEventListener(name: string, fn: (ev: MessageEvent) => void): void {
    (this.listeners[name] ??= []).push(fn);
  }

  removeEventListener(name: string, fn: (ev: MessageEvent) => void): void {
    this.listeners[name] = (this.listeners[name] ?? []).filter((f) => f !== fn);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}
type FakeSource = FakeEventSource;

function open(): FakeSource[] {
  return created.filter((source) => !source.closed);
}

function emit(source: FakeSource, name: string, data: unknown): void {
  act(() => {
    for (const fn of source.listeners[name] ?? []) {
      fn({ data: JSON.stringify(data) } as MessageEvent);
    }
  });
}

function Subscriber({ url, onDelta, reconnectUrl }: {
  url: string | null;
  onDelta: (d: unknown) => void;
  reconnectUrl?: () => string;
}) {
  const status = useEventSource(url, { events: { delta: onDelta }, ...(reconnectUrl ? { reconnectUrl } : {}) });
  return <span data-testid="status">{status}</span>;
}

/** The browser's answer to a non-200 response: one `error`, readyState CLOSED, no retry. */
function refuse(source: FakeSource): void {
  act(() => {
    source.readyState = 2;
    source.onerror?.();
  });
}

describe("useEventSource", () => {
  beforeEach(() => {
    created.length = 0;
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  it("holds exactly one live connection under StrictMode's double mount", () => {
    render(
      <StrictMode>
        <Subscriber url="/api/sessions/live?id=a" onDelta={() => {}} />
      </StrictMode>,
    );
    expect(open()).toHaveLength(1);
  });

  it("delivers each frame once, not once per mount", () => {
    const seen: unknown[] = [];
    render(
      <StrictMode>
        <Subscriber url="/api/sessions/live?id=a" onDelta={(d) => seen.push(d)} />
      </StrictMode>,
    );
    emit(open()[0], "delta", { from: 0 });
    expect(seen).toHaveLength(1);
  });

  it("closes the connection when the component goes away", () => {
    const view = render(<Subscriber url="/api/sessions/live?id=a" onDelta={() => {}} />);
    expect(open()).toHaveLength(1);
    view.unmount();
    expect(open()).toHaveLength(0);
  });

  it("swaps connections when the url changes, never stacking them", () => {
    const view = render(<Subscriber url="/api/sessions/live?id=a" onDelta={() => {}} />);
    view.rerender(<Subscriber url="/api/sessions/live?id=b" onDelta={() => {}} />);
    expect(open()).toHaveLength(1);
    expect(open()[0].url).toContain("id=b");
  });

  it("opens nothing at all when there is nothing selected", () => {
    render(<Subscriber url={null} onDelta={() => {}} />);
    expect(created).toHaveLength(0);
  });

  it("stops for good on a server `err` frame — that answer is not retryable", () => {
    const view = render(<Subscriber url="/api/sessions/live?id=a" onDelta={() => {}} />);
    const source = open()[0];
    act(() => {
      for (const fn of source.listeners.err ?? []) fn({ data: "forbidden" } as MessageEvent);
    });
    expect(source.closed).toBe(true);
    expect(view.getByTestId("status").textContent).toBe("closed");
  });

  it("ignores a malformed frame instead of tearing the stream down", () => {
    const seen: unknown[] = [];
    render(<Subscriber url="/api/sessions/live?id=a" onDelta={(d) => seen.push(d)} />);
    const source = open()[0];
    act(() => {
      for (const fn of source.listeners.delta ?? []) fn({ data: "not json" } as MessageEvent);
    });
    expect(seen).toHaveLength(0);
    expect(source.closed).toBe(false);
  });

  it("silences a late listener from an old subscription, even against the newest handler", () => {
    // The bug this is written for: handlers are held in a ref that points at
    // the LATEST render's closures, so a listener whose event was already
    // queued when we swapped URLs would call somebody else's onDelta. The
    // effect-local `closed` token stops that at the door — pinned here by
    // saving the actual listener function from before the swap and invoking
    // it AFTER the URL changed, exactly as a late event queue would.
    const deltas: unknown[] = [];
    const fatals: string[] = [];
    let onDelta = (d: unknown): void => {
      deltas.push({ owner: "A", data: d });
    };
    let onFatal = (m: string): void => {
      fatals.push(`A:${m}`);
    };
    function TwoHandlers({ url }: { url: string | null }) {
      const status = useEventSource(url, {
        events: { delta: (d) => onDelta(d) },
        onFatal: (m) => onFatal(m),
      });
      return <span data-testid="status">{status}</span>;
    }

    const view = render(<TwoHandlers url="/api/sessions/live?id=a" />);
    const sourceA = open()[0];
    // Save the actual listener references that WOULD have been dispatched by
    // an event queued before the URL swap. A late event handler is exactly
    // this closure being invoked out of order — not a call through the ref.
    const savedDelta = sourceA.listeners.delta?.[0];
    const savedFatal = sourceA.listeners.err?.[0];
    expect(savedDelta).toBeDefined();
    expect(savedFatal).toBeDefined();

    // Swap to a fresh subscription. Handlers rotate too — a late listener
    // that routed through the ref would call THESE, not A's.
    onDelta = (d) => {
      deltas.push({ owner: "B", data: d });
    };
    onFatal = (m) => {
      fatals.push(`B:${m}`);
    };
    view.rerender(<TwoHandlers url="/api/sessions/live?id=b" />);

    // A's underlying source is closed and its listeners are removed from the
    // dispatch table — but a runtime that already grabbed those functions
    // will still invoke them. That is what we simulate here.
    act(() => {
      savedDelta!({ data: JSON.stringify({ from: 999 }) } as MessageEvent);
      savedFatal!({ data: "revoked" } as MessageEvent);
    });

    // None of it may write state or route to any handler, current or old.
    expect(deltas).toEqual([]);
    expect(fatals).toEqual([]);
    // The live status still belongs to B — a late fatal that had leaked
    // through would have marked the hook `closed`, hiding a live stream.
    expect(view.getByTestId("status").textContent).not.toBe("closed");
    // And the new subscription is genuinely live, not muzzled by the late frames.
    const sourceB = open()[0];
    expect(sourceB.url).toContain("id=b");
    expect(sourceB.closed).toBe(false);
    onDelta = (d) => {
      deltas.push({ owner: "B", data: d });
    };
    emit(sourceB, "delta", { from: 0 });
    expect(deltas).toEqual([{ owner: "B", data: { from: 0 } }]);
  });

  it("silences a late listener after the caller has said `url: null`", () => {
    // Same property as the URL swap case, but for the "nothing selected" path
    // — a queued frame from the old subscription must not resurrect state on
    // a screen that already moved on.
    const seen: unknown[] = [];
    let value: unknown = null;
    function Sub({ url }: { url: string | null }) {
      return (
        <Subscriber
          url={url}
          onDelta={(d) => {
            value = d;
            seen.push(d);
          }}
        />
      );
    }
    const view = render(<Sub url="/api/sessions/live?id=a" />);
    const sourceA = open()[0];
    const savedDelta = sourceA.listeners.delta?.[0];
    expect(savedDelta).toBeDefined();

    view.rerender(<Sub url={null} />);
    act(() => {
      savedDelta!({ data: JSON.stringify({ from: 42 }) } as MessageEvent);
    });
    expect(seen).toEqual([]);
    expect(value).toBeNull();
  });
});

describe("useEventSource when the browser gives up on a stream", () => {
  beforeEach(() => {
    created.length = 0;
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says so, then reopens after a backoff from the caller's current cursor", () => {
    let cursor = 7;
    const seen: unknown[] = [];
    const view = render(<Subscriber url="/api/tickets/1/live?from=0" onDelta={(d) => seen.push(d)}
      reconnectUrl={() => `/api/tickets/1/live?from=${cursor}`} />);
    const first = open()[0];
    act(() => first.onopen?.());
    expect(view.getByTestId("status").textContent).toBe("open");

    cursor = 9;
    refuse(first);
    // The browser closed it; the hook must not keep claiming a live stream.
    expect(first.closed).toBe(true);
    expect(view.getByTestId("status").textContent).toBe("reconnecting");
    expect(open()).toHaveLength(0);

    act(() => vi.advanceTimersByTime(999));
    expect(open()).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    const second = open()[0];
    expect(second.url).toBe("/api/tickets/1/live?from=9");
    act(() => second.onopen?.());
    expect(view.getByTestId("status").textContent).toBe("open");
    emit(second, "delta", { from: 9 });
    expect(seen).toEqual([{ from: 9 }]);
  });

  it("doubles the wait up to a cap, and a successful open resets it", () => {
    render(<Subscriber url="/live?from=0" onDelta={() => {}} />);
    const waits: number[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      refuse(open()[0]);
      let waited = 0;
      while (!open().length) {
        act(() => vi.advanceTimersByTime(500));
        waited += 500;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, SSE_RECONNECT_MAX_MS, SSE_RECONNECT_MAX_MS, SSE_RECONNECT_MAX_MS]);
    act(() => open()[0].onopen?.());
    refuse(open()[0]);
    act(() => vi.advanceTimersByTime(1_000));
    expect(open()).toHaveLength(1);
  });

  it("leaves a dropped stream to the browser's own retry while it is still connecting", () => {
    const view = render(<Subscriber url="/live?from=0" onDelta={() => {}} />);
    const source = open()[0];
    act(() => source.onopen?.());
    act(() => source.onerror?.());
    expect(view.getByTestId("status").textContent).toBe("reconnecting");
    expect(source.closed).toBe(false);
    act(() => vi.advanceTimersByTime(SSE_RECONNECT_MAX_MS));
    expect(created).toHaveLength(1);
    act(() => source.onopen?.());
    expect(view.getByTestId("status").textContent).toBe("open");
  });

  it("drops a frame queued on the closed connection and cancels a pending reopen on unmount", () => {
    const seen: unknown[] = [];
    const view = render(<Subscriber url="/live?from=0" onDelta={(d) => seen.push(d)} />);
    const first = open()[0];
    const late = first.listeners.delta?.[0];
    refuse(first);
    act(() => vi.advanceTimersByTime(1_000));
    act(() => late!({ data: JSON.stringify({ from: 1 }) } as MessageEvent));
    expect(seen).toEqual([]);

    refuse(open()[0]);
    view.unmount();
    act(() => vi.advanceTimersByTime(SSE_RECONNECT_MAX_MS));
    expect(created).toHaveLength(2);
    expect(open()).toHaveLength(0);
  });

  it("never reopens after the server's own `err` frame", () => {
    const view = render(<Subscriber url="/live?from=0" onDelta={() => {}} />);
    const source = open()[0];
    act(() => {
      for (const fn of source.listeners.err ?? []) fn({ data: "revoked" } as MessageEvent);
    });
    act(() => vi.advanceTimersByTime(SSE_RECONNECT_MAX_MS));
    expect(created).toHaveLength(1);
    expect(view.getByTestId("status").textContent).toBe("closed");
  });
});
