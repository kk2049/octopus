import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import { AttachmentUploads, storeAttachment } from "./store.js";
import { transferTicketAttachments } from "./runner-transfer.js";

const homes: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true }))); });
async function fixture(owner?: string, size = 8) {
  const home = await fs.mkdtemp(path.join(tmpdir(), "attachment-transfer-"));
  homes.push(home);
  const bytes = Buffer.alloc(size, 7);
  const result = await storeAttachment(home, { owner, name: "screen.png", mediaType: "image/png", data: bytes.toString("base64") });
  if (!result.ok) throw new Error(result.message);
  const body = `截图附件：\`${result.attachment.path}\``;
  return { home, bytes, body, file: result.attachment.path };
}

it("transfers bounded chunks and rewrites only persisted store references to the execution receipt path", async () => {
  const f = await fixture("alice", MACHINE_LIMITS.sessionAttachmentChunkBytes + 3);
  const chunks: Buffer[] = [];
  const upload = vi.fn(async (args: Record<string, unknown>) => {
    expect(args).not.toHaveProperty("path");
    expect(args.id).toBe("original-native-session");
    chunks.push(Buffer.from(String(args.data), "base64"));
    return { upload_id: "a".repeat(24), complete: args.chunk_index === 1,
      ...(args.chunk_index === 1 ? { attachment: { path: "/execution/workspace/.octopus-attachment-test/screen.png", bytes: f.bytes.length } } : {}) };
  });
  const prompt = await transferTicketAttachments({ home: f.home, owner: "alice", prompt: `${f.body}\n${f.body}`,
    persistedBodies: [f.body], sessionId: "original-native-session", upload });
  expect(upload).toHaveBeenCalledTimes(2);
  expect(upload.mock.calls[1]![0]).toMatchObject({ upload_id: "a".repeat(24), chunk_index: 1, chunk_count: 2 });
  expect(Buffer.concat(chunks)).toEqual(f.bytes);
  expect(prompt).not.toContain(f.file);
  expect(prompt.match(/\/execution\/workspace/g)).toHaveLength(2);
  expect(await fs.readFile(f.file)).toEqual(f.bytes);
});

it("allows an old 8-hex attachment only when the exact reference is in this ticket's persisted user messages", async () => {
  const f = await fixture();
  const upload = vi.fn(async () => ({ upload_id: "b".repeat(24), complete: true,
    attachment: { path: "/execution/workspace/legacy.png", bytes: f.bytes.length } }));
  const input = { home: f.home, owner: "alice", prompt: f.body, sessionId: "ticket-578", upload };
  await expect(transferTicketAttachments({ ...input, persistedBodies: [] })).rejects.toThrow("本工单已保存");
  expect(upload).not.toHaveBeenCalled();
  expect(await transferTicketAttachments({ ...input, persistedBodies: [f.body] })).toContain("/execution/workspace/legacy.png");
});

it("rejects other owners and missing new-format metadata instead of falling back to legacy", async () => {
  const f = await fixture("bob");
  const upload = vi.fn();
  const input = { home: f.home, owner: "alice", prompt: f.body, persistedBodies: [f.body], sessionId: "ticket-1", upload };
  await expect(transferTicketAttachments(input)).rejects.toThrow("不属于工单主人");
  await fs.rm(`${f.file}.owner.json`);
  await expect(transferTicketAttachments(input)).rejects.toThrow();
  expect(upload).not.toHaveBeenCalled();
});

it("does not read arbitrary service paths or follow a substituted store symlink", async () => {
  const f = await fixture();
  const secret = path.join(f.home, "private.txt");
  await fs.writeFile(secret, "unrelated");
  const upload = vi.fn();
  const text = `说明路径 \`${secret}\``;
  expect(await transferTicketAttachments({ home: f.home, owner: "alice", prompt: text, persistedBodies: [text], sessionId: "s1", upload })).toBe(text);
  await fs.rm(f.file);
  await fs.symlink(secret, f.file);
  await expect(transferTicketAttachments({ home: f.home, owner: "alice", prompt: f.body, persistedBodies: [f.body], sessionId: "s1", upload })).rejects.toThrow("路径已变化");
  expect(upload).not.toHaveBeenCalled();
});

