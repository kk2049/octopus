/**
 * The three deck modules: a manifest and a mount for each.
 *
 * ── What lives here rather than in the components ───────────────────────────
 *
 * Reading the instance's config, reading the deck through it, holding the
 * per-instance state (a selection, an armed delete, a notice), turning a
 * canvas gesture into `deck-model/v1` commands, and raising the ONE layout
 * intent. Nothing else — the components take props and return elements, which
 * is what lets a test render them from a fixture with no port at all.
 *
 * ── The one thing that is NOT here: an action string ────────────────────────
 *
 * `config.command_action` is the only action id in this package, and it is data
 * an App author wrote in a composition a reviewer read. What crosses is a
 * `deck-model/v1` command encoded by the CONTRACT, so the trusted side validates
 * with `readDeckCommand` — the same function — rather than trusting a shape this
 * bundle assembled. `architecture.test.ts` checks nothing here gained a literal.
 *
 * ── The commit model: a gesture is a command ────────────────────────────────
 *
 * The canvas edits in place, so each gesture maps to one command (two for a
 * reorder — `lib/edits.ts` states the mapping) and is proposed at once. There
 * is no batch and no save button, which dissolves the partial-save reporting
 * the old form needed. Gestures are still SERIALISED: commands from one panel
 * go out one at a time in gesture order, because two in flight could apply in
 * an order the person never performed. A refusal is shown where it happened;
 * the projection remains the only truth the canvas renders.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppData } from "@claude-bot/agent-data-view";
import type { InstanceConfig } from "@claude-bot/agent-module-contract";
import type { ModuleProps, ModuleRegistryEntry } from "@claude-bot/agent-view-react/workspace";
import {
  deckToTypst,
  encodeDeckCommand,
  findSlide,
  slideIndexOf,
  type DeckLayout,
  type DeckTheme,
  type WireDeckCommand,
} from "@claude-bot/deck-model-contract";
import { DeckOutline, type OutlineRow } from "./components/DeckOutline.js";
import { SlideCanvas, type CanvasNotice } from "./components/SlideCanvas.js";
import { TypstExport } from "./components/TypstExport.js";
import { nextSlideId, readDeckSource, type DeckSource } from "./lib/deck-source.js";
import {
  appendItemCommands,
  removeItemCommands,
  replaceTextCommands,
  scalarValue,
  swapItemCommands,
  listValue,
} from "./lib/edits.js";
import {
  DECK_OUTLINE_MANIFEST,
  DECK_SLIDE_CONTEXT_KEY,
  DECK_SLIDE_MANIFEST,
  DECK_SLIDE_RESOURCE_KIND,
  DECK_TYPST_MANIFEST,
  DECK_TYPST_RESOURCE_KIND,
} from "./manifests.js";

// ── config ──────────────────────────────────────────────────────────────────

/**
 * Config is read here and only here.
 *
 * A missing key is a fallback rather than a refusal, because the contract layer
 * has already refused everything ambiguous: an undeclared key, a wrong type and
 * a missing REQUIRED key are all link-time failures where a registry is present.
 */
function text(config: InstanceConfig | null, key: string, fallback = ""): string {
  const value = config?.[key];
  return typeof value === "string" && value ? value : fallback;
}

/** Distinguishes "not set" from "set to empty", which mean different things. */
function textOrUnset(config: InstanceConfig | null, key: string, fallback: string): string {
  const value = config?.[key];
  return typeof value === "string" ? value : fallback;
}

function useDomIdScope({ panel, workspace }: ModuleProps): string | undefined {
  const [scope] = useState(() => {
    const first = workspace.state.panels.find((candidate) => candidate.moduleId === panel.moduleId);
    return first?.panelId === panel.panelId ? undefined : panel.panelId;
  });
  return scope;
}

/** The deck this instance points at, recomputed only when the projection moves. */
function useDeckSource(source: string): { snapshotDeck: DeckSource; booting: boolean } {
  const { snapshot } = useAppData();
  const snapshotDeck = useMemo(() => readDeckSource(snapshot.projection, source), [snapshot.projection, source]);
  return { snapshotDeck, booting: snapshot.projection === null };
}

/** Lifecycle visibility for this instance's configured command action. */
function useActionInflight(action: string): boolean {
  const { snapshot } = useAppData();
  return Boolean(action) && snapshot.proposals.some(
    (proposal) => proposal.action === action && proposal.phase === "inflight",
  );
}

/**
 * Send commands one at a time, stopping at the first refusal.
 *
 * Answers with how many landed and the refusal that stopped it, because those
 * are two different facts and a caller that had only one of them could not write
 * an honest sentence.
 */
