import {
  COMPOSITION_SCHEMA,
  encodeComposition,
  encodeModuleLock,
  moduleLockOf,
  type AgentComposition,
  type AgentModuleManifest,
} from "@claude-bot/agent-module-contract";
import { DATA_FORM_MODULE_ID, DATA_MANIFESTS } from "@claude-bot/agent-data-view/manifests";
import {
  DECK_MANIFESTS,
  DECK_OUTLINE_MODULE_ID,
  DECK_SLIDE_MODULE_ID,
  DECK_SLIDE_RESOURCE_KIND,
  DECK_TYPST_MODULE_ID,
  DECK_TYPST_RESOURCE_KIND,
} from "@claude-bot/agent-deck-view/manifests";

export const PPT_STUDIO_APP = "ppt-studio";
export const PPT_STUDIO_PUBLISHER = "octopus:first-party";
export const MODULE_LOCK_ASSET = "view/module-lock.json";
export const COMPOSITION_ASSET = "view/composition.json";

export const PPT_STUDIO_MANIFESTS: readonly AgentModuleManifest[] = Object.freeze([
  ...DATA_MANIFESTS,
  ...DECK_MANIFESTS,
]);
export const PPT_STUDIO_MODULE_LOCK = moduleLockOf(PPT_STUDIO_MANIFESTS);

export const PPT_STUDIO_COMPOSITION: AgentComposition = {
  schema: COMPOSITION_SCHEMA,
  app: PPT_STUDIO_APP,
  instances: [
    {
      instance: "outline",
      module: DECK_OUTLINE_MODULE_ID,
      slot: "navigation",
      title: "幻灯片",
      config: {
        source: "deck",
        title: "幻灯片",
        command_action: "deck_command",
        export_kind: DECK_TYPST_RESOURCE_KIND,
        empty_text: "还没有页面；把目标交给演示文稿 agent。"
      }
    },
    {
      instance: "slide",
      module: DECK_SLIDE_MODULE_ID,
      slot: "primary",
      title: "画布",
      config: {
        source: "deck",
        title: "幻灯画布",
        command_action: "deck_command",
        hint: "点击文字就地编辑；回车或失焦提交一条语义命令。"
      }
    },
    {
      instance: "typst",
      module: DECK_TYPST_MODULE_ID,
      slot: "secondary",
      title: "Typst 导出",
      config: { source: "deck", title: "Typst 源码" }
    },
    {
      instance: "brief",
      module: DATA_FORM_MODULE_ID,
      slot: "bottom",
      title: "交给 Agent",
      config: {
        action: "ask_presenter",
        fields: "askPresenterParams",
        title: "演示目标",
        submit_label: "生成 / 改写"
      }
    }
  ],
  open: [
    { resource: DECK_SLIDE_RESOURCE_KIND, module: DECK_SLIDE_MODULE_ID, slot: "primary", mode: "rebind" },
    { resource: DECK_TYPST_RESOURCE_KIND, module: DECK_TYPST_MODULE_ID, slot: "secondary", mode: "rebind" }
  ]
};

export const PPT_STUDIO_MODULE_LOCK_JSON = encodeModuleLock(PPT_STUDIO_MODULE_LOCK);
export const PPT_STUDIO_COMPOSITION_JSON = encodeComposition(PPT_STUDIO_COMPOSITION);
export const PPT_STUDIO_MODULE_ASSETS = Object.freeze([
  { name: COMPOSITION_ASSET, source: PPT_STUDIO_COMPOSITION_JSON },
  { name: MODULE_LOCK_ASSET, source: PPT_STUDIO_MODULE_LOCK_JSON }
]);
