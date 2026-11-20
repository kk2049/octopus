import { createHash, randomUUID } from "node:crypto";
import type { RpcRequest, RpcResponse } from "./core.js";
import {
  SESSION_PROJECTION_ROSTER_MAX,
  RUNNER_SESSION_PROJECTION_SCHEMA,
  type RunnerSessionProjection,
  type RunnerSessionProjectionCommand,
  type SessionProjectionSource,
  sessionRosterProjectionFromResult,
  sessionTranscriptProjectionFromResult,
} from "./session-projection.js";

const CHANGE_COALESCE_MS = 75;
/** Bound whole-tail reads while preserving visibly incremental app-server output. */
const MANAGED_TRANSCRIPT_COALESCE_MS = 250;
/**
 * Hooks are the fast path, but an independently started CLI may have missing
 * or not-yet-trusted hooks. Keep the materialized roster close enough to the
 * filesystem for a new user prompt to move its session while it is still
 * useful, without making the browser poll a capability-bearing read.
 */
const RECONCILE_MS = 10_000;
/** Preserve the old five-minute full-frame heartbeat for cache freshness. */
const ROSTER_HEARTBEAT_MS = 5 * 60_000;
const TRANSCRIPT_SUBSCRIPTION_MAX = 64;

interface ProjectionDispatcher {
  handle(request: RpcRequest): Promise<RpcResponse>;
}

interface TranscriptSubscription {
  source: SessionProjectionSource;
  sessionId: string;
  maxMessages: number;
  closeSource?: () => void;
  sourceGeneration: object;
}

export interface RunnerSessionProjectorOptions {
  dispatcher: ProjectionDispatcher;
  send(projection: RunnerSessionProjection): void;
  onError?(operation: "roster" | "transcript", error: Error): void;
  reconcileMs?: number;
  watchTranscriptSource?(source: SessionProjectionSource, sessionId: string, onChanged: () => void, onChecked?: () => void): () => void;
}

/**
 * Device-local materializer. Hooks only invalidate; the append-only session
 * files remain truth and every emitted frame is rebuilt through the normal
 * scanner/translation/runtime pipeline.
 */
export class RunnerSessionProjector {
  private readonly epoch = randomUUID();
  private sequence = 0;
  private rosterTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private rosterInFlight = false;
  private rosterTrailing = false;
  private lastRosterSignature = "";
  private lastRosterSentAt = 0;
  private closed = false;
  private readonly published = new Map<string, { signature: string; sequence: number; valid: boolean }>();
  private readonly subscriptions = new Map<string, TranscriptSubscription>();
  private readonly transcriptTimers = new Map<string, NodeJS.Timeout>();
  private readonly transcriptInFlight = new Set<string>();
  private readonly transcriptTrailing = new Set<string>();

  constructor(private readonly options: RunnerSessionProjectorOptions) {}

