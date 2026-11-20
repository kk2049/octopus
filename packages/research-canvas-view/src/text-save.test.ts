import { describe, expect, it } from "vitest";
import type { Call } from "./client.js";
import { saveText, TEXT_SAVE_WINDOW_BYTES } from "./text-save.js";

/** A host that stages like the research plane: begin → append × N → commit. */
function host() {
  const calls: Array<Record<string, unknown> & { action: string }> = [];
  let staged = "", body = "旧";
  const call = (async (action: string, params: Record<string, unknown> = {}) => {
    calls.push({ action, ...params });
    if (params.stage === undefined) { body = String(params.text); return { status: "saved", revision: "whole" }; }
    if (params.stage === "begin") { staged = ""; return { status: "staged", upload: "a".repeat(32), size: 0, digest: "sha256:base" }; }
    if (params.stage === "append") {
      expect(Number(params.offset)).toBe(new TextEncoder().encode(staged).length);
      staged += String(params.text);
      return { status: "staged", upload: params.upload, size: new TextEncoder().encode(staged).length };
    }
    expect(Number(params.size)).toBe(new TextEncoder().encode(staged).length);
    body = staged;
    return { status: "saved", revision: "staged" };
  }) as Call;
  return { call, calls, body: () => body };
}

describe("saving a text of any size", () => {
  it("sends a text that fits one call exactly as before: one call, no stage", async () => {
    const { call, calls, body } = host();
    await saveText(call, "file_write", { request: "r1", node: "n" }, "短文本");
    expect(calls).toEqual([{ action: "file_write", request: "r1", node: "n", text: "短文本" }]);
    expect(body()).toBe("短文本");
  });

  it("stages a text past one call's window: every call within the window, commit names the base", async () => {
    const { call, calls, body } = host();
    const text = "多字节正文😀\n".repeat(120_000);
    expect(await saveText(call, "file_write", { request: "r2", node: "n" }, text)).toMatchObject({ revision: "staged" });
    expect(body()).toBe(text);
    expect(calls[0]).toMatchObject({ stage: "begin", request: "r2" });
    expect(calls.at(-1)).toMatchObject({ stage: "commit", request: "r2", upload: "a".repeat(32), expected: "sha256:base",
      size: String(new TextEncoder().encode(text).length) });
    const appends = calls.filter((c) => c.stage === "append");
    expect(appends.length).toBeGreaterThan(5);
    for (const a of appends) {
      expect(new TextEncoder().encode(String(a.text)).length).toBeLessThanOrEqual(TEXT_SAVE_WINDOW_BYTES);
      expect(String(a.text).length).toBeLessThanOrEqual(196_608);
    }
    // A caller's own base wins over the version begin reports.
    await saveText(call, "document_write", { request: "r3", node: "n", expected: "rev-mine" }, text);
    expect(calls.at(-1)).toMatchObject({ stage: "commit", expected: "rev-mine" });
  });

  it("stops before commit when an append is not acknowledged in full", async () => {
    const calls: string[] = [];
    const call = (async (_action: string, params: Record<string, unknown> = {}) => {
      calls.push(String(params.stage));
      return params.stage === "begin" ? { upload: "b".repeat(32), size: 0 } : { size: 1 };
    }) as Call;
    await expect(saveText(call, "document_write", { request: "r", node: "n" }, "x".repeat(400_000))).rejects.toThrow("没有被改动");
    expect(calls).toEqual(["begin", "append"]);
  });
});
