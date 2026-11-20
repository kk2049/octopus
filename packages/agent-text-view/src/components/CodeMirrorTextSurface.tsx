import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  closeSearchPanel,
  getSearchQuery,
  openSearchPanel,
  search,
  searchKeymap,
  searchPanelOpen,
  setSearchQuery,
} from "@codemirror/search";
import { Annotation, Compartment, EditorState, Text, Transaction, type Extension } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { AvButton, adoptDocumentStyles, documentStyleNonce } from "@claude-bot/agent-view-react/ui";

const AV_TOKEN_THEME = EditorView.theme({
  "&": {
    color: "var(--av-fg)",
    backgroundColor: "var(--av-surface)",
  },
  ".cm-content": {
    caretColor: "var(--av-accent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--av-accent)",
  },
  ".cm-content::selection, .cm-content ::selection": {
    backgroundColor: "var(--av-accent)",
    color: "var(--av-accent-contrast, #fff)",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--av-warn, #d97706) 28%, transparent)",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--av-warn, #d97706) 48%, transparent)",
    outline: "1px solid var(--av-warn, #d97706)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--av-tool-bg)",
    color: "var(--av-muted)",
    borderRight: "1px solid var(--av-line)",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--av-tool-bg)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--av-tool-bg)",
    color: "var(--av-fg)",
  },
});

// Keep CodeMirror's search commands, query state and read-only guard. Only the
// presentation is local: selecting text must never turn on occurrence search.
const SEARCH_PHRASES = EditorState.phrases.of({
  Find: "查找内容",
  Replace: "替换为",
  next: "下一处",
  previous: "上一处",
  all: "全选匹配",
  "match case": "区分大小写",
  regexp: "正则表达式",
  "by word": "全词匹配",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭查找",
  "current match": "当前匹配",
  "on line": "所在行",
  "replaced match on line $": "已替换第 $ 行的匹配",
  "replaced $ matches": "已替换 $ 处匹配",
});

/** Programmatic stream/reload updates are not user edits and must not create a draft. */
const EXTERNAL_DOCUMENT = Annotation.define<boolean>();

/**
 * CodeMirror's own CSS, put where a released document can accept it (#253).
 *
 * ── What the reader saw ─────────────────────────────────────────────────────
 *
 * "跳转成功了，能看到行号，但是页面内容并加载不出来" — a file name, a real size,
 * the toolbar, then 1 2 3 … 19 and nothing else. Measured in a real browser:
 * `.cm-scroller` computes to `display: block`, and the content box sits
 * DIRECTLY BELOW the gutter box at the same x and width. That is not a failed
 * read; it is CodeMirror with no stylesheet. The gutter stops being a sticky
 * column beside the text and becomes a stack of line numbers above it, and on a
 * phone the text is simply below the fold.
 *
 * ── Why the nonce is not there to be had ────────────────────────────────────
 *
 * `style-mod` builds that CSS while the editor initialises and mounts it as a
 * `<style>`. A published release document is `style-src 'sha256-…'` over an
 * immutable cached body (see `adoptDocumentStyles`), so there is no nonce on it
 * and the browser refuses the element — with no error, leaving `.sheet` null and
 * the rules sitting in `textContent`. `EditorView.cspNonce` only helps the
 * unpublished shape, and this surface has shipped since #201 relying on it.
 *
 * ── The repair, and its bounds ──────────────────────────────────────────────
 *
 * Adopt exactly the element style-mod just created, and only when the document
 * REFUSED it. The element is identified by having appeared across the
 * `new EditorView(...)` call — not by sniffing its content, and not by walking
 * every blocked `<style>` in the document, which would hand the same repair to
 * anything the transcript renders. `state.facet(EditorView.styleModule)` is not
 * enough on its own: the base theme — the half that carries `.cm-scroller`,
 * `.cm-content` and `.cm-line` — is concatenated inside `EditorView` and never
 * reaches that facet.
 */
let generated: HTMLStyleElement | null = null;

/** Style elements this document already had, so a new one is identifiable. */
function styleSnapshot(): ReadonlySet<Element> {
  if (typeof document === "undefined") return new Set();
  return new Set(document.querySelectorAll("style"));
}

/** Remember the element the editor's construction added, if it added one. */
function rememberGeneratedStyles(before: ReadonlySet<Element>): void {
  if (typeof document === "undefined") return;
  if (generated?.isConnected) return;
  generated = null;
  for (const style of document.querySelectorAll("style")) {
    if (before.has(style)) continue;
    generated = style as HTMLStyleElement;
    return;
  }
}

/**
 * Adopt those rules if the document refused them.
 *
 * `sheet !== null` means the browser accepted the element (a nonce document, a
 * test, a permissive host), and then there is nothing to repair. Re-running is
 * free: `adoptDocumentStyles` adopts each distinct text once, and style-mod
 * rewrites this one element's text rather than adding a second.
 */
