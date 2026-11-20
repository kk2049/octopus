import { describe, expect, it, vi } from "vitest";
import { ProviderSessionRefs, type ProviderSessionRename } from "./provider-session-ref.js";

describe("ProviderSessionRefs", () => {
  it("enumerates only current attachments through detach, rename and clear", async () => {
    const sessions = new ProviderSessionRefs<string>();
    for (let n = 0; n < 1_000; n++) sessions.reference("codex", `cold-${n}`);
    const live = sessions.reference("codex", "live"); sessions.attach(live, "controller");
    await sessions.rename("codex", "live", "renamed");
    expect(sessions.values()).toEqual(["controller"]);
    expect(sessions.detach(live, "different")).toBe(false);
    expect(sessions.values()).toEqual(["controller"]);
    expect(sessions.detach(live, "controller")).toBe(true);
    expect(sessions.values()).toEqual([]);
    sessions.attach(live, "replacement"); sessions.clearAttachments();
    expect(sessions.values()).toEqual([]); expect(sessions.attachment(live)).toBeUndefined();
  });
  it("moves one attachment across both aliases before rename participants run", async () => {
    const observations: Array<{ oldAttachment?: string; newAttachment?: string; current: string }> = [];
    let sessions!: ProviderSessionRefs<string>;
    const onRename = vi.fn(async ({ provider, from, to, ref }: ProviderSessionRename) => {
      observations.push({
        oldAttachment: sessions.attachment(provider, from),
        newAttachment: sessions.attachment(provider, to),
        current: ref.currentProviderId,
      });
    });
    sessions = new ProviderSessionRefs({ onRename });
    const ref = sessions.reference("codex", "thread-child", "/srv/codex/thread-child.jsonl");
    sessions.attach(ref, "attachment");

    await expect(sessions.rename("codex", "thread-child", "thread-fork")).resolves.toBe(ref);

    expect(sessions.resolve("codex", "thread-child")).toBe(ref);
    expect(sessions.resolve("codex", "thread-fork")).toBe(ref);
    expect(sessions.attachment("codex", "thread-child")).toBe("attachment");
    expect(sessions.attachment("codex", "thread-fork")).toBe("attachment");
    expect(sessions.snapshot(ref)).toEqual({
      logicalId: "thread-child",
      currentProviderId: "thread-fork",
      rolloutPath: "/srv/codex/thread-child.jsonl",
      lineage: ["thread-child", "thread-fork"],
    });
    expect(observations).toEqual([{
      oldAttachment: "attachment",
      newAttachment: "attachment",
      current: "thread-fork",
    }]);
    await expect(sessions.rename("codex", "thread-child", "thread-stale-fork"))
      .rejects.toThrow(/no longer current/);
    expect(onRename).toHaveBeenCalledOnce();
  });

  it("restores every lineage alias to one stable ref", () => {
    const sessions = new ProviderSessionRefs({
      restored: [{
        provider: "codex",
        logicalId: "thread-child",
        currentProviderId: "thread-fork-2",
        rolloutPath: "/srv/codex/thread-child.jsonl",
        lineage: ["thread-child", "thread-fork-1", "thread-fork-2"],
      }],
    });

    const original = sessions.resolve("codex", "thread-child");
    expect(original).toBeDefined();
    expect(sessions.resolve("codex", "thread-fork-1")).toBe(original);
    expect(sessions.resolve("codex", "thread-fork-2")).toBe(original);
    expect(original).toMatchObject({
      logicalId: "thread-child",
      currentProviderId: "thread-fork-2",
    });
  });
});
