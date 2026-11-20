/**
 * The three data modules: a manifest and a mount for each.
 *
 * ── What lives here rather than in the components ───────────────────────────
 *
 * Reading the instance's config, reading the projection through it, holding the
 * per-instance state (a selection, a draft), and raising the ONE layout intent.
 * Nothing else — the components below take props and return elements, which is
 * what lets a harness render them from a fixture with no port at all.
 *
 * ── The acceptance property these modules exist to demonstrate ──────────────
 *
 * `panel.config` is the composition's per-instance value (decision 7). Two
 * instances of `data.list/v1` with two `source` paths are 收件箱 and 归档箱: one
 * implementation, two purposes, zero branches. Every default below is a
 * fallback for a key the instance did not set, never a special case for a
 * particular App.
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 *
 * A literal action id. `data.form/v1` proposes `config.action` — a string an App
 * author wrote in a composition a reviewer read, and one the Host authorises on
 * arrival like any other proposal. There is no wire vocabulary in this package
 * to hard-code, and `architecture.test.ts` checks that nothing gained one.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { InstanceConfig } from "@claude-bot/agent-module-contract";
import type { ModuleProps, ModuleRegistryEntry } from "@claude-bot/agent-view-react/workspace";
import { DataDetail } from "./components/DataDetail.js";
import { DataForm, type FormNotice } from "./components/DataForm.js";
import { DataList } from "./components/DataList.js";
import { DataActions } from "./components/DataActions.js";
import { useAppData } from "./context.js";
import {
  findRecord,
  initialFieldValue,
  readActionSpecs,
  readFacts,
  readFieldSpecs,
  readNotice,
  readRecord,
  readRows,
  readSections,
  readThread,
  selectPath,
  type ActionSpec,
  type DataRow,
  type FieldSpec,
} from "./lib/select.js";
import {
  DATA_ACTIONS_MANIFEST,
  DATA_DETAIL_MANIFEST,
  DATA_FORM_MANIFEST,
  DATA_LIST_MANIFEST,
  DATA_RECORD_RESOURCE_KIND,
} from "./manifests.js";
import { APP_DATA_LIMITS, type AppDataProposal } from "./port.js";

const DEFAULT_ROW_LIMIT = 200;

// ── config ──────────────────────────────────────────────────────────────────

/**
 * Config is read here and only here.
 *
 * A missing key is a fallback rather than a refusal, because the contract layer
 * has already refused everything that would make this ambiguous: an undeclared
 * key, a wrong type and a missing REQUIRED key are all link-time failures where
 * a registry is present. What reaches this function is a value the module
 * declared and the composition supplied, or nothing.
 */
function text(config: InstanceConfig | null, key: string, fallback = ""): string {
  const value = config?.[key];
  return typeof value === "string" && value ? value : fallback;
}

function count(config: InstanceConfig | null, key: string, fallback: number, cap: number): number {
  const value = config?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), cap));
}

function flag(config: InstanceConfig | null, key: string, fallback: boolean): boolean {
  const value = config?.[key];
  return typeof value === "boolean" ? value : fallback;
}

/**
 * A projection value read as an id a panel may act on.
 *
 * Bounded like a `ResourceLink.ref`: a default_ref that resolved to a paragraph
 * is a wiring mistake, and treating it as "no default" keeps the panel honest
 * instead of hiding the mistake behind a lookup that can never succeed.
 */
function refText(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : "";
}

/** First instance keeps the plain DOM hooks; a later copy gets a namespace. */
function useDomIdScope({ panel, workspace }: ModuleProps): string | undefined {
  const [scope] = useState(() => {
    const first = workspace.state.panels.find((candidate) => candidate.moduleId === panel.moduleId);
    return first?.panelId === panel.panelId ? undefined : panel.panelId;
  });
  return scope;
}

/**
 * How many pages of one collection are revealed. A page bounds one render
 * step, never the collection; a different collection (another `source`, another
 * record) starts again at its first page instead of inheriting the last one's.
 */
function usePages(collection: unknown): [number, () => void] {
  const [state, setState] = useState({ collection, pages: 1 });
  const pages = Object.is(state.collection, collection) ? state.pages : 1;
  const more = useCallback(
    () => setState((current) => ({
      collection,
      pages: (Object.is(current.collection, collection) ? current.pages : 1) + 1,
    })),
    [collection],
  );
  return [pages, more];
}

// ── data.list/v1 ────────────────────────────────────────────────────────────

