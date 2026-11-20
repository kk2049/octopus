/**
 * Human disclosure catalog for Session Plus' kernel operations.
 *
 * It lists the UNION of every operation any implemented contract may declare —
 * twelve today — because this is the dictionary a consent screen and the config
 * validator read, and both must be able to describe an operation before anyone
 * can be asked about it. What a given release actually asks for is its own
 * contract; the intersection happens in `IntentGrantResolver`, not here.
 *
 * The union grew a WRITE on 2026-08-07, an OUTBOUND MESSAGE on 2026-08-08, and
 * the two COLLABORATIVE-DOCUMENT tokens on 2026-08-10 (served by the
 * `crdt-doc-v1` capability Object, whose edit lease is what lets the
 * `edit_document` row below promise an approval that something delivers).
 * Nothing about the union is an authorisation — a row here is a sentence
 * somebody can be shown — but the assertion below is what stops an operation
 * reaching a Gate before anybody has written that sentence.
 */

import {
  defineOperationCatalog,
  type OperationCatalog,
  type OperationInfo,
  type SubjectCatalogEntry,
  type SubjectInfo,
} from "../permissions/catalog.js";
import {
  SESSION_PLUS_ALL_OPERATIONS,
  SESSION_PLUS_APP_ID,
  SESSION_PLUS_PERMISSION_CONTRACT,
  SESSION_PLUS_PUBLISHER,
  sessionPlusPermissionContractDigest,
  type SessionPlusPermissionContract,
} from "./contract.js";