function useCommandRunner(action: string) {
  const { submit } = useAppData();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const run = useCallback(
    async (commands: readonly WireDeckCommand[]): Promise<{ applied: number; refusal: string }> => {
      let applied = 0;
      for (const command of commands) {
        const params = encodeDeckCommand(command);
        /* c8 ignore next -- `WireDeckCommand` excludes the one that answers null */
        if (!params) return { applied, refusal: "这条命令不能通过这个通道提交。" };
        const reply = await submit(action, params).catch(() => ({
          ok: false,
          message: "这次提交没有返回结果。",
        }));
        if (!reply.ok) return { applied, refusal: reply.message || "可信外层拒绝了这次提交。" };
        applied += 1;
      }
      return { applied, refusal: "" };
    },
    [action, submit],
  );

  return { run, live };
}

/**
 * Raise the one layout intent: "show this deck, at this slide".
 *
 * The ref is the deck and the slide rides in `context`. `layout-finding.test.ts`
 * has the measurement that makes this the right way round; the short version is
 * that a ref per slide would put every slide after the first into an anonymous
 * panel with no config.
 *
 * `open()` answers false when the composition cannot route the intent. Local
 * selection has already happened, so a refusal costs a highlight — and inventing
 * a fallback route here would be this module deciding what the composition
 * declined to.
 */
function openSlide(
  workspace: ModuleProps["workspace"],
  spec: { kind: string; deckRef: string; view: string; slide: string; label: string },
): void {
  workspace.open(
    { kind: spec.kind, ref: spec.deckRef, label: spec.label },
    { context: { [DECK_SLIDE_CONTEXT_KEY]: spec.slide }, ...(spec.view ? { view: spec.view } : {}) },
  );
}

// ── deck.outline/v1 ─────────────────────────────────────────────────────────

function DeckOutlineModule({ panel, workspace }: ModuleProps) {
  const config = panel.config;
  const source = text(config, "source");
  const action = text(config, "command_action");
  const openKind = text(config, "open_kind", DECK_SLIDE_RESOURCE_KIND);
  const openView = text(config, "open_view");
  const exportKind = textOrUnset(config, "export_kind", DECK_TYPST_RESOURCE_KIND);
  // Both kinds address the DECK. Which slide, and which panel, are context and
  // layout respectively — see `DECK_SLIDE_RESOURCE_KIND`'s comment.
  const deckRef = source || "deck";
  const domIdScope = useDomIdScope({ panel, workspace });
  const { snapshotDeck, booting } = useDeckSource(source);
  const { run, live } = useCommandRunner(action);
  const actionInflight = useActionInflight(action);

  const [selected, setSelected] = useState<string | null>(null);
  const [arming, setArming] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const busy = submitting || actionInflight;

  const deck = snapshotDeck.deck;
  const rows = useMemo<OutlineRow[]>(
    () => (deck ? deck.slides.map((slide) => ({ id: slide.id, slide })) : []),
    [deck],
  );

  const send = useCallback(
    (commands: readonly WireDeckCommand[], done: string) => {
      if (!action || busy || !commands.length) return;
      setSubmitting(true);
      setNotice("");
      void run(commands).then((result) => {
        if (!live.current) return;
        setSubmitting(false);
        setNotice(result.refusal || done);
      });
    },
    [action, busy, live, run],
  );

  const onSelect = useCallback(
    (id: string) => {
      setSelected(id);
      setArming(null);
      const slide = deck ? findSlide(deck, id) : null;
      // `open()` answers false when the composition cannot route the intent.
      // Local selection has already happened, so a refusal costs a highlight —
      // and inventing a fallback route here would be this module deciding what
      // the composition declined to.
      openSlide(workspace, { kind: openKind, deckRef, view: openView, slide: id, label: slide?.title || id });
    },
    [deck, deckRef, openKind, openView, workspace],
  );

  const onMove = useCallback(
    (id: string, delta: -1 | 1) => {
      if (!deck) return;
      const at = slideIndexOf(deck, id);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= deck.slides.length) return;
      send([{ op: "move_slide", slide: id, index: to }], "");
    },
    [deck, send],
  );

  const onInsert = useCallback(
    (layout: DeckLayout) => {
      if (!deck) return;
      const id = nextSlideId(deck);
      // After the insert, the new slide is what the reader wants to be editing.
      // Selecting optimistically would highlight a slide that may not exist; so
      // the selection is set only once the command has landed.
      if (!action || busy) return;
      setSubmitting(true);
      setNotice("");
      void run([{ op: "insert_slide", slide: id, layout, index: deck.slides.length }]).then((result) => {
        if (!live.current) return;
        setSubmitting(false);
        if (result.refusal) {
          setNotice(result.refusal);
          return;
        }
        setSelected(id);
        openSlide(workspace, { kind: openKind, deckRef, view: openView, slide: id, label: id });
      });
    },
    [action, busy, deck, deckRef, live, openKind, openView, run, workspace],
  );

  const onRemove = useCallback(
    (id: string) => {
      setArming(null);
      send([{ op: "remove_slide", slide: id }], "已删除这一页。它的恢复只能由服务端的撤销记录完成。");
      if (selected === id) setSelected(null);
    },
    [selected, send],
  );

  const onExport = useCallback(() => {
    if (!exportKind) return;
    workspace.open({ kind: exportKind, ref: deckRef, label: "Typst 源码" });
  }, [deckRef, exportKind, workspace]);

  return (
    <DeckOutline
      title={text(config, "title", panel.label)}
      deckTitle={deck?.title ?? ""}
      status={snapshotDeck.status}
      source={source}
      issues={snapshotDeck.issues}
      rows={rows}
      theme={deck?.theme ?? "light"}
      selected={selected}
      booting={booting}
      emptyText={text(config, "empty_text")}
      editable={Boolean(action)}
      busy={busy}
      arming={arming}
      canExport={Boolean(exportKind)}
      notice={notice}
      domIdScope={domIdScope}
      onSelect={onSelect}
      onMove={onMove}
      onInsert={onInsert}
      onArm={setArming}
      onRemove={onRemove}
      onExport={onExport}
    />
  );
}

