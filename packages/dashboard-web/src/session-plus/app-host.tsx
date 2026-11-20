import { type ComponentType, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { AgentViewErrorBoundary, AgentViewProvider } from "@claude-bot/agent-view-react";
import { createAppRuntimeClient, type AppRuntimeClient, type AgentViewOperation } from "@claude-bot/agent-view-react/runtime";
import { createSessionPlusHost, type HostDeps, type HostSnapshot as LegacySnapshot, type SessionPlusHost, type DispatchReply } from "./frame-host.js";
import { createElementPicker } from "../lib/element-picker.js";
import { uiValue, type UiTextValue } from "../i18n/ui-text.js";

export type { Proposal } from "./frame-host.js";
export interface HostSnapshot extends LegacySnapshot { element?: ReactNode }
export interface AppHostDeps extends Omit<HostDeps, "doc" | "win" | "slot" | "onChange"> {
  doc: Document;
  win: Window;
  slot: HTMLElement;
  appId: string;
  packageDigest: string;
  onChange?(snapshot: HostSnapshot): void;
  /** Browser tests can supply a real module without opening a network. */
  loadModule?(base: string): Promise<{ App: ComponentType; styles: string[]; scope?: string } | null>;
}

const styles = new Map<string, { element: HTMLLinkElement; ready: Promise<void>; count: number }>();
function acquireStyle(doc: Document, href: string): { ready: Promise<void>; release(): void } {
  let row = styles.get(href);
  if (!row) {
    const element = doc.createElement("link");
    element.rel = "stylesheet"; element.href = href;
    const ready = new Promise<void>((resolve, reject) => {
      element.onload = () => resolve();
      element.onerror = () => reject(new Error("App stylesheet unavailable"));
    });
    row = { element, ready, count: 0 };
    styles.set(href, row);
    doc.head.appendChild(element);
  }
  row.count++;
  let released = false;
  return { ready: row.ready, release() {
    if (released) return;
    released = true;
    if (--row!.count === 0) { row!.element.remove(); styles.delete(href); }
  } };
}

async function loadModule(base: string, appId: string): Promise<{ App: ComponentType; styles: string[]; scope?: string } | null> {
  const response = await fetch(base + "agent-view.entry.json", { credentials: "same-origin" });
  if (response.status === 404) return null; // An installed legacy release keeps its original renderer.
  if (!response.ok) throw new Error(`App manifest unavailable (${response.status})`);
  const entry = await response.json() as { schema?: string; runtime?: string; appId?: string; scope?: string; entry?: string; styles?: unknown };
  if (entry.schema !== "octopus-app-module/v1" || entry.runtime !== "octopus-ui/v1" || entry.appId !== appId
    || typeof entry.scope !== "string" || !entry.scope.startsWith(appId + "--") || !/^[a-z][a-z0-9-]{0,63}--[0-9a-f]{16}$/.test(entry.scope)
    || entry.entry !== "agent-view.js" || !Array.isArray(entry.styles)
    || !entry.styles.every((name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.css$/.test(name))) {
    throw new Error("App runtime version or manifest is incompatible");
  }
  const imported = await import(/* @vite-ignore */ base + entry.entry) as { default?: ComponentType };
  if (typeof imported.default !== "function" && typeof imported.default !== "object") throw new Error("App entry has no component");
  return { App: imported.default!, scope: entry.scope, styles: entry.styles.map((name: string) => base + name) };
}

/** One App in the existing React tree, with independently versioned executable bytes. */
export function createAppHost(deps: AppHostDeps): Omit<SessionPlusHost, "snapshot"> & { snapshot(): HostSnapshot } {
  let generation = 0;
  let disposed = false;
  let projection = deps.projection;
  let revision: number | undefined;
  let appearance = deps.appearance;
  let recovery = deps.recovery;
  let runtime: AppRuntimeClient | null = null;
  let legacy: SessionPlusHost | null = null;
  let releaseStyles: Array<() => void> = [];
  let latest: HostSnapshot = { state: "idle", detail: "", generation: 0, handshakes: 0, ports: 0, accepted: 0, refused: 0, ignored: 0, lastProposal: null, lastAnswer: null };
  const emit = (patch: Partial<HostSnapshot>): void => {
    latest = { ...latest, ...patch };
    if (!disposed) deps.onChange?.(latest);
  };
  const picker = createElementPicker(deps.doc, (picked) => deps.onDebugEvent?.("pick", picked));
  const stop = (why?: UiTextValue): void => {
    generation++;
    picker.stop();
    runtime?.close(); runtime = null;
    legacy?.dispose(why); legacy = null;
    for (const release of releaseStyles) release();
    releaseStyles = [];
    emit({ state: "idle", element: undefined, generation, detail: why ? uiValue(why) : "" });
  };
  const mount = (): void => {
    if (disposed || runtime || legacy) return;
    const mine = ++generation;
    emit({ state: "loading", detail: "", generation: mine, element: undefined });
    deps.slot.dataset.appSurface = deps.appId;
    deps.slot.dataset.avTheme = appearance?.theme ?? "classic";
    runtime = createAppRuntimeClient({
      projection, revision, appearance, recovery,
      drafts: deps.drafts ? { get: (key) => deps.drafts!.read(key), set: (key, text) => { deps.drafts!.write(key, text); }, subscribe: (key, listener) => deps.drafts!.subscribe(key, listener) } : undefined,
      onRecovery: (value) => { recovery = value; deps.onRecovery?.(value); },
      onPerformance: deps.onPerformance,
      dispatch: async (action, params) => {
        if (generation !== mine || disposed) return { ok: false, code: "instance_ended" };
        const proposal = { action, params };
        emit({ lastProposal: proposal });
        const answer: DispatchReply = await deps.dispatch?.(proposal) ?? { ok: false, code: "unavailable" };
        if (generation !== mine || disposed) return { ...answer, revision: typeof answer.revision === "number" ? answer.revision : undefined };
        const ok = answer.ok !== false;
        emit({ accepted: latest.accepted + (ok ? 1 : 0), refused: latest.refused + (ok ? 0 : 1), lastAnswer: { action, ok, code: answer.code } });
        if (Object.prototype.hasOwnProperty.call(answer, "projection")) {
          const nextRevision = typeof answer.revision === "number" ? answer.revision : undefined;
          if (nextRevision === undefined || revision === undefined || nextRevision > revision) { projection = answer.projection; if (nextRevision !== undefined) revision = nextRevision; }
        }
        return { ...answer, revision: typeof answer.revision === "number" ? answer.revision : undefined };
      },
    });
    const client = runtime;
    const base = `/ui/apps/${deps.packageDigest}/`;
    void (deps.loadModule ? deps.loadModule(base) : loadModule(base, deps.appId)).then(async (loaded) => {
      if (generation !== mine || disposed) return;
      if (!loaded) {
        client.close(); runtime = null;
        legacy = createSessionPlusHost({ ...deps, projection, appearance, recovery, onChange: (snapshot) => emit(snapshot) });
        legacy.mount();
        return;
      }
      deps.slot.dataset.appSurface = loaded.scope ?? deps.appId;
      deps.slot.dataset.appId = deps.appId;
      const acquired = loaded.styles.map((href) => acquireStyle(deps.doc, href));
      releaseStyles = acquired.map((row) => row.release);
      await Promise.all(acquired.map((row) => row.ready));
      if (generation !== mine || disposed) return;
      const App = loaded.App;
      emit({ state: "ready", element: <AgentViewProvider key={mine} client={client} uiProvider={false} reflectAppearance={false}>
        <AgentViewErrorBoundary onError={() => emit({ state: "degraded" })}><App /></AgentViewErrorBoundary>
      </AgentViewProvider> });
    }).catch((error: unknown) => {
      if (generation !== mine || disposed) return;
      client.close();
      for (const release of releaseStyles) release();
      releaseStyles = [];
      emit({ state: "unavailable", detail: error instanceof Error ? error.message.slice(0, 200) : "App unavailable" });
    });
  };
  return {
    mount,
    destroy: stop,
    dispose(why) { if (disposed) return; stop(why); disposed = true; },
    async reconstruct() {
      if (disposed) return;
      if (deps.resetResources && !await deps.resetResources()) return;
      // Commit the explicit replacement before closing its client: App effect
      // cleanup flushes deferred drafts and layout recovery through that client.
      // This runs from the rebuild action, never from React effect disposal.
      flushSync(() => emit({ element: undefined }));
      stop(); mount();
    },
    update(next, nextRevision) {
      if (typeof nextRevision === "number" && typeof revision === "number" && nextRevision <= revision) return;
      projection = next; if (nextRevision !== undefined) revision = nextRevision;
      runtime?.update(next, nextRevision); legacy?.update(next, nextRevision);
    },
    operation(next) { if (next && typeof next === "object") runtime?.operation(next as AgentViewOperation); legacy?.operation(next); },
    wake(next) { runtime?.wake(next); legacy?.wake(next); },
    updateAppearance(next) { appearance = next; deps.slot.dataset.avTheme = next.theme; runtime?.updateAppearance(next); legacy?.updateAppearance(next); },
    async debug(op) {
      if (legacy) return legacy.debug(op);
      if (op === "pick.start") { picker.start(); return { ok: true }; }
      if (op === "pick.stop") { picker.stop(); return { ok: true }; }
      return { ok: false, message: "unsupported debug action" };
    },
    snapshot: () => latest,
    onWindowMessage(event) { legacy?.onWindowMessage(event); },
  };
}
