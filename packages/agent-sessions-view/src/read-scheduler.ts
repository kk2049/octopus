/** Per-port session reads: independent resources progress within a bounded budget. */
import type { ReadWindowRequest, SessionsPort } from "@claude-bot/agent-sessions-contract";

const CONCURRENCY = 2;
const PAGE_SIZE = 200;

export interface SessionReadScheduler {
  read(resource: string | null, limit: number, offset?: number): void;
  ensure(resource: string | null): void;
  retain(resource: string | null): () => void;
  workspace(device: string, force: boolean): void;
  holds(resource: string): boolean;
  activate(): void;
  pause(): void;
  destroy(): void;
}

export function createSessionReadScheduler(
  port: SessionsPort,
  observer: { busy(resources: readonly string[]): void; read(resource: string): void },
): SessionReadScheduler {
  let active = true;
  let destroyed = false;
  const queued: ReadWindowRequest[] = [];
  const inflight = new Map<string, ReadWindowRequest>();
  const requested = new Set<string>();
  const retained = new Map<string, number>();
  const released = new Set<string>();
  const closing = new Set<string>();
  const workspaceQueue: string[] = [];
  const workspaceInflight = new Set<string>();
  const workspaceRequested = new Set<string>();
  const key = (row: ReadWindowRequest): string => JSON.stringify([row.resource, row.limit, row.offset ?? null]);
  const busy = (): void => {
    if (active) observer.busy([...new Set([...inflight.keys(), ...queued.map((row) => row.resource)])]);
  };
  const closeReleased = (resource: string): void => {
    if ((!released.has(resource) && active) || retained.has(resource) || inflight.has(resource) || closing.has(resource)) return;
    released.delete(resource);
    if (!port.closeSession) return;
    closing.add(resource);
    // Closing a view lease is not an interrupt and never replays a read.
    void Promise.resolve().then(() => port.closeSession!(resource)).catch(() => {}).finally(() => {
      closing.delete(resource);
      if (active) pump();
    });
  };
  const pump = (): void => {
    if (!active) return;
    while (inflight.size < CONCURRENCY) {
      const index = queued.findIndex((row) => !inflight.has(row.resource) && !closing.has(row.resource));
      if (index < 0) break;
      const [request] = queued.splice(index, 1);
      inflight.set(request.resource, request);
      busy();
      void (async () => active ? port.readWindow(request) : null)().then((reply) => {
        if (active && reply?.ok && !released.has(request.resource)) observer.read(request.resource);
      }).catch(() => {}).finally(() => {
        inflight.delete(request.resource);
        closeReleased(request.resource);
        if (active) { busy(); pump(); }
      });
    }
  };
  const read = (resource: string | null, limit: number, offset?: number): void => {
    if (!active || !resource) return;
    const request: ReadWindowRequest = {
      resource,
      limit: Math.max(1, Math.min(500, limit || PAGE_SIZE)),
      ...(offset === undefined ? {} : { offset: Math.max(0, offset) }),
    };
    const encoded = key(request);
    if (key(inflight.get(resource) ?? { resource: "", limit: 0 }) === encoded
      || queued.some((row) => key(row) === encoded)) return;
    requested.add(resource);
    queued.push(request);
    busy();
    pump();
  };
  const pumpWorkspaces = (): void => {
    if (!active) return;
    while (workspaceInflight.size < CONCURRENCY && workspaceQueue.length) {
      const device = workspaceQueue.shift()!;
      workspaceInflight.add(device);
      void (async () => active ? port.listWorkspaces(device) : null)().catch(() => {}).finally(() => {
        workspaceInflight.delete(device);
        if (active) pumpWorkspaces();
      });
    }
  };
  return {
    read,
    ensure(resource) {
      if (!active || !resource || requested.has(resource)) return;
      const transcript = port.snapshot().projection?.transcript?.[resource];
      if (transcript) return;
      read(resource, PAGE_SIZE);
    },
    retain(resource) {
      if (!active || !resource) return () => {};
      const previous = retained.get(resource) ?? 0;
      retained.set(resource, previous + 1);
      released.delete(resource);
      // Cached data is display state; every reopen restores the read/watch lease.
      if (previous === 0) read(resource, PAGE_SIZE);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const count = retained.get(resource) ?? 0;
        if (count > 1) { retained.set(resource, count - 1); return; }
        retained.delete(resource);
        requested.delete(resource);
        released.add(resource);
        for (let i = queued.length - 1; i >= 0; i--) if (queued[i].resource === resource) queued.splice(i, 1);
        busy();
        // A StrictMode remount in this turn keeps its existing lease.
        queueMicrotask(() => closeReleased(resource));
      };
    },
    workspace(device, force) {
      if (!active || !device || !force && workspaceRequested.has(device)
        || workspaceInflight.has(device) || workspaceQueue.includes(device)) return;
      workspaceRequested.add(device);
      workspaceQueue.push(device);
      pumpWorkspaces();
    },
    holds: (resource) => retained.has(resource),
    activate() { if (!destroyed) { active = true; busy(); pump(); pumpWorkspaces(); } },
    pause() { active = false; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      active = false;
      queued.length = 0;
      workspaceQueue.length = 0;
      for (const resource of new Set([...retained.keys(), ...inflight.keys()])) {
        retained.delete(resource);
        released.add(resource);
        closeReleased(resource);
      }
    },
  };
}
