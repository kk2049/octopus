import { createHash } from "node:crypto";
import type { AppRuntimeClient, RuntimeEvent, RuntimeJson } from "@claude-bot/app-runtime";
import {
  canonicalJson,
  STATE_READ_PAGE_LIMIT,
  type StateClient,
  type StoredEvent,
} from "@claude-bot/app-state";
import { createLogger } from "../logger.js";

const log = createLogger("app-projection-cache");

export interface CanonicalProjection {
  projection: RuntimeJson;
  head: number;
  digest: string;
}

interface ProjectionInput {
  state: StateClient;
  runtime: AppRuntimeClient;
  streamId: string;
  backendCodeDigest: string;
  onCacheError?: (error: unknown) => void;
}

interface ViewerProjectionInput extends ProjectionInput {
  canonical: CanonicalProjection;
  context: Record<string, RuntimeJson>;
}

// Canonical work has no viewer context. Share only the exact State client,
// runtime, stream and projector; replacement clients get independent work.
const canonicalLoads = new WeakMap<StateClient, WeakMap<AppRuntimeClient, Map<string, Promise<CanonicalProjection>>>>();

/** Digest the exact projector and trusted viewer evidence that produced a cache entry. */
export function projectionCacheDigest(
  backendCodeDigest: string,
  context?: Readonly<Record<string, RuntimeJson>>,
): string {
  return createHash("sha256")
    .update(canonicalJson({
      format: "projection-cache/v1",
      backendCodeDigest,
      context: context ?? null,
    }))
    .digest("hex");
}

/**
 * Build the trusted, no-viewer checkpoint from one indexed snapshot plus
 * bounded tail pages. A cold stream pays one complete fold once; every later
 * open and dispatch starts at the snapshot revision.
 */
export async function loadCanonicalProjection(input: ProjectionInput): Promise<CanonicalProjection> {
  let runtimes = canonicalLoads.get(input.state);
  if (!runtimes) { runtimes = new WeakMap(); canonicalLoads.set(input.state, runtimes); }
  let pending = runtimes.get(input.runtime);
  if (!pending) { pending = new Map(); runtimes.set(input.runtime, pending); }
  const key = canonicalJson([input.streamId, input.backendCodeDigest]);
  const existing = pending.get(key);
  if (existing) return await existing;
  const loading = loadCanonicalPages(input);
  pending.set(key, loading);
  try { return await loading; }
  finally { if (pending.get(key) === loading) pending.delete(key); }
}

async function loadCanonicalPages(input: ProjectionInput): Promise<CanonicalProjection> {
  const digest = projectionCacheDigest(input.backendCodeDigest);
  const cached = await input.state.snapshot(input.streamId, digest);
  let projection = cached?.view as RuntimeJson | undefined;
  let cursor = cached?.revision ?? 0;

  for (;;) {
    const page = await input.state.readSince(input.streamId, cursor, STATE_READ_PAGE_LIMIT);
    if (projection === undefined) {
      projection = await input.runtime.project({
        backendCodeDigest: input.backendCodeDigest,
        events: page.events,
      });
    } else if (page.events.length > 0) {
      try {
        projection = await input.runtime.project({
          backendCodeDigest: input.backendCodeDigest,
          snapshot: projection,
          events: page.events,
        });
      } catch (error) {
        if (!isIncrementalUnsupported(error)) throw error;
        return await projectFullHistory(input, undefined, digest);
      }
    }
    cursor = page.cursor;
    if (!page.hasMore) {
      const result = { projection, head: page.head, digest };
      await persistSnapshot(input, result);
      return result;
    }
    if (page.events.length === 0) throw new Error("app-state returned an empty non-terminal history page");
    // This is an exact prefix, not the page's advertised stream head. A later
    // timeout/restart can resume here; directory reads still require revision
    // === head and therefore never present this unfinished prefix as current.
    await persistSnapshot(input, { projection, head: cursor, digest });
  }
}

/** Apply a just-committed tail directly to the pre-invoke checkpoint. */
export async function advanceCanonicalProjection(
  input: ProjectionInput & { canonical: CanonicalProjection; events: readonly RuntimeEvent[]; revision: number },
): Promise<CanonicalProjection> {
  // AppState may report an older dispatch as a successful duplicate even when
  // the stream has advanced since that dispatch. The pre-invoke checkpoint
  // already contains it; never fold the caller's proposed events twice or
  // replace a newer snapshot with the duplicate's older revision.
  if (input.revision <= input.canonical.head) return input.canonical;
  if (input.revision !== input.canonical.head + input.events.length) {
    throw new Error("committed projection tail does not join the pre-invoke checkpoint");
  }
  try {
    const projection = input.events.length === 0
      ? input.canonical.projection
      : await input.runtime.project({
          backendCodeDigest: input.backendCodeDigest,
          snapshot: input.canonical.projection,
          events: input.events,
        });
    const result = { projection, head: input.revision, digest: input.canonical.digest };
    await persistSnapshot(input, result);
    return result;
  } catch (error) {
    if (!isIncrementalUnsupported(error)) throw error;
    return await projectFullHistory(input, undefined, input.canonical.digest);
  }
}

