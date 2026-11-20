/**
 * The trusted page's flight recorder: one bounded semantic timeline per
 * document, plus the assert monitor over it
 * (design: doc/development/frontend-observability-design.md §3–§4).
 *
 * Everything recorded here is the TRUSTED side's own account of what it did —
 * proposals it forwarded, frames it applied, wire state it observed. Nothing
 * reaches in from the View: the iframe's interior states arrive only later,
 * over the explicit debug channel, and are merged at export time by whoever
 * asked. The recorder holds no authority and exports only on an explicit call.
 *
 * The window hook (`window.__octopusFlight`) exists because a MessagePort
 * boundary has no other external observer: the browser e2e suite and a person
 * with devtools both need ONE sanctioned way to pull the timeline, and a
 * DOM-rendered dump of every event would be worse telemetry than none.
 */

import {
  createFlightRecorder,
  evaluateAsserts,
  noShrink,
  pendingSettles,
  projectionFacts,
  revisionMonotonic,
  summarizeProjectionFrame,
  violationEvent,
  type AssertViolation,
  type FlightRecorder,
  type ProjectionFrameFacts,
  type TemporalAssert,
} from "@claude-bot/flight-recorder";

export interface PageFlight {
  readonly recorder: FlightRecorder;
  /** Record one forwarded proposal; the returned rid keys its settlement. */
  propose(action: string): string;
  /** Record the reply to a proposal: ok/refused/transport-failed. */
  settle(rid: string, ok: boolean, code?: string): void;
  /** Record one applied projection frame (dispatch reply or stream push). */
  frame(projection: unknown, revision?: number, rid?: string): void;
  /** Record one operation-stream record; `opId` correlates its lifecycle. */
  operation(operation: string, status: string, opId?: string): void;
  wake(): void;
  /** Record a wire-state transition: connected / reconnecting / closed. */
  channel(state: string): void;
  /** Violations found so far (monitor passes; deduplicated). */
  violations(): readonly AssertViolation[];
  /** Start the periodic assert monitor; returns the stop function. */
  startMonitor(intervalMs?: number): () => void;
}

/** Collections the sessions+ projection carries that are worth counting. */
const SESSIONS_COLLECTIONS = ["sessions", "operations", "sources"] as const;

/** Search legitimately replaces the list with a smaller one. */
const SHRINK_EXEMPT_ACTIONS = ["search_sessions"];

/** One monitor pass every 15s: cheap, and violations are about minutes. */
const MONITOR_INTERVAL_MS = 15_000;

/** A proposal unanswered for this long is a spinner nobody will resolve. */
const PENDING_TIMEOUT_MS = 30_000;

declare global {
  interface Window {
    /** Sanctioned observer for e2e and devtools; export-only, no authority. */
    __octopusFlight?: { export(): string; violations(): readonly AssertViolation[] };
  }
}

export function createPageFlight(surface: string, options: { now?: () => number } = {}): PageFlight {
  const now = options.now ?? Date.now;
  const recorder = createFlightRecorder({ now });
  const found: AssertViolation[] = [];
  const foundKeys = new Set<string>();
  let previousFacts: ProjectionFrameFacts | null = null;
  /** Mirrors the Host's retained revision so the timeline records applied frames only. */
  let projectionRevision: number | null = null;
  let nextRid = 0;

  const asserts: TemporalAssert[] = [
    noShrink({ collection: "sessions", exemptActions: SHRINK_EXEMPT_ACTIONS }),
    revisionMonotonic(),
    pendingSettles({ timeoutMs: PENDING_TIMEOUT_MS }),
  ];

  const violations = (): readonly AssertViolation[] => found;

  const runMonitor = (): void => {
    const fresh = evaluateAsserts(asserts, recorder.events(), now());
    for (const violation of fresh) {
      const key = `${violation.assert}|${violation.key}|${violation.at}`;
      if (foundKeys.has(key)) continue;
      foundKeys.add(key);
      found.push(violation);
      recorder.record(violationEvent(violation));
      // The console line is for the person already looking; the archive is
      // for everyone else. Never throw from a monitor pass.
      // eslint-disable-next-line no-console
      console.warn(`[flight] ${violation.assert}: ${violation.summary}`);
    }
    if (typeof document !== "undefined") {
      document.body.setAttribute("data-flight-violations", String(found.length));
    }
  };

  return {
    recorder,
    propose(action) {
      const rid = `p${++nextRid}`;
      recorder.record({ source: "user", kind: "user.propose", key: action, delta: {}, rid });
      return rid;
    },
    settle(rid, ok, code) {
      recorder.record({
        source: "wire",
        kind: "user.settle",
        key: surface,
        delta: { ok, ...(code ? { code } : {}) },
        rid,
      });
    },
    frame(projection, revision, rid) {
      const numbered = typeof revision === "number"
        && Number.isSafeInteger(revision)
        && revision >= 0;
      if (numbered && projectionRevision !== null && revision <= projectionRevision) return;

      const facts = projectionFacts(projection, {
        collections: SESSIONS_COLLECTIONS,
        ...(numbered ? { revision } : {}),
      });
      recorder.record({
        source: "frame",
        kind: "frame.projection",
        key: surface,
        delta: summarizeProjectionFrame(previousFacts, facts),
        ...(rid ? { rid } : {}),
      });
      previousFacts = facts;
      projectionRevision = numbered ? revision : null;
    },
    operation(operation, status, opId) {
      recorder.record({
        source: "frame",
        kind: "frame.operation",
        key: operation,
        delta: { status },
        ...(opId ? { rid: opId } : {}),
      });
    },
    wake() {
      recorder.record({ source: "wire", kind: "wire.wake", key: surface, delta: {} });
    },
    channel(state) {
      recorder.record({ source: "wire", kind: "wire.channel", key: surface, delta: { state } });
    },
    violations,
    startMonitor(intervalMs = MONITOR_INTERVAL_MS) {
      runMonitor();
      const timer = setInterval(runMonitor, intervalMs);
      return () => clearInterval(timer);
    },
  };
}

