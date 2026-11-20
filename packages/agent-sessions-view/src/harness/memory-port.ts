/**
 * A second, real implementation of `agent-sessions/v1` — in memory, read-only.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 *
 * It is the proof that the port is a boundary and not a description of one
 * transport. The Session Plus App satisfies `SessionsPort` by proposing over its
 * own channel to a trusted coordinator; this satisfies it out of a fixture. The
 * roster, the search box and the chat cannot tell the difference, because there
 * is no method on the port that would tell them.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *
 * It does not copy the backend. There is no session store, no scan, no Runner,
 * no capability, no operation coordinator. It does not construct a wire message
 * either: bypassing the typed port to hand the modules a `session-plus/2` frame
 * would prove that the App works, which is not the claim being made.
 *
 * ── Why the writes refuse rather than being absent ──────────────────────────
 *
 * A read-only consumer gets the SAME interface. Refusing is how a provider
 * without an execute grant behaves, so the modules discover the limit through
 * the one channel they discover every other limit through — a bounded refusal —
 * rather than through a differently-shaped object they would have to branch on.
 */

import {
  READ_ONLY_REFUSAL,
  type RichMessage,
  type SearchHit,
  type SessionSummary,
  type SessionsPort,
  type SessionsProjection,
  type SessionsReply,
  type SessionsSnapshot,
  type SourceRow,
  type WorkspaceGroup,
} from "@claude-bot/agent-sessions-contract";

export interface MemorySessionsFixture {
  notice?: string;
  sessions: readonly SessionSummary[];
  sources?: readonly SourceRow[];
  /** Full history per resource id; the port windows it like a real provider. */
  transcripts?: Readonly<Record<string, readonly RichMessage[]>>;
  workspaces?: Readonly<Record<string, WorkspaceGroup>>;
  pinned?: readonly string[];
}

export interface MemorySessionsPort extends SessionsPort {
  /** Every method call, in order — a harness assertion surface, not state. */
  readonly calls: readonly string[];
}

const OK: SessionsReply = Object.freeze({ ok: true, result: null, message: "" });

export function createMemorySessionsPort(fixture: MemorySessionsFixture): MemorySessionsPort {
  const transcripts = fixture.transcripts ?? {};
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  let snapshot: SessionsSnapshot = {
    phase: "open",
    projection: {
      notice: fixture.notice ?? "只读 sessions 视图：它没有被授予任何写入或执行 operation。",
      pinned: [...(fixture.pinned ?? [])],
      sessions: [...fixture.sessions],
      sources: [...(fixture.sources ?? [])],
    },
    operations: [],
    refusal: "",
  };

  function publish(projection: SessionsProjection, refusal = snapshot.refusal): void {
    snapshot = { ...snapshot, projection, refusal };
    for (const listener of [...listeners]) listener();
  }

  function refuse(): SessionsReply {
    publish(snapshot.projection!, READ_ONLY_REFUSAL.message);
    return READ_ONLY_REFUSAL;
  }

  return {
    get calls() {
      return calls;
    },
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clearRefusal() {
      if (snapshot.refusal) publish(snapshot.projection!, "");
    },
    async refreshSessions() {
      calls.push("refreshSessions");
      publish({ ...snapshot.projection, sessions: [...fixture.sessions] });
      return OK;
    },
    async search(query, limit) {
      calls.push(`search:${query}`);
      const needle = query.trim();
      const results: SearchHit[] = [];
      if (needle) {
        for (const session of fixture.sessions) {
          const hit = (transcripts[session.resourceId] ?? []).find((message) =>
            textOf(message).includes(needle),
          );
          if (hit) results.push({ session, snippet: textOf(hit).slice(0, 160) });
          if (results.length >= limit) break;
        }
      }
      publish({ ...snapshot.projection, search: { query, results } });
      return OK;
    },
    async readWindow({ resource, limit, offset }) {
      calls.push(`readWindow:${resource}:${limit}:${offset ?? "tail"}`);
      const all = transcripts[resource] ?? [];
      const start = offset == null ? Math.max(0, all.length - limit) : Math.max(0, Math.min(offset, all.length));
      const messages = all.slice(start, start + limit);
      publish({
        ...snapshot.projection,
        transcript: {
          ...snapshot.projection?.transcript,
          [resource]: {
            messages: [...messages],
            offset: start,
            totalMessages: all.length,
            hasMore: start > 0,
            activity: { state: "idle" },
          },
        },
      });
      return OK;
    },
    async listWorkspaces(device) {
      calls.push(`listWorkspaces:${device}`);
      const group = fixture.workspaces?.[device];
      if (!group) return OK;
      publish({
        ...snapshot.projection,
        workspacesByDevice: { ...snapshot.projection?.workspacesByDevice, [device]: group },
      });
      return OK;
    },
    async start() {
      calls.push("start");
      return refuse();
    },
    async append() {
      calls.push("append");
      return refuse();
    },
    async resume() {
      calls.push("resume");
      return refuse();
    },
    async takeover() {
      calls.push("takeover");
      return refuse();
    },
    async fallback() {
      calls.push("fallback");
      return refuse();
    },
    async interrupt() {
      calls.push("interrupt");
      return refuse();
    },
    async releaseControl() {
      calls.push("releaseControl");
      return refuse();
    },
    async respondInteraction() {
      calls.push("respondInteraction");
      return refuse();
    },
    async openTerminal() {
      calls.push("openTerminal");
      return refuse();
    },
    async readTerminal() {
      calls.push("readTerminal");
      return refuse();
    },
    async sendTerminal() {
      calls.push("sendTerminal");
      return refuse();
    },
    async closeTerminal() {
      calls.push("closeTerminal");
      return refuse();
    },
    async pin() {
      calls.push("pin");
      return refuse();
    },
    async setTitle() {
      calls.push("setTitle");
      return refuse();
    },
    async markReviewed() {
      calls.push("markReviewed");
      return refuse();
    },
    async attachFile() {
      calls.push("attachFile");
      return refuse();
    },
    async setFileAnnotations(fileKey) {
      calls.push(`setFileAnnotations:${fileKey}`);
      return refuse();
    },
  };
}

function textOf(message: RichMessage): string {
  const blocks = (message.blocks ?? []).map((block) => String(block?.text ?? "")).join(" ");
  return `${message.text ?? ""} ${blocks}`;
}
