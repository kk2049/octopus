import { declareContract, refusalVocabulary } from "@claude-bot/typed-port-kit";
export const DOCS_APP = "research-docs";
export const DOCS_PUBLISHER = "octopus:first-party";
const str = (description: string, maxLength = 160, optional = false) => ({
  type: "string" as const,
  description,
  maxLength,
  ...(optional ? { optional: true as const } : {}),
});
const doc = str("文档 ID"),
  request = str("稳定请求 ID；未知结果重试沿用同一 ID"),
  limit = str(
    "每页条数（最多 200）；省略时整份回答，仅为旧版页面保留",
    4,
    true,
  ),
  after = str("分页游标：上一页返回的 next", 160, true);
/**
 * One answer of `library` / `comments` with a `limit`: at most this many
 * entries and about this many JSON bytes (always at least one entry). The list
 * itself has no length; `next` continues it.
 */
export const LIST_PAGE_ENTRIES = 200;
export const LIST_PAGE_BYTES = 192 * 1024;
export const DOCS_CONTRACT = declareContract({
  contract: "research-docs/v1",
  summary: "独立共享富文本文档、附件与已授权科研元件",
  refusals: refusalVocabulary(
    ["no_authority", "invalid_input", "unavailable"],
    { fallback: "unavailable" },
  ),
  actions: {
    library: {
      summary:
        "读取共享空间的文档目录；带 limit 时按创建顺序分页，任意篇数，按 next 继续",
      operation: "read_documents",
      params: { limit, after },
    },
    create: {
      summary: "新建文档；相同请求幂等",
      operation: "edit_documents",
      params: {
        request,
        title: str("文档标题", 240),
        parent: str("父文档 ID", 160, true),
        seed: str("初始块 JSON", 180000, true),
      },
    },
    metadata: {
      summary: "重命名、移动、归档或恢复文档，校验版本",
      operation: "edit_documents",
      params: {
        doc,
        expected: str("当前元数据版本", 32),
        title: str("标题", 240, true),
        parent: str("父文档 ID；root 表示顶层", 160, true),
        archived: str("归档状态", 8, true),
      },
    },
    read: {
      summary:
        "读取文档 CRDT 或相对本地副本的增量；带 offset 时按 192 KiB 窗口分段，任意大小，按 snapshot 与 next 继续",
      operation: "read_documents",
      params: {
        doc,
        vector: str("Yjs 状态向量 base64", 4096, true),
        offset: str("分段读取的字节偏移；首段 0，之后用返回的 next", 20, true),
        snapshot: str("首段返回的分段快照 ID", 64, true),
      },
    },
    update: {
      summary:
        "持久合并 Yjs 更新并返回差异；不会整页覆盖。较大的更新按 offset/total 分段推送，最后一段一次合并",
      operation: "edit_documents",
      params: {
        doc,
        update: str("Yjs update base64；分段时为本段", 262144),
        vector: str("本地状态向量 base64", 4096),
        offset: str("分段推送时本段的字节偏移", 20, true),
        total: str("分段推送时整个更新的字节数", 20, true),
      },
    },
    comments: {
      summary: "读取文档讨论；带 limit 时按发布顺序分页，任意条数，按 next 继续",
      operation: "read_documents",
      params: { doc, limit, after },
    },
    comment: {
      summary: "追加可追溯的文档讨论，不发送外部消息",
      operation: "edit_documents",
      params: {
        doc,
        request,
        text: str("讨论正文", 8000),
        block: str("关联块 ID", 160, true),
        thread: str("回复的讨论 ID", 160, true),
      },
    },
    resolve: {
      summary: "解决或重新打开讨论",
      operation: "edit_documents",
      params: {
        doc,
        comment: str("讨论 ID"),
        resolved: str("true / false", 8),
      },
    },
    sources: {
      summary: "读取本人有权访问的科研项目目录",
      operation: "read_sources",
      params: {},
    },
    source: {
      summary: "读取科研项目资源目录；原项目权限仍逐次检查",
      operation: "read_sources",
      params: { project: str("源项目 ID"), after: str("分页游标", 512, true) },
    },
    source_call: {
      summary: "操作文档中的源资源，复用原项目的权限和执行语义",
      operation: "interact_sources",
      params: {
        project: str("源项目 ID"),
        action: str("闭合的资源动作", 80),
        params: str("原资源动作 JSON", 262144),
      },
    },
    upload: {
      summary: "上传本人选择的附件块；稳定 ID 和顺序保证续传",
      operation: "edit_documents",
      params: {
        doc,
        request,
        name: str("文件名", 240),
        media: str("MIME", 160),
        size: str("完整文件字节数", 16),
        offset: str("块字节偏移", 16),
        data: str("base64 文件块", 48000),
      },
    },
    attachment: {
      summary: "按需读取本文档的附件块",
      operation: "read_documents",
      params: { doc, file: str("附件 ID"), offset: str("块字节偏移", 16) },
    },
    members: {
      summary: "读取共享空间成员和角色",
      operation: "read_documents",
      params: {},
    },
  },
});
export const DOCS_OPERATIONS = DOCS_CONTRACT.operations;
export type DocsAction = (typeof DOCS_CONTRACT.actionIds)[number];
export type DocsRole = "owner" | "editor" | "viewer";
export interface PageInfo {
  id: string;
  title: string;
  parent: string;
  archived: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  seed?: unknown[];
}
export interface DocsBoot {
  sourceEpoch?: number;
  space: string;
  viewer: string;
  role: DocsRole;
  epoch: number;
  title: string;
}
export interface DocumentState {
  update: string;
  vector: string;
  seed?: unknown[];
  page: PageInfo;
  /** Windowed answers (requests with an offset): this window's place in the whole state. */
  offset?: number;
  total?: number;
  next?: number | null;
  snapshot?: string;
}
export interface DocComment {
  id: string;
  author: string;
  text: string;
  block: string;
  thread: string;
  createdAt: string;
  resolved: boolean;
}
/** A `library` answer; `next` is present when the request carried a `limit`. */
export interface LibraryPage {
  pages: PageInfo[];
  next?: string | null;
}
/** A `comments` answer; `next` is present when the request carried a `limit`. */
export interface CommentsPage {
  comments: DocComment[];
  next?: string | null;
}
export interface AttachmentInfo {
  id: string;
  name: string;
  media: string;
  size: number;
}
export type Call = <T = unknown>(
  action: string,
  params?: Record<string, unknown>,
) => Promise<T>;