// ── deck.slide/v1 ───────────────────────────────────────────────────────────

function DeckSlideModule({ panel, workspace }: ModuleProps) {
  const config = panel.config;
  const source = text(config, "source");
  const action = text(config, "command_action");
  const deckRef = source || "deck";
  const { snapshotDeck, booting } = useDeckSource(source);
  const { run, live } = useCommandRunner(action);
  const actionInflight = useActionInflight(action);

  // The ref names the deck; the context says which slide. See
  // `DECK_SLIDE_RESOURCE_KIND` for the measurement that decided that.
  // With no selection yet, the canvas shows the FIRST slide — a deck opens at
  // page one, it does not open at an invitation to pick a page.
  const requestedId = panel.context?.[DECK_SLIDE_CONTEXT_KEY] ?? "";
  const deck = snapshotDeck.deck;
  const slideId = requestedId || deck?.slides[0]?.id || "";
  const slide = deck && slideId ? findSlide(deck, slideId) : null;

  const [pending, setPending] = useState(0);
  const [notice, setNotice] = useState<CanvasNotice | null>(null);

  // Gestures are serialised: each commit waits for the previous one, so two
  // quick edits reach the App in the order they were performed.
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const commit = useCallback(
    (commands: readonly WireDeckCommand[], overwrote: boolean) => {
      if (!action || !commands.length) return;
      setNotice(null);
      setPending((count) => count + 1);
      const turn = queue.current.then(() => run(commands));
      queue.current = turn.then(
        () => undefined,
        () => undefined,
      );
      void turn.then((result) => {
        if (!live.current) return;
        setPending((count) => count - 1);
        if (result.refusal) {
          setNotice({
            tone: "error",
            // Two facts when a multi-command gesture stops halfway.
            text:
              commands.length > 1 && result.applied > 0
                ? `前 ${result.applied} 条已写入，第 ${result.applied + 1} 条被拒绝：${result.refusal}`
                : `这次修改被拒绝：${result.refusal}`,
          });
        } else if (overwrote) {
          // No expected-digest on this channel (worklog wall 5): two writers to
          // one field are last-writer-wins. Detected and said, never prevented.
          setNotice({ tone: "warn", text: "这一段刚在别处被改过；画布上现在是你输入的版本。" });
        }
      });
    },
    [action, live, run],
  );

  const onText = useCallback(
    (field: string, index: number | null, next: string, seed: string) => {
      if (!slide) return;
      const current = index === null ? scalarValue(slide, field) : (listValue(slide, field)[index] ?? "");
      commit(replaceTextCommands(slide, field, index, next), seed !== current);
    },
    [commit, slide],
  );

  const onAddItem = useCallback(
    (field: string, value: string) => {
      if (slide) commit(appendItemCommands(slide, field, value), false);
    },
    [commit, slide],
  );

  const onRemoveItem = useCallback(
    (field: string, index: number) => {
      if (slide) commit(removeItemCommands(slide, field, index), false);
    },
    [commit, slide],
  );

  const onMoveItem = useCallback(
    (field: string, index: number, delta: -1 | 1) => {
      if (slide) commit(swapItemCommands(slide, field, index, delta), false);
    },
    [commit, slide],
  );

  const onInsertSlide = useCallback(
    (layout: DeckLayout) => {
      if (!deck || !action) return;
      const id = nextSlideId(deck);
      setNotice(null);
      setPending((count) => count + 1);
      const turn = queue.current.then(() => run([{ op: "insert_slide", slide: id, layout, index: deck.slides.length }]));
      queue.current = turn.then(
        () => undefined,
        () => undefined,
      );
      void turn.then((result) => {
        if (!live.current) return;
        setPending((count) => count - 1);
        if (result.refusal) {
          setNotice({ tone: "error", text: `这次修改被拒绝：${result.refusal}` });
          return;
        }
        openSlide(workspace, { kind: DECK_SLIDE_RESOURCE_KIND, deckRef, view: "", slide: id, label: id });
      });
    },
    [action, deck, deckRef, live, run, workspace],
  );

  const onTheme = useCallback(
    (theme: DeckTheme) => {
      commit([{ op: "set_theme", value: theme }], false);
    },
    [commit],
  );

  if (booting || snapshotDeck.status !== "ok" || !slide) {
    return (
      <section className="dkv-editor" data-dkv-source={source} data-dkv-status={snapshotDeck.status}>
        <header className="dkv-head">
          <b>{text(config, "title", panel.label)}</b>
        </header>
        {booting ? (
          <p className="dkv-note" role="note">⏳ 正在等待第一份投影…</p>
        ) : snapshotDeck.status !== "ok" ? (
          <p className="dkv-note" role="note">
            这个组合指向的 deck 读不出来：<code>{source}</code>
          </p>
        ) : requestedId ? (
          <p className="dkv-note" role="note">这一页已经不在 deck 里了。</p>
        ) : (
          <p className="dkv-note" role="note">这份 deck 还没有任何一页；从左边加一页开始。</p>
        )}
      </section>
    );
  }

  return (
    <SlideCanvas
      title={text(config, "title", panel.label)}
      slide={slide}
      theme={deck!.theme}
      index={slideIndexOf(deck!, slide.id)}
      count={deck!.slides.length}
      editable={Boolean(action)}
      pending={Math.max(pending, actionInflight ? 1 : 0)}
      notice={notice}
      hint={text(config, "hint")}
      onText={onText}
      onAddItem={onAddItem}
      onRemoveItem={onRemoveItem}
      onMoveItem={onMoveItem}
      onInsertSlide={onInsertSlide}
      onTheme={onTheme}
      {...(requestedId ? { onClose: () => workspace.close(panel.panelId) } : {})}
    />
  );
}

