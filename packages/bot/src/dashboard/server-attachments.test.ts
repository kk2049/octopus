/**
 * `POST /api/attachments` over real HTTP: a file larger than any one request
 * window arrives as chunks inside the panel's default body limit, and the
 * route no longer raises that limit for anyone.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ATTACHMENT_CHUNK_BYTES } from "@claude-bot/dashboard-web/contract";
import type { DevPipeline } from "../devpipe/pipeline.js";
import { Store } from "../store/store.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { type DashboardServer, mintDashboardToken } from "./server.js";

const NOW = "2026-10-20T10:00:00.000Z";

describe("dashboard chunked attachments", () => {
  let dir: string;
  let store: Store;
  let dash: DashboardServer;
  let base: string;
  let alice: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dash-attach-"));
    store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 1, home_dir: "/x/a", created_at: NOW });
    store.grantCapability("alice", "dev", "test", NOW);
    alice = mintDashboardToken(store, "alice");
    dash = createDashboardTestServer(store, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: "admin-secret",
      devPipeline: {} as unknown as DevPipeline,
      devScanHome: join(dir, "home"),
    });
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;
  });

  afterAll(async () => {
    await dash.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (body: unknown) => fetch(`${base}/api/attachments`, {
    method: "POST",
    headers: { authorization: `Bearer ${alice}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("assembles a 40 MiB non-image file from requests inside the default body window", async () => {
    const bytes = Buffer.alloc(40 * 1024 * 1024 + 5, 0x5a);
    bytes.write("%PDF-1.7\n<script>alert(1)</script>", 0);
    const chunkCount = Math.ceil(bytes.length / ATTACHMENT_CHUNK_BYTES);
    let uploadId = "";
    let done: { path: string; bytes: number; media_type: string; sha256: string; label: string } | undefined;
    for (let index = 0; index < chunkCount; index += 1) {
      const body = {
        chunk_index: index,
        chunk_count: chunkCount,
        ...(index === 0 ? { name: "report.pdf", media_type: "application/pdf", size: bytes.length } : { upload_id: uploadId }),
        data: bytes.subarray(index * ATTACHMENT_CHUNK_BYTES, (index + 1) * ATTACHMENT_CHUNK_BYTES).toString("base64"),
      };
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(1_000_000);
      const res = await post(body);
      expect(res.status).toBe(200);
      const answer = await res.json() as { complete: boolean; upload_id: string; attachment?: typeof done };
      uploadId = answer.upload_id;
      expect(answer.complete).toBe(index === chunkCount - 1);
      done = answer.attachment;
    }
    expect(done).toMatchObject({ label: "report.pdf", media_type: "application/pdf", bytes: bytes.length });
    expect(done!.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(readFileSync(done!.path).equals(bytes)).toBe(true);
    // Inert by construction: the panel has no route that serves a stored
    // attachment back to a browser (agents read it by path), so an HTML-ish
    // payload is never a document in this origin.
    const read = await fetch(`${base}/api/attachments?path=${encodeURIComponent(done!.path)}`, {
      headers: { authorization: `Bearer ${alice}` },
    });
    expect(read.status).not.toBe(200);
    expect(await read.text()).not.toContain("<script>");
  });

  it("keeps the default window: one request carrying a whole large file is refused at the transport", async () => {
    const res = await post({ name: "big.png", media_type: "image/png", data: Buffer.alloc(1_000_000).toString("base64") });
    expect(res.status).toBe(413);
  });

  it("answers an older page's single-shot upload in the shape it reads", async () => {
    const res = await post({ name: "shot.png", media_type: "image/png", data: Buffer.from("png-bytes").toString("base64") });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, attachment: { label: "shot.png", media_type: "image/png", bytes: 9 } });
  });

  it("maps a broken chunk sequence onto a bounded refusal", async () => {
    const res = await post({ upload_id: "z".repeat(24), chunk_index: 1, chunk_count: 2, data: "AAAA" });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: "expired" });
  });
});