/** Derive and cache one viewer-safe view from the canonical checkpoint. */
export async function renderViewerProjection(input: ViewerProjectionInput): Promise<RuntimeJson> {
  const digest = projectionCacheDigest(input.backendCodeDigest, input.context);
  const cached = await input.state.snapshot(input.streamId, digest);
  if (cached?.revision === input.canonical.head) return cached.view as RuntimeJson;

  let projection: RuntimeJson;
  try {
    projection = await input.runtime.project({
      backendCodeDigest: input.backendCodeDigest,
      snapshot: input.canonical.projection,
      events: [],
      context: input.context,
    });
  } catch (error) {
    if (!isIncrementalUnsupported(error)) throw error;
    projection = (await projectFullHistory(input, input.context, digest)).projection;
  }
  await persistSnapshot(input, { projection, head: input.canonical.head, digest });
  return projection;
}

/**
 * Directory reads are cache-only: an exact viewer snapshot is returned
 * directly; otherwise an exact canonical snapshot may be cheaply declassified.
 * No directory row starts a history replay.
 */
export async function readCachedViewerProjection(
  input: ProjectionInput & { head: number; context?: Record<string, RuntimeJson> },
): Promise<RuntimeJson | null> {
  const viewerDigest = projectionCacheDigest(input.backendCodeDigest, input.context);
  const viewer = await input.state.snapshot(input.streamId, viewerDigest);
  if (viewer?.revision === input.head) return viewer.view as RuntimeJson;

  const digest = projectionCacheDigest(input.backendCodeDigest);
  const cached = await input.state.snapshot(input.streamId, digest);
  if (cached?.revision !== input.head) return null;
  const context = input.context;
  if (context === undefined) return cached.view as RuntimeJson;
  return await renderViewerProjection({
    ...input,
    context,
    canonical: { projection: cached.view as RuntimeJson, head: cached.revision, digest },
  });
}

/** Read arbitrary consumers page-by-page without ever crossing the State RPC ceiling. */
export async function readAllStateEvents(
  state: StateClient,
  streamId: string,
  after: number,
): Promise<{ events: StoredEvent[]; head: number }> {
  const events: StoredEvent[] = [];
  let cursor = Math.max(0, after);
  for (;;) {
    const page = await state.readSince(streamId, cursor, STATE_READ_PAGE_LIMIT);
    events.push(...page.events);
    cursor = page.cursor;
    if (!page.hasMore) return { events, head: page.head };
    if (page.events.length === 0) throw new Error("app-state returned an empty non-terminal history page");
  }
}

/**
 * A release without `projectIncremental` can only fold the complete history in
 * one call; that is its own contract, not a transport limit. History is read in
 * bounded State pages and handed over once; child-rpc carries a request larger
 * than one frame as ordered parts, so the stream's length is not a cliff.
 */
async function projectFullHistory(
  input: ProjectionInput,
  context: Record<string, RuntimeJson> | undefined,
  digest: string,
): Promise<CanonicalProjection> {
  const history = await readAllStateEvents(input.state, input.streamId, 0);
  const projection = await input.runtime.project({
    backendCodeDigest: input.backendCodeDigest,
    events: history.events,
    ...(context === undefined ? {} : { context }),
  });
  const result = { projection, head: history.head, digest };
  await persistSnapshot(input, result);
  return result;
}

async function persistSnapshot(input: ProjectionInput, value: CanonicalProjection): Promise<void> {
  try {
    await input.state.putSnapshot(input.streamId, value.head, value.digest, value.projection);
  } catch (error) {
    // Snapshots are disposable acceleration. The immutable event chain and the
    // projection already computed for this request remain authoritative.
    if (input.onCacheError) input.onCacheError(error);
    else log.warn({ streamId: input.streamId, digest: value.digest, err: error }, "could not persist projection snapshot");
  }
}

function isIncrementalUnsupported(error: unknown): boolean {
  return (error as { code?: unknown })?.code === "incremental_projection_unsupported";
}