// ── deck.typst/v1 ───────────────────────────────────────────────────────────

function DeckTypstModule({ panel, workspace }: ModuleProps) {
  const config = panel.config;
  const source = text(config, "source");
  const { snapshotDeck, booting } = useDeckSource(source);

  // Derived on every projection change, never cached across one: the whole
  // point of §15.5 is that this file is a function of the deck.
  const typst = useMemo(() => (snapshotDeck.deck ? deckToTypst(snapshotDeck.deck) : ""), [snapshotDeck.deck]);

  // Selecting and copying need the rendered node, so they live in the component
  // with the ref. This module stays free of the DOM, like the other two.
  return (
    <TypstExport
      title={text(config, "title", panel.label)}
      status={snapshotDeck.status}
      source={source}
      issues={snapshotDeck.issues}
      booting={booting}
      typst={typst}
      slideCount={snapshotDeck.deck?.slides.length ?? 0}
      {...(panel.resourceRef ? { onClose: () => workspace.close(panel.panelId) } : {})}
    />
  );
}

// ── registry entries ────────────────────────────────────────────────────────

export const DECK_OUTLINE_MODULE: ModuleRegistryEntry = Object.freeze({
  manifest: DECK_OUTLINE_MANIFEST,
  component: DeckOutlineModule,
});

export const DECK_SLIDE_MODULE: ModuleRegistryEntry = Object.freeze({
  manifest: DECK_SLIDE_MANIFEST,
  component: DeckSlideModule,
});

export const DECK_TYPST_MODULE: ModuleRegistryEntry = Object.freeze({
  manifest: DECK_TYPST_MANIFEST,
  component: DeckTypstModule,
});

export const DECK_MODULES: readonly ModuleRegistryEntry[] = Object.freeze([
  DECK_OUTLINE_MODULE,
  DECK_SLIDE_MODULE,
  DECK_TYPST_MODULE,
]);

/** Every config key each module actually reads. `config.test.ts` compares them. */
export const CONFIG_KEYS_READ = Object.freeze({
  outline: Object.freeze(["source", "title", "command_action", "open_kind", "open_view", "export_kind", "empty_text"]),
  slide: Object.freeze(["source", "title", "command_action", "hint"]),
  typst: Object.freeze(["source", "title"]),
});
