/**
 * Server-sent events, with the lifetime rules written down.
 *
 * ── The failures this exists to prevent ─────────────────────────────────────
 *
 *  1. **Two subscriptions to one stream.** React 19's StrictMode mounts, cleans
 *     up and mounts again in development; a naive effect opens two
 *     `EventSource`s and the transcript applies every delta twice. The hook
 *     closes the previous connection in its cleanup and keys the effect on the
 *     URL alone, so a double mount produces one live connection — pinned by a
 *     test that renders under StrictMode.
 *  2. **A stream that outlives what it was following.** Every connection is
 *     owned by one effect and closed when the URL changes or the component
 *     unmounts. Leaving one open keeps a server-side tailer alive against a
 *     session nobody is looking at.
 *  3. **A silent reconnect loop, or a silent death.** `EventSource` retries a
 *     dropped stream by itself, but it gives up for good when an attempt is
 *     answered with anything but a 200 event stream (a proxy 502 during a
 *     restart, a 503 while the device is away) — the browser has closed it,
 *     and a caller that kept saying "following live" would be lying. The hook
 *     then opens a new connection itself after a bounded backoff (1 s doubling
 *     to 30 s, reset by every successful open), asking the caller for a fresh
 *     cursor when it can give one. A server-sent `err` event still means
 *     "stop", not "retry", so the hook closes for good in that case. All of it
 *     is surfaced through `status`.
 *  4. **A late listener that ran after cleanup.** Handlers are held in a ref
 *     so callers may pass fresh closures on every render — but that means the
 *     ref points at the LATEST handler, not the one this subscription was set
 *     up with. A listener whose event was already queued when we called
 *     `source.close()` still runs, and if we routed it through the ref it
 *     would call somebody else's onDelta/onFatal on somebody else's ticket.
 *     Every subscription therefore owns an effect-local `token` and cleanup
 *     sets `token.closed = true` BEFORE removing the listeners and closing
 *     the source; every listener bails out on `token.closed` before it does
 *     anything. The identity is per-effect and cannot be spoofed by a global.
 *
 * `url: null` means "do not connect", which is how a component expresses
 * "nothing selected yet" without a second branch around the hook.
 */

import { useEffect, useRef, useState } from "react";

export type SseStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface SseHandlers {
  /** Named events, e.g. `{ delta: fn, operation: fn }`. */
  events: Record<string, (data: unknown) => void>;
  /** The server sent an `err` event: the stream is over, do not reconnect. */
  onFatal?: (message: string) => void;
  /**
   * The address for a reconnect the hook opens itself, so it resumes from the
   * caller's current cursor rather than the one the subscription began with.
   * Absent, the original URL is reused.
   */
  reconnectUrl?: () => string;
}

/** First delay before reopening a stream the browser gave up on. */
export const SSE_RECONNECT_BASE_MS = 1_000;
/** The backoff never waits longer than this between attempts. */
export const SSE_RECONNECT_MAX_MS = 30_000;
/** `EventSource.CLOSED`: the browser will not retry this connection. */
const CLOSED = 2;

/**
 * Subscribe to one SSE endpoint.
 *
 * Handlers are held in a ref so that a component may pass fresh closures on
 * every render without tearing the connection down — the effect depends on the
 * URL and nothing else, which is the property that makes double-mount safe.
 */
export function useEventSource(url: string | null, handlers: SseHandlers): SseStatus {
  const [status, setStatus] = useState<SseStatus>("idle");
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!url) {
      setStatus("idle");
      return;
    }
    // The subscription's identity: a fresh object per effect, checked by every
    // listener before it touches state. It is captured by reference in every
    // listener closure, so a `token.closed = true` from cleanup silences this
    // subscription's late frames even though the same listener functions are
    // still on the EventSource for the microseconds before removal.
    const token = { closed: false };
    let source: EventSource | null = null;
    let detach = (): void => {};
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const connect = (target: string): void => {
      const current = new EventSource(target);
      source = current;
      // A listener answers only for the connection it was attached to: after
      // a reconnect, a frame already queued on the old one is dropped.
      const live = (): boolean => !token.closed && source === current;
      const listeners: Array<[string, EventListener]> = [];
      for (const name of Object.keys(ref.current.events)) {
        const listener: EventListener = (event) => {
          if (!live()) return;
          const message = event as MessageEvent<string>;
          let data: unknown;
          try {
            data = JSON.parse(message.data);
          } catch {
            // One malformed frame must not kill the stream.
            return;
          }
          ref.current.events[name]?.(data);
        };
        current.addEventListener(name, listener);
        listeners.push([name, listener]);
      }

      // `err` is the server saying the subscription is over (revoked, forbidden,
      // gone). Reconnecting would re-ask a question that was already answered.
      const fatal: EventListener = (event) => {
        if (!live()) return;
        const message = event as MessageEvent<string>;
        token.closed = true;
        detach();
        setStatus("closed");
        ref.current.onFatal?.(message.data || "");
      };
      current.addEventListener("err", fatal);

      current.onopen = () => {
        if (!live()) return;
        failures = 0;
        setStatus("open");
      };
      current.onerror = () => {
        if (!live()) return;
        // Still CONNECTING: the browser is retrying a dropped stream itself,
        // resuming from the last event id it saw.
        if (current.readyState !== CLOSED) {
          setStatus("reconnecting");
          return;
        }
        // CLOSED: an attempt was answered with something other than a 200
        // event stream, and the browser will not try again. Neither will this
        // connection; a new one follows after a bounded backoff.
        detach();
        setStatus("reconnecting");
        const delay = Math.min(SSE_RECONNECT_BASE_MS * 2 ** failures, SSE_RECONNECT_MAX_MS);
        failures += 1;
        retry = setTimeout(() => {
          retry = undefined;
          if (!token.closed) connect(ref.current.reconnectUrl?.() ?? url);
        }, delay);
      };

      detach = () => {
        // The order is load-bearing: forget the connection BEFORE removing
        // listeners and closing it. A listener whose event was already queued
        // for this task still runs after removeEventListener returns, and only
        // the `live()` check stops it.
        if (source === current) source = null;
        current.removeEventListener("err", fatal);
        for (const [name, listener] of listeners) current.removeEventListener(name, listener);
        current.onopen = null;
        current.onerror = null;
        current.close();
      };
    };

    connect(url);
    setStatus("connecting");

    return () => {
      token.closed = true;
      if (retry !== undefined) clearTimeout(retry);
      detach();
    };
  }, [url]);

  return status;
}
