import { describe, expect, it } from "vitest";
import type { AppDataReply } from "../port.js";
import { createMemoryAppDataPort } from "./memory-port.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("memory app-data port", () => {
  it("keeps an asynchronous action observable as inflight until its answer arrives", async () => {
    const answer = deferred<AppDataReply>();
    const fixture = createMemoryAppDataPort({
      projection: {},
      actions: { save: () => answer.promise },
    });

    const submitted = fixture.port.submit("save", { value: "draft" });
    expect(fixture.port.snapshot().proposals).toEqual([
      expect.objectContaining({ action: "save", params: { value: "draft" }, phase: "inflight" }),
    ]);

    answer.resolve({ ok: false, code: "denied", message: "这份草稿不能保存。" });
    await expect(submitted).resolves.toMatchObject({ ok: false, code: "denied" });
    expect(fixture.port.snapshot().proposals).toEqual([
      expect.objectContaining({ action: "save", phase: "refused", message: "这份草稿不能保存。" }),
    ]);
  });
});
