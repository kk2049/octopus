import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../store/store.js";
import { ResourceRecoveryService } from "../resources/recovery.js";
import { ManagedExecutionSupervisor } from "../managed-execution/supervisor.js";
import { AgentLoop } from "../app-agents/loop.js";
import { DiscussionService } from "./service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });

it("restores a secretary after a model outage without repeating a committed group message", async () => {
  const store = new Store(":memory:");
  cleanups.push(async () => store.close());
  for (const [index, username] of ["alice", "bob"].entries()) {
    store.saveUser({ username, uid: index + 1, home_dir: `/tmp/test/${username}`, created_at: "now" });
    store.saveIdentity(username, { provider: "feishu", externalId: `ou_${username}` });
  }
  const recovery = new ResourceRecoveryService(store.resourceWaiters);
  let supervisor = new ManagedExecutionSupervisor(store.managedExecutions, recovery);
  const send = vi.fn(async () => "message-one");
  const transport = { create: async () => "test-room", send, card: async () => "test-card", history: async () => ({ items: [] }) };
  let online = false, calls = 0;
  const loop = new AgentLoop({ baseUrl: "http://model.invalid/v1", apiKey: "test",
    fetchImpl: async () => {
      calls++;
      if (calls > 1 && !online) throw new TypeError("network disconnected");
      const message = calls === 1 ? { tool_calls: [{ id: "send-one", type: "function", function: {
        name: "send_to_group", arguments: JSON.stringify({ text: "one committed message" }),
      } }] } : { content: "complete" };
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
    } });
  const models = { enabled: true, filter: async () => ({ wake: false, reason: "quiet" }), run: loop.run.bind(loop) };
  let service = new DiscussionService(store, transport, models, { owners: ["alice"] }, supervisor);
  cleanups.push(async () => { await service.close(); await supervisor.close(); });
  const room = await service.start("alice", { request_id: "one", topic: "test", participants: "bob" });
  await vi.waitFor(() => expect(store.managedExecutions.active("alice", "discussion", room.id)?.observed).toBe("reconnecting"));
  expect(send).toHaveBeenCalledOnce();
  expect(service.read("alice", room.id).status).toBe("active");
  await service.close(); await supervisor.close();
  supervisor = new ManagedExecutionSupervisor(store.managedExecutions, recovery);
  service = new DiscussionService(store, transport, models, { owners: ["alice"] }, supervisor);
  service.restore();
  online = true;
  await Promise.all([recovery.recovered("model:discussion"), recovery.recovered("model:discussion")]);
  await vi.waitFor(() => expect(service.activeCount()).toBe(0));
  expect(send).toHaveBeenCalledOnce();
  expect(service.read("bob", room.id).events.filter(event => event.kind === "completed")).toHaveLength(1);
  expect(() => service.read("mallory", room.id)).toThrow();
});
