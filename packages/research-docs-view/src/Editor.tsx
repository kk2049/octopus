import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  BlockNoteSchema,
  defaultBlockSpecs,
  filterSuggestionItems,
} from "@blocknote/core";
import { zh } from "@blocknote/core/locales";
import { BlockNoteView } from "@blocknote/mantine";
import {
  useCreateBlockNote,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
} from "@blocknote/react";
// Keep the App on its system font stack; optional embedded Inter fonts are blocked by the Host CSP.
import "@blocknote/mantine/style.css";
import type { Call, PageInfo } from "@claude-bot/research-docs-contract";
import { DocumentSession } from "./session.js";
import {
  researchResource,
  ResourceContext,
  type ResourceProps,
} from "./plugins.js";
import {
  ATTACHMENT_PREVIEW_BYTES,
  readAttachment,
  uploadFile,
} from "./attachments.js";
export const schema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, researchResource: researchResource() },
});
export type EditorInstance = typeof schema.BlockNoteEditor;
export interface Heading {
  id: string;
  text: string;
  level: number;
}
export function PageEditor({
  page,
  session,
  call,
  editable,
  active,
  onEditor,
  onOutline,
  openResource,
  insertResource,
  onChanged,
  onError,
  storageKey,
}: {
  storageKey: string;
  page: PageInfo;
  session: DocumentSession;
  call: Call;
  editable: boolean;
  active: boolean;
  onEditor: (e: EditorInstance) => void;
  onOutline: (h: Heading[]) => void;
  openResource: (p: ResourceProps) => void;
  insertResource: () => void;
  onChanged: () => void;
  onError: (e: string) => void;
}) {
  const sync = useSyncExternalStore(session.subscribe, session.snapshot);
  useEffect(() => {
    void session.open();
    const save = () => session.checkpoint();
    window.addEventListener("beforeunload", save);
    return () => window.removeEventListener("beforeunload", save);
  }, [session]);
  if (!sync.ready)
    return (
      <div className="rd-page-state" role="status">
        <span className="rd-state-icon">▤</span>
        <h2>{sync.error ? "暂时无法打开文档" : "正在打开文档"}</h2>
        <p>{sync.error || "连接共享内容…"}</p>
        {sync.error && (
          <button onClick={() => void session.retry()}>重新连接</button>
        )}
      </div>
    );
  return (
    <RichEditor
      {...{
        page,
        session,
        call,
        editable,
        active,
        onEditor,
        onOutline,
        openResource,
        insertResource,
        onChanged,
        onError,
        storageKey,
      }}
    />
  );
}
function RichEditor({
  page,
  session,
  call,
  editable,
  active,
  onEditor,
  onOutline,
  openResource,
  insertResource,
  onChanged,
  onError,
  storageKey,
}: Parameters<typeof PageEditor>[0]) {
  const cached = () => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? "null") as {
        title: string;
        revision: number;
      } | null;
    } catch {
      return null;
    }
  };
  const initial = cached(),
    baseRevision = useRef(initial?.revision ?? page.revision);
  const [title, setTitle] = useState(initial?.title ?? page.title),
    dirty = useRef(Boolean(initial)),
    [titleError, setTitleError] = useState(""),
    [saving, setSaving] = useState(false),
    [portal, setPortal] = useState<HTMLDivElement | null>(null),
    urls = useRef<string[]>([]);
  const editor = useCreateBlockNote(
    {
      schema,
      dictionary: zh,
      collaboration: {
        fragment: session.doc.getXmlFragment("content"),
        user: { name: page.createdBy, color: "#3565da" },
      },
      uploadFile: async (file) => {
        const f = await uploadFile(call, page.id, file, () => {});
        return "octopus-attachment:" + f.id;
      },
      resolveFileUrl: async (url) => {
        if (!url.startsWith("octopus-attachment:")) {
          if (/^https?:\/\//i.test(url)) return url;
          throw new Error("不支持的文件链接");
        }
        // Embedded previews resolve on open, so they stop at the preview budget;
        // the attachment card's explicit load has none.
        const r = await readAttachment(
          call,
          page.id,
          url.slice(19),
          undefined,
          ATTACHMENT_PREVIEW_BYTES,
        );
        const value = URL.createObjectURL(r.blob);
        urls.current.push(value);
        return value;
      },
    },
    [session],
  );
  const context = useMemo(() => ({ open: openResource }), [openResource]);
  useEffect(() => {
    if (!dirty.current) {
      setTitle(page.title);
      baseRevision.current = page.revision;
    }
  }, [page.title, page.revision]);
  useEffect(() => {
    if (active) onEditor(editor);
  }, [active, editor, onEditor]);
  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
    },
    [],
  );
  const outline = () =>
    onOutline(
      editor.document
        .filter((b) => b.type === "heading")
        .map((b) => ({
          id: b.id,
          level: b.props.level ?? 2,
          text: Array.isArray(b.content)
            ? b.content.map((c) => ("text" in c ? c.text : "")).join("")
            : "",
        })),
    );
  useEffect(() => {
    if (active) outline();
  }, [active, editor]);
  const saveTitle = async () => {
    if (!dirty.current || saving || !editable) return;
    if (!title.trim()) {
      setTitle(page.title);
      dirty.current = false;
      return;
    }
    setSaving(true);
    try {
      const updated = await call<PageInfo>("metadata", {
        doc: page.id,
        title: title.trim(),
        expected: baseRevision.current,
      });
      baseRevision.current = updated.revision;
      dirty.current = false;
      setTitleError("");
      try {
        localStorage.removeItem(storageKey);
      } catch {}
      onChanged();
    } catch (e) {
      setTitleError(String(e));
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <ResourceContext.Provider value={context}>
      <article className="rd-paper" data-page-id={page.id}>
        <div className="rd-document-kicker">
          <span>▤</span> 研究文档 <span className="rd-dot">·</span>{" "}
          {new Date(page.createdAt).toLocaleDateString("zh-CN")}
        </div>
        <input
          className="rd-title"
          aria-label="文档标题"
          value={title}
          readOnly={!editable}
          maxLength={240}
          onChange={(e) => {
            if (!dirty.current) baseRevision.current = page.revision;
            dirty.current = true;
            setTitle(e.target.value);
            try {
              localStorage.setItem(
                storageKey,
                JSON.stringify({
                  title: e.target.value,
                  revision: baseRevision.current,
                }),
              );
            } catch {
              setTitleError("标题草稿无法写入本地，请保持页面打开。");
            }
          }}
          onBlur={() => void saveTitle()}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        {titleError && (
          <div className="rd-title-conflict" role="alert">
            <span>{titleError}</span>
            <button
              onClick={() => {
                setTitle(page.title);
                dirty.current = false;
                baseRevision.current = page.revision;
                setTitleError("");
                try {
                  localStorage.removeItem(storageKey);
                } catch {}
              }}
            >
              使用最新标题
            </button>
            <button
              onClick={() => {
                baseRevision.current = page.revision;
                void saveTitle();
              }}
            >
              保留我的标题
            </button>
          </div>
        )}
        <div className="rd-document-meta">
          <span>{page.createdBy}</span>
          <span>
            {editable
              ? "与团队一起书写，输入 / 插入内容"
              : "你正在查看共享文档"}
          </span>
          {saving && <span>保存标题…</span>}
        </div>
        <div className="rd-editor-portals" ref={setPortal} />
        <BlockNoteView
          className="rd-editor"
          editor={editor}
          editable={editable && !page.archived}
          theme="light"
          slashMenu={false}
          portalElements={portal ? { default: portal } : undefined}
          onChange={() => {
            if (active) outline();
          }}
        >
          {editable && (
            <SuggestionMenuController
              triggerCharacter="/"
              getItems={async (query) =>
                filterSuggestionItems(
                  [
                    ...getDefaultReactSlashMenuItems(editor),
                    {
                      title: "科研元件",
                      subtext: "插入 Agent、文件、录音或研究结果",
                      aliases: [
                        "agent",
                        "file",
                        "audio",
                        "科研",
                        "文件",
                        "录音",
                      ],
                      group: "研究工作",
                      icon: <span>✳</span>,
                      onItemClick: insertResource,
                    },
                  ],
                  query,
                )
              }
            />
          )}
        </BlockNoteView>
        {editable && (
          <p className="rd-page-hint">
            写下想法，或把资料放进来。选中文字可设置格式，拖动左侧手柄可调整顺序。
          </p>
        )}
      </article>
    </ResourceContext.Provider>
  );
}
