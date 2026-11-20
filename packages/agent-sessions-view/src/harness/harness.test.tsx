/**
 * The reuse proof, checked rather than asserted in prose.
 *
 * A second App, a second provider, a different composition — and the SAME
 * search, roster and chat objects. The last part is the one that matters, so it
 * is checked by identity (`SESSIONS_MODULES` contains these very entries), not
 * by rendering something that merely looks similar.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createModuleRegistry } from "@claude-bot/agent-view-react/workspace";
import {
  AGENT_CHAT_MANIFEST,
  NEW_SESSION_MANIFEST,
  SESSION_OPERATIONS_MANIFEST,
  SESSION_ROSTER_MANIFEST,
  SESSION_SEARCH_MANIFEST,
} from "../manifests.js";
import { SESSIONS_MODULES } from "../modules.js";
import { READ_ONLY_COMPOSITION, ReadOnlySessionsApp } from "./ReadOnlySessions.js";
import { createMemorySessionsPort, type MemorySessionsPort } from "./memory-port.js";

const FIXTURE = {
  sessions: [
    {
      resourceId: "demo-1",
      deviceId: "fixture-laptop",
      deviceLabel: "fixture-laptop",
      cliKind: "codex",
      accountLabel: "a",
      projectLabel: "只读演示",
      cwdDisplay: "~/demo/read-only",
      lastActivity: new Date().toISOString(),
      status: "idle",
      resumable: true,
      messageCount: 3,
    },
  ],
  sources: [{ kind: "runner", device: "fixture-laptop", online: true }],
  transcripts: {
    "demo-1": [
      { role: "user", blocks: [{ type: "text", text: "这是只读 harness 的第一条消息" }] },
      { role: "assistant", blocks: [{ type: "text", text: "复用同一个 AgentChat 渲染" }] },
    ],
  },
};

function mount(): MemorySessionsPort {
  const port = createMemorySessionsPort(FIXTURE);
  render(<ReadOnlySessionsApp port={port} />);
  return port;
}

describe("read-only sessions harness", () => {
  it("mounts the same module objects the production App registers", () => {
    const ids = READ_ONLY_COMPOSITION.instances.map((row) => row.module);
    expect(ids).toEqual([SESSION_SEARCH_MANIFEST.id, SESSION_ROSTER_MANIFEST.id, AGENT_CHAT_MANIFEST.id]);
    for (const id of ids) {
      const entry = SESSIONS_MODULES.find((row) => row.manifest.id === id);
      expect(entry, `${id} is not one of the shared modules`).toBeTruthy();
    }
    // A genuinely different composition: no new-agent form, no status strip.
    expect(ids).not.toContain(NEW_SESSION_MANIFEST.id);
    expect(ids).not.toContain(SESSION_OPERATIONS_MANIFEST.id);
  });

  it("renders the roster and the transcript from a fixture, with no transport at all", async () => {
    const port = mount();
    // The title appears in the roster row AND in the chat header, which is the
    // point: two modules, one projection.
    expect(await screen.findAllByText("只读演示")).toHaveLength(2);
    expect(document.querySelector('.sess[data-id="demo-1"]')).toHaveTextContent("只读演示");
    expect(document.querySelector(".detailhead .title")).toHaveTextContent("只读演示");
    expect(document.querySelector('.sess[data-id="demo-1"] .m')).toHaveTextContent("Codex-a");
    expect(document.querySelector(".detailhead .meta")).toHaveTextContent("Codex-a");
    // The chat mounted and read a window through the port — the same controller
    // path the real App uses.
    expect(port.calls.some((call) => call.startsWith("readWindow:demo-1"))).toBe(true);
    expect(await screen.findByText("复用同一个 AgentChat 渲染")).toBeInTheDocument();
    expect(document.querySelector("[data-av-chat-transcript]")).toHaveAttribute("data-av-chat-total", "2");
  });

  it("searches the fixture through the same search module", async () => {
    mount();
    await userEvent.type(document.getElementById("search")!, "harness");
    await userEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(await screen.findByText(/搜索 “harness”/)).toBeInTheDocument();
    expect(document.querySelector(".results .hit")).toHaveTextContent("只读演示");
  });

  it("shows the write path refusing, because the port has no execute grant", async () => {
    const port = mount();
    const composer = (await screen.findByPlaceholderText("继续这个会话…")) as HTMLTextAreaElement;
    await userEvent.type(composer, "试着写一句");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    // The module asked; the provider refused. Nothing about the module changed.
    expect(port.calls).toContain("resume");
    expect(port.snapshot().refusal).toContain("只读");
    // And the App shows it, rather than looking broken.
    expect(await screen.findByRole("note")).toHaveTextContent("只读");
    await userEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("only registers the three modules its composition names", () => {
    const registry = createModuleRegistry(
      SESSIONS_MODULES.filter((entry) => READ_ONLY_COMPOSITION.instances.some((row) => row.module === entry.manifest.id)),
    );
    expect(registry.lock().modules.map((row) => row.id).sort()).toEqual([
      AGENT_CHAT_MANIFEST.id,
      SESSION_ROSTER_MANIFEST.id,
      SESSION_SEARCH_MANIFEST.id,
    ].sort());
    expect(registry.has(NEW_SESSION_MANIFEST.id)).toBe(false);
  });
});
