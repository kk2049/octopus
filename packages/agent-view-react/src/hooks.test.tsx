/**
 * The App-author surface, exercised the way an App uses it.
 *
 * The interesting assertions are the negative ones: a projection update must
 * reach the tree without the App polling, a refusal must become a bounded
 * sentence rather than a rejected promise, and unmounting must actually close
 * the channel — a provider that leaked its port would keep an "alive" View
 * answering after React had thrown the tree away.
 */

import { StrictMode, startTransition } from "react";
import { createRoot } from "react-dom/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { APPEARANCE_CONTRACT, MSG, VIEW_HELLO } from "@claude-bot/web-trust/frame-protocol";
import { directHarness } from "./runtime.test-support.js";
import { AgentViewProvider } from "./provider.js";
import { useAgentViewStatus, useOperations, useProjection, usePropose, useRefusal } from "./hooks.js";

const connected = directHarness;

function tick(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function Probe() {
  const projection = useProjection<{ title?: string }>();
  const operations = useOperations();
  const status = useAgentViewStatus();
  const propose = usePropose();
  const refusal = useRefusal();
  return (
    <div>
      <span data-testid="title">{projection?.title ?? "(none)"}</span>
      <span data-testid="phase">{status.phase}</span>
      <span data-testid="ready">{String(status.ready)}</span>
      <span data-testid="ops">{operations.map((o) => `${o.id}:${o.status}`).join(",")}</span>
      <span data-testid="notice">{refusal.text}</span>
      <button type="button" onClick={() => void propose("pin_session", { session: "s1" })}>pin</button>
      <button type="button" onClick={refusal.clear}>clear</button>
    </div>
  );
}

describe("Agent View hooks", () => {
  it("throws a useful error when an App forgets the provider", () => {
    // A silent `null` here would surface much later as "the projection is
    // always empty", which is the hardest possible way to learn about a missing
    // provider.
    expect(() => render(<Probe />)).toThrow(/AgentViewProvider/);
  });

  it("delivers boot, projection updates and operations without the App polling", async () => {
    const { client, host } = connected();
    render(
      <AgentViewProvider client={client}>
        <Probe />
      </AgentViewProvider>,
    );
    expect(screen.getByTestId("phase")).toHaveTextContent("waiting");
    expect(screen.getByTestId("ready")).toHaveTextContent("false");

    host.postMessage({ t: MSG.boot, projection: { title: "第一帧" } });
    await tick();
    expect(screen.getByTestId("title")).toHaveTextContent("第一帧");
    expect(screen.getByTestId("phase")).toHaveTextContent("open");
    expect(screen.getByTestId("ready")).toHaveTextContent("true");

    host.postMessage({ t: MSG.view, projection: { title: "第二帧" } });
    host.postMessage({ t: MSG.op, operation: { id: "op1", status: "waiting_approval" } });
    await tick();
    expect(screen.getByTestId("title")).toHaveTextContent("第二帧");
    expect(screen.getByTestId("ops")).toHaveTextContent("op1:waiting_approval");
    client.destroy();
  });

  it("turns a refusal into bounded text instead of a rejected promise", async () => {
    const { client, host } = connected();
    let rid = "";
    host.onmessage = (event) => {
      const msg = event.data as Record<string, unknown>;
      if (msg.t === MSG.propose) rid = String(msg.rid);
    };
    render(
      <AgentViewProvider client={client}>
        <Probe />
      </AgentViewProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "pin" }));
    await tick();
    host.postMessage({
      t: MSG.result,
      rid,
      ok: false,
      code: "action_rejected",
      result: { message: "这个动作不在当前 release 的声明里" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("notice")).toHaveTextContent("可信外层拒绝了 pin_session");
    });
    expect(screen.getByTestId("notice")).toHaveTextContent("不在当前 release 的声明里");

    await userEvent.click(screen.getByRole("button", { name: "clear" }));
    expect(screen.getByTestId("notice")).toHaveTextContent("");
    client.destroy();
  });

  it("bounds the refusal text a hostile-length message could produce", async () => {
    const { client, host } = connected();
    let rid = "";
    host.onmessage = (event) => {
      const msg = event.data as Record<string, unknown>;
      if (msg.t === MSG.propose) rid = String(msg.rid);
    };
    render(
      <AgentViewProvider client={client}>
        <Probe />
      </AgentViewProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "pin" }));
    await tick();
    host.postMessage({ t: MSG.result, rid, ok: false, result: { message: "长".repeat(5000) } });
    await waitFor(() => expect(screen.getByTestId("notice").textContent!.length).toBeGreaterThan(10));
    expect(screen.getByTestId("notice").textContent!.length).toBeLessThanOrEqual(500);
    client.destroy();
  });

  it("clears the previous refusal when a new proposal is sent", async () => {
    const { client, host } = connected();
    const rids: string[] = [];
    host.onmessage = (event) => {
      const msg = event.data as Record<string, unknown>;
      if (msg.t === MSG.propose) rids.push(String(msg.rid));
    };
    render(
      <AgentViewProvider client={client}>
        <Probe />
      </AgentViewProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "pin" }));
    await tick();
    host.postMessage({ t: MSG.result, rid: rids[0], ok: false, result: { message: "第一次被拒" } });
    await waitFor(() => expect(screen.getByTestId("notice")).toHaveTextContent("第一次被拒"));
    await userEvent.click(screen.getByRole("button", { name: "pin" }));
    await waitFor(() => expect(screen.getByTestId("notice")).toHaveTextContent(""));
    client.destroy();
  });

  it("leaves the caller-owned runtime open after unmount", async () => {
    const { client } = connected();
    const { unmount } = render(<AgentViewProvider client={client}><Probe /></AgentViewProvider>);
    unmount();
    act(() => client.update({ title: "还活着" }));
    expect(client.snapshot().projection).toEqual({ title: "还活着" });
    client.destroy();
  });

  it("survives StrictMode's double mount with one live channel", async () => {
    const { client, host } = connected();
    render(
      <StrictMode>
        <AgentViewProvider client={client}>
          <Probe />
        </AgentViewProvider>
      </StrictMode>,
    );
    host.postMessage({ t: MSG.boot, projection: { title: "一次" } });
    await tick();
    expect(screen.getByTestId("title")).toHaveTextContent("一次");
    expect(screen.getByTestId("phase")).toHaveTextContent("open");
    client.destroy();
  });

  it("does not register or announce from an abandoned concurrent render", async () => {
    const post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
    const add = vi.spyOn(window, "addEventListener");
    const { client } = connected();
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      startTransition(() => root.render(
        <AgentViewProvider client={client}>
          <Probe />
        </AgentViewProvider>,
      ));
      // Urgent work supersedes the transition before its tree commits.
      root.render(<span>replacement</span>);
    });

    expect(container).toHaveTextContent("replacement");
    expect(post.mock.calls.filter(([message]) => message === VIEW_HELLO)).toHaveLength(0);
    expect(add.mock.calls.filter(([type]) => type === "message")).toHaveLength(0);
    root.unmount();
    client.destroy();
  });

  it("mirrors the outer shell's appearance onto <html data-av-theme> (ticket #45)", async () => {
    // The provider's job on the DOM side of ticket #45 is a single attribute
    // write, driven by the client's snapshot. Boot with Apple paints from
    // the Apple token block; a subsequent MSG.appearance to ink swaps it;
    // classic REMOVES the attribute (that is the "reachable pre-theme
    // rendering" contract the SDK owes every App).
    delete document.documentElement.dataset.avTheme;
    const { client, host } = connected();
    render(
      <AgentViewProvider client={client}>
        <Probe />
      </AgentViewProvider>,
    );
    host.postMessage({
      t: MSG.boot,
      projection: { title: "首帧" },
      appearance: { contract: APPEARANCE_CONTRACT, theme: "apple" },
    });
    await tick();
    expect(document.documentElement.dataset.avTheme).toBe("apple");

    host.postMessage({
      t: MSG.appearance,
      appearance: { contract: APPEARANCE_CONTRACT, theme: "ink" },
    });
    await tick();
    expect(document.documentElement.dataset.avTheme).toBe("ink");

    host.postMessage({
      t: MSG.appearance,
      appearance: { contract: APPEARANCE_CONTRACT, theme: "classic" },
    });
    await tick();
    expect(document.documentElement.dataset.avTheme).toBeUndefined();
    client.destroy();
  });

  it("updates the page-zoom font floor without remounting or disturbing an editor draft", async () => {
    const { client, host } = connected();
    const { unmount } = render(<AgentViewProvider client={client}><textarea defaultValue="未发送草稿" /></AgentViewProvider>);
    const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
    editor.focus();
    editor.setSelectionRange(2, 2);
    for (const controlFontSize of [32, 21.34, undefined]) {
      host.postMessage({ t: MSG.appearance, appearance: { contract: APPEARANCE_CONTRACT, theme: "classic", controlFontSize } });
      await tick();
      expect(document.documentElement.style.getPropertyValue("--mobile-control-font-size")).toBe(`${controlFontSize ?? 16}px`);
      expect(screen.getByRole("textbox")).toBe(editor);
      expect(document.activeElement).toBe(editor);
      expect(editor.value).toBe("未发送草稿");
      expect(editor.selectionStart).toBe(2);
    }
    unmount();
    client.destroy();
  });

  it("shares a caller runtime in StrictMode without window messages", () => {
    const post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
    const { client } = connected();
    render(<StrictMode><AgentViewProvider client={client}><Probe /></AgentViewProvider></StrictMode>);
    act(() => client.update({ title: "共享运行时" }));
    expect(screen.getByTestId("title")).toHaveTextContent("共享运行时");
    expect(post).not.toHaveBeenCalled();
    client.destroy();
  });
});