function repairGeneratedStyles(): void {
  if (!generated || generated.sheet) return;
  adoptDocumentStyles(generated.textContent ?? "");
}

export interface CodeMirrorTextSurfaceProps {
  /** Loaded text. A new `docKey` replaces the CodeMirror state and its history. */
  doc: string;
  /** Opaque resource identity plus version/reload token, never a path. */
  docKey: string;
  readOnly: boolean;
  line: number | null;
  lineToken: string;
  /** Fires only when the clean/dirty bit changes, never with the whole buffer. */
  onDirtyChange?(dirty: boolean): void;
  /**
   * Compatibility escape hatch for an older controlled editor adapter.
   * Consumers should prefer `onDirtyChange`: supplying this callback opts into
   * materialising the whole buffer after each user transaction.
   */
  onTextChange?(text: string): void;
  /**
   * Marks the `doc` prop as the latest committed baseline. A changed token does
   * not replace later keystrokes; it only advances the comparison baseline.
   */
  cleanToken?: string;
  /** Ctrl/⌘+S. The whole buffer is materialised only for this explicit act. */
  onSave?(text: string): boolean;
  domIdScope?: string;
  idBase?: string;
  className?: string;
  ariaLabel?: string;
  initialWrap?: boolean;
  /** Syntax support selected from display metadata; null/undefined stays plain text. */
  language?: Extension | null;
}

export interface CodeMirrorTextSurfaceHandle {
  /** Materialise the buffer for an explicit Save button, never for a keystroke. */
  getText(): string;
  focus(): void;
}

