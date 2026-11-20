import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { useAgentViewSnapshot, usePropose } from "@claude-bot/agent-view-react";
import type { AppHostDeps } from "../session-plus/app-host.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrap } from "../lib/bootstrap.js";
import { renderPage } from "../test-utils.js";
import type { SessionPlusAppProps } from "../contract.js";
import { SessionPlusPage } from "./SessionPlusPage.js";

vi.mock("../app/Shell.js", () => ({
  ShellPageActions: ({ children }: { children: ReactNode }) => children,
}));

// The tab's instance handle; absent unless a test supplies one.
const instanceHandle = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("../lib/bootstrap.js", async (original) => ({
  ...await original<typeof import("../lib/bootstrap.js")>(),
  appInstanceHandle: () => instanceHandle.value,
}));

// Supply only the loaded module; keep the real host, runtime, provider and mount.
const moduleLoader = vi.hoisted(() => vi.fn());
vi.mock("../session-plus/app-host.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-plus/app-host.js")>();
  return {
    ...actual,
    createAppHost: (deps: AppHostDeps) => actual.createAppHost({ ...deps, loadModule: moduleLoader }),
  };
});

function ModuleApp() {
  const [draft, setDraft] = useState("");
  const projection = useAgentViewSnapshot().projection;
  return <section aria-label="Loaded Session Plus module">
    <textarea aria-label="Session draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
    <output aria-label="Session projection">{JSON.stringify(projection)}</output>
  </section>;
}

const PROPS: SessionPlusAppProps = {
  mode: "app",
  identity: {
    stableAppId: "session-plus",
    publisher: "octopus:test",
    packageDigest: "a".repeat(64),
    permissionContractDigest: "b".repeat(64),
    viewOrigin: "https://session-plus.test",
    frameAncestors: ["https://dashboard.test"],
    development: false,
    contractOperations: [],
  },
  trustReason: "exact_release",
  authorization: {
    source: null,
    editable: true,
    needsAuthorization: false,
    contractChanged: false,
    publisherChanged: false,
    entries: [],
  },
  resourceGeneration: 1,
  projection: { pinned: [], sessions: [], sources: [] },
};

