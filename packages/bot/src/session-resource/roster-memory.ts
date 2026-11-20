/** Bounded last-success memory for partial session-roster fan-out failures. */

import type { HubSessionSummary } from "../sessionhub/service.js";
import type { SessionResourcePlane } from "./bundle.js";

/** A missing device remains visible for this long after its last successful report. */
export const SESSION_ROSTER_STALE_TTL_MS = 10 * 60_000;

const MAX_REMEMBERED_INSTANCES = 256;
const MAX_REMEMBERED_DEVICES_PER_INSTANCE = 64;
const MAX_REMEMBERED_ROWS_PER_DEVICE = 500;

interface DeviceSnapshot {
  reportedAt: number;
  rows: HubSessionSummary[];
}

type PlaneSnapshots = Map<string, DeviceSnapshot>;
type InstanceSnapshots = Map<SessionResourcePlane, PlaneSnapshots>;

/**
 * One process-local cache, partitioned first by App instance and then by plane
 * and device. Successful reports replace a device wholesale; absence reuses
 * only the last successful rows until the named TTL. A caller-owned bundle
 * liveness predicate prunes instances, so this cache creates no second
 * lifecycle alongside AppAuthorityBundles.
 */
export class SessionRosterMemory {
  private readonly byInstance = new Map<string, InstanceSnapshots>();

  constructor(
    private readonly ttlMs = SESSION_ROSTER_STALE_TTL_MS,
    private readonly maxInstances = MAX_REMEMBERED_INSTANCES,
    private readonly maxDevicesPerInstance = MAX_REMEMBERED_DEVICES_PER_INSTANCE,
    private readonly maxRowsPerDevice = MAX_REMEMBERED_ROWS_PER_DEVICE,
  ) {}

  /** Replace every device that successfully answered and retain absent peers as stale. */
  reconcile(
    instanceId: string,
    plane: SessionResourcePlane,
    successfulDevices: readonly string[],
    currentRows: readonly HubSessionSummary[],
    now: number,
  ): HubSessionSummary[] {
    if (!instanceId) return [];
    const devices = uniqueDevices(successfulDevices);
    const successful = new Set(devices);
    const rowsByDevice = new Map<string, HubSessionSummary[]>();
    for (const row of currentRows) {
      if (!successful.has(row.deviceId)) continue;
      const rows = rowsByDevice.get(row.deviceId) ?? [];
      rows.push(fresh(row));
      rowsByDevice.set(row.deviceId, rows);
    }

    const snapshots = this.plane(instanceId, plane);
    for (const device of devices) {
      // Refreshing also makes this the newest device for the secondary bound.
      snapshots.delete(device);
      while (snapshots.size >= this.maxDevicesPerInstance) {
        const oldest = snapshots.keys().next();
        if (oldest.done) break;
        snapshots.delete(oldest.value);
      }
      snapshots.set(device, {
        reportedAt: now,
        rows: (rowsByDevice.get(device) ?? []).slice(0, this.maxRowsPerDevice),
      });
    }

    const current = devices.flatMap((device) => rowsByDevice.get(device) ?? []);
    return [...current, ...this.staleRows(snapshots, successful, now)];
  }

  /** A whole plane failed operationally; reuse only still-live snapshots. */
  stale(instanceId: string, plane: SessionResourcePlane, now: number): HubSessionSummary[] {
    const snapshots = this.byInstance.get(instanceId)?.get(plane);
    return snapshots ? this.staleRows(snapshots, new Set(), now) : [];
  }

  /** An authority refusal is not an operational absence and cannot use cached disclosure. */
  forgetPlane(instanceId: string, plane: SessionResourcePlane): void {
    const instance = this.byInstance.get(instanceId);
    if (!instance) return;
    instance.delete(plane);
    if (!instance.size) this.byInstance.delete(instanceId);
  }

  /** Drop closed instances and expired device snapshots. */
  prune(isLive: (instanceId: string) => boolean, now: number): void {
    for (const [instanceId, instance] of [...this.byInstance]) {
      if (!isLive(instanceId)) {
        this.byInstance.delete(instanceId);
        continue;
      }
      for (const [plane, snapshots] of [...instance]) {
        this.staleRows(snapshots, new Set(), now);
        if (!snapshots.size) instance.delete(plane);
      }
      if (!instance.size) this.byInstance.delete(instanceId);
    }
  }

  /** Diagnostics and tests. */
  size(instanceId?: string): number {
    if (instanceId === undefined) return this.byInstance.size;
    const instance = this.byInstance.get(instanceId);
    if (!instance) return 0;
    return [...instance.values()].reduce((total, devices) => total + devices.size, 0);
  }

  private plane(instanceId: string, plane: SessionResourcePlane): PlaneSnapshots {
    let instance = this.byInstance.get(instanceId);
    if (!instance) {
      while (this.byInstance.size >= this.maxInstances) {
        const oldest = this.byInstance.keys().next();
        if (oldest.done) break;
        this.byInstance.delete(oldest.value);
      }
      instance = new Map();
      this.byInstance.set(instanceId, instance);
    }
    let snapshots = instance.get(plane);
    if (!snapshots) {
      snapshots = new Map();
      instance.set(plane, snapshots);
    }
    return snapshots;
  }

  private staleRows(
    snapshots: PlaneSnapshots,
    currentDevices: ReadonlySet<string>,
    now: number,
  ): HubSessionSummary[] {
    const stale: HubSessionSummary[] = [];
    for (const [device, snapshot] of [...snapshots]) {
      if (currentDevices.has(device)) continue;
      if (now - snapshot.reportedAt > this.ttlMs) {
        snapshots.delete(device);
        continue;
      }
      stale.push(...snapshot.rows.map((row) => ({ ...row, stale: true })));
    }
    return stale;
  }
}

function fresh(row: HubSessionSummary): HubSessionSummary {
  const { stale: _stale, ...rest } = row;
  return rest;
}

function uniqueDevices(devices: readonly string[]): string[] {
  return [...new Set(devices.filter((device) => Boolean(device)))];
}
