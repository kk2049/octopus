/**
 * The standard shell, exercised the way a zero-code App uses it.
 *
 * The claim being tested is narrow and checkable: given three release documents
 * as data, a module list and a table of adapters, ONE element assembles a
 * working workspace — and every way that can go wrong is a sentence rather than
 * a blank frame.
 *
 * The modules here are trivial on purpose. What is under test is the assembly:
 * that a port really reaches a module through the factory the App supplied, that
 * the adapters are released when the tree goes away, that a plan which does not
 * link is fatal instead of degraded, and that a declared binding with no adapter
 * is named rather than discovered as a crash one render later.
 */

import { createContext, useContext, type ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  COMPOSITION_SCHEMA,
  RESOURCE_BINDINGS_SCHEMA,
  RESOURCE_BINDINGS_SCHEMA_V2,
  type AgentComposition,
  type AgentModuleManifest,
  type AgentResourceBindings,
  type ResourceBindingPlan,
} from "@claude-bot/agent-module-contract";
import { AgentViewProvider } from "../provider.js";
import { createFixtureAgentViewClient } from "@claude-bot/agent-view-preview";
import type { ModuleProps, ModuleRegistryEntry } from "../workspace/index.js";
import { StandardApp, type AppTransport, type PortAdapterFactory } from "./StandardApp.js";

const APP = "demo";
const DEMO_CONTRACT = "demo-notes/v1";

/** The port these test modules read, and the only thing they know about. */
interface NotesPort {
  label: string;
  propose(): Promise<{ ok: boolean; message: string }>;
}

const NotesContext = createContext<NotesPort | null>(null);

const manifest = (id: string, overrides: Partial<AgentModuleManifest> = {}): AgentModuleManifest => ({
  id,
  version: "1.0.0",
  implementation: `test#${id}`,
  title: id,
  slots: ["navigation", "primary", "secondary", "bottom"],
  ports: [],
  opens: [],
  ...overrides,
});

function Notes({ panel }: ModuleProps) {
  const port = useContext(NotesContext);
  return (
    <div>
      <span data-testid={`label-${panel.panelId}`}>{port ? port.label : "(no port)"}</span>
      <span data-testid={`config-${panel.panelId}`}>{String(panel.config?.source ?? "")}</span>
      <button type="button" onClick={() => void port?.propose()}>
        propose-{panel.panelId}
      </button>
    </div>
  );
}

const NOTES_MODULE: ModuleRegistryEntry = {
  manifest: manifest("demo.notes/v1", {
    ports: [DEMO_CONTRACT],
    opens: ["note"],
    config: { source: { type: "string" } },
  }),
  component: Notes,
};

const PLAIN_MODULE: ModuleRegistryEntry = {
  manifest: manifest("demo.plain/v1"),
  component: ({ panel }: ModuleProps) => <span data-testid={`plain-${panel.panelId}`}>plain</span>,
};

const COMPOSITION: AgentComposition = {
  schema: COMPOSITION_SCHEMA,
  app: APP,
  instances: [
    { instance: "left", module: NOTES_MODULE.manifest.id, slot: "navigation", config: { source: "inbox" } },
    { instance: "right", module: NOTES_MODULE.manifest.id, slot: "primary", config: { source: "archive" } },
    { instance: "strip", module: PLAIN_MODULE.manifest.id, slot: "bottom" },
  ],
  open: [],
};

const BINDINGS: AgentResourceBindings = {
  schema: RESOURCE_BINDINGS_SCHEMA,
  app: APP,
  bindings: [{ binding: "notes", contract: DEMO_CONTRACT }],
  connections: [
    { instance: "left", port: DEMO_CONTRACT, binding: "notes" },
    { instance: "right", port: DEMO_CONTRACT, binding: "notes" },
  ],
};

const TEMPLATE_BINDINGS: ResourceBindingPlan = {
  ...BINDINGS,
  schema: RESOURCE_BINDINGS_SCHEMA_V2,
  templates: [{ instance: "right", maxInstances: 3 }],
};

/** A factory that records how often it was built and torn down. */
function notesAdapter(label = "接上了") {
  const built: AppTransport[] = [];
  const destroy = vi.fn();
  const factory: PortAdapterFactory = (transport) => {
    built.push(transport);
    const port: NotesPort = {
      label,
      propose: async () => {
        const reply = await transport.propose("add_note", { title: "x" });
        return { ok: reply.ok, message: reply.message };
      },
    };
    return {
      provide: (children: ReactNode) => <NotesContext.Provider value={port}>{children}</NotesContext.Provider>,
      destroy,
    };
  };
  return { factory, built, destroy };
}

