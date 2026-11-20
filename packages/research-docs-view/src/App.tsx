import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  useProjection,
  usePropose,
  useAgentViewStatus,
} from "@claude-bot/agent-view-react";
import type {
  Call,
  DocsBoot,
  PageInfo,
} from "@claude-bot/research-docs-contract";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import { PageEditor, type EditorInstance, type Heading } from "./Editor.js";
import { DocumentSession } from "./session.js";
import { readAll } from "./list.js";
import { plugins, type ResourceProps } from "./plugins.js";
import { SourcePicker } from "./SourcePicker.js";
import { ResourcePanel } from "./ResourcePanel.js";
import { Comments } from "./Comments.js";
import { importIntoDocuments } from "./import.js";
import { uploadFile } from "./attachments.js";
import "./styles.css";
type Boot = DocsBoot & {
  libraryEpoch: number;
  revisions: Record<string, number>;
  peers: { user: string; doc: string }[];
};
const stored = <T,>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const remember = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* in-memory input remains */
  }
};
const rid = () => crypto.randomUUID();
function download(name: string, data: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([data], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function App() {
  const projection = useProjection<{ docs?: Boot | null }>(),
    status = useAgentViewStatus();
  if (!projection?.docs)
    return (
      <div className="rd-app rd-opening">
        <span className="rd-brand-icon">▤</span>
        <h1>研究文档</h1>
        <p>
          {status.ready ? "请从共享空间列表打开文档。" : "正在连接文档空间…"}
        </p>
      </div>
    );
  return (
    <Workspace
      key={projection.docs.viewer + ":" + projection.docs.space}
      boot={projection.docs}
    />
  );
}
export function Workspace({
  boot,
  providedCall,
}: {
  boot: Boot;
  providedCall?: Call;
}) {
  const propose = usePropose();
  const call = useCallback<Call>(
    async <T,>(action: string, params: Record<string, unknown> = {}) => {
      if (providedCall) return providedCall<T>(action, params);
      const answer = await propose(
        action,
        Object.fromEntries(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [
              k,
              typeof v === "object" ? JSON.stringify(v) : String(v),
            ]),
        ),
      );
      if (!answer.ok) throw new Error(answer.message || "操作未完成");
      return answer.result as T;
    },
    [propose, providedCall],
  );
  const key = "research-docs:" + boot.viewer + ":" + boot.space;
  const [pages, setPages] = useState<PageInfo[]>([]),
    [selected, setSelected] = useState(
      () =>
        new URLSearchParams(location.search).get("doc") ||
        stored(key + ":selected", ""),
    ),
    [visited, setVisited] = useState<string[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [nav, setNav] = useState(false),
    [archive, setArchive] = useState(false),
    [favorites, setFavorites] = useState<string[]>(() =>
      stored(key + ":favorites", []),
    ),
    [collapsed, setCollapsed] = useState<string[]>([]),
    [outline, setOutline] = useState<Heading[]>([]),
    [picker, setPicker] = useState(false),
    [resource, setResource] = useState<ResourceProps | null>(null),
    [comments, setComments] = useState(false),
    [share, setShare] = useState(false),
    [copied, setCopied] = useState(false),
    [creating, setCreating] = useState(false),
    [upload, setUpload] = useState<number | null>(null),
    [recording, setRecording] = useState(false),
    [more, setMore] = useState(false);
  const editor = useRef<EditorInstance | null>(null),
    sessions = useRef(new Map<string, DocumentSession>()),
    generation = useRef(0),
    fileInput = useRef<HTMLInputElement>(null),
    markdownInput = useRef<HTMLInputElement>(null),
    searchInput = useRef<HTMLInputElement>(null),
    recorder = useRef<MediaRecorder | null>(null),
    recordStream = useRef<MediaStream | null>(null),
    uploadRequest = useRef<{
      file: File;
      request: string;
      page: string;
      editor: EditorInstance;
    } | null>(null),
    outgoing = useRef<{
      request: string;
      title: string;
      parent?: string;
    } | null>(stored(key + ":create", null));
  const alive = useRef(true),
    seenRevisions = useRef<Record<string, number>>({});
  const editable = boot.role !== "viewer",
    page = pages.find((p) => p.id === selected);
  const refresh = useCallback(async () => {
    const g = ++generation.current;
    try {
      const all = await readAll<PageInfo>(
        call,
        "library",
        "pages",
        {},
        () => g === generation.current,
      );
      if (!all) return;
      setPages((old) =>
        JSON.stringify(old) === JSON.stringify(all) ? old : all,
      );
      setLoading(false);
    } catch (e) {
      if (g === generation.current) {
        setError(String(e));
        setLoading(false);
      }
    }
  }, [call]);
  useEffect(() => {
    void refresh();
  }, [refresh, boot.libraryEpoch]);
  const select = useCallback(
    (id: string) => {
      setSelected(id);
      setVisited((old) => (old.includes(id) ? old : [...old, id]));
      setNav(false);
      setResource(null);
      setOutline([]);
      remember(key + ":selected", id);
      const url = new URL(location.href);
      url.searchParams.set("doc", id);
      history.pushState({}, "", url);
    },
    [key],
  );
  useEffect(() => {
    if (!loading && !selected && pages.some((p) => !p.archived))
      select(pages.find((p) => !p.archived)!.id);
    else if (selected)
      setVisited((old) => (old.includes(selected) ? old : [...old, selected]));
  }, [loading, pages, selected, select]);
  useEffect(() => {
    const handle = () => {
      const id = new URLSearchParams(location.search).get("doc");
      if (id) {
        setSelected(id);
        setVisited((old) => (old.includes(id) ? old : [...old, id]));
      }
    };
    window.addEventListener("popstate", handle);
    return () => window.removeEventListener("popstate", handle);
  }, []);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setNav(true);
        setTimeout(() => searchInput.current?.focus(), 20);
      }
      if (e.key === "Escape") {
        setPicker(false);
        setShare(false);
        setMore(false);
        setNav(false);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);
  const getSession = (id: string) => {
    let session = sessions.current.get(id);
    if (!session) {
      session = new DocumentSession(id, call, key + ":draft:" + id);
      sessions.current.set(id, session);
    }
    return session;
  };
  useEffect(() => {
    for (const [id, session] of sessions.current)
      if (
        boot.revisions[id] !== undefined &&
        boot.revisions[id] !== seenRevisions.current[id]
      )
        session.wake();
    seenRevisions.current = boot.revisions;
  }, [JSON.stringify(boot.revisions)]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
      for (const s of sessions.current.values()) s.destroy();
      if (recorder.current?.state === "recording") {
        recorder.current.onstop = null;
        recorder.current.stop();
      }
      recordStream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  const onEditor = useCallback((e: EditorInstance) => {
    editor.current = e;
  }, []);
  const openResource = useCallback((r: ResourceProps) => {
    setResource(r);
    setComments(false);
  }, []);
  const insertResource = useCallback(() => setPicker(true), []);
  const insert = (r: ResourceProps) => {
    const e = editor.current;
    if (!e) return;
    const position = e.getTextCursorPosition().block;
    e.insertBlocks(
      [
        { type: "researchResource", props: r },
        { type: "paragraph", content: "" },
      ],
      position,
      "after",
    );
    setPicker(false);
    e.focus();
  };
  const create = async (parent?: string) => {
    if (creating) return;
    const request = outgoing.current ?? {
      request: rid(),
      title: "无标题文档",
      ...(parent ? { parent } : {}),
    };
    outgoing.current = request;
    remember(key + ":create", request);
    setCreating(true);
    setError("");
    try {
      const p = await call<PageInfo>("create", request);
      outgoing.current = null;
      remember(key + ":create", null);
      await refresh();
      select(p.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };
  const importSource = async (project: string, nodes: ResearchNode[]) => {
    const first = await importIntoDocuments(call, project, nodes, key + ":import:" + project);
    await refresh();
    if (first) select(first);
  };
  const doUpload = async (
    file: File,
    target?: { id: string; editor: EditorInstance },
  ) => {
    if (!page || !editor.current) return;
    const task = uploadRequest.current ?? {
      file,
      request: rid(),
      page: target?.id ?? page.id,
      editor: target?.editor ?? editor.current,
    };
    uploadRequest.current = task;
    setUpload(0);
    setError("");
    try {
      const info = await uploadFile(
        call,
        task.page,
        task.file,
        setUpload,
        task.request,
      );
      if (!alive.current) return;
      const props = {
        plugin: info.media.startsWith("audio/") ? "audio" : "file",
        project: "",
        node: "",
        file: info.id,
        title: info.name,
        summary: "",
        media: info.media,
        size: info.size,
      };
      task.editor.insertBlocks(
        [
          { type: "researchResource", props },
          { type: "paragraph", content: "" },
        ],
        task.editor.document.at(-1)!,
        "after",
      );
      uploadRequest.current = null;
    } catch (e) {
      setError(String(e) + "；可以点击重试上传");
    } finally {
      setUpload(null);
    }
  };
  const record = async () => {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    if (!page || !editor.current) return;
    const target = { id: page.id, editor: editor.current };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      recordStream.current = stream;
      const media = new MediaRecorder(stream),
        chunks: BlobPart[] = [];
      recorder.current = media;
      media.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      media.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (!alive.current) return;
        setRecording(false);
        void doUpload(
          new File(
            chunks,
            "会议录音-" +
              new Date().toISOString().replace(/[:.]/g, "-") +
              ".webm",
            { type: media.mimeType || "audio/webm" },
          ),
          target,
        );
      };
      media.start();
      setRecording(true);
    } catch (e) {
      setError("录音未开始：" + String(e));
    }
  };
  const exportDoc = async (format: "md" | "json") => {
    if (!editor.current || !page) return;
    try {
      const data =
        format === "json"
          ? JSON.stringify(editor.current.document, null, 2)
          : await editor.current.blocksToMarkdownLossy(editor.current.document);
      download(
        page.title + "." + format,
        data,
        format === "json" ? "application/json" : "text/markdown",
      );
      setMore(false);
    } catch (e) {
      setError(String(e));
    }
  };
  const toggleArchive = async () => {
    if (!page) return;
    try {
      await call("metadata", {
        doc: page.id,
        expected: page.revision,
        archived: !page.archived,
      });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };
  const locate = (id: string) => {
    const node = document.querySelector(
      '[data-page-id="' + selected + '"] [data-id="' + CSS.escape(id) + '"]',
    );
    node?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const tree = useMemo(() => {
    const result: { page: PageInfo; depth: number }[] = [],
      seen = new Set<string>();
    const visible = pages.filter(
      (p) =>
        p.archived === archive &&
        (!query || p.title.toLowerCase().includes(query.toLowerCase())),
    );
    const walk = (p: PageInfo, d: number) => {
      if (seen.has(p.id)) return;
      seen.add(p.id);
      result.push({ page: p, depth: Math.min(d, 5) });
      if (!collapsed.includes(p.id) || query)
        visible.filter((c) => c.parent === p.id).forEach((c) => walk(c, d + 1));
    };
    visible
      .filter((p) => !visible.some((c) => c.id === p.parent))
      .forEach((p) => walk(p, 0));
    return result;
  }, [pages, archive, query, collapsed]);
  useEffect(() => {
    if (visited.length <= 8) return;
    const removable = visited
      .filter(
        (id) =>
          id !== selected &&
          id !== uploadRequest.current?.page &&
          !sessions.current.get(id)?.snapshot().pending &&
          !sessions.current.get(id)?.snapshot().busy,
      )
      .slice(0, visited.length - 8);
    if (!removable.length) return;
    setVisited((old) => old.filter((id) => !removable.includes(id)));
    for (const id of removable) {
      sessions.current.get(id)?.destroy();
      sessions.current.delete(id);
    }
  }, [visited, selected]);
  const peerNames = [
    ...new Set(
      (boot.peers ?? [])
        .filter((p) => p.doc === selected && p.user !== boot.viewer)
        .map((p) => p.user),
    ),
  ];
  return (
    <div className="rd-app">
      {nav && (
        <button
          className="rd-nav-scrim"
          aria-label="关闭目录"
          onClick={() => setNav(false)}
        />
      )}
      <nav
        className={"rd-sidebar " + (nav ? "is-open" : "")}
        aria-label="文档目录"
      >
        <div className="rd-brand">
          <span className="rd-brand-icon">▤</span>
          <div>
            <strong>研究文档</strong>
            <small>把想法写成共同进展</small>
          </div>
        </div>
        <label className="rd-search">
          <span>⌕</span>
          <input
            ref={searchInput}
            placeholder="搜索文档"
            aria-label="搜索文档"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>⌘ K</kbd>
        </label>
        <button
          className="rd-new-page"
          disabled={!editable || creating}
          onClick={() => void create()}
        >
          <span>＋</span>
          {creating ? "创建中…" : outgoing.current ? "重试创建" : "新建文档"}
        </button>
        {favorites.length > 0 && !archive && !query && (
          <section className="rd-favorites">
            <h3>星标</h3>
            {favorites
              .map((id) => pages.find((p) => p.id === id && !p.archived))
              .filter((p): p is PageInfo => Boolean(p))
              .map((p) => (
                <button key={p.id} onClick={() => select(p.id)}>
                  ☆ <span>{p.title}</span>
                </button>
              ))}
          </section>
        )}
        <div className="rd-nav-heading">
          <span>{archive ? "已归档" : "空间文档"}</span>
          <button aria-label="刷新文档目录" onClick={() => void refresh()}>
            ↻
          </button>
        </div>
        <div className="rd-page-tree">
          {loading ? (
            <p className="rd-muted">读取目录…</p>
          ) : (
            tree.map(({ page: p, depth }) => (
              <div
                key={p.id}
                className={
                  "rd-page-row " + (p.id === selected ? "is-selected" : "")
                }
                style={{ paddingLeft: 10 + depth * 14 }}
              >
                <button
                  className="rd-expand"
                  aria-label={
                    (collapsed.includes(p.id) ? "展开 " : "折叠 ") + p.title
                  }
                  onClick={() =>
                    setCollapsed((old) =>
                      old.includes(p.id)
                        ? old.filter((id) => id !== p.id)
                        : [...old, p.id],
                    )
                  }
                >
                  {pages.some((c) => c.parent === p.id)
                    ? collapsed.includes(p.id)
                      ? "▸"
                      : "▾"
                    : "▤"}
                </button>
                <button
                  className="rd-page-link"
                  onClick={() => select(p.id)}
                  title={p.title}
                >
                  {p.title}
                </button>
                {editable && (
                  <button
                    className="rd-add-child"
                    aria-label={"在 " + p.title + " 下新建文档"}
                    onClick={() => void create(p.id)}
                  >
                    ＋
                  </button>
                )}
              </div>
            ))
          )}
          {!loading && !tree.length && (
            <p className="rd-muted">
              {query ? "没有匹配的文档" : "还没有文档"}
            </p>
          )}
        </div>
        <div className="rd-sidebar-footer">
          <button
            onClick={() => {
              setArchive(!archive);
              setQuery("");
            }}
          >
            {archive ? "▤ 返回文档" : "▱ 已归档"}
          </button>
          <button onClick={() => setPicker(true)}>◇ 科研资料</button>
          <div className="rd-user">
            <span>{boot.viewer.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{boot.viewer}</strong>
              <small>{editable ? "可协作编辑" : "只读成员"}</small>
            </div>
          </div>
        </div>
      </nav>
      <main className="rd-main">
        <header className="rd-topbar">
          <div className="rd-breadcrumb">
            <button
              className="rd-mobile-menu"
              aria-label="打开文档目录"
              onClick={() => setNav(true)}
            >
              ☰
            </button>
            <span title={boot.title}>{boot.title}</span>
            <span>/</span>
            <strong>{page?.title || "欢迎"}</strong>
            {page && (
              <button
                aria-label="星标文档"
                aria-pressed={favorites.includes(page.id)}
                onClick={() => {
                  const next = favorites.includes(page.id)
                    ? favorites.filter((id) => id !== page.id)
                    : [...favorites, page.id];
                  setFavorites(next);
                  remember(key + ":favorites", next);
                }}
              >
                {favorites.includes(page.id) ? "★" : "☆"}
              </button>
            )}
          </div>
          <div className="rd-top-actions">
            {page && <SaveStatus session={getSession(page.id)} />}
            <div className="rd-peer-list" aria-label="正在查看本文档">
              {peerNames.slice(0, 3).map((name) => (
                <span key={name} title={name}>
                  {name.slice(0, 1).toUpperCase()}
                </span>
              ))}
            </div>
            <button
              onClick={() => {
                setComments(!comments);
                setResource(null);
              }}
              disabled={!page}
            >
              ☷ <span>讨论</span>
            </button>
            <button className="rd-primary" onClick={() => setShare(true)}>
              分享
            </button>
          </div>
        </header>
        {error && (
          <div className="rd-error rd-global-error" role="alert">
            <span>{error}</span>
            {uploadRequest.current && (
              <button
                onClick={() => void doUpload(uploadRequest.current!.file)}
              >
                重试上传
              </button>
            )}
            <button aria-label="收起提示" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {page ? (
          <>
            <div className="rd-toolbar">
              <div className="rd-format-tools">
                <button
                  title="撤销"
                  aria-label="撤销"
                  disabled={!editable}
                  onClick={() => editor.current?.undo()}
                >
                  ↶
                </button>
                <button
                  title="重做"
                  aria-label="重做"
                  disabled={!editable}
                  onClick={() => editor.current?.redo()}
                >
                  ↷
                </button>
                <i />
                <select
                  aria-label="段落格式"
                  disabled={!editable}
                  defaultValue="paragraph"
                  onChange={(e) => {
                    const ed = editor.current;
                    if (!ed) return;
                    const type = e.target.value;
                    if (type.startsWith("h"))
                      ed.updateBlock(ed.getTextCursorPosition().block, {
                        type: "heading",
                        props: { level: Number(type.slice(1)) as 1 | 2 | 3 },
                      });
                    else
                      ed.updateBlock(ed.getTextCursorPosition().block, {
                        type: type as
                          | "paragraph"
                          | "bulletListItem"
                          | "checkListItem",
                      });
                  }}
                >
                  <option value="paragraph">正文</option>
                  <option value="h1">标题 1</option>
                  <option value="h2">标题 2</option>
                  <option value="h3">标题 3</option>
                  <option value="bulletListItem">项目列表</option>
                  <option value="checkListItem">待办事项</option>
                </select>
                <i />
                {(["bold", "italic", "underline"] as const).map((s, i) => (
                  <button
                    key={s}
                    aria-label={["加粗", "斜体", "下划线"][i]}
                    disabled={!editable}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => editor.current?.toggleStyles({ [s]: true })}
                  >
                    <span
                      style={{
                        fontWeight: i === 0 ? 700 : 400,
                        fontStyle: i === 1 ? "italic" : "normal",
                        textDecoration: i === 2 ? "underline" : "none",
                      }}
                    >
                      {["B", "I", "U"][i]}
                    </span>
                  </button>
                ))}
              </div>
              <div className="rd-insert-tools">
                <button
                  disabled={!editable || page.archived}
                  onClick={() => setPicker(true)}
                >
                  ＋ 插入元件
                </button>
                <button
                  disabled={!editable || upload !== null}
                  onClick={() => fileInput.current?.click()}
                >
                  ↥ <span>{upload !== null ? upload + "%" : "上传文件"}</span>
                </button>
                <button
                  className={recording ? "is-recording" : ""}
                  disabled={!editable}
                  onClick={() => void record()}
                >
                  {recording ? "● 停止录音" : "♩ 录音"}
                </button>
                <div className="rd-more">
                  <button
                    aria-label="更多文档操作"
                    onClick={() => setMore(!more)}
                  >
                    ···
                  </button>
                  {more && (
                    <div className="rd-menu">
                      <button onClick={() => void exportDoc("md")}>
                        导出 Markdown
                      </button>
                      <button onClick={() => void exportDoc("json")}>
                        导出完整块 JSON
                      </button>
                      {editable && (
                        <button onClick={() => markdownInput.current?.click()}>
                          导入 Markdown 到末尾
                        </button>
                      )}
                      <button onClick={() => window.print()}>
                        打印 / 另存为 PDF
                      </button>
                      {editable && (
                        <button
                          onClick={() => {
                            setMore(false);
                            void toggleArchive();
                          }}
                        >
                          {page.archived ? "恢复文档" : "归档文档"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
            {page.archived && (
              <div className="rd-archive-banner">
                这份文档已归档，内容仍然保留。
                {editable && (
                  <button onClick={() => void toggleArchive()}>恢复文档</button>
                )}
              </div>
            )}
            <div className="rd-workspace-body">
              <div className="rd-document-scroll">
                {visited.map((id) => {
                  const p = pages.find((p) => p.id === id);
                  return p ? (
                    <div key={id} hidden={selected !== id}>
                      <PageEditor
                        storageKey={key + ":title:" + id}
                        page={p}
                        session={getSession(id)}
                        call={call}
                        editable={editable}
                        active={selected === id}
                        {...{ onEditor, openResource, insertResource }}
                        onOutline={setOutline}
                        onChanged={() => void refresh()}
                        onError={setError}
                      />
                    </div>
                  ) : null;
                })}
              </div>
              {!resource && !comments && outline.length > 0 && (
                <aside className="rd-outline">
                  <span>本文目录</span>
                  {outline.map((h) => (
                    <button
                      key={h.id}
                      style={{ paddingLeft: Math.min(h.level - 1, 2) * 10 }}
                      onClick={() => locate(h.id)}
                    >
                      {h.text || "无标题段落"}
                    </button>
                  ))}
                </aside>
              )}
              {resource && (
                <ResourcePanel
                  key={
                    resource.project + ":" + resource.node + ":" + resource.file
                  }
                  resource={resource}
                  onNavigate={openResource}
                  call={call}
                  boot={boot}
                  page={page.id}
                  onClose={() => setResource(null)}
                />
              )}{" "}
              {comments && (
                <Comments
                  key={page.id}
                  call={call}
                  page={page.id}
                  editable={editable && !page.archived}
                  epoch={boot.libraryEpoch}
                  block={() =>
                    editor.current?.getTextCursorPosition().block.id ?? ""
                  }
                  onClose={() => setComments(false)}
                  onLocate={locate}
                  storageKey={key + ":comment:" + page.id}
                />
              )}
            </div>
          </>
        ) : (
          <div className="rd-welcome">
            <div className="rd-welcome-mark">▤</div>
            <span className="rd-eyebrow">A SHARED PLACE TO THINK</span>
            <h1>让研究从一份文档开始。</h1>
            <p>
              写下问题，放进资料，邀请同伴。
              <br />
              文件、Agent 和会议记录，都可以成为文档的一部分。
            </p>
            <div>
              <button
                className="rd-primary"
                disabled={!editable || creating}
                onClick={() => void create()}
              >
                ＋ 创建第一份文档
              </button>
              <button onClick={() => setPicker(true)}>从科研项目开始 ↗</button>
            </div>
            <div className="rd-welcome-features">
              {plugins.slice(0, 3).map((p) => (
                <section key={p.id}>
                  <span>{p.icon}</span>
                  <h3>{p.label}</h3>
                  <p>{p.description}</p>
                </section>
              ))}
            </div>
          </div>
        )}
      </main>
      <input
        hidden
        ref={fileInput}
        type="file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void doUpload(f);
          e.target.value = "";
        }}
      />
      <input
        hidden
        ref={markdownInput}
        type="file"
        accept=".md,.txt"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f && editor.current)
            try {
              if (f.size > 180000)
                throw new Error("请导入 180 KB 以内的 Markdown");
              const blocks = await editor.current.tryParseMarkdownToBlocks(
                await f.text(),
              );
              const last = editor.current.document.at(-1);
              if (last) editor.current.insertBlocks(blocks, last, "after");
              setMore(false);
            } catch (e) {
              setError(String(e));
            }
        }}
      />
      {picker && (
        <SourcePicker
          call={call}
          onClose={() => setPicker(false)}
          onInsert={insert}
          onImport={importSource}
        />
      )}
      {share && (
        <div
          className="rd-modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShare(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="分享文档"
            className="rd-modal rd-share"
          >
            <header>
              <h2>一起完成这份研究</h2>
              <button aria-label="关闭分享" onClick={() => setShare(false)}>
                ×
              </button>
            </header>
            <div className="rd-modal-content">
              <p>
                分享此空间给已登录的 Octopus
                成员，大家可以协作编辑文档。关联的科研资源仍按原项目授权开放。
              </p>
              <label>
                文档链接
                <input readOnly value={location.href} />
              </label>
              <button
                className="rd-primary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(location.href);
                    setCopied(true);
                  } catch {
                    setError("复制失败，请选择上方链接复制。");
                  }
                }}
              >
                {copied ? "✓ 已复制" : "复制分享链接"}
              </button>
              <a
                href="/apps/research-docs/open"
                target="_blank"
                rel="noreferrer"
              >
                管理空间与成员 ↗
              </a>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
function SaveStatus({ session }: { session: DocumentSession }) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  return (
    <span
      className={"rd-save " + (state.error ? "has-error" : "")}
      role="status"
      title={
        state.error ||
        (!state.localDurable ? "本地存储已满，请保持页面打开并导出文档" : "")
      }
    >
      <span>{state.error ? "!" : state.pending ? "○" : "✓"}</span>
      {state.error
        ? "尚未同步"
        : !state.ready
          ? "连接中"
          : state.busy
            ? "正在同步"
            : state.pending
              ? "保存中"
              : "已保存"}
      {state.error && (
        <button onClick={() => void session.retry()}>重试</button>
      )}
    </span>
  );
}
