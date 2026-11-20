/** Real-model acceptance; every external message is captured in this marked lab. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
// Drivers may be developed outside an immutable release. All code under test
// is resolved from the exact candidate cwd, never from the driver's checkout.
const fromCandidate = (file: string) => import(pathToFileURL(path.join(process.cwd(), file)).href);
const { Store } = await fromCandidate("packages/bot/src/store/store.ts");
const { ResourceRecoveryService } = await fromCandidate("packages/bot/src/resources/recovery.ts");
const { ManagedExecutionSupervisor } = await fromCandidate("packages/bot/src/managed-execution/supervisor.ts");
const { DiscussionService } = await fromCandidate("packages/bot/src/discussions/service.ts");
const { DiscussionModelClient } = await fromCandidate("packages/bot/src/discussions/model.ts");

const root = path.resolve(process.argv[2] ?? "/lab");
assert(fs.existsSync(path.join(root, ".refactor-lab")), "marked lab required");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const config = JSON.parse(fs.readFileSync(path.join(root, "private/config.json"), "utf8"));
assert(new URL(config.openai.base_url).hostname === "127.0.0.1", "use the private lab model route");
const directory = path.join(root, "harness", `discussion-${sha}-${Date.now()}`);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const db = path.join(directory, "bot.db");
let store = new Store(db);
for (const [index, username] of ["lab_alice", "lab_bob"].entries()) {
  store.saveUser({ username, uid: index + 1, home_dir: `${directory}/${username}`, created_at: new Date().toISOString() });
  store.saveIdentity(username, { provider: "feishu", externalId: `ou_${username}` });
}
const sent: Array<{ room: string; id: string }> = [];
const captured: unknown[] = [];
const transport = {
  create: async () => "oc_lab_captured",
  send: async (room: string, text: string, id: string) => {
    sent.push({ room, id }); captured.push({ room, text, id });
    return `om_lab_${id}`;
  },
  card: async () => "om_lab_card", history: async () => ({ items: [] }),
};
let faultInjected = false, modelRequests = 0;
const models = new DiscussionModelClient({ baseUrl: config.openai.base_url, apiKey: config.openai.api_key,
  fetchImpl: async (...args) => {
    if (sent.length && !faultInjected) { faultInjected = true; throw new TypeError("lab model transport outage after committed send"); }
    modelRequests++;
    return fetch(...args);
  } });
let recovery = new ResourceRecoveryService(store.resourceWaiters);
let supervisor = new ManagedExecutionSupervisor(store.managedExecutions, recovery);
const options = { owners: ["lab_alice"], max_concurrent: 2 };
let service = new DiscussionService(store, transport, models, options, supervisor);
const startedAt = new Date().toISOString();
const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 180_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("real discussion acceptance timed out");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
};
try {
  const room = await service.start("lab_alice", { request_id: "real-discussion", participants: "lab_bob",
    topic: "隔离验收：二加三", agenda: "这是完全合成的会议，群消息会被测试捕获。请先 consult 一个专题顾问计算 2+3，顾问使用 gpt-5.6-sol / low；随后 remember 保存结果；最后只通过 send_to_group 发一次答案 5。已有成功的工具不要重复。无需向人提问。",
    settings: JSON.stringify({ secretary: { model: "gpt-5.6-sol", effort: "low", prompt: "执行合成议程，严格只公开发言一次。" } }) });
  await until(() => Boolean(store.managedExecutions.active("lab_alice", "discussion", room.id)?.dependency));
  assert.equal(sent.length, 1, "one committed send before outage");
  const original = store.managedExecutions.active("lab_alice", "discussion", room.id)!;
  await service.close(); await supervisor.close(); store.close();
  store = new Store(db); recovery = new ResourceRecoveryService(store.resourceWaiters);
  supervisor = new ManagedExecutionSupervisor(store.managedExecutions, recovery);
  service = new DiscussionService(store, transport, models, options, supervisor);
  service.restore();
  await Promise.all([recovery.recovered("model:discussion"), recovery.recovered("model:discussion")]);
  await until(() => service.activeCount() === 0);
  const detail = service.read("lab_alice", room.id);
  const final = store.managedExecutions.get("lab_alice", original.id)!;
  assert.equal(final.observed, "completed"); assert.equal(sent.length, 1);
  assert(detail.memory.includes("5"));
  assert(detail.events.some(event => event.agent.startsWith("consultant-") && event.kind === "completed"));
  assert.equal(service.list("outsider").length, 0);
  const receipt = { schema: "octopus-refactor-acceptance/v1", realAgent: true, consumerIds: ["discussion"], scenarios: ["head-restart"], scenario: "discussion-real-model-checkpoint",
    sha, driverSha256: createHash("sha256").update(fs.readFileSync(import.meta.filename)).digest("hex"), startedAt, finishedAt: new Date().toISOString(), executionId: original.id, roomId: room.id,
    modelRequests, capturedSends: sent.length, fault: "transport failure after committed send, service and DB reopened, duplicate recovery events",
    finalState: final.observed, passed: true };
  fs.writeFileSync(path.join(root, "artifacts", `discussion-${sha}.json`), JSON.stringify(receipt, null, 2));
  fs.writeFileSync(path.join(directory, "captured-messages.json"), JSON.stringify(captured), { mode: 0o600 });
  console.log(JSON.stringify(receipt));
} finally { await service.close(); await supervisor.close(); store.close(); }