function mount(
  ui: ReactNode,
  fixture = createFixtureAgentViewClient({ projection: { ok: true } }),
) {
  const view = render(<AgentViewProvider client={fixture.client}>{ui}</AgentViewProvider>);
  return { ...view, fixture };
}

describe("StandardApp", () => {
  it("assembles a whole workspace from the release documents and one element", () => {
    const notes = notesAdapter();
    mount(
      <StandardApp
        composition={COMPOSITION}
        bindings={BINDINGS}
        modules={[NOTES_MODULE, PLAIN_MODULE]}
        adapters={{ [DEMO_CONTRACT]: notes.factory }}
      />,
    );
    // Three panels, in the three slots the composition named.
    expect(document.querySelector('[data-av-slot="navigation"] [data-av-panel="left"]')).not.toBeNull();
    expect(document.querySelector('[data-av-slot="primary"] [data-av-panel="right"]')).not.toBeNull();
    expect(document.querySelector('[data-av-slot="bottom"] [data-av-panel="strip"]')).not.toBeNull();
  });

  it("offers the bounded docking presentation without changing the plan or ports", async () => {
    const notes = notesAdapter();
    mount(
      <StandardApp
        composition={COMPOSITION}
        bindings={BINDINGS}
        modules={[NOTES_MODULE, PLAIN_MODULE]}
        adapters={{ [DEMO_CONTRACT]: notes.factory }}
        presentation="dock-documents"
      />,
    );
    await waitFor(() => expect(document.querySelector("[data-av-dock-workspace]")).not.toBeNull());
    expect(screen.getByTestId("label-left")).toHaveTextContent("接上了");
    expect(screen.getByTestId("label-right")).toHaveTextContent("接上了");
    expect(notes.built).toHaveLength(1);
  });

  it("hands each module the port its App supplied, and each instance its own config", () => {
    const notes = notesAdapter("笔记端口");
    mount(
      <StandardApp
        composition={COMPOSITION}
        bindings={BINDINGS}
        modules={[NOTES_MODULE, PLAIN_MODULE]}
        adapters={{ [DEMO_CONTRACT]: notes.factory }}
      />,
    );
    expect(screen.getByTestId("label-left")).toHaveTextContent("笔记端口");
    expect(screen.getByTestId("config-left")).toHaveTextContent("inbox");
    expect(screen.getByTestId("config-right")).toHaveTextContent("archive");
    // Built ONCE for the whole workspace, not once per consuming panel.
    expect(notes.built).toHaveLength(1);
  });

  it("assembles a v2 template plan through the same adapter boundary", () => {
    const notes = notesAdapter("模板端口");
    mount(
      <StandardApp
        composition={{
          ...COMPOSITION,
          open: [{ resource: "note", module: NOTES_MODULE.manifest.id, slot: "primary" }],
        }}
        bindings={TEMPLATE_BINDINGS}
        modules={[NOTES_MODULE, PLAIN_MODULE]}
        adapters={{ [DEMO_CONTRACT]: notes.factory }}
      />,
    );
    expect(screen.getByTestId("label-right")).toHaveTextContent("模板端口");
    expect(notes.built).toHaveLength(1);
  });

  it("gives the adapter the provider's propose, so a refusal becomes a notice", async () => {
    const user = userEvent.setup();
    const notes = notesAdapter();
    mount(
      <StandardApp
        composition={COMPOSITION}
        bindings={BINDINGS}
        modules={[NOTES_MODULE, PLAIN_MODULE]}
        adapters={{ [DEMO_CONTRACT]: notes.factory }}
      />,
      createFixtureAgentViewClient({
        projection: {},
        actions: { add_note: { ok: false, message: "不行" } },
      }),
    );
    await user.click(screen.getByText("propose-left"));
    // The provider records the Host's sentence; the raw client would not have.
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("不行"));
  });

  it("releases every adapter when the tree goes away", () => {
    const notes = notesAdapter();
    const view = mount(
      <StandardApp
        composition={COMPOSITION}
        bindings={BINDINGS}
        modules={[NOTES_MODULE, PLAIN_MODULE]}
        adapters={{ [DEMO_CONTRACT]: notes.factory }}
      />,
    );
    expect(notes.destroy).not.toHaveBeenCalled();
    view.unmount();
    expect(notes.destroy).toHaveBeenCalled();
  });

  it("does not rebuild ports when the App writes its adapter table inline", () => {
    const notes = notesAdapter();
    const view = mount(
      <StandardApp
        composition={COMPOSITION}
        bindings={BINDINGS}
        modules={[NOTES_MODULE, PLAIN_MODULE]}
        adapters={{ [DEMO_CONTRACT]: notes.factory }}
      />,
    );
    // A fresh object literal and a fresh closure, exactly what an inline table
    // produces. Rebuilding here would re-open a resource port's streams on every
    // render — the footgun this memo key exists to disarm.
    view.rerender(
      <AgentViewProvider client={view.fixture.client}>
        <StandardApp
          composition={COMPOSITION}
          bindings={BINDINGS}
          modules={[NOTES_MODULE, PLAIN_MODULE]}
          adapters={{ [DEMO_CONTRACT]: notesAdapter().factory }}
        />
      </AgentViewProvider>,
    );
    expect(notes.built).toHaveLength(1);
    expect(notes.destroy).not.toHaveBeenCalled();
  });

  it("names a declared binding that has no adapter instead of crashing a render later", () => {
    mount(
      <StandardApp composition={COMPOSITION} bindings={BINDINGS} modules={[NOTES_MODULE, PLAIN_MODULE]} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(DEMO_CONTRACT);
    expect(screen.getByRole("alert")).toHaveTextContent("没有为它提供 adapter");
  });

  it("reports a composition that does not link, rather than degrading a panel", () => {
    mount(
      <StandardApp
        composition={{
          ...COMPOSITION,
          instances: [{ instance: "left", module: "demo.absent/v1", slot: "navigation" }],
        }}
        modules={[PLAIN_MODULE]}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("demo.absent/v1");
  });

  it("mounts App-own providers outside the resource adapters", () => {
    const wrapper = (name: string): PortAdapterFactory => () => ({
      provide: (children: ReactNode) => <div data-wrap={name}>{children}</div>,
    });
    mount(
      <StandardApp
        composition={{ ...COMPOSITION, instances: [COMPOSITION.instances[2]!], open: [] }}
        bindings={{ ...BINDINGS, connections: [] }}
        modules={[PLAIN_MODULE]}
        providers={{ "app-data/v1": wrapper("own") }}
        adapters={{ [DEMO_CONTRACT]: wrapper("resource") }}
      />,
    );
    // Nesting, not call order: a resource provider may read App state, and not
    // the other way round.
    expect(document.querySelector('[data-wrap="own"] [data-wrap="resource"]')).not.toBeNull();
    expect(document.querySelector('[data-wrap="resource"] [data-wrap="own"]')).toBeNull();
  });

  it("waits rather than assembling before there is a channel", () => {
    // A real client is `waiting` until the Host transfers a port. The snapshot
    // object is frozen and shared, because `useSyncExternalStore` compares by
    // identity — a fresh object per call is an infinite render loop.
    const waiting = createFixtureAgentViewClient({ projection: null });
    const frozen = Object.freeze({ ...waiting.client.snapshot(), phase: "waiting" as const });
    const notes = notesAdapter();
    render(
      <AgentViewProvider client={{ ...waiting.client, snapshot: () => frozen }}>
        <StandardApp
          composition={COMPOSITION}
          bindings={BINDINGS}
          modules={[NOTES_MODULE, PLAIN_MODULE]}
          adapters={{ [DEMO_CONTRACT]: notes.factory }}
        />
      </AgentViewProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("等待可信外层转交通道");
    expect(document.querySelector('[data-av-panel="left"]')).toBeNull();
  });

  it("applies the default chrome and lets an App override one slot without losing the rest", () => {
    const notes = notesAdapter();
    mount(
      <StandardApp
        composition={COMPOSITION}
        bindings={BINDINGS}
        modules={[NOTES_MODULE, PLAIN_MODULE]}
        adapters={{ [DEMO_CONTRACT]: notes.factory }}
        chrome={{ primary: { className: "mine" } }}
      />,
    );
    expect(document.querySelector('[data-av-slot="navigation"]')).toHaveClass("av-std-nav");
    expect(document.querySelector('[data-av-slot="primary"]')).toHaveClass("mine");
    // The rail's splitter survives an override of a different slot.
    expect(document.querySelector(".av-splitter")).not.toBeNull();
  });

  it("renders the App's header even when the plan is fatal", () => {
    mount(
      <StandardApp
        composition={COMPOSITION}
        modules={[PLAIN_MODULE]}
        header={<b data-testid="head">我的 App</b>}
      />,
    );
    expect(screen.getByTestId("head")).toBeInTheDocument();
  });
});
