import type { AgentModuleManifest } from "@claude-bot/agent-module-contract";
import { FEISHU_DOCUMENT_RESOURCE_KIND } from "./links.js";

export const FEISHU_DOCUMENT_MODULE_ID = "feishu.document-link/v1";

export const FEISHU_DOCUMENT_MANIFEST: AgentModuleManifest = {
  id: FEISHU_DOCUMENT_MODULE_ID,
  version: "1.0.0",
  implementation: "@claude-bot/agent-feishu-view#FeishuDocument",
  title: "飞书文档",
  slots: ["primary", "secondary"],
  ports: [],
  opens: [FEISHU_DOCUMENT_RESOURCE_KIND],
};

export const FEISHU_MANIFESTS: readonly AgentModuleManifest[] = Object.freeze([FEISHU_DOCUMENT_MANIFEST]);