/** The repository's sole CodeMirror integration; resource and save state stay outside. */
export const CodeMirrorTextSurface = forwardRef<CodeMirrorTextSurfaceHandle, CodeMirrorTextSurfaceProps>(
function CodeMirrorTextSurface(props, forwardedRef) {
  const outer = useRef<HTMLDivElement | null>(null);
  const editorHost = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const onDirtyChange = useRef(props.onDirtyChange);
  onDirtyChange.current = props.onDirtyChange;
  const onTextChange = useRef(props.onTextChange);
  onTextChange.current = props.onTextChange;
  const onSave = useRef(props.onSave);
  onSave.current = props.onSave;
  const baseline = useRef<Text>(documentText(props.doc));
  const dirty = useRef(false);
  const editable = useRef(new Compartment());
  const saveBinding = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const accessibleName = useRef(new Compartment());
  const applied = useRef<{ docKey: string; lineToken: string }>({ docKey: props.docKey, lineToken: "" });
  /**
   * The `doc` string the surface last applied, and the editor document that
   * applying it produced. A streamed append may insert only its suffix, but
   * only while the editor still holds exactly that document (same object):
   * any edit, undo or receipt in between takes the general path.
   */
  const appliedDoc = useRef(props.doc);
  const appliedText = useRef<Text | null>(null);
  const [wrap, setWrap] = useState(props.initialWrap ?? true);
  const saveEnabled = props.onSave !== undefined;

  const publishDirty = useCallback((next: boolean): void => {
    if (dirty.current === next) return;
    dirty.current = next;
    onDirtyChange.current?.(next);
  }, []);

  useImperativeHandle(forwardedRef, () => ({
    getText: () => view.current?.state.sliceDoc() ?? props.doc,
    focus: () => view.current?.focus(),
  }), [props.doc]);

  const saveKeymap = useCallback(
    (readOnly: boolean, enabled: boolean) =>
      readOnly || !enabled
        ? []
        : keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: (editor) => onSave.current?.(editor.state.sliceDoc()) ?? false,
            },
          ]),
    [],
  );

  const extensions = useCallback(
    (readOnly: boolean, wrapped: boolean, enabled: boolean, lineSeparator: string) => {
      const nonce = documentStyleNonce();
      return [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        EditorState.lineSeparator.of(lineSeparator),
        search({ top: true }),
        SEARCH_PHRASES,
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        ...(props.language ? [props.language] : []),
        keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
        editable.current.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        saveBinding.current.of(saveKeymap(readOnly, enabled)),
        wrapping.current.of(wrapped ? EditorView.lineWrapping : []),
        accessibleName.current.of(EditorView.contentAttributes.of({
          "aria-label": props.ariaLabel || "文本内容",
        })),
        EditorView.updateListener.of((update) => {
          if (
            update.docChanged
            && !update.transactions.some((transaction) => transaction.annotation(EXTERNAL_DOCUMENT))
          ) {
            onTextChange.current?.(update.state.sliceDoc());
            publishDirty(!update.state.doc.eq(baseline.current));
          }
        }),
        AV_TOKEN_THEME,
        ...(nonce ? [EditorView.cspNonce.of(nonce)] : []),
      ];
    },
    [props.ariaLabel, props.language, publishDirty, saveKeymap],
  );

  useEffect(() => {
    const parent = editorHost.current;
    if (!parent) return;
    const beforeStyles = styleSnapshot();
    const created = new EditorView({
      state: EditorState.create({
        doc: documentText(props.doc),
        extensions: extensions(props.readOnly, wrap, saveEnabled, lineSeparatorFor(props.doc)),
      }),
      parent,
    });
    rememberGeneratedStyles(beforeStyles);
    repairGeneratedStyles();
    view.current = created;
    baseline.current = created.state.doc;
    appliedText.current = created.state.doc;
    dirty.current = false;
    applied.current = { docKey: props.docKey, lineToken: "" };
    return () => {
      view.current = null;
      created.destroy();
    };
    // One EditorView per mount. Prop changes are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const appliedCleanToken = useRef(props.cleanToken);
  useLayoutEffect(() => {
    const current = view.current;
    if (!current || appliedCleanToken.current === props.cleanToken) return;
    appliedCleanToken.current = props.cleanToken;
    // A new resource establishes its baseline in the docKey branch below.
    if (applied.current.docKey !== props.docKey) return;
    // Run before prop synchronization. If the person undid back to the OLD
    // baseline while Save was in flight, that text is dirty relative to the
    // newly committed body and must not be overwritten by props.doc.
    baseline.current = documentText(props.doc);
    publishDirty(!current.state.doc.eq(baseline.current));
  }, [props.cleanToken, props.doc, props.docKey, publishDirty]);

  useLayoutEffect(() => {
    const current = view.current;
    if (!current) return;
    if (applied.current.docKey !== props.docKey) {
      current.setState(EditorState.create({
        doc: documentText(props.doc),
        extensions: extensions(props.readOnly, wrap, saveEnabled, lineSeparatorFor(props.doc)),
      }));
      repairGeneratedStyles();
      baseline.current = current.state.doc;
      publishDirty(false);
      applied.current = { docKey: props.docKey, lineToken: "" };
      appliedDoc.current = props.doc;
      appliedText.current = current.state.doc;
      return;
    }
    // A stream publishes progressively under one document key. Keep the surface
    // in step without reporting those bytes as a person's draft. Once an
    // editable surface is dirty, an external render cannot overwrite it.
    if (dirty.current || props.doc === appliedDoc.current) return;
    // The common streamed case: the new text extends what is shown. Insert only
    // the suffix (O(chunk)) instead of re-splitting and replacing the whole
    // document (O(n) per repaint, O(n²) per read). A `\r` at the seam could be
    // half of a `\r\n`, so that case takes the general path below.
    const shown = appliedDoc.current;
    if (
      current.state.doc === appliedText.current
      && shown.length > 0
      && props.doc.length > shown.length
      && !shown.endsWith("\r")
      && current.state.lineBreak === lineSeparatorFor(props.doc)
      && props.doc.startsWith(shown)
    ) {
      current.dispatch({
        changes: { from: current.state.doc.length, insert: detached(props.doc.slice(shown.length)) },
        annotations: [
          EXTERNAL_DOCUMENT.of(true),
          Transaction.addToHistory.of(false),
        ],
      });
      baseline.current = current.state.doc;
      appliedDoc.current = props.doc;
      appliedText.current = current.state.doc;
      publishDirty(false);
      return;
    }
    const nextSeparator = lineSeparatorFor(props.doc);
    if (!dirty.current && current.state.lineBreak !== nextSeparator) {
      current.setState(EditorState.create({
        doc: documentText(props.doc),
        extensions: extensions(props.readOnly, wrap, saveEnabled, nextSeparator),
      }));
      repairGeneratedStyles();
      baseline.current = current.state.doc;
      appliedDoc.current = props.doc;
      appliedText.current = current.state.doc;
      publishDirty(false);
      return;
    }
    appliedDoc.current = props.doc;
    const nextBaseline = documentText(props.doc);
    if (!dirty.current && !current.state.doc.eq(nextBaseline)) {
      current.dispatch({
        changes: { from: 0, to: current.state.doc.length, insert: nextBaseline },
        annotations: [
          EXTERNAL_DOCUMENT.of(true),
          Transaction.addToHistory.of(false),
        ],
      });
      baseline.current = current.state.doc;
      publishDirty(false);
    }
    appliedText.current = current.state.doc;
  }, [extensions, props.doc, props.docKey, props.readOnly, publishDirty, saveEnabled, wrap]);

  useEffect(() => {
    const current = view.current;
    if (!current || current.state.readOnly === props.readOnly) return;
    // CodeMirror constructs the search panel from the read-only facet. Rebuild
    // an already-open panel so an editor that became structurally read-only
    // cannot keep stale replacement controls on screen.
    const reopenSearch = searchPanelOpen(current.state);
    const query = getSearchQuery(current.state);
    const focused = current.dom.ownerDocument.activeElement;
    const focusedField = focused instanceof HTMLInputElement
      && current.dom.contains(focused) && focused.closest(".cm-search")
      ? { name: focused.name, from: focused.selectionStart, to: focused.selectionEnd }
      : null;
    if (reopenSearch) closeSearchPanel(current);
    current.dispatch({
      effects: editable.current.reconfigure([
        EditorState.readOnly.of(props.readOnly),
        EditorView.editable.of(!props.readOnly),
      ]),
    });
    if (reopenSearch) {
      openSearchPanel(current);
      // Opening a panel can seed its query from the document selection. A
      // permission change is not a new search and must retain the user's input.
      current.dispatch({ effects: setSearchQuery.of(query) });
      if (focusedField) {
        const field = [...current.dom.querySelectorAll<HTMLInputElement>(".cm-search input")]
          .find((input) => input.name === focusedField.name);
        field?.focus();
        if (focusedField.from !== null && focusedField.to !== null) {
          field?.setSelectionRange(focusedField.from, focusedField.to);
        }
      } else if (focused instanceof HTMLElement && focused.isConnected) {
        focused.focus();
      }
    }
  }, [props.readOnly]);

  useEffect(() => {
    view.current?.dispatch({
      effects: saveBinding.current.reconfigure(saveKeymap(props.readOnly, saveEnabled)),
    });
  }, [props.readOnly, saveEnabled, saveKeymap]);

  useEffect(() => {
    const current = view.current;
    if (!current) return;
    current.dispatch({
      effects: accessibleName.current.reconfigure(
        EditorView.contentAttributes.of({ "aria-label": props.ariaLabel || "文本内容" }),
      ),
    });
  }, [props.ariaLabel]);

  useEffect(() => {
    const current = view.current;
    if (!current || props.line === null) return;
    if (applied.current.docKey !== props.docKey) return;
    if (applied.current.lineToken === props.lineToken) return;
    applied.current = { docKey: props.docKey, lineToken: props.lineToken };
    const line = Math.min(Math.max(props.line, 1), current.state.doc.lines);
    const target = current.state.doc.line(line);
    current.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: "center" }),
    });
    outer.current?.setAttribute("data-caret-line", String(line));
  }, [props.docKey, props.line, props.lineToken]);

  const toggleWrap = useCallback(() => {
    setWrap((previous) => {
      const next = !previous;
      view.current?.dispatch({
        effects: wrapping.current.reconfigure(next ? EditorView.lineWrapping : []),
      });
      return next;
    });
  }, []);

  const openSearch = useCallback(() => {
    const current = view.current;
    if (current) openSearchPanel(current);
  }, []);

  const idBase = props.idBase ?? "textSurface";
  const id = props.domIdScope ? `${idBase}-${props.domIdScope}` : idBase;
  const classes = ["av-text-surface", props.className].filter(Boolean).join(" ");
  return (
    <div
      className={classes}
      id={id}
      ref={outer}
      data-av-text-surface={props.readOnly ? "readonly" : "editable"}
      data-readonly={props.readOnly ? "1" : undefined}
      data-wrap={wrap ? "1" : "0"}
    >
      <div className="av-text-surface-toolbar" role="toolbar" aria-label="文本工具">
        <AvButton onClick={openSearch}>查找</AvButton>
        <AvButton aria-pressed={wrap} onClick={toggleWrap}>
          {wrap ? "关闭自动换行" : "开启自动换行"}
        </AvButton>
      </div>
      <div className="av-text-editor-host" ref={editorHost} />
    </div>
  );
});

/** Parse every standard EOL even when a file mixes conventions. */
/**
 * A copy of `text` that shares no storage with the string it was cut from.
 *
 * V8 represents a long `slice` as a view onto its parent, and every line
 * CodeMirror splits out of it is a view too. Each streamed repaint flattens the
 * whole growing text into a fresh string, so lines kept from each repaint's
 * suffix pinned every one of those copies: 100 MiB read over 40 repaints held
 * ~2 GiB and crashed the tab. Concatenating forces a flat copy of the suffix
 * alone, so what the editor retains stays O(n).
 */
function detached(text: string): string {
  return (" " + text).slice(1);
}

function documentText(doc: string): Text {
  return Text.of(doc.split(/\r\n|\r|\n/));
}

/** Preserve the convention established by the file's first existing EOL. */
function lineSeparatorFor(doc: string): "\r\n" | "\r" | "\n" {
  const first = doc.search(/[\r\n]/);
  if (first < 0 || doc[first] === "\n") return "\n";
  if (doc[first + 1] === "\n") return "\r\n";
  return "\r";
}
