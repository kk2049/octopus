import { describe, expect, it } from "vitest";
import type { PermissionService } from "../permissions/service.js";
import { resourceId } from "../sessionhub/core.js";
import type { AppAuthorityBundles } from "./bundle.js";
import { KEPT_LOOKUP_TTL_MS, keptIdentities } from "./kept-sessions.js";
import { SessionResourceService } from "./service.js";

const mint = (device: string, cliKind: string, sessionId: string, owner = "alice") =>
  resourceId({ owner, device, cliKind, sessionId });

describe("keptIdentities", () => {
  it("orders favorites before folder members and only decodes this owner's device resources", () => {
    const pinned = mint("laptop", "codex", "wechat");
    const filed = mint("desk", "claude", "acc-e0");
    const projection = {
      pinned: [pinned, mint("laptop", "codex", "x", "bob"), mint("bot-host", "omp", "local"), "not-a-resource"],
      sessionFolders: [{ id: "f", name: "F", sessions: [filed, pinned] }],
    };
    expect(keptIdentities(projection, "alice")).toEqual([
      { resourceId: pinned, device: "laptop", source: "codex", id: "wechat" },
      { resourceId: filed, device: "desk", source: "claude", id: "acc-e0" },
    ]);
    expect(keptIdentities(null, "alice")).toEqual([]);
  });
});

describe("kept chats outside the recency window", () => {
  function harness(options: { ids?: "honoured" | "ignored" | "fails"; approval?: boolean } = {}) {
    let now = 1_000;
    const calls: Array<Record<string, unknown>> = [];
    const window = {
      devices: ["laptop"],
      sessions: [{ device: "laptop", source: "codex", id: "recent", last_activity: "2026-10-22T12:00:00Z" }],
    };
    const keptRow = { device: "laptop", source: "codex", id: "wechat", last_activity: "2026-09-01T00:00:00Z", title: "微信备份" };
    const bundles = {
      profile: { app: "session-plus", publisher: "octopus:first-party", operations: [], autoAllow: [] },
      get: (instanceId: string) => instanceId === "instance" ? { owner: "alice" } : null,
      openController: (_instanceId: string, plane: "runner" | "local") => ({
        caps: {
          request: async (_kind: string, _operation: string, args: Record<string, unknown>) => {
            if (plane === "local") return { status: "succeeded", result: { sessions: [] } };
            calls.push(args);
            if (options.approval && !args.ids) return { status: "approval_required", pendingCallId: "p1" };
            if (!args.ids) return { status: "succeeded", result: window };
            if (options.ids === "fails") throw new Error("link lost");
            // An old Runner ignores `ids` and answers its ordinary recent list.
            return { status: "succeeded", result: { sessions: options.ids === "ignored" ? window.sessions : [keptRow] } };
          },
        },
        close() {},
      }),
    } as unknown as AppAuthorityBundles;
    const service = new SessionResourceService(bundles, { audit() {} } as unknown as PermissionService, 2_000, 10, null, null, () => now);
    const current = { pinned: [mint("laptop", "codex", "wechat"), mint("offline", "codex", "gone")] };
    const refresh = async () => {
      const result = await service.execute("instance", "refresh_sessions", { limit: "200" }, current);
      return result.ok ? (result.patch.sessions as Array<{ sessionId: string; title?: string }>) : [];
    };
    return { calls, refresh, advance: (ms: number) => { now += ms; } };
  }

  it("asks the online device for the exact kept identities and keeps them past the window", async () => {
    const { calls, refresh, advance } = harness();
    expect((await refresh()).map((row) => row.sessionId).sort()).toEqual(["recent", "wechat"]);
    const lookup = calls.find((args) => args.ids);
    expect(lookup).toMatchObject({ device: "laptop", source: "all", limit: 1, ids: "codex:wechat", _octopus_include_session_plus: true });
    // The offline device is never asked; the View shows that favorite as absent.
    expect(calls.filter((args) => args.ids)).toHaveLength(1);

    // Wake refreshes inside the TTL reuse the answer instead of reading the device again.
    advance(KEPT_LOOKUP_TTL_MS - 1);
    expect((await refresh()).map((row) => row.sessionId)).toContain("wechat");
    expect(calls.filter((args) => args.ids)).toHaveLength(1);
    advance(2);
    await refresh();
    expect(calls.filter((args) => args.ids)).toHaveLength(2);
  });

  it("drops rows an old Runner returns for an ignored selector and does not cache a failed read", async () => {
    const ignored = harness({ ids: "ignored" });
    expect((await ignored.refresh()).map((row) => row.sessionId)).toEqual(["recent"]);
    const failing = harness({ ids: "fails" });
    await failing.refresh();
    await failing.refresh();
    expect(failing.calls.filter((args) => args.ids)).toHaveLength(2);
  });

  it("never spends a lookup while the window itself waits for approval", async () => {
    const { calls, refresh } = harness({ approval: true });
    await refresh();
    expect(calls.filter((args) => args.ids)).toHaveLength(0);
  });
});