it("fails without a completed remote receipt and never retries the upload", async () => {
  const f = await fixture("alice");
  const upload = vi.fn(async () => ({ upload_id: "c".repeat(24), complete: false }));
  await expect(transferTicketAttachments({ home: f.home, owner: "alice", prompt: f.body, persistedBodies: [f.body], sessionId: "s1", upload })).rejects.toThrow("没有确认完整附件");
  expect(upload).toHaveBeenCalledOnce();
});

it("does not report a new upload successful if the owner sidecar cannot be created", async () => {
  const f = await fixture();
  const original = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith(".owner.json")) throw new Error("sidecar refused");
    return await original(...args);
  });
  const answer = await storeAttachment(f.home, { owner: "alice", mediaType: "image/png", data: "aGVsbG8=" });
  expect(answer).toMatchObject({ ok: false, code: "write_failed" });
  expect(await fs.readFile(f.file)).toEqual(f.bytes);
});

it("copies non-image attachments of any size and count, one bounded chunk in memory at a time", async () => {
  const home = await fs.mkdtemp(path.join(tmpdir(), "attachment-transfer-"));
  homes.push(home);
  const uploads = new AttachmentUploads(home);
  const chunk = MACHINE_LIMITS.sessionAttachmentChunkBytes;
  const big = Buffer.alloc(chunk * 3 + 17, 3);
  const files: Array<{ path: string; bytes: Buffer }> = [];
  for (let index = 0; index < 20; index += 1) {
    const bytes = index === 0 ? big : Buffer.from(`log line ${index}\n`);
    const stored = await uploads.accept({ owner: "alice", name: `run-${index}.log`, mediaType: "text/plain", data: bytes.toString("base64") });
    if (!stored.ok || !stored.complete) throw new Error("upload failed");
    files.push({ path: stored.attachment.path, bytes });
  }
  const body = files.map((file) => `- \`${file.path}\``).join("\n");
  const received = new Map<string, Buffer[]>();
  let sequence = 0;
  const upload = vi.fn(async (args: Record<string, unknown>) => {
    expect(args.media_type).toBe("text/plain");
    expect(Buffer.from(String(args.data), "base64").length).toBeLessThanOrEqual(chunk);
    const id = typeof args.upload_id === "string" ? args.upload_id : String(sequence++).padStart(24, "u");
    const parts = received.get(id) ?? [];
    parts.push(Buffer.from(String(args.data), "base64"));
    received.set(id, parts);
    const complete = args.chunk_index === Number(args.chunk_count) - 1;
    return { upload_id: id, complete, ...(complete ? { attachment: { path: `/remote/${String(args.name)}`, bytes: Buffer.concat(parts).length } } : {}) };
  });
  const prompt = await transferTicketAttachments({ home, owner: "alice", prompt: body, persistedBodies: [body], sessionId: "s1", upload });
  expect(received.size).toBe(20);
  expect(Buffer.concat(received.get("0".padStart(24, "u"))!)).toEqual(big);
  expect(upload).toHaveBeenCalledTimes(4 + 19);
  for (const file of files) expect(prompt).not.toContain(file.path);
  expect(prompt.match(/\/remote\//g)).toHaveLength(20);
});

it("never treats a legacy 8-hex name as anything but one of the historical image types", async () => {
  const f = await fixture();
  const forged = f.file.replace(/\.png$/, ".html");
  await fs.rename(f.file, forged);
  const body = `\`${forged}\``;
  const upload = vi.fn();
  await expect(transferTicketAttachments({ home: f.home, owner: "alice", prompt: body, persistedBodies: [body], sessionId: "s1", upload }))
    .rejects.toThrow("本工单已保存");
  expect(upload).not.toHaveBeenCalled();
});