function DataListModule({ panel, workspace }: ModuleProps) {
  const { snapshot } = useAppData();
  const domIdScope = useDomIdScope({ panel, workspace });
  const config = panel.config;
  const source = text(config, "source");
  const openKind = text(config, "open_kind");
  const openView = text(config, "open_view");
  // `limit` is the page: how many more rows each "显示更多" reveals. The
  // collection itself is never cut off — it is already in the projection.
  const limit = count(config, "limit", DEFAULT_ROW_LIMIT, APP_DATA_LIMITS.maxRows);
  const [pages, onMore] = usePages(source);
  const keys = useMemo(
    () => ({
      id: text(config, "id_key", "id"),
      title: text(config, "title_key", "title"),
      subtitle: text(config, "subtitle_key", "subtitle"),
      badge: text(config, "badge_key", "badge"),
      tone: text(config, "tone_key", "tone"),
    }),
    [config],
  );
  const set = useMemo(
    () => readRows(selectPath(snapshot.projection, source), keys, limit * pages),
    [keys, limit, pages, snapshot.projection, source],
  );
  const noticePath = text(config, "notice");
  const notice = useMemo(
    () => (noticePath ? readNotice(selectPath(snapshot.projection, noticePath)) : null),
    [noticePath, snapshot.projection],
  );
  // The reader's explicit click is sticky; the projection's default_ref only
  // fills the gap before one exists (`userOverride ?? derivedDefault`). A data
  // frame that changes the default therefore never moves an explicit choice.
  const [chosen, setChosen] = useState<string | null>(null);
  const defaultPath = text(config, "default_ref");
  const fallback = defaultPath ? refText(selectPath(snapshot.projection, defaultPath)) : "";
  const selected = chosen ?? (fallback || null);

  const onSelect = useCallback(
    (row: DataRow) => {
      setChosen(row.id);
      if (!openKind) return;
      // `open()` answers false for an intent the composition cannot route or a
      // ref the contract will not carry (it is bounded printable ASCII). Local
      // selection has already happened, so a refusal costs a highlight and not
      // a broken panel — and inventing a fallback route here would be this
      // module deciding what the composition declined to.
      workspace.open(
        { kind: openKind, ref: row.id, label: row.title || row.id },
        openView ? { view: openView } : {},
      );
    },
    [openKind, openView, workspace],
  );

  return (
    <DataList
      title={text(config, "title", panel.label)}
      rows={set.rows}
      truncated={set.truncated}
      total={set.total}
      onMore={onMore}
      status={set.status}
      source={source}
      emptyText={text(config, "empty_text")}
      selected={selected}
      booting={snapshot.projection === null}
      domIdScope={domIdScope}
      notice={notice}
      onSelect={onSelect}
    />
  );
}

// ── data.detail/v1 ──────────────────────────────────────────────────────────

