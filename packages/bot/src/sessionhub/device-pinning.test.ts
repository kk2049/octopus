import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { RunnerCapabilities } from "../runner/capability.js";
import type { RunnerTransport } from "../runner/gateway.js";
import { PermissionService } from "../permissions/service.js";
import { SessionHubService } from "./service.js";

const NOW = Date.parse("2026-10-20T08:00:00.000Z");
const principal = { username: "alice", admin: false, session: true, credential: "ws:test" };
let dir: string;
let store: Store;
let hub: SessionHubService;
/** Every Runner call that left the process, with the arguments the gateway would route on. */
let frames: Array<{ method: string; args: Record<string, unknown> }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-device-"));
  store = new Store(join(dir, "t.db"));
  store.saveUser({ username: "alice", uid: 6001, home_dir: "/x/a", created_at: new Date(NOW).toISOString() });
  frames = [];
  const transport = {
    dispatch: async (_owner: string, method: string, args: Record<string, unknown>) => {
      frames.push({ method, args });
      return method === "read_session" ? { meta: { id: "s1" }, messages: [] } : { sessions: [], devices: ["observer"] };
    },
    listDevices: () => ["laptop", "observer"].map((device) => ({ device, online: true, created_at: "", last_seen_at: "" })),
    isOnline: () => true,
    ping: async () => 1,
    disconnect: () => true,
  } as unknown as RunnerTransport;
  const caps = new RunnerCapabilities(store, transport);
  caps.mintDeviceToken("alice", "laptop");
  caps.mintDeviceToken("alice", "observer");
  hub = new SessionHubService({ store, permissions: new PermissionService({ store, caps, now: () => NOW }), caps, now: () => NOW });
});

afterEach(() => {
  store.close?.();
  rmSync(dir, { recursive: true, force: true });
});

it("reads a session from the device its handle names, not from each device in turn", async () => {
  expect((await hub.read(principal, "alice", "observer", { id: "s1", rich: true })).ok).toBe(true);
  expect(frames).toEqual([{ method: "read_session", args: expect.objectContaining({ id: "s1", device: "observer" }) }]);
});

it("lists one named device, or all of them", async () => {
  await hub.roster(principal, "alice", { limit: 10, source: "all", device: "observer" });
  expect(frames).toEqual([{ method: "list_recent_sessions", args: expect.objectContaining({ device: "observer" }) }]);
  frames.length = 0;
  await hub.roster(principal, "alice", { limit: 10, source: "all" });
  expect(frames).toHaveLength(1);
  expect(frames[0]!.args).not.toHaveProperty("device");
});
