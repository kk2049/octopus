import {
  COMPOSITION_SCHEMA,
  encodeComposition,
  encodeModuleLock,
  moduleLockOf,
  type AgentComposition,
  type AgentModuleManifest,
} from "@claude-bot/agent-module-contract";

import { AGENT_CHAT_MANIFEST, AGENT_CHAT_MODULE_ID } from '@claude-bot/agent-sessions-view/manifests';
import { FILE_VIEWER_MANIFEST, FILE_VIEWER_MODULE_ID, WORKSPACE_TEXT_RESOURCE_KIND } from '@claude-bot/agent-workspace-files-view/manifests';
import { WORKSPACE_MEDIA_RESOURCE_KIND } from '@claude-bot/workspace-files-contract';
export const RESEARCH_PROGRAM_APP = "research-program";
export const RESEARCH_PROGRAM_PORT = "research-program/v1";
export const RESEARCH_AGENT_CHAT_MODULE_ID = AGENT_CHAT_MODULE_ID;
export const RESEARCH_DOCUMENT_MODULE_ID = FILE_VIEWER_MODULE_ID;
export const RESEARCH_DOCUMENT_RESOURCE_KIND = WORKSPACE_TEXT_RESOURCE_KIND;
export const RESEARCH_AGENT_CHAT_MANIFEST = AGENT_CHAT_MANIFEST;
export const RESEARCH_DOCUMENT_MANIFEST = FILE_VIEWER_MANIFEST;

export const RESEARCH_PROGRAM_MANIFESTS: readonly AgentModuleManifest[] = Object.freeze([
  RESEARCH_AGENT_CHAT_MANIFEST,
  RESEARCH_DOCUMENT_MANIFEST,
]);

export const RESEARCH_PROGRAM_COMPOSITION: AgentComposition = {
  schema: COMPOSITION_SCHEMA,
  app: RESEARCH_PROGRAM_APP,
  instances: [
    { instance: "agent", module: RESEARCH_AGENT_CHAT_MODULE_ID, slot: "primary", title: "Agent" },
    { instance: "document", module: RESEARCH_DOCUMENT_MODULE_ID, slot: "secondary", title: "文档" },
  ],
  open: [
    { resource: "session", module: RESEARCH_AGENT_CHAT_MODULE_ID, slot: "primary" },
    { resource: RESEARCH_DOCUMENT_RESOURCE_KIND, module: RESEARCH_DOCUMENT_MODULE_ID, slot: "secondary" },
    { resource: WORKSPACE_MEDIA_RESOURCE_KIND, module: RESEARCH_DOCUMENT_MODULE_ID, slot: "secondary" },
  ],
};

export const RESEARCH_PROGRAM_MODULE_ASSETS = Object.freeze([
  { name: "view/composition.json", source: encodeComposition(RESEARCH_PROGRAM_COMPOSITION) },
  { name: "view/module-lock.json", source: encodeModuleLock(moduleLockOf(RESEARCH_PROGRAM_MANIFESTS)) },
]);
