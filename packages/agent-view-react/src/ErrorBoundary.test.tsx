/**
 * Containment: an App component that throws must not take the frame with it.
 *
 * The property that matters is not "a nice error message" — it is that the
 * transport is still open afterwards. A React tree that unmounts on a throw
 * leaves a frame holding a live MessagePort and rendering nothing, which from
 * the Host's side is indistinguishable from a hostile View playing dead.
 */

import { useState } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentViewErrorBoundary } from "./ErrorBoundary.js";
import { createAppRuntimeClient } from "./runtime.js";
import { AgentViewProvider } from "./provider.js";
import { useProjection } from "./hooks.js";

// React logs the caught error; the noise would otherwise look like a failure.
beforeEach(() => void vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

function Boom({ when }: { when: boolean }): React.ReactElement {
  if (when) throw new Error("projection.sessions.map is not a function");
  return <p>正常内容</p>;
}

describe("AgentViewErrorBoundary", () => {
  it("renders a legible fallback instead of unmounting the frame", () => {
    render(
      <AgentViewErrorBoundary>
        <Boom when />
      </AgentViewErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("这个视图渲染失败了");
    expect(screen.getByRole("alert")).toHaveTextContent("projection.sessions.map is not a function");
    // And it says where recovery lives, which is not here.
    expect(screen.getByRole("alert")).toHaveTextContent("重建视图");
  });

  it("bounds the message so a thrown value cannot become a payload", () => {
    function Long(): React.ReactElement {
      throw new Error("x".repeat(5000));
    }
    render(
      <AgentViewErrorBoundary>
        <Long />
      </AgentViewErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent!.length).toBeLessThan(600);
  });

  it("keeps the channel open and still delivering projections after a crash", async () => {
    const client = createAppRuntimeClient({ dispatch: async () => ({ ok: true }) });

    function Live() {
      const projection = useProjection<{ title?: string }>();
      return <span data-testid="live">{projection?.title ?? "(none)"}</span>;
    }

    render(
      <AgentViewProvider client={client}>
        <AgentViewErrorBoundary>
          <Boom when />
        </AgentViewErrorBoundary>
        <Live />
      </AgentViewProvider>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    act(() => client.update({ title: "仍在接收" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId("live")).toHaveTextContent("仍在接收");
    client.destroy();
  });

  it("only retries when the App asks — never on a timer", async () => {
    function Toggle() {
      const [broken, setBroken] = useState(true);
      return (
        <AgentViewErrorBoundary
          fallback={({ message, reset }) => (
            <div>
              <span data-testid="msg">{message}</span>
              <button
                type="button"
                onClick={() => {
                  setBroken(false);
                  reset();
                }}
              >
                重试
              </button>
            </div>
          )}
        >
          <Boom when={broken} />
        </AgentViewErrorBoundary>
      );
    }
    render(<Toggle />);
    expect(screen.getByTestId("msg")).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    // Still broken: nothing re-rendered it behind our back.
    expect(screen.getByTestId("msg")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(screen.getByText("正常内容")).toBeInTheDocument();
  });

  it("does not let a throwing observer take the fallback down", () => {
    render(
      <AgentViewErrorBoundary onError={() => { throw new Error("observer exploded"); }}>
        <Boom when />
      </AgentViewErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