function DataDetailModule({ panel, workspace }: ModuleProps) {
  const { snapshot } = useAppData();
  const domIdScope = useDomIdScope({ panel, workspace });
  const config = panel.config;
  const source = text(config, "source");
  // One key, one meaning: set means `source` is a collection to look a ref up
  // in; unset means `source` IS the record. The alternative — sniffing the
  // shape — makes a panel's behaviour depend on how much data happens to be
  // there, which is the sort of thing that works until the collection is empty.
  const idKey = text(config, "id_key");
  const titleKey = text(config, "title_key", "title");
  const bodyKey = text(config, "body_key", "body");
  const value = selectPath(snapshot.projection, source);
  // An OPENED ref is the reader's act and always wins; `default_ref` only fills
  // the gap before one exists, so a fresh workspace shows the projection's pick
  // (the newest record, say) instead of an empty pane telling the reader to go
  // click something first.
  const defaultPath = text(config, "default_ref");
  const fallbackRef = idKey && defaultPath ? refText(selectPath(snapshot.projection, defaultPath)) : "";
  const ref = panel.resourceRef ?? (fallbackRef || null);
  const lookup = useMemo(
    () => (idKey ? (ref ? findRecord(value, idKey, ref) : { record: null, status: "not_found" as const }) : readRecord(value)),
    [idKey, ref, value],
  );
  const record = lookup.record;
  const threadKey = text(config, "thread_key");
  const sectionNames = useMemo(() => {
    const path = text(config, "sections");
    return path ? selectPath(snapshot.projection, path) : undefined;
  }, [config, snapshot.projection]);
  const sections = useMemo(
    () => readSections(record, sectionNames, APP_DATA_LIMITS.maxSections),
    [record, sectionNames],
  );
  const fieldNames = useMemo(() => {
    const path = text(config, "fields");
    return path ? selectPath(snapshot.projection, path) : undefined;
  }, [config, snapshot.projection]);
  const facts = useMemo(
    () =>
      readFacts(
        record,
        fieldNames,
        [idKey, titleKey, bodyKey, threadKey, ...sections.map((section) => section.key)],
        APP_DATA_LIMITS.maxFacts,
      ),
    [bodyKey, fieldNames, idKey, record, sections, threadKey, titleKey],
  );
  const [threadPages, onMoreThread] = usePages(ref);
  const thread = useMemo(
    () =>
      threadKey && record
        ? {
            title: text(config, "thread_title", "动态"),
            set: readThread(record[threadKey], APP_DATA_LIMITS.maxThreadEntries * threadPages),
            onMore: onMoreThread,
          }
        : null,
    [config, onMoreThread, record, threadKey, threadPages],
  );
  // The record-scoped menu: same reader, same allowlist discipline as
  // `data.actions/v1`. What is new is only WHERE the id comes from — the record
  // this panel is showing, injected under each entry's declared context_param,
  // so acting on "this one" never involves retyping its id.
  const menuPath = text(config, "menu");
  const menuSet = useMemo(
    () =>
      menuPath
        ? readActionSpecs(
            selectPath(snapshot.projection, menuPath),
            text(config, "allowed_actions"),
            APP_DATA_LIMITS.maxActions,
          )
        : null,
    [config, menuPath, snapshot.projection],
  );
  const contextRef = idKey ? (ref ?? "") : refText(record?.["id"]);
  const menu = lookup.status === "ok" && menuSet?.status === "ok" ? menuSet.actions : [];
  const [active, setActive] = useState<ActionSpec | null>(null);
  useEffect(() => {
    if (!active) return;
    const current = menu.find((action) => action.action === active.action) ?? null;
    if (current !== active) setActive(current);
  }, [active, menu]);

  const body = typeof record?.[bodyKey] === "string" ? (record[bodyKey] as string) : "";
  const heading =
    text(config, "title")
    || (typeof record?.[titleKey] === "string" ? (record[titleKey] as string) : "")
    || panel.label;

  return (
    <>
      <DataDetail
        title={heading}
        facts={facts}
        body={body}
        status={lookup.status}
        source={source}
        emptyText={text(config, "empty_text")}
        booting={snapshot.projection === null}
        domIdScope={domIdScope}
        variant={text(config, "variant")}
        sections={sections}
        thread={thread}
        menu={menu}
        onAction={setActive}
        {...(panel.resourceRef ? { onClose: () => workspace.close(panel.panelId) } : {})}
      />
      {active ? (
        <ActionDialog action={active} onClose={() => setActive(null)}>
          {(close) => (
            <DataFormModule
              panel={{
                ...panel,
                panelId: `${panel.panelId}--${active.action}`,
                moduleId: DATA_FORM_MANIFEST.id,
                label: active.label,
                config: {
                  action: active.action,
                  fields: active.fields,
                  title: active.title,
                  submit_label: active.submitLabel,
                  hint: active.hint,
                  ...(active.contextParam && contextRef
                    ? { context_param: active.contextParam, context_value: contextRef }
                    : {}),
                },
              }}
              workspace={workspace}
              onClose={close}
            />
          )}
        </ActionDialog>
      ) : null}
    </>
  );
}

// ── data.form/v1 ────────────────────────────────────────────────────────────

interface DraftState {
  /** The declaration these values belong to; a new one resets the draft. */
  signature: string;
  values: Record<string, string>;
}

