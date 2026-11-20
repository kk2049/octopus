import { describe, expect, it, vi } from "vitest";
import type { CardPayload } from "../feishu/direct-card.js";
import {
  RUNNER_ONLINE_NOTICE_MIN_OFFLINE_MS,
  runnerOnlineNotice,
  runnerOnlineNoticeCard,
  runnerOnlineNoticeKey,
  runnerOnlineNotices,
} from "./online-notice.js";

const NOW = Date.parse("2026-10-23T01:32:48.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function harness(watched: Record<string, "feishu" | undefined>, send = vi.fn(async (_owner: string, _card: CardPayload) => {})) {
  const failed = vi.fn();
  const sent = vi.fn();
  const listener = runnerOnlineNotices({
    channel: (owner, device) => watched[`${owner}/${device}`],
    displayName: (_owner, device) => device === "jim-laptop" ? "JIM 笔记本" : undefined,
    sendFeishu: send,
    sent,
    failed,
    now: () => NOW,
  });
  return { listener, send, sent, failed };
}

const text = (card: CardPayload) => JSON.stringify(card);

describe("Runner online notices", () => {
  it("tells the owner once when a watched device returns after being away", async () => {
    const { listener, send, sent, failed } = harness({ "lht/jim-laptop": "feishu" });
    listener("lht", "jim-laptop", true, ago(36 * 3_600_000 + 5 * 60_000));
    await vi.waitFor(() => expect(sent).toHaveBeenCalledWith("lht", "jim-laptop"));
    expect(send).toHaveBeenCalledOnce();
    const [owner, card] = send.mock.calls[0]!;
    expect(owner).toBe("lht");
    expect(card.header?.title).toEqual({ tag: "plain_text", content: "设备已上线：JIM 笔记本（jim-laptop）" });
    expect(text(card)).toContain("2026-10-23 09:32:48（北京时间）");
    expect(text(card)).toContain("上次在线 2026-10-21 21:27:48，离线约 1 天 12 小时");
    expect(failed).not.toHaveBeenCalled();
  });

  it("treats a short gap as a reconnect: self-update, gateway restart, network blip", () => {
    const { listener, send } = harness({ "lht/jim-laptop": "feishu" });
    listener("lht", "jim-laptop", true, ago(1_000));
    listener("lht", "jim-laptop", true, ago(RUNNER_ONLINE_NOTICE_MIN_OFFLINE_MS - 1));
    expect(send).not.toHaveBeenCalled();
    listener("lht", "jim-laptop", true, ago(RUNNER_ONLINE_NOTICE_MIN_OFFLINE_MS));
    expect(send).toHaveBeenCalledOnce();
  });

  it("ignores drops and devices nobody asked about", () => {
    const { listener, send } = harness({ "lht/jim-laptop": "feishu" });
    listener("lht", "jim-laptop", false);
    listener("lht", "desktop-pc", true, ago(86_400_000));
    listener("bob", "jim-laptop", true, ago(86_400_000));
    expect(send).not.toHaveBeenCalled();
  });

  it("announces a device with no earlier proof of life", async () => {
    const { listener, send } = harness({ "lht/new-box": "feishu" });
    listener("lht", "new-box", true, null);
    expect(send).toHaveBeenCalledOnce();
    expect(text(send.mock.calls[0]![1])).toContain("此前没有在线记录");
  });

  it("reports a delivery failure without throwing into the gateway", async () => {
    const error = new Error("飞书通道未启用");
    const { listener, failed, sent } = harness({ "lht/jim-laptop": "feishu" }, vi.fn(async () => { throw error; }));
    expect(() => listener("lht", "jim-laptop", true, ago(86_400_000))).not.toThrow();
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith("lht", "jim-laptop", error));
    expect(sent).not.toHaveBeenCalled();
  });

  it("reads only the feishu value of the owner's setting", () => {
    const settings = new Map<string, string>([
      [`lht:${runnerOnlineNoticeKey("a")}`, "feishu"],
      [`lht:${runnerOnlineNoticeKey("b")}`, "off"],
      [`lht:${runnerOnlineNoticeKey("c")}`, "email"],
    ]);
    const store = { getSetting: (owner: string, key: string) => settings.get(`${owner}:${key}`) };
    expect(runnerOnlineNotice(store, "lht", "a")).toBe("feishu");
    expect(runnerOnlineNotice(store, "lht", "b")).toBeUndefined();
    expect(runnerOnlineNotice(store, "lht", "c")).toBeUndefined();
    expect(runnerOnlineNotice(store, "bob", "a")).toBeUndefined();
  });

  it("keeps owner-chosen names out of Markdown", () => {
    const card = runnerOnlineNoticeCard({ device: "box", displayName: "**[x](http://e)**", at: new Date(NOW) });
    expect(card.elements.every((element) => (element.text as { tag: string }).tag === "plain_text")).toBe(true);
    expect(card.header?.title).toEqual({ tag: "plain_text", content: "设备已上线：**[x](http://e)**（box）" });
  });
});
