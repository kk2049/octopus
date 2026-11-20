import { expect, it, vi } from "vitest";
import { render, waitFor, act, fireEvent } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { createBrowserDraftStore } from "../lib/browser-drafts.js";
import { useAgentView, useAgentViewSnapshot, type AgentViewClient } from "@claude-bot/agent-view-react";
import { createAppHost, type HostSnapshot } from "./app-host.js";
import * as runtimeModule from "@claude-bot/agent-view-react/runtime";
it("mounts an independently loaded App in the existing React tree and keeps newest projection", async () => {
  const slot = document.createElement("div"); document.body.appendChild(slot);
  const mounted = render(<div />, { container: slot });
  function App() { const value = useAgentViewSnapshot(); return <span>{String(value.projection?.value)}</span>; }
  let latest: HostSnapshot | undefined;
  const host = createAppHost({ doc: document, win: window, slot, appId: "session-plus", packageDigest: "a".repeat(64), appOrigin: location.origin,
    projection: { value: 1 }, loadModule: async () => ({ App, styles: [] }),
    onChange: (next) => { latest = next; mounted.rerender(<>{next.element}</>); }, dispatch: vi.fn(),
  });
  await act(async () => { host.mount(); });
  await waitFor(() => expect(slot.textContent).toBe("1"));
  expect(latest?.ports).toBe(0); expect(slot.querySelector("iframe")).toBeNull();
  act(() => { host.update({ value: 3 }, 3); host.update({ value: 2 }, 2); });
  expect(slot.textContent).toBe("3");
  await act(async () => {
    host.update({ value: 4 }); host.update({ value: 2 }, 2);
    await host.reconstruct();
  });
  await waitFor(() => expect(slot.textContent).toBe("4"));
  act(() => host.dispose());
  expect(slot.textContent).toBe("");
  mounted.unmount(); slot.remove();
});
it("does not mount a late module into a disposed generation", async () => {
  const slot = document.createElement("div");
  let resolve!: (value: { App: () => null; styles: string[] }) => void;
  const loadModule = () => new Promise<{ App: () => null; styles: string[] }>((done) => { resolve = done; });
  const host = createAppHost({ doc: document, win: window, slot, appId: "session-plus", packageDigest: "b".repeat(64), appOrigin: location.origin, projection: {}, loadModule });
  host.mount(); host.dispose(); resolve({ App: () => null, styles: [] });
  await Promise.resolve(); expect(host.snapshot().element).toBeUndefined();
});