  start(): void {
    if (this.closed || this.reconcileTimer) return;
    this.queueRoster(0);
    const reconcileMs = Math.max(1_000, this.options.reconcileMs ?? RECONCILE_MS);
    // Reconcile only the roster. Hook/runtime signals still refresh subscribed
    // transcripts through notifySessionChanged(); blind transcript polling would turn
    // one missing lifecycle hook into repeated whole-window reads.
    this.reconcileTimer = setInterval(() => this.queueRoster(0), reconcileMs);
    this.reconcileTimer.unref?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.rosterTimer) clearTimeout(this.rosterTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const timer of this.transcriptTimers.values()) clearTimeout(timer);
    this.rosterTimer = null;
    this.reconcileTimer = null;
    this.transcriptTimers.clear();
    for (const subscription of this.subscriptions.values()) subscription.closeSource?.();
    this.subscriptions.clear();
    this.published.clear();
    this.transcriptTrailing.clear();
  }

  /** Coalesced invalidation from hooks, runtime state, interactions, or reconcile. */
  notifyChanged(): void {
    if (this.closed) return;
    this.queueRoster(CHANGE_COALESCE_MS);
  }

  /** A local event identifies one session; other subscribed logs are untouched. */
  notifySessionChanged(source: SessionProjectionSource, sessionId: string): void {
    if (this.closed) return;
    this.queueRoster(MANAGED_TRANSCRIPT_COALESCE_MS);
    this.queueTranscript(transcriptKey(source, sessionId), MANAGED_TRANSCRIPT_COALESCE_MS);
  }

  /** Refresh only the live transcript named by one provider-native activity signal. */
  notifyTranscriptChanged(source: SessionProjectionSource, sessionId: string): void {
    if (this.closed) return;
    this.queueTranscript(transcriptKey(source, sessionId), MANAGED_TRANSCRIPT_COALESCE_MS);
  }

  handleCommand(command: RunnerSessionProjectionCommand): void {
    if (this.closed) return;
    const key = transcriptKey(command.source, command.session_id);
    this.published.delete(key);
    if (command.kind === "transcript_unsubscribe") {
      this.subscriptions.get(key)?.closeSource?.();
      this.subscriptions.delete(key);
      this.transcriptTrailing.delete(key);
      const timer = this.transcriptTimers.get(key);
      clearTimeout(timer);
      this.transcriptTimers.delete(key);
      return;
    }
    const current = this.subscriptions.get(key);
    if (!current && this.subscriptions.size >= TRANSCRIPT_SUBSCRIPTION_MAX) {
      this.options.onError?.("transcript", new Error("transcript projection subscription capacity reached"));
      return;
    }
    const subscription: TranscriptSubscription = {
      source: command.source,
      sessionId: command.session_id,
      maxMessages: command.max_messages,
      closeSource: current?.closeSource,
      sourceGeneration: current?.sourceGeneration ?? {},
    };
    this.subscriptions.set(key, subscription);
    if (!current) subscription.closeSource = this.options.watchTranscriptSource?.(
      subscription.source, subscription.sessionId, () => {
        if (this.subscriptions.get(key)?.sourceGeneration === subscription.sourceGeneration) {
          this.queueTranscript(key, CHANGE_COALESCE_MS);
        }
      },
      () => {
        if (this.subscriptions.get(key)?.sourceGeneration === subscription.sourceGeneration) this.sendChecked(key);
      },
    );
    this.queueTranscript(key, 0);
  }

  private queueRoster(delayMs: number): void {
    if (this.closed) return;
    if (this.rosterInFlight) {
      this.rosterTrailing = true;
      return;
    }
    if (this.rosterTimer) return;
    this.rosterTimer = setTimeout(() => {
      this.rosterTimer = null;
      void this.refreshRoster();
    }, delayMs);
    this.rosterTimer.unref?.();
  }

  private async refreshRoster(): Promise<void> {
    if (this.closed || this.rosterInFlight) return;
    this.rosterInFlight = true;
    let backfill = false;
    try {
      const response = await this.options.dispatcher.handle({
        id: `projection-roster-${this.sequence + 1}`,
        method: "list_recent_sessions",
        args: { source: "all", limit: SESSION_PROJECTION_ROSTER_MAX, primary_window: true },
      });
      if (!response.ok) throw new Error(response.error ?? "session roster projection failed");
      if (this.closed) return;
      const projection = sessionRosterProjectionFromResult(response.result, this.epoch, 1);
      if (!projection) throw new Error("session roster projection produced an invalid payload");
      backfill = projection.index_pending === true;
      // The ten-second fallback observes files; it does not manufacture ten-
      // second UI frames. Only semantic roster changes wake the trusted host.
      // A bounded heartbeat retains the previous cache-freshness guarantee.
      const signature = JSON.stringify([projection.total_found, projection.index_pending, projection.sessions]);
      const now = Date.now();
      if (signature === this.lastRosterSignature && now - this.lastRosterSentAt < ROSTER_HEARTBEAT_MS) return;
      this.options.send({ ...projection, sequence: this.nextSequence() });
      this.lastRosterSignature = signature;
      this.lastRosterSentAt = now;
    } catch (error) {
      this.options.onError?.("roster", asError(error));
    } finally {
      this.rosterInFlight = false;
      if ((this.rosterTrailing || backfill) && !this.closed) {
        this.rosterTrailing = false;
        this.queueRoster(backfill ? 1_000 : 0);
      }
    }
  }

  private sendChecked(key: string): void {
    const published = this.published.get(key);
    const subscription = this.subscriptions.get(key);
    if (this.closed || !subscription || !published?.valid || this.transcriptInFlight.has(key)
      || this.transcriptTimers.has(key) || this.transcriptTrailing.has(key)) return;
    this.options.send({ schema: RUNNER_SESSION_PROJECTION_SCHEMA, kind: "transcript_checked",
      epoch: this.epoch, sequence: this.nextSequence(), observed_at: new Date().toISOString(),
      source: subscription.source, session_id: subscription.sessionId, content_sequence: published.sequence });
  }

  private queueTranscript(key: string, delayMs: number): void {
    if (this.closed || !this.subscriptions.has(key)) return;
    const published = this.published.get(key);
    if (published) published.valid = false;
    if (this.transcriptInFlight.has(key)) {
      this.transcriptTrailing.add(key);
      return;
    }
    if (this.transcriptTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.transcriptTimers.delete(key);
      void this.refreshTranscript(key);
    }, delayMs);
    timer.unref?.();
    this.transcriptTimers.set(key, timer);
  }

  private async refreshTranscript(key: string): Promise<void> {
    const subscription = this.subscriptions.get(key);
    if (this.closed || !subscription || this.transcriptInFlight.has(key)) return;
    this.transcriptInFlight.add(key);
    let unchanged = false;
    try {
      const response = await this.options.dispatcher.handle({
        id: `projection-transcript-${this.sequence + 1}`,
        method: "read_session",
        args: {
          source: subscription.source,
          id: subscription.sessionId,
          rich: true,
          // This subscription already names one authorized native identity.
          // Use the same exact LaunchJournal lookup as the initial Host read;
          // ordinary discovery intentionally excludes the isolated split home.
          _octopus_include_session_plus: true,
          max_messages: subscription.maxMessages,
        },
      });
      if (!response.ok) throw new Error(response.error ?? "session transcript projection failed");
      if (this.closed || this.subscriptions.get(key) !== subscription) return;
      const projection = sessionTranscriptProjectionFromResult(
        response.result,
        subscription.source,
        subscription.sessionId,
        this.epoch,
        this.nextSequence(),
      );
      if (!projection) throw new Error("session transcript projection produced an invalid payload");
      const signature = createHash("sha256").update(JSON.stringify(projection.transcript)).digest("hex");
      const previous = this.published.get(key);
      if (previous?.signature === signature) {
        previous.valid = true;
        unchanged = true;
        // Send after clearing in-flight, below. A checked frame never advances
        // content revision or triggers a downstream render by itself.
      } else {
        this.published.set(key, { signature, sequence: projection.sequence, valid: true });
        this.options.send(projection);
      }
    } catch (error) {
      this.options.onError?.("transcript", asError(error));
    } finally {
      this.transcriptInFlight.delete(key);
      if (unchanged) this.sendChecked(key);
      if (this.transcriptTrailing.delete(key) && !this.closed && this.subscriptions.has(key)) {
        this.queueTranscript(key, MANAGED_TRANSCRIPT_COALESCE_MS);
      }
    }
  }

  private nextSequence(): number {
    if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new Error("session projection sequence exhausted");
    return ++this.sequence;
  }
}

function transcriptKey(source: SessionProjectionSource, sessionId: string): string {
  return `${source}\u0000${sessionId}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