export const SESSION_RESOURCE_OPERATIONS: readonly OperationInfo[] = [
  {
    id: "list_recent_sessions",
    runner: "list_recent_sessions",
    title: "列出最近会话",
    description: "查看会话类型、设备、工作区显示名和最近活动时间，不读取 transcript 正文。",
    effect: "observe",
    risk: "枚举与状态",
    alwaysApprove: false,
    mayAutoAllow: true,
    disclosure: "session-metadata",
  },
  {
    id: "search_sessions",
    runner: "search_sessions",
    title: "搜索会话",
    description: "按关键词搜索会话，并返回包含匹配正文的片段。",
    effect: "read",
    risk: "读取私密内容",
    alwaysApprove: false,
    mayAutoAllow: true,
    disclosure: "session-content",
  },
  {
    id: "read_session",
    runner: "read_session",
    title: "读取与跟随会话",
    description: "读取完整 transcript；持续跟随也使用同一权限，撤销后两者一起停止。",
    effect: "read",
    risk: "读取私密内容",
    alwaysApprove: false,
    mayAutoAllow: true,
    disclosure: "session-content",
  },
  {
    id: "list_session_workspaces",
    runner: "list_session_workspaces",
    title: "列出可用工作区",
    description: "查看可用于新会话的工作区标签和显示路径；设备上的规范绝对路径不会披露给应用。",
    effect: "observe",
    risk: "枚举与状态",
    alwaysApprove: false,
    mayAutoAllow: true,
    disclosure: "workspace-labels",
  },
  {
    id: "start_session",
    runner: "start_session",
    title: "启动新会话",
    description: "在你自己的设备与工作区启动 Claude Code、Codex 或 Oh My Pi(omp)；本人可信页面可直接执行。",
    effect: "execute",
    risk: "执行命令",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: "append_session",
    runner: "append_session",
    title: "续跑或恢复会话",
    description: "向你自己的既有会话提交新指令，包括恢复已结束会话；本人可信页面可直接执行。",
    effect: "execute",
    risk: "执行命令",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: "list_workspace_entries",
    runner: "list_workspace_entries",
    title: "浏览工作区目录",
    description:
      "按需展开已登记工作区里的一层目录，查看文件名、大小与修改时间；符号链接与设备文件只被列出，不可打开。",
    effect: "read",
    risk: "读取私密内容",
    alwaysApprove: false,
    mayAutoAllow: true,
    disclosure: "workspace-file-listing",
  },
  {
    id: "read_workspace_text",
    runner: "read_workspace_text",
    title: "读取工作区文本文件",
    description:
      "以有界分块读取工作区内一个 UTF-8 文本文件的内容；不写入、不监听变化，设备上的规范绝对路径不会披露给应用。",
    effect: "read",
    risk: "读取私密内容",
    alwaysApprove: false,
    mayAutoAllow: true,
    disclosure: "workspace-file-content",
  },
  {
    id: "read_workspace_binary",
    runner: "read_workspace_binary",
    title: "预览工作区图片或 PDF",
    description:
      "以有界分块读取已登记工作区内经内容识别的 PNG、JPEG、GIF、WebP 或 PDF；不写入、不执行文件内容。",
    effect: "read",
    risk: "读取私密内容",
    alwaysApprove: false,
    mayAutoAllow: true,
    disclosure: "workspace-file-content",
  },
  {
    id: "download_workspace_file",
    runner: "download_workspace_file",
    title: "下载工作区文件",
    description:
      "以有界分块读取并下载已登记工作区内一个普通文件；文件内容不在浏览器内执行，设备上的规范绝对路径不会披露给应用。",
    effect: "read",
    risk: "读取私密内容",
    alwaysApprove: false,
    mayAutoAllow: true,
    disclosure: "workspace-file-content",
  },
  {
    id: "access_owner_files",
    runner: "access_owner_files",
    title: "访问本人 Runner 文件",
    description:
      "按需列出并读取你自己的 Runner 上当前 OS 账号可访问的绝对路径；不要求路径属于已登记工作区，且不扩大到其他用户的设备。",
    effect: "read",
    risk: "读取私密内容",
    alwaysApprove: false,
    mayAutoAllow: true,
    disclosure: "owner-runner-file-content",
  },
  {
    id: "replace_owner_text",
    runner: "replace_owner_text",
    title: "改写本人 Runner 文本文件",
    description:
      "整份改写你自己的 Runner 上当前 OS 账号可访问的已存在 UTF-8 文本文件，不要求登记工作区。"
      + "仅在文件仍匹配编辑时的版本摘要时原子替换；不新建、不删除、不保留可撤销的旧副本。"
      + "只限本人设备，需单独授权；本人可信页面可直接写入。",
    effect: "modify",
    risk: "修改",
    alwaysApprove: false,
    mayAutoAllow: true,
    disclosure: "owner-runner-file-content",
  },
  {
    id: "replace_workspace_text",
    runner: "replace_workspace_text",
    title: "改写工作区文本文件",
    /**
     * The description says the three things a person deciding about a WRITE
     * needs and a reader does not: it replaces everything, it is refused when
     * the file has moved on, and there is no undo copy anywhere.
     */
    description:
      "整份改写工作区内一个已存在的 UTF-8 文本文件。必须给出这次编辑所基于的版本摘要，"
      + "文件已经被别人改动时会拒绝并且一个字节都不写；不新建文件、不删除文件，"
      + "也不保留可撤销的旧副本。本人可信页面可直接写入。",
    effect: "modify",
    risk: "修改",
    alwaysApprove: false,
    mayAutoAllow: true,
    disclosure: "workspace-file-content",
  },
  {
    id: "upload_session_file",
    runner: "upload_session_file",
    title: "上传会话临时文件",
    description:
      "把本人选择的文件按有界分块写入可信执行设备新建的附件目录，不设文件总大小上限，"
      + "磁盘空间不足时停止并清理未完成文件；完成后的绝对路径交给下一条消息引用，应用不能选择目标目录或覆盖既有文件。",
    effect: "modify",
    risk: "修改",
    alwaysApprove: false,
    mayAutoAllow: true,
    disclosure: "session-attachment",
  },
  {
    id: "send_notification",
    runner: "send_notification",
    title: "给你发通知",
    /**
     * Three things a person deciding about an OUTBOUND message needs, and one
     * they would otherwise assume:
     *
     *  · it reaches them on a chat platform, i.e. outside this browser tab and
     *    outside any session they are looking at;
     *  · the App composes the text, so the content is the App's, not a quote of
     *    theirs — nothing of the owner's is disclosed by this operation, which
     *    is why there is no `disclosure` class on this row;
     *  · it can only reach the person using the App. Naming anybody else is not
     *    a permission this build withholds, it is a recipient the trusted side
     *    never mints (`notify-grant.ts`).
     *
     * `alwaysApprove` records the POLICY: a durable grant may never make an
     * outbound message unsupervised. It is not yet enforced by anything — see
     * the note in `contract.ts` on why no release shape may declare the contract
     * that contains this operation until it is.
     */
    description:
      "把一条有界的通知（一行标题加最多三行正文）发到你自己的聊天账号上。"
      + "正文由应用撰写，它读不到、也带不走你的任何内容；"
      + "收件人只能是正在使用这个应用的你本人，应用说不出别人的名字。",
    effect: "modify",
    risk: "对外发送",
    alwaysApprove: true,
    mayAutoAllow: false,
  },
  {
    id: "read_document",
    runner: "read_document",
    title: "读取协作文档",
    description:
      "读取平台上授予这个应用的协作文档的内容与后续改动。文档由部署者指定，"
      + "应用列不出其它文档，也说不出文档存在哪里。",
    effect: "read",
    risk: "读取私密内容",
    alwaysApprove: false,
    mayAutoAllow: true,
    disclosure: "crdt-document-content",
  },
  {
    id: "edit_document",
    runner: "edit_document",
    title: "编辑协作文档",
    /**
     * The sentence a person is agreeing to has to describe the LEASE, because
     * that is what the Gate enforces: one approval covers one document for one
     * open instance, and the individual keystroke bursts inside it are the
     * person's own editing, not separately supervisable events. Claiming
     * "every change needs approval" would promise a card per keystroke that
     * nothing delivers; claiming nothing would hide that merges flow freely
     * inside an approved sitting. This row says exactly the middle.
     */
    description:
      "把你在文档里的编辑合并进大家共享的内容。每次打开应用后，对每份文档的第一次编辑"
      + "都需要你单独批准；批准只对本次打开有效，关闭页面或撤销授权后立即失效。"
      + "已合并的内容没有可撤销的旧副本。",
    effect: "modify",
    risk: "修改",
    alwaysApprove: true,
    mayAutoAllow: false,
    disclosure: "crdt-document-content",
  },
  {
    id: "open_workspace_terminal",
    runner: "open_workspace_terminal",
    title: "打开远端工作区终端",
    description:
      "在你自己的设备上从已登记工作区启动一个真实 shell。本人打开无需逐次确认；共享访客打开仍需你批准。"
      + "shell 可以离开起始工作区并访问该账号能访问的其它内容。",
    effect: "execute",
    risk: "执行命令",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: "workspace_terminal",
    runner: "workspace_terminal",
    title: "使用已批准的远端终端",
    description:
      "只在本次打开已经批准的远端终端里刷新画面、输入命令或关闭；不能凭此打开新的 shell，也不能接入"
      + "另一个页面的终端。终端关闭或闲置 30 分钟后通道失效。",
    effect: "execute",
    risk: "执行命令",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
];

export const SESSION_RESOURCE_CATALOG = defineOperationCatalog(
  "session plus",
  SESSION_RESOURCE_OPERATIONS,
);

// Contract and catalog are independent declarations with one required
// equality. Failing at composition is preferable to publishing a consent row
// that does not describe the Gate vocabulary.
if (SESSION_RESOURCE_CATALOG.ids.join("\0") !== SESSION_PLUS_ALL_OPERATIONS.join("\0")) {
  throw new Error("session plus catalog does not match its permission contracts");
}

/**
 * The catalog narrowed to one release's ask.
 *
 * A consent screen must show what THIS release asks for. Showing the union
 * would invite somebody to grant an operation the running release never
 * declared, and the row would then claim an agreement about a contract nobody
 * was shown. Auto-allow policy is release data too: a historical contract must
 * not inherit a newer release's silent owner-local operations from the union
 * catalog.
 */
export function sessionResourceCatalogFor(contract: SessionPlusPermissionContract): OperationCatalog {
  const declared = new Set(contract.operations);
  const autoAllowable = new Set(contract.autoAllow);
  return defineOperationCatalog(
    "session plus release",
    SESSION_RESOURCE_OPERATIONS
      .filter((row) => declared.has(row.id))
      .map((row) => ({
        ...row,
        alwaysApprove: row.alwaysApprove || !autoAllowable.has(row.id),
        mayAutoAllow: row.mayAutoAllow && autoAllowable.has(row.id),
      })),
  );
}

export const SESSION_PLUS_SUBJECT: SubjectInfo = Object.freeze({
  type: "app",
  id: SESSION_PLUS_APP_ID,
  title: "会话+",
  publisher: SESSION_PLUS_PUBLISHER,
  description:
    "Agentic App 会话界面。应用只通过平台能力管线读取或驱动你的本地会话，"
    + "每个资源与动作请求都由服务端授权。",
  enforced: true,
});

/**
 * The permission-centre entry for one deployment.
 *
 * `catalog` is the union — it is the dictionary, and a screen has to be able to
 * describe an operation before anybody is asked about it. `declared` is what
 * the release being served ACTUALLY asks for, which is what the three columns
 * are computed over: on a host running the six-token release the two workspace
 * operations are simply not on the page, so nobody can grant a permission that
 * release never requested.
 *
 * `activeContract` returns null while no release is usable (deactivated, or an
 * activation this build refused). The base ask is the honest fallback there:
 * it is what every rollback target declares.
 *
 * Config rows remain read-only; accounts without one can consent themselves.
 */
export function sessionPlusSubjectEntry(
  activeContract: () => SessionPlusPermissionContract | null,
): SubjectCatalogEntry {
  return Object.freeze({
    info: SESSION_PLUS_SUBJECT,
    catalog: SESSION_RESOURCE_CATALOG,
    declared: () => (activeContract() ?? SESSION_PLUS_PERMISSION_CONTRACT).operations,
    userManaged: true,
    grantIdentity: Object.freeze({
      publisher: SESSION_PLUS_PUBLISHER,
      contractDigest: sessionPlusPermissionContractDigest(),
    }),
  });
}

/** The single-release entry: what a deployment with no hot pointer declares. */
export const SESSION_PLUS_SUBJECT_ENTRY: SubjectCatalogEntry = sessionPlusSubjectEntry(() => null);
