import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunnerCapabilityManager, type CapabilityConnection } from "./capability-manager.js";
import { writeCapabilityRegistration, readPrivateRegistration, capabilityRegistryDirectory, removeCapabilityRegistration,
  type CapabilityRegistration } from "./capability-registry.js";
import { CAPABILITY_LIMITS, publicCapabilityAdvertisement } from "./capability-protocol.js";
import { handleRpc } from "./core.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const descriptor = { name: "echo", description: "Echo", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } };
const output = { content: [{ type: "text", text: "ok" }], structuredContent: { value: "ok" } };
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "runner-capabilities-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const config: CapabilityRegistration = { schema: "runner-capability-registration/v1", id: "demo", title: "Demo",
    version: "1", command: process.execPath, args: [], env: { SECRET: "never-public" }, enabled: true };
  let digest = await writeCapabilityRegistration(home, config, "absent");
  const connections: Array<CapabilityConnection & { call: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; notify(): void; disconnect(): void }> = [];
  const connect = vi.fn(async () => {
    let changed = () => {}, lost = () => {};
    const connection = { tools: async () => [descriptor], call: vi.fn(async () => output), close: vi.fn(async () => {}),
      changed: (listener: () => void) => { changed = listener; }, lost: (listener: () => void) => { lost = listener; },
      notify: () => changed(), disconnect: () => lost() };
    connections.push(connection); return connection;
  });
  const manager = new RunnerCapabilityManager(home, { connect });
  cleanup.push(() => manager.close());
  await manager.refresh();
  const call = (id = "req-1") => ({ provider: "demo", revision: manager.advertisement().providers[0]!.revision,
    tool: "echo", request_id: id, input_json: '{"value":"ok"}' });
  const update = async (value: Partial<CapabilityRegistration> = {}) => {
    digest = await writeCapabilityRegistration(home, { ...config, ...value }, digest); await manager.refresh();
  };
  return { home, config, manager, call, connect, connections, update, digest: () => digest };
}
describe("resident capability registry", () => {
  it("reports disabled machine operations without launching a configured provider", async () => {
    const f = await fixture();
    const manager = new RunnerCapabilityManager(f.home, { enabled: false, connect: f.connect });
    cleanup.push(() => manager.close());
    await manager.refresh();
    expect(manager.advertisement().providers[0]).toMatchObject({ status: "disabled", reason: "machine_ops_disabled", tools: [] });
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(await manager.call(f.call())).toMatchObject({ status: "refused" });
  });
  it("treats invalid output as unknown and keeps its receipt instead of replaying", async () => {
    const f = await fixture();
    f.connections[0]!.call.mockResolvedValueOnce({ content: [], structuredContent: { value: 42 } });
    const args = f.call();
    expect(await f.manager.call(args)).toMatchObject({ status: "indeterminate", reason: "result_unavailable" });
    expect(await f.manager.call(args)).toMatchObject({ status: "indeterminate" });
    expect(f.connections[0]!.call).toHaveBeenCalledTimes(1);
  });

  it("publishes bounded schemas, validates nested input, deduplicates calls and protects private config", async () => {
    const f = await fixture();
    expect(publicCapabilityAdvertisement(f.manager.advertisement())).toEqual(f.manager.advertisement());
    expect(JSON.stringify(f.manager.advertisement())).not.toMatch(/never-public|command|SECRET/);
    expect(await f.manager.call({ ...f.call(), input_json: '{"extra":1}' })).toMatchObject({ status: "refused", reason: "invalid_input" });
    expect(await f.manager.call(f.call())).toMatchObject({ status: "succeeded", result: output });
    expect(await f.manager.call(f.call())).toMatchObject({ status: "succeeded" });
    expect(f.connections[0]!.call).toHaveBeenCalledTimes(1);
    expect(await f.manager.call({ ...f.call(), input_json: '{"value":"different"}' })).toMatchObject({ status: "refused", reason: "request_conflict" });
    // Different locally authenticated sites never share receipts.
    expect(await f.manager.call(f.call(), "other-site-token")).toMatchObject({ status: "succeeded" });
    expect(f.connections[0]!.call).toHaveBeenCalledTimes(2);
  });
  it("updates while a call drains, rejects old revisions and disables without restarting the resident", async () => {
    const f = await fixture(), old = f.call();
    let finish!: (value: typeof output) => void;
    f.connections[0]!.call.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.manager.call(old);
    await f.update({ version: "2" });
    expect(f.connections[0]!.close).not.toHaveBeenCalled();
    expect(await f.manager.call({ ...old, request_id: "other" })).toMatchObject({ status: "refused", reason: "stale_revision" });
    expect(await f.manager.call(f.call("new"))).toMatchObject({ status: "succeeded" });
    finish(output); expect(await pending).toMatchObject({ status: "succeeded", revision: old.revision });
    expect(f.connections[0]!.close).toHaveBeenCalledTimes(1);
    await f.update({ enabled: false });
    expect(f.manager.advertisement().providers[0]).toMatchObject({ status: "disabled", tools: [] });
    expect(await f.manager.call(f.call("disabled"))).toMatchObject({ status: "refused" });
    expect(f.connect).toHaveBeenCalledTimes(2);
  });
  it("rotates references after tool changes and never replays uncertain execution", async () => {
    const f = await fixture(), old = f.call();
    f.connections[0]!.notify();
    await vi.waitFor(() => expect(f.manager.advertisement().providers[0]!.status).toBe("ready"));
    expect(await f.manager.call(old)).toMatchObject({ reason: "stale_revision" });
    f.connections[0]!.call.mockRejectedValueOnce(new Error("secret stderr"));
    const args = f.call("lost");
    expect(await f.manager.call(args)).toMatchObject({ status: "indeterminate", reason: "provider_lost" });
    expect(await f.manager.call(args)).toMatchObject({ status: "indeterminate" });
    expect(f.connections[0]!.call).toHaveBeenCalledTimes(1);
    f.connections[0]!.disconnect();
    expect(f.manager.advertisement().providers[0]).toMatchObject({ status: "error", tools: [] });
  });
  it("rejects public manifests, lost CAS and malformed configuration without preserving callable authority", async () => {
    const f = await fixture();
    await expect(writeCapabilityRegistration(f.home, f.config, "absent")).rejects.toThrow("changed");
    const file = path.join(capabilityRegistryDirectory(f.home), "demo.json");
    await chmod(file, 0o644);
    await expect(readPrivateRegistration(file)).rejects.toThrow("private");
    await f.manager.refresh();
    expect(f.manager.advertisement().providers[0]).toMatchObject({ status: "error", reason: "invalid_config", tools: [] });
    await chmod(file, 0o600);
    await f.manager.refresh();
    expect(f.manager.advertisement().providers[0]!.status).toBe("ready");
    await removeCapabilityRegistration(f.home, "demo", f.digest());
    await f.manager.refresh();
    expect(f.manager.advertisement().providers).toEqual([]);
  });
  it("bounds completed receipts by invalidating old identities before evicting results", async () => {
    const f = await fixture(), original = f.call();
    for (let i = 0; i < CAPABILITY_LIMITS.receipts; i++) expect(await f.manager.call(f.call("r" + i))).toMatchObject({ status: "succeeded" });
    expect(await f.manager.call(f.call("rotate"))).toMatchObject({ reason: "stale_revision" });
    expect(await f.manager.call({ ...original, request_id: "r0" })).toMatchObject({ reason: "stale_revision" });
    expect(await f.manager.call(f.call("fresh"))).toMatchObject({ status: "succeeded" });
  });
  it("does not expose the generic RPC without both machine authority and the site-bound manager", async () => {
    const f = await fixture(), req = { id: "r", method: "invoke_runner_capability", args: f.call() };
    expect(await handleRpc(f.home, req, { allowMachineOps: false, capabilities: f.manager })).toMatchObject({ ok: false });
    expect(await handleRpc(f.home, req, { allowMachineOps: true })).toMatchObject({ ok: false });
    expect(f.connections[0]!.call).not.toHaveBeenCalled();
    expect(await handleRpc(f.home, req, { allowMachineOps: true, capabilities: f.manager, executionOnly: true })).toMatchObject({ ok: true, result: { status: "succeeded" } });
  });
  it("connects an ordinary stdio MCP program and changes its registration in the same daemon", async () => {
    const f = await fixture();
    await f.manager.close();
    const program = path.join(f.home, "provider.mjs");
    await writeFile(program, `import readline from "node:readline";
const schema = {type:"object",properties:{value:{type:"string"}},required:["value"]};
readline.createInterface({input:process.stdin}).on("line",line=>{
 const r=JSON.parse(line); if(r.id===undefined)return;
 const result=r.method==="initialize"?{protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"test",version:"1"}}:
 r.method==="tools/list"?{tools:[{name:"echo",inputSchema:schema}]}:
 {content:[{type:"text",text:r.params.arguments.value}],structuredContent:r.params.arguments};
 process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result})+"\\n");
});`);
    await writeCapabilityRegistration(f.home, { ...f.config, args: [program] }, f.digest());
    const manager = new RunnerCapabilityManager(f.home);
    cleanup.push(() => manager.close());
    await manager.refresh();
    expect(manager.advertisement().providers[0]!.status).toBe("ready");
    expect(await manager.call({ ...f.call("real"), revision: manager.advertisement().providers[0]!.revision })).toMatchObject({
      status: "succeeded", result: { structuredContent: { value: "ok" } },
    });
  });
});