function DataFormModule({ panel, workspace, onClose }: ModuleProps & { onClose?: () => void }) {
  const { port, snapshot, submit, dismissProposal } = useAppData();
  const domIdScope = useDomIdScope({ panel, workspace });
  const config = panel.config;
  const action = text(config, "action");
  const source = text(config, "fields");
  const set = useMemo(
    () => readFieldSpecs(selectPath(snapshot.projection, source), APP_DATA_LIMITS.maxFields),
    [snapshot.projection, source],
  );
  // A context-injected parameter is satisfied by the opener, not typed: it is
  // removed from the visible declaration and merged back into the payload at
  // submit. Injection only happens for a parameter the declaration carries —
  // sending a name the backend never declared would turn a UI affordance into
  // an undeclared wire field.
  const contextParam = text(config, "context_param");
  const contextValue = text(config, "context_value");
  const injectedField =
    contextParam && contextValue ? set.fields.find((field) => field.name === contextParam) ?? null : null;
  const injectedName = injectedField ? injectedField.name : "";
  const visible = useMemo(
    () => (injectedName ? set.fields.filter((field) => field.name !== injectedName) : set.fields),
    [injectedName, set.fields],
  );
  const signature = useMemo(() => visible.map((field) => `${field.name}:${field.type}`).join(" "), [visible]);

  const [draft, setDraft] = useState<DraftState>(() => ({ signature, values: seed(visible) }));
  const [invalid, setInvalid] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<FormNotice | null>(null);
  const busy = snapshot.proposals.some((proposal) => proposal.action === action && proposal.phase === "inflight");
  const refused = latestRefusal(snapshot.proposals, action);
  // A projection update that changes the declaration replaces the draft; one
  // that does not must leave a half-typed message alone, which is the whole
  // reason a panel keeps a stable React key.
  const values = draft.signature === signature ? draft.values : seed(visible);
  useEffect(() => {
    setDraft((previous) => (previous.signature === signature ? previous : { signature, values: seed(visible) }));
  }, [signature, visible]);

  /** Whether a late answer may still be written. */
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const onChange = useCallback(
    (name: string, next: string) => {
      setDraft((previous) => {
        const base = previous.signature === signature ? previous.values : {};
        return { signature, values: { ...base, [name]: next } };
      });
      setInvalid((previous) => (previous.includes(name) ? previous.filter((row) => row !== name) : previous));
      setNotice(null);
    },
    [signature],
  );

  const onSubmit = useCallback(() => {
    if (busy || set.status !== "ok" || !action) return;
    if (refused) dismissProposal(refused.rid);
    const missing = visible
      .filter((field) => field.required && !(values[field.name] ?? "").trim())
      .map((field) => field.name);
    const tooLong = visible
      .filter((field) => (values[field.name] ?? "").length > APP_DATA_LIMITS.maxValueLength)
      .map((field) => field.name);
    if (missing.length || tooLong.length) {
      setInvalid([...missing, ...tooLong]);
      setNotice({
        tone: "warn",
        text: missing.length ? "还有必填项没有填。" : `有字段超过了 ${APP_DATA_LIMITS.maxValueLength} 个字符。`,
      });
      return;
    }
    const payload: Record<string, string> = {};
    for (const field of visible) {
      const value = values[field.name] ?? "";
      // An optional field left blank is left OUT rather than sent as "": the
      // App's backend declared which parameters are required, and an empty
      // string is a value it would have to learn to distinguish from absence.
      if (!value && !field.required) continue;
      payload[field.name] = value;
    }
    if (injectedName) payload[injectedName] = contextValue;
    setInvalid([]);
    setNotice(null);
    void submit(action, payload).then(
      (reply) => {
        if (!live.current) return;
        if (reply.ok) {
          setNotice({ tone: "ok", text: reply.message || "已提交。" });
          if (flag(config, "reset_on_success", true)) setDraft({ signature, values: seed(visible) });
          return;
        }
        // Current ports retain this answer in the correlated ledger. Keep the
        // fallback only for an older port that has no lifecycle entry.
        const retained = port.snapshot().proposals.some(
          (proposal) => proposal.action === action && proposal.phase === "refused",
        );
        if (!retained) setNotice({ tone: "error", text: reply.message || "可信外层拒绝了这次提交。" });
      },
      () => {
        // The port promises to resolve; a rejection means a broken
        // implementation of it, and a form stuck on "提交中…" would be worse
        // than an honest refusal.
        if (!live.current) return;
        setNotice({ tone: "error", text: "这次提交没有返回结果。" });
      },
    );
  }, [action, busy, config, contextValue, dismissProposal, injectedName, port, refused, set.status, signature, submit, values, visible]);

  const onDismissNotice = useCallback(() => {
    if (!refused) return;
    dismissProposal(refused.rid);
    setNotice(null);
  }, [dismissProposal, refused]);

  const displayedNotice = refused
    ? { tone: "error" as const, text: refused.message || "这次提交被拒绝了。" }
    : notice;

  return (
    <DataForm
      title={text(config, "title", panel.label)}
      fields={visible}
      status={set.status}
      source={source}
      values={values}
      invalid={invalid}
      busy={busy}
      booting={snapshot.projection === null}
      notice={displayedNotice}
      context={injectedField ? { label: injectedField.label, value: contextValue } : null}
      submitLabel={text(config, "submit_label", "提交")}
      hint={text(config, "hint")}
      domIdScope={domIdScope}
      onChange={onChange}
      onSubmit={onSubmit}
      {...(refused ? { onDismissNotice } : {})}
      {...(onClose ? { onClose } : panel.resourceRef ? { onClose: () => workspace.close(panel.panelId) } : {})}
    />
  );
}

// ── data.actions/v1 ────────────────────────────────────────────────────────

