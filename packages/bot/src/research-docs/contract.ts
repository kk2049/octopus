import { contractDigestOf } from "@claude-bot/engine";
import {
  DOCS_APP,
  DOCS_PUBLISHER,
  DOCS_OPERATIONS,
} from "@claude-bot/research-docs-contract";
import {
  defineOperationCatalog,
  type SubjectCatalogEntry,
  type OperationInfo,
} from "../permissions/catalog.js";
export const DOCS_PROFILE = "research-docs/v1";
export const DOCS_PERMISSION = {
  app: DOCS_APP,
  publisher: DOCS_PUBLISHER,
  operations: [...DOCS_OPERATIONS],
  autoAllow: [...DOCS_OPERATIONS],
  actions: {},
  agents: {},
  delivery: [],
};
export const DOCS_DIGEST = contractDigestOf(DOCS_PERMISSION);
export const isDocsContract = (
  app: string,
  publisher: string,
  digest: string,
) => app === DOCS_APP && publisher === DOCS_PUBLISHER && digest === DOCS_DIGEST;
const descriptions: Record<
  string,
  Pick<OperationInfo, "title" | "description" | "effect" | "risk">
> = {
  read_documents: {
    title: "读取共享文档",
    description: "读取本人已加入的文档空间、附件和讨论。",
    effect: "read",
    risk: "读取私密内容",
  },
  edit_documents: {
    title: "协作编辑文档",
    description: "按成员角色合并文档、管理页面、上传附件和参与讨论。",
    effect: "modify",
    risk: "修改",
  },
  read_sources: {
    title: "浏览科研来源",
    description: "浏览本人另有授权的科研项目，文档共享不扩张原资源权限。",
    effect: "read",
    risk: "读取私密内容",
  },
  interact_sources: {
    title: "操作引用的科研资源",
    description:
      "通过原科研项目权限打开文件、与绑定 Agent 交互或处理录音。每次动作仍检查原项目权限。",
    effect: "execute",
    risk: "执行命令",
  },
};
export const DOCS_CATALOG = defineOperationCatalog(
  "research-docs",
  DOCS_OPERATIONS.map((id) => ({
    id,
    runner: id,
    ...descriptions[id],
    alwaysApprove: false,
    mayAutoAllow: true,
  })),
);
export const DOCS_SUBJECT: SubjectCatalogEntry = {
  info: {
    type: "app",
    id: DOCS_APP,
    publisher: DOCS_PUBLISHER,
    title: "研究文档",
    description: "文档、资料和 Agent 的共享工作空间",
    enforced: true,
  },
  catalog: DOCS_CATALOG,
  declared: () => [...DOCS_OPERATIONS],
  userManaged: true,
  grantIdentity: { publisher: DOCS_PUBLISHER, contractDigest: DOCS_DIGEST },
};