describe("Session Plus instance recovery", () => {
  beforeEach(() => {
    bootstrap.pageProps = PROPS;
    instanceHandle.value = null;
    moduleLoader.mockReset().mockResolvedValue({ App: ModuleApp, styles: [] });
  });

  it("keeps the current document on a stale stream and offers an explicit reload", async () => {
    let resolveStream!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { resolveStream = resolve; });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.endsWith("/api/session-plus/stream")) throw new Error(`unexpected request to ${url}`);
      return response;
    });
    vi.stubGlobal("fetch", fetcher);

    renderPage(<SessionPlusPage />, "/sessions-plus");
    const draft = await screen.findByRole("textbox", { name: "Session draft" });
    expect(screen.getByLabelText("Session projection")).toHaveTextContent(JSON.stringify(PROPS.projection));
    fireEvent.change(draft, { target: { value: "keep this unsent draft" } });
    await act(async () => resolveStream(new Response(null, { status: 404 })));

    expect(await screen.findByRole("alert")).toHaveTextContent("当前页面不会自动刷新");
    expect(screen.getByRole("button", { name: "重新载入会话+" })).toBeInTheDocument();
    await act(async () => {
      fireEvent.focus(window);
      fireEvent(window, new Event("online"));
      fireEvent(document, new Event("visibilitychange"));
    });
    expect(screen.getByRole("textbox", { name: "Session draft" })).toBe(draft);
    expect(draft).toHaveValue("keep this unsent draft");
    expect(document.body).toHaveAttribute("data-sp-generation", "1");
    expect(moduleLoader).toHaveBeenCalledExactlyOnceWith("/ui/apps/" + PROPS.identity.packageDigest + "/");
    // Module loading has its own seam. The only network call is the original
    // stream; focus/reconnect must not reconstruct or replay resource actions.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the channel generation diagnostic-only", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith("/api/session-plus/stream")) throw new Error(`unexpected request to ${url}`);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
        },
      });
      return new Response(stream, { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);

    renderPage(<SessionPlusPage />, "/sessions-plus");

    expect(await screen.findByRole("region", { name: "Loaded Session Plus module" })).toBeInTheDocument();
    await waitFor(() => expect(document.body).toHaveAttribute("data-sp-generation", "1"));
    expect(screen.queryByText(/第\s*\d+\s*代/u)).not.toBeInTheDocument();
  });

  it("folds streamed operation updates into the trusted session information", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          "event: op",
          'data: {"operation":{"id":"op-1","operation":"open_terminal","status":"waiting_approval","message":"等待批准"}}',
          "",
          "event: op",
          'data: {"operation":{"id":"op-1","operation":"open_terminal","status":"succeeded","message":"已完成"}}',
          "",
          "",
        ].join("\n")));
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.endsWith("/api/session-plus/stream")) throw new Error(`unexpected request to ${url}`);
      return new Response(stream, { status: 200 });
    }));

    renderPage(<SessionPlusPage />, "/sessions-plus");

    expect(await screen.findByRole("region", { name: "Loaded Session Plus module" })).toBeInTheDocument();
    expect(await screen.findAllByText("已完成")).toHaveLength(2);
    expect(screen.getByText("open_terminal")).toBeInTheDocument();
    expect(screen.queryByText("等待批准")).not.toBeInTheDocument();
    const history = screen.getByText("历史动作").closest("details");
    expect(history).not.toBeNull();
    expect(within(history!).getByText("1")).toBeInTheDocument();
  });

  it("rebuilds streamed projection patches before the App sees them, and resyncs a mismatch", async () => {
    const encoder = new TextEncoder();
    const bodies = [
      [
        "event: view",
        'data: {"type":"view","revision":5,"projection":{"pinned":[],"sessions":[],"sources":[]}}',
        "",
        "event: view-patch",
        'data: {"revision":6,"base":5,"patch":[["=",["pinned"],["streamed"]]]}',
        "",
        "event: view-patch",
        'data: {"revision":8,"base":7,"patch":[["=",["pinned"],["lost"]]]}',
        "",
        "",
      ],
      [
        "event: view",
        'data: {"type":"view","revision":9,"projection":{"pinned":["resynced"],"sessions":[],"sources":[]}}',
        "",
        "",
      ],
    ];
    const requests: Array<{ headers: Headers; aborted: () => boolean }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith("/api/session-plus/stream")) throw new Error(`unexpected request to ${url}`);
      const lines = bodies[requests.length] ?? [];
      requests.push({ headers: new Headers(init?.headers), aborted: () => init?.signal?.aborted === true });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(lines.join("\n")));
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
        },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);

    renderPage(<SessionPlusPage />, "/sessions-plus");

    expect(await screen.findByRole("region", { name: "Loaded Session Plus module" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Session projection")).toHaveTextContent('"pinned":["streamed"]'));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    expect(requests[0].headers.get("x-projection-delta")).toBe("1");
    // The patch that named a frame this tab never held dropped its connection.
    expect(requests[0].aborted()).toBe(true);
    await waitFor(() => expect(screen.getByLabelText("Session projection")).toHaveTextContent('"pinned":["resynced"]'));
    expect(screen.getByLabelText("Session projection")).not.toHaveTextContent("lost");
  });

  it("names the held frame on an action and hands the App the rebuilt reply projection", async () => {
    function ProposingApp() {
      const propose = usePropose();
      const projection = useAgentViewSnapshot().projection;
      return <section aria-label="Loaded Session Plus module">
        <button type="button" onClick={() => void propose("pin_session", { session: "demo" })}>pin</button>
        <output aria-label="Session projection">{JSON.stringify(projection)}</output>
      </section>;
    }
    moduleLoader.mockResolvedValue({ App: ProposingApp, styles: [] });
    instanceHandle.value = "tab-handle";
    const stream = "0123456789abcdef";
    let actHeaders: Headers | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/session-plus/stream")) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode([
              "event: view",
              `data: {"type":"view","revision":5,"projection":{"pinned":[],"sessions":[],"sources":[]},"stream":"${stream}"}`,
              "",
              "",
            ].join("\n")));
            init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
          },
        }), { status: 200 });
      }
      if (url.endsWith("/api/session-plus/act")) {
        actHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({
          ok: true,
          result: { session: "demo" },
          revision: 6,
          projection_base: `${stream}.5`,
          projection_patch: [["=", ["pinned"], ["demo"]]],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // The trusted chrome's own instance-scoped reads (agent activity).
      if (url.includes("/agent-activity")) return Response.json({ activity: [] });
      throw new Error(`unexpected request to ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    renderPage(<SessionPlusPage />, "/sessions-plus");
    expect(await screen.findByRole("region", { name: "Loaded Session Plus module" })).toBeInTheDocument();
    await waitFor(() => expect(fetcher.mock.calls.some(([input]) => String(input).endsWith("/api/session-plus/stream"))).toBe(true));
    // Let the first frame land before acting, as a person would.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    fireEvent.click(screen.getByRole("button", { name: "pin" }));

    await waitFor(() => expect(screen.getByLabelText("Session projection")).toHaveTextContent('"pinned":["demo"]'));
    expect(actHeaders?.get("x-projection-base")).toBe(`${stream}.5`);
    expect(actHeaders?.get("x-session-plus-instance")).toBe("tab-handle");
  });
});