function DataActionsModule({ panel, workspace }: ModuleProps) {
  const { snapshot } = useAppData();
  const source = text(panel.config, "source");
  const set = useMemo(
    () => readActionSpecs(
      selectPath(snapshot.projection, source),
      text(panel.config, "allowed_actions"),
      APP_DATA_LIMITS.maxActions,
    ),
    [panel.config, snapshot.projection, source],
  );
  const [active, setActive] = useState<ActionSpec | null>(null);
  useEffect(() => {
    if (!active) return;
    const current = set.actions.find((action) => action.action === active.action) ?? null;
    if (current !== active) setActive(current);
  }, [active, set.actions]);
  return (
    <>
      <DataActions
        title={text(panel.config, "title", panel.label || "可用动作")}
        source={source}
        actions={set.actions}
        status={set.status}
        booting={snapshot.projection === null}
        onSelect={setActive}
      />
      {active ? (
        <ActionDialog action={active} onClose={() => setActive(null)}>
          {(close) => (
            <DataFormModule
              panel={{
                ...panel,
                panelId: `${panel.panelId}--${active.action}`,
                moduleId: DATA_FORM_MANIFEST.id,
                label: active.label,
                config: {
                  action: active.action,
                  fields: active.fields,
                  title: active.title,
                  submit_label: active.submitLabel,
                  hint: active.hint,
                },
              }}
              workspace={workspace}
              onClose={close}
            />
          )}
        </ActionDialog>
      ) : null}
    </>
  );
}

function ActionDialog({
  action,
  onClose,
  children,
}: {
  action: ActionSpec;
  onClose(): void;
  children(close: () => void): ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useCallback(() => {
    const dialog = ref.current;
    if (dialog && typeof dialog.close === "function" && dialog.open) dialog.close();
    else onClose();
  }, [onClose]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="dv-action-dialog"
      aria-label={action.title}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      {children(close)}
    </dialog>
  );
}

function latestRefusal(proposals: readonly AppDataProposal[], action: string): AppDataProposal | null {
  if (!action) return null;
  for (let index = proposals.length - 1; index >= 0; index -= 1) {
    const proposal = proposals[index]!;
    if (proposal.action === action && proposal.phase === "refused") return proposal;
  }
  return null;
}

function seed(fields: readonly FieldSpec[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) out[field.name] = initialFieldValue(field);
  return out;
}

/**
 * The four, ready to be registered.
 *
 * An App picks from this list rather than assembling entries itself: a manifest
 * and its component belong together, and a composition that could pair a
 * manifest with a different implementation would make the lock a claim rather
 * than a fact.
 */
export const DATA_LIST_MODULE: ModuleRegistryEntry = Object.freeze({
  manifest: DATA_LIST_MANIFEST,
  component: DataListModule,
});

export const DATA_DETAIL_MODULE: ModuleRegistryEntry = Object.freeze({
  manifest: DATA_DETAIL_MANIFEST,
  component: DataDetailModule,
});

export const DATA_FORM_MODULE: ModuleRegistryEntry = Object.freeze({
  manifest: DATA_FORM_MANIFEST,
  component: DataFormModule,
});

export const DATA_ACTIONS_MODULE: ModuleRegistryEntry = Object.freeze({
  manifest: DATA_ACTIONS_MANIFEST,
  component: DataActionsModule,
});

export const DATA_MODULES: readonly ModuleRegistryEntry[] = Object.freeze([
  DATA_LIST_MODULE,
  DATA_DETAIL_MODULE,
  DATA_FORM_MODULE,
  DATA_ACTIONS_MODULE,
]);

/** Re-exported so a composition can name the kind a list opens by default. */
export { DATA_RECORD_RESOURCE_KIND };

/** Every config key each module actually reads. `config.test.ts` compares them. */
export const CONFIG_KEYS_READ = Object.freeze({
  list: Object.freeze([
    "source",
    "title",
    "id_key",
    "title_key",
    "subtitle_key",
    "badge_key",
    "tone_key",
    "empty_text",
    "limit",
    "open_kind",
    "open_view",
    "default_ref",
    "notice",
  ]),
  detail: Object.freeze([
    "source",
    "title",
    "id_key",
    "title_key",
    "body_key",
    "fields",
    "empty_text",
    "default_ref",
    "sections",
    "thread_key",
    "thread_title",
    "menu",
    "allowed_actions",
    "variant",
  ]),
  form: Object.freeze(["action", "fields", "title", "submit_label", "hint", "reset_on_success", "context_param", "context_value"]),
  actions: Object.freeze(["source", "allowed_actions", "title"]),
});
