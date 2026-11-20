import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAdapterWatcher, type AdapterSnapshot, type AdapterTransport, type AdapterWatcher } from "./adapter-watch.js";

class ProjectionTransport implements AdapterTransport {
  snapshot: AdapterSnapshot = { node: "node_adapter", version: 1, status: "registered" };
  values: number[] = [];
  readStatuses: string[] = [];
  attempts = 0;
  failure: Error | null = null;
  beforePublish?: () => void;
  async register() { return { node: this.snapshot.node, version: this.snapshot.version }; }
  async read() {
    this.readStatuses.push(this.snapshot.status);
    return { ...this.snapshot };
  }
  async publish(input: Parameters<AdapterTransport["publish"]>[0]) {
    this.attempts++;
    this.beforePublish?.();
    if (input.version !== this.snapshot.version) throw new Error("适配器版本已变化");
    if (this.snapshot.status === "paused" || this.snapshot.status === "removed") throw new Error("适配器不可发布");
    if (this.failure) throw this.failure;
    this.values.push(Number(input.data.rows[0].cells.value));
    this.snapshot.version++;
    this.snapshot.status = "live";
    return { node: this.snapshot.node, version: this.snapshot.version };
  }
  async control(input: Parameters<AdapterTransport["control"]>[0]) {
    if (input.version !== this.snapshot.version) throw new Error("适配器版本已变化");
    this.externalControl(input.state);
    return { node: this.snapshot.node, version: this.snapshot.version };
  }
  externalControl(status: AdapterSnapshot["status"]) {
    this.snapshot.status = status;
    this.snapshot.version++;
  }
}
const roots: string[] = [];
const watchers: AdapterWatcher[] = [];
afterEach(async () => {
  await Promise.all(watchers.splice(0).map((watcher) => watcher.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "adapter-watch-"));
  roots.push(root);
  const source = join(root, "metrics.json"), modulePath = join(root, "adapter.mjs");
  await writeFile(source, JSON.stringify({ latency: 4 }));
  await writeFile(modulePath, `export const register = ${JSON.stringify({ title: "指标", summary: "test", schema: { view: "metrics", columns: [{ key: "name", label: "名称" }, { key: "value", label: "值", kind: "number" }] } })}; export function project({ text }) { return Object.entries(JSON.parse(text)).map(([name, value]) => ({id:name,cells:{name,value}})); }`);
  const transport = new ProjectionTransport(), errors: Error[] = [];
  const watcher = await startAdapterWatcher({
    workspaceRoot: root, sourcePath: source, modulePath, transport,
    debounceMs: 10, pausedPollMs: 30, onError: (error) => { errors.push(error); },
  });
  watchers.push(watcher);
  return { root, source, transport, watcher, errors };
}
describe("adapter watcher SDK", () => {
  it("publishes initial content and resumes its own paused watcher with the current version", async () => {
    const { source, transport, watcher } = await fixture();
    expect(watcher.node).toBe("node_adapter");
    expect(transport.values).toEqual([4]);
    await watcher.pause();
    await writeFile(source, JSON.stringify({ latency: 8 }));
    await vi.waitFor(() => expect(transport.readStatuses).toContain("paused"));
    expect(transport.values).toEqual([4]);
    await watcher.resume();
    expect(transport.values.at(-1)).toBe(8);
    expect(transport.snapshot.status).toBe("live");
  });
  it("follows UI pause/resume without losing pending source changes or atomic file replacements", async () => {
    const { root, source, transport, watcher, errors } = await fixture();
    transport.externalControl("paused");
    await writeFile(source, JSON.stringify({ latency: 9 }));
    await vi.waitFor(() => expect(transport.readStatuses).toContain("paused"));
    expect(transport.values).toEqual([4]);
    // No further file event: the queued update must publish when the UI resumes.
    transport.externalControl("registered");
    await vi.waitFor(() => expect(transport.values.at(-1)).toBe(9));
    const replacement = join(root, "next.json");
    await writeFile(replacement, JSON.stringify({ latency: 12 }));
    await rename(replacement, source);
    await vi.waitFor(() => expect(transport.values.at(-1)).toBe(12));
    expect(watcher.error).toBeNull();
    expect(errors).toEqual([]);
  });
  it("rechecks a CAS race and obeys a UI pause instead of overriding it", async () => {
    const { source, transport, errors } = await fixture();
    transport.beforePublish = () => {
      transport.beforePublish = undefined;
      transport.externalControl("paused");
    };
    await writeFile(source, JSON.stringify({ latency: 15 }));
    await vi.waitFor(() => expect(transport.readStatuses).toContain("paused"));
    expect(transport.values).toEqual([4]);
    transport.externalControl("registered");
    await vi.waitFor(() => expect(transport.values.at(-1)).toBe(15));
    expect(errors).toEqual([]);
  });
  it("reports uncertain failures without retrying and closes permanently after external removal", async () => {
    const { source, transport, watcher, errors } = await fixture();
    const uncertain = new Error("publish acknowledgement unavailable");
    transport.failure = uncertain;
    await writeFile(source, JSON.stringify({ latency: 16 }));
    await vi.waitFor(() => expect(errors).toEqual([uncertain]));
    expect(watcher.error).toBe(uncertain);
    expect(transport.attempts).toBe(2); // Initial publish plus one failed attempt.
    transport.failure = null;
    await writeFile(source, JSON.stringify({ latency: 17 }));
    await vi.waitFor(() => expect(transport.values.at(-1)).toBe(17));
    expect(watcher.error).toBeNull();
    transport.externalControl("removed");
    await writeFile(source, JSON.stringify({ latency: 18 }));
    await vi.waitFor(() => expect(transport.readStatuses).toContain("removed"));
    await expect(watcher.resume()).rejects.toThrow("已关闭");
    expect(transport.values.at(-1)).toBe(17);
  });
});