/**
 * The markdown body a feedback (discuss) ticket carries: the person's words
 * first, then bounded diagnostic blocks — assert findings, the picked UI
 * element, the trusted-side and View-side timelines. Every block is clipped,
 * so a runaway structure cannot turn one ticket into a payload dump; what the
 * person previews is exactly what is sent.
 *
 * Ticket #201 added the two facts an agent asked for first and never got: WHICH
 * PAGE this was (the dock now files from anywhere, so "Sessions+" stopped being
 * a safe assumption) and WHERE the element is — a selector chain that resolves
 * back to it, ahead of the subtree that only says what it looks like. The
 * trailer is the attachment refs, appended last so a picture is named in the
 * body rather than travelling beside it.
 */
export interface PickedElementFacts {
  selector?: unknown;
  path?: unknown;
  route?: unknown;
}

export function composeFeedbackBody(input: {
  description: string;
  /** The address this was filed from, when the caller knows it. */
  route?: string;
  picked?: (PickedElementFacts & Record<string, unknown>) | null;
  timeline?: readonly unknown[];
  viewTimeline?: readonly unknown[];
  violations?: readonly AssertViolation[];
  /** Markdown appended verbatim after the diagnostics (attachment refs). */
  trailer?: string;
}): string {
  const clip = (value: unknown, max: number): string => {
    try {
      const text = JSON.stringify(value, null, 1) ?? "";
      return text.length > max ? `${text.slice(0, max)}\n…(已截断)` : text;
    } catch {
      return "(无法序列化)";
    }
  };
  const block = (title: string, value: unknown, max: number): string =>
    `**${title}**\n\n\`\`\`json\n${clip(value, max)}\n\`\`\``;
  const parts: string[] = [input.description.trim() || "(未填写描述)"];
  parts.push("---\n### 自动附带的前端诊断上下文");
  const route = input.route ?? (typeof input.picked?.route === "string" ? input.picked.route : "");
  if (route) parts.push(`**页面**:\`${String(route).slice(0, 300)}\``);
  // The address FIRST. A subtree describes an element; only this says where it
  // is, and it is the line an agent turns into a grep.
  const selector = typeof input.picked?.selector === "string" ? input.picked.selector : "";
  if (selector) parts.push(`**选中元素**:\`${selector.slice(0, 600)}\``);
  if (Array.isArray(input.picked?.path) && input.picked.path.length) {
    parts.push(block("元素路径(从文档根往下)", input.picked.path, 1_500));
  }
  if (input.violations?.length) parts.push(block(`断言违例(${input.violations.length})`, input.violations.slice(-8), 2_000));
  if (input.picked != null) parts.push(block("选中的 UI 元素(有界子树)", input.picked, 4_000));
  if (input.timeline?.length) parts.push(block(`可信侧时间线(最近 ${Math.min(input.timeline.length, 80)} 条)`, input.timeline.slice(-80), 6_000));
  if (input.viewTimeline?.length) parts.push(block(`View 侧时间线(最近 ${Math.min(input.viewTimeline.length, 40)} 条)`, input.viewTimeline.slice(-40), 4_000));
  if (input.trailer?.trim()) parts.push(input.trailer.trim());
  return parts.join("\n\n");
}

/**
 * The published observer, for a surface that did not create the flight.
 *
 * The dock is mounted by the shell and files from every page; only some pages
 * run a recorder. Reading the hook rather than holding a reference is what
 * lets "there is no timeline here" be an empty array instead of a special
 * case at every call site. Export-only, exactly as published — this grants the
 * reader nothing the page had not already put on `window`.
 */
export function readFlightHook(): { timeline(): readonly unknown[]; violations(): readonly AssertViolation[] } | null {
  if (typeof window === "undefined" || !window.__octopusFlight) return null;
  const hook = window.__octopusFlight;
  return {
    timeline() {
      try {
        const parsed = JSON.parse(hook.export()) as { events?: unknown };
        return Array.isArray(parsed.events) ? parsed.events : [];
      } catch {
        return [];
      }
    },
    violations() {
      try {
        return hook.violations();
      } catch {
        return [];
      }
    },
  };
}

/**
 * Publish the sanctioned observer. Trusted pages call this once per document;
 * repeated calls (StrictMode, remount) simply repoint to the same flight.
 */
export function publishFlightHook(flight: PageFlight): void {
  if (typeof window === "undefined") return;
  window.__octopusFlight = {
    export: () => flight.recorder.export(),
    violations: () => flight.violations(),
  };
}