it("keeps a retired pending send uncertain while preserving its late receipt without changing the replacement", async () => {
  const slot = document.createElement("div");
  document.body.appendChild(slot);
  const mounted = render(<div />, { container: slot });
  let client: AgentViewClient | undefined;
  function App() {
    client = useAgentView().client;
    const snapshot = useAgentViewSnapshot();
    return <span>{String(snapshot.projection?.value)}</span>;
  }
  let resolve!: (reply: runtimeModule.AppRuntimeReply) => void;
  const deferred = new Promise<runtimeModule.AppRuntimeReply>((done) => { resolve = done; });
  const dispatch = vi.fn(() => deferred);
  // Keep the actual runtime. Observe what the Host returns to its retired
  // runtime even though disposal has already settled that runtime's UI caller.
  const createRuntime = runtimeModule.createAppRuntimeClient;
  const returned: runtimeModule.AppRuntimeReply[] = [];
  const factory = vi.spyOn(runtimeModule, "createAppRuntimeClient").mockImplementation((options) => createRuntime({
    ...options,
    dispatch: async (action, params) => {
      const reply = await options.dispatch(action, params);
      returned.push(reply);
      return reply;
    },
  }));
  const changed = vi.fn((next: HostSnapshot) => mounted.rerender(<>{next.element}</>));
  const host = createAppHost({
    doc: document, win: window, slot, appId: "session-plus", packageDigest: "c".repeat(64), appOrigin: location.origin,
    projection: { value: "original" }, loadModule: async () => ({ App, styles: [] }), onChange: changed, dispatch,
  });
  try {
    await act(async () => { host.mount(); });
    await waitFor(() => expect(slot.textContent).toBe("original"));
    const retired = client!;
    let pending!: ReturnType<AgentViewClient["propose"]>;
    await act(async () => { pending = retired.propose("append_session", { prompt: "only once" }); });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(retired.snapshot().inFlight).toBe(1);
    await act(async () => {
      host.update({ value: "replacement" }, 10);
      await host.reconstruct();
    });
    await expect(pending).resolves.toMatchObject({ ok: false, code: "backend_unavailable" });
    await waitFor(() => expect(slot.textContent).toBe("replacement"));
    expect(retired.snapshot()).toMatchObject({ phase: "closed", inFlight: 0 });
    const replacement = client!;
    expect(replacement).not.toBe(retired);
    act(() => host.operation({ id: "op-original", status: "unknown" }));
    const current = replacement.snapshot();
    const hostBefore = host.snapshot();
    const publications = changed.mock.calls.length;
    const operation = { id: "op-original", status: "succeeded", sessionId: "original-session" };
    const late = { ok: true, result: { operation }, projection: { value: "obsolete" }, revision: 1 };
    await act(async () => { resolve(late); });
    await waitFor(() => expect(returned).toHaveLength(1));
    expect(returned[0]).toEqual(late);
    expect(replacement.snapshot()).toBe(current);
    expect(host.snapshot()).toBe(hostBefore);
    expect(changed).toHaveBeenCalledTimes(publications);
    expect(slot.textContent).toBe("replacement");
    expect(host.snapshot()).toMatchObject({ accepted: 0, refused: 0 });
    // Recovery arrives through the same operation stream, with the same id.
    // It does not turn the closed UI promise into an instruction to replay.
    act(() => host.operation(operation));
    expect(replacement.snapshot().operations).toEqual([operation]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toMatchObject({ ok: false, code: "backend_unavailable" });
  } finally {
    await act(async () => { resolve({ ok: true }); host.dispose(); });
    factory.mockRestore();
    mounted.unmount();
    slot.remove();
  }
});

it("retains one shared stylesheet until both live App instances release it", async () => {
  const slots = [document.createElement("div"), document.createElement("div")];
  for (const slot of slots) document.body.appendChild(slot);
  const mounted = slots.map((slot) => render(<div />, { container: slot }));
  function App() { return <span>{String(useAgentViewSnapshot().projection?.value)}</span>; }
  const digest = "d".repeat(64);
  const href = `/ui/apps/${digest}/agent-view.css`;
  const hosts = slots.map((slot, index) => createAppHost({
    doc: document, win: window, slot, appId: "session-plus", packageDigest: digest, appOrigin: location.origin,
    projection: { value: `App ${index}` },
    loadModule: async () => ({ App, styles: [href], scope: "session-plus--dddddddddddddddd" }),
    onChange: (next) => mounted[index]!.rerender(<>{next.element}</>),
  }));
  const links = () => document.head.querySelectorAll<HTMLLinkElement>(`link[rel="stylesheet"][href="${href}"]`);
  try {
    await act(async () => { for (const host of hosts) host.mount(); });
    expect(links()).toHaveLength(1);
    expect(hosts.map((host) => host.snapshot().state)).toEqual(["loading", "loading"]);
    const shared = links()[0]!;
    await act(async () => { shared.dispatchEvent(new Event("load")); });
    await waitFor(() => expect(slots.map((slot) => slot.textContent)).toEqual(["App 0", "App 1"]));
    act(() => { hosts[0]!.dispose(); hosts[0]!.dispose(); });
    expect(slots[0]!.textContent).toBe("");
    expect(slots[1]!.textContent).toBe("App 1");
    expect(links()).toHaveLength(1);
    expect(links()[0]).toBe(shared);
    expect(shared.isConnected).toBe(true);
    act(() => hosts[1]!.dispose());
    expect(links()).toHaveLength(0);
    expect(shared.isConnected).toBe(false);
  } finally {
    act(() => { for (const host of hosts) host.dispose(); });
    for (const root of mounted) root.unmount();
    for (const slot of slots) slot.remove();
  }
});

it("flushes an App's deferred draft on reconstruction before closing the retired client", async () => {
  const slot = document.createElement("div");
  document.body.appendChild(slot);
  const mounted = render(<div />, { container: slot });
  const drafts = createBrowserDraftStore({ namespace: "host-rebuild", storage: null, eventTarget: null });
  let current: AgentViewClient | undefined;
  function App() {
    const { client } = useAgentView();
    current = client;
    const [text, setText] = useState(() => client.drafts.get("composer").text);
    const unsaved = useRef(text);
    unsaved.current = text;
    // A component may debounce persistence while typing and flush on unmount.
    useEffect(() => () => client.drafts.set("composer", unsaved.current), [client]);
    return <textarea aria-label="Composer" value={text} onChange={(event) => setText(event.target.value)} />;
  }
  const host = createAppHost({
    doc: document, win: window, slot, appId: "session-plus", packageDigest: "e".repeat(64),
    appOrigin: location.origin, projection: {}, drafts, loadModule: async () => ({ App, styles: [] }),
    onChange: (next) => mounted.rerender(<>{next.element}</>),
  });
  try {
    await act(async () => host.mount());
    const original = mounted.getByRole("textbox", { name: "Composer" });
    fireEvent.change(original, { target: { value: "keep this unsent draft" } });
    expect(drafts.read("composer").text).toBe("");
    const retired = current!;
    await act(async () => host.reconstruct());
    const replacement = mounted.getByRole("textbox", { name: "Composer" });
    expect(replacement).not.toBe(original);
    expect(replacement).toHaveValue("keep this unsent draft");
    expect(drafts.read("composer").text).toBe("keep this unsent draft");
    expect(retired.snapshot().phase).toBe("closed");
    retired.drafts.set("composer", "obsolete writer");
    expect(drafts.read("composer").text).toBe("keep this unsent draft");
  } finally {
    act(() => host.dispose());
    mounted.unmount();
    drafts.destroy();
    slot.remove();
  }
});
