import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../store/store.js";
import { gitOrThrow } from "./worktree.js";
import { verifyLandingSpecifications } from "./knowledge-specifications.js";
import { checkSpecifications, parseSpecifications, type KnowledgeSpecification } from "../knowledge/specifications.js";
import { parseLandingKnowledge } from "./landing-knowledge.js";

vi.mock("./worktree.js", () => ({ gitOrThrow: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const source = "packages/example/src/window.ts";
const test = "packages/example/src/window.test.ts";
const spec = (patch: Partial<KnowledgeSpecification> = {}): KnowledgeSpecification => ({
  kind: "requirement", statement: "先按 tmux 优先级排序再截取会话窗口", strength: "agent_inferred",
  provenance: { author: { kind: "agent", name: "extractor", model: null, ref: "ticket:529" }, basis: ["ticket:529"], events: [] },
  realized_by: [source], verified_by: [test], ...patch,
});
const knowledge = (items = [spec()]) => ({ requirements: [spec().statement], decisions: [], specifications: items });

it("treats specifications as an optional record: none, partial or extra entries never refuse", () => {
  const files = new Set([source, test]);
  expect(checkSpecifications({}, files)).toEqual([]);
  expect(checkSpecifications({ specifications: [] }, files)).toEqual([]);
  expect(checkSpecifications(knowledge([spec()]), files)).toHaveLength(1);
  expect(checkSpecifications({ specifications: [spec(), spec({ kind: "decision", statement: "另一条只在规格里记录的设计" })] }, files)).toHaveLength(2);
  const docs = spec({ realized_by: [source], verified_by: [], verification_note: "本次只整理设计文档的文字说明，不改变任何可执行行为。" });
  expect(checkSpecifications(knowledge([docs]), files)).toHaveLength(1);
});

it("does not accept a human_required label, human author attribution or unrelated evidence as backing", () => {
  expect(() => parseSpecifications([spec({ strength: "human_required" })])).toThrow(/实际为 agent_inferred/);
  const plain = spec();
  expect(() => parseSpecifications([spec({ provenance: { ...plain.provenance, author: { ...plain.provenance.author, kind: "human" } } })])).toThrow(/人类归因/);
});

it("requires exact existing files and test files in a present specification", () => {
  const files = new Set([source, test, "doc/design.md"]);
  for (const realized_by of [["packages/example/src"], ["packages/../example.ts"], ["packages/missing.ts"]]) {
    expect(() => checkSpecifications(knowledge([spec({ realized_by })]), files)).toThrow();
  }
  expect(() => parseSpecifications([spec({ verified_by: [source] })])).toThrow(/测试文件/);
});

it("checks immutable original source identity and the exact candidate tree before landing", async () => {
  const store = new Store(":memory:");
  store.saveUser({ username: "alice", uid: 1, home_dir: "/x/alice", created_at: "2026-09-08" });
  const statement = spec().statement;
  const ticket = store.devTickets.createDevTicket({ title: "会话窗口", body: statement, requester: "alice", kind: "simple", app_id: null, model: "fixture", effort: "medium" });
  const event = { kind: "requirement" as const, actor: "alice", at: ticket.created_at, ref: `ticket:${ticket.id}`, source_kind: "original_prompt" as const, source_sha256: createHash("sha256").update(statement).digest("hex"), quote: statement, design: statement };
  const human = spec({ strength: "human_required", provenance: { ...spec().provenance, events: [event] } });
  const input = { repoDir: "/fixture", to: "candidate", changed: [source], knowledge: knowledge([human]), store };
  vi.mocked(gitOrThrow).mockResolvedValue([source, test].map((file) => `100644 blob ${"a".repeat(40)}\t${file}`).join("\n"));
  try {
    await expect(verifyLandingSpecifications(input)).resolves.toBeUndefined();
    event.source_sha256 = "f".repeat(64);
    await expect(verifyLandingSpecifications(input)).rejects.toThrow(/哈希/);
    event.source_sha256 = createHash("sha256").update(statement).digest("hex");
    input.knowledge = knowledge([spec()]);
    vi.mocked(gitOrThrow).mockResolvedValue(`120000 blob ${"a".repeat(40)}\t${source}\n100644 blob ${"a".repeat(40)}\t${test}`);
    await expect(verifyLandingSpecifications(input)).rejects.toThrow(/普通文件/);
  } finally { store.close(); }
});

it("carries structured specifications through the MCP knowledge parser without upgrading legacy summaries", () => {
  const payload = { summary: "会话排序", requirements: [spec().statement], decisions: ["保留现有会话窗口上限并调整进入窗口的顺序"], non_goals: [], risks: [], verification: ["窗口回归测试通过"], context_keys: [], supersedes: [] };
  expect(parseLandingKnowledge(payload).specifications).toBeUndefined();
  expect(parseLandingKnowledge({ ...payload, specifications: [spec()] }).specifications).toEqual([spec()]);
  expect(parseLandingKnowledge({ ...payload, specifications: [] }).specifications).toBeUndefined();
});

it("admits a new owner browser confirmation and refuses imports, other owners and forged confirmation bytes", async () => {
  const store = new Store(":memory:");
  store.saveUser({ username: "alice", uid: 1, home_dir: "/x/alice", created_at: "2026-09-17" });
  const statement = "会话窗口必须先排序再执行截取";
  const imported = store.knowledgeSources.import("alice", { provider: "codex", device: "device", session_id: "session", message_id: "message", source_at: "2026-09-01T00:00:00Z", role: "user", text: statement });
  const event = store.knowledgeSources.confirm("alice", imported.id, imported.source_sha256, "requirement", statement);
  const human = spec({ statement, strength: "human_required", provenance: { ...spec().provenance, events: [event] } });
  const input = { repoDir: "/fixture", to: "candidate", changed: [source], knowledge: { requirements: [statement], decisions: [], specifications: [human] }, store, owner: "alice" };
  vi.mocked(gitOrThrow).mockResolvedValue([source, test].map((file) => `100644 blob ${"a".repeat(40)}\t${file}`).join("\n"));
  try {
    await expect(verifyLandingSpecifications(input)).resolves.toBeUndefined();
    await expect(verifyLandingSpecifications({ ...input, owner: "bob" })).rejects.toThrow(/来源不可用/);
    event.ref = `knowledge-source:${imported.id}`;
    await expect(verifyLandingSpecifications(input)).rejects.toThrow(/来源不可用/);
    event.ref = store.knowledgeSources.confirmations("alice", imported.id)[0].ref;
    event.source_sha256 = "0".repeat(64);
    await expect(verifyLandingSpecifications(input)).rejects.toThrow(/哈希/);
  } finally { store.close(); }
});
