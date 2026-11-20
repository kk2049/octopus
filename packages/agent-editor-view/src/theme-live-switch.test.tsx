/**
 * Ticket #45 correction #7 (jsdom half): what CAN be proved without a browser.
 *
 * ── Why this file no longer asserts real colours ────────────────────────────
 *
 * The previous version used `getComputedStyle(...)`.backgroundColor` and
 * `.getPropertyValue("--av-*")` to prove that a live theme flip changed the
 * pixels CodeMirror paints. That was correct as a THING TO ASSERT, but wrong
 * as a place to assert it: jsdom (verified on the workspace's pinned
 * jsdom@27.4.0) does not resolve inherited CSS custom properties into a
 * concrete value and does not fold `background: var(--av-*)` into an RGB
 * string. Both `.getPropertyValue("--av-surface")` (on any element other
 * than the one that declared it) and `.backgroundColor` (on an element
 * whose declared value is `var(--av-*)`) return "" or the literal
 * `var(...)` text respectively. A test that survived those calls at all
 * would be one that stopped after `.startsWith("var(")` — asserting
 * nothing about what the browser would paint.
 *
 * So the responsibility split is written down:
 *
 *   THIS file (jsdom)  — the extension really runs; the editor is not rebuilt;
 *                        the CodeMirror-injected `<style>` rule contains
 *                        `var(--av-*)` REFERENCES for every property
 *                        `AV_TOKEN_THEME` sets. If someone removes the
 *                        extension, the style rule loses those tokens and
 *                        this file fails.
 *   BROWSER e2e        — the actual computed colour on `.cm-editor` /
 *   (Playwright)         `.cm-gutters` moves when `data-av-theme` moves; the
 *                        editor identity survives the flip. See the ticket
 *                        #45 case in `packages/bot/src/session-plus/browser.e2e.test.ts`.
 *
 * Neither replaces the other. Structural claim (the token references leave
 * this bundle) does not need a browser; visual claim (those references
 * resolve to real pixels the user sees) does.
 */

import { afterEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { LayoutPanel, WorkspaceApi } from "@claude-bot/agent-view-react/workspace";
import type { ResourceLink } from "@claude-bot/agent-module-contract";
import { WorkspaceFilesProvider } from "@claude-bot/agent-workspace-files-view";
import { EDITOR_MODULE } from "./modules.js";
import { EDITOR_MODULE_ID, WORKSPACE_TEXT_RESOURCE_KIND } from "./manifests.js";
import {
  createWritableMemoryWorkspaceFilesPort,
  digestOf,
  type WritableMemoryFixture,
  type WritableMemoryWorkspaceFilesPort,
} from "./harness/writable-memory-port.js";

const TEXT = "line one\nline two\nline three\n";

function fixture(): WritableMemoryFixture {
  return {
    roots: { roots: [{ ref: "r1", label: "octopus", sourceLabel: "laptop" }], truncated: false },
    directories: {
      r1: {
        ref: "r1",
        label: "octopus",
        truncated: false,
        entries: [{ ref: "f1", label: "notes.md", kind: "file", sizeBytes: TEXT.length }],
      },
    },
    files: {
      f1: {
        document: {
          ref: "f1",
          label: "notes.md",
          mediaType: "text/plain; charset=utf-8",
          sizeBytes: TEXT.length,
          digest: digestOf(TEXT),
        },
        text: TEXT,
      },
    },
  };
}

function fakeWorkspace(panels: LayoutPanel[]): WorkspaceApi {
  return {
    state: { panels, active: {} as never, focused: null, narrow: false, drilledIn: false, seq: 0 },
    open: (_resource: ResourceLink) => true,
    openIntent: () => true,
    focus: () => undefined,
    close: () => undefined,
    report: () => undefined,
    back: () => undefined,
  };
}

function panelOf(overrides: Partial<LayoutPanel> = {}): LayoutPanel {
  return {
    panelId: "editor",
    moduleId: EDITOR_MODULE_ID,
    slot: "secondary",
    resourceRef: "f1",
    resourceKind: WORKSPACE_TEXT_RESOURCE_KIND,
    label: "notes.md",
    status: "ready",
    reason: "",
    detail: "",
    config: null,
    context: null,
    ...overrides,
  };
}

afterEach(() => {
  delete document.documentElement.dataset.avTheme;
});

interface MountedEditor {
  surface: HTMLElement;
  editor: HTMLElement;
  gutters: HTMLElement;
  port: WritableMemoryWorkspaceFilesPort;
}

async function mountLoaded(port: WritableMemoryWorkspaceFilesPort): Promise<MountedEditor> {
  const p = panelOf();
  const Editor = EDITOR_MODULE.component;
  render(
    <WorkspaceFilesProvider port={port.port}>
      <Editor panel={p} workspace={fakeWorkspace([p])} />
    </WorkspaceFilesProvider>,
  );
  const surface = await waitFor(() => {
    const el = document.querySelector(".wsedit-surface") as HTMLElement | null;
    if (!el) throw new Error("no surface yet");
    return el;
  });
  const editor = await waitFor(() => {
    const el = surface.querySelector(".cm-editor") as HTMLElement | null;
    if (!el) throw new Error("CodeMirror has not mounted");
    return el;
  });
  const gutters = await waitFor(() => {
    const el = editor.querySelector(".cm-gutters") as HTMLElement | null;
    if (!el) throw new Error("no gutters yet");
    return el;
  });
  await waitFor(() => {
    const text = [...surface.querySelectorAll(".cm-line")].map((l) => l.textContent ?? "").join("\n");
    expect(text).toContain("line one");
  });
  return { surface, editor, gutters, port };
}

/**
 * Collect the CSS text of every `<style>` element on the document, joined
 * with newlines. CodeMirror appends its theme (built from `EditorView.theme`
 * + `EditorView.baseTheme`) to `document.head` at mount time under the
 * document nonce; every `var(--av-*)` reference our `AV_TOKEN_THEME`
 * declares must appear here verbatim.
 */
function allStyleText(): string {
  return Array.from(document.querySelectorAll("style"))
    .map((el) => el.textContent ?? "")
    .join("\n");
}

describe("editor picks up live theme switches without rebuilding (ticket #45 — jsdom)", () => {
  it("mounts CodeMirror through the module and reads the file", async () => {
    // The scaffolding others rely on: the editor mounts, reads the fixture
    // and paints its content. If this fails everything below is meaningless.
    const port = createWritableMemoryWorkspaceFilesPort(fixture());
    const { editor, gutters } = await mountLoaded(port);
    expect(editor.isConnected).toBe(true);
    expect(gutters.isConnected).toBe(true);
    // No accidental extra reads: each read crosses a Gate.
    expect(port.calls.filter((c) => c.method === "openText").length).toBe(1);
  });

  it("the AV_TOKEN_THEME extension really injects rules that consume --av-* tokens", async () => {
    // CodeMirror translates `EditorView.theme({...})` into a `<style>`
    // element in the document. The class prefix it generates is opaque
    // (`.ͼa` etc.), but the VALUE strings are copied verbatim — so if the
    // extension is present, every property AV_TOKEN_THEME sets appears in
    // the stylesheet as a `var(--av-*)` reference. If someone removes the
    // extension the property either disappears entirely or reverts to
    // CodeMirror's baseTheme hard-coded colour, and this file fails.
    //
    // The set of references below is exactly the set of tokens
    // `AV_TOKEN_THEME` names in agent-text-view's shared surface. Keeping the two in sync
    // is the point of this test.
    const port = createWritableMemoryWorkspaceFilesPort(fixture());
    await mountLoaded(port);
    const styles = allStyleText();
    for (const ref of [
      "var(--av-fg)",
      "var(--av-surface)",
      "var(--av-accent)",
      "var(--av-accent-contrast, #fff)",
      "var(--av-warn, #d97706)",
      "var(--av-tool-bg)",
      "var(--av-muted)",
      "var(--av-line)",
    ]) {
      expect(styles, `expected some <style> element to contain ${ref}`).toContain(ref);
    }
  });

  it("switching data-av-theme does NOT rebuild the mounted editor instance", async () => {
    // The remaining half of the browser test that CAN be proved here: node
    // identity across the flip, no additional Gate reads. The colour change
    // itself is a browser property and is asserted in `browser.e2e.test.ts`.
    const port = createWritableMemoryWorkspaceFilesPort(fixture());
    const { surface, editor, gutters } = await mountLoaded(port);
    const readsBefore = port.calls.filter((c) => c.method === "openText").length;

    document.documentElement.dataset.avTheme = "aurora";
    // React does not re-render on a `document.documentElement` attribute
    // change; the editor is not remounted by React or by the module.
    expect(document.querySelector(".wsedit-surface")).toBe(surface);
    expect(surface.querySelector(".cm-editor")).toBe(editor);
    expect(editor.querySelector(".cm-gutters")).toBe(gutters);

    document.documentElement.dataset.avTheme = "ink";
    expect(document.querySelector(".wsedit-surface")).toBe(surface);
    expect(surface.querySelector(".cm-editor")).toBe(editor);

    delete document.documentElement.dataset.avTheme;
    expect(document.querySelector(".wsedit-surface")).toBe(surface);

    // No uncovenanted re-read triggered by the flip.
    expect(port.calls.filter((c) => c.method === "openText").length).toBe(readsBefore);
  });

  it("keeps `screen` in scope (harness reference)", () => {
    expect(typeof screen).toBe("object");
  });
});
