/**
 * A whole App, as data.
 *
 * ── What to look at ─────────────────────────────────────────────────────────
 *
 * There is no component in this file, and no App package. What is here is the
 * `agent-composition/v1` document a release would ship, a module list, one line
 * of wiring, and a fixture standing in for the backend's projection. The
 * standard shell assembles the rest.
 *
 * Two of the three panels are the SAME module — `data.list/v1` — turned into
 * 收件箱 and 归档箱 by their instance `config` alone. That is decision 7's
 * acceptance scenario written out as a thing you can look at:
 *
 *     pnpm run app:preview -- packages/agent-data-view/examples/inbox.preview.ts
 *
 * ── What a real App would add ───────────────────────────────────────────────
 *
 * The `projection` and `actions` below stand in for an App Runtime: in a real
 * release they come from the App's own `projection.ts` and `app.yaml`, over the
 * one channel, and the `providers` line is unchanged. Nothing else in this file
 * would differ — which is the claim being demonstrated.
 */

import {
  COMPOSITION_SCHEMA,
  type AgentComposition,
} from "@claude-bot/agent-module-contract";
import { definePreviewPlan } from "@claude-bot/agent-view-preview";
import {
  APP_DATA_CONTRACT,
  DATA_DETAIL_MODULE_ID,
  DATA_FORM_MODULE_ID,
  DATA_LIST_MODULE_ID,
  DATA_MODULES,
  DATA_RECORD_RESOURCE_KIND,
  appDataAdapter,
} from "../src/index.js";

const APP = "notes-demo";

/** The release document. Ordinary data — a reviewer reads it top to bottom. */
const composition: AgentComposition = {
  schema: COMPOSITION_SCHEMA,
  app: APP,
  instances: [
    {
      instance: "inbox",
      module: DATA_LIST_MODULE_ID,
      slot: "navigation",
      title: "收件箱",
      config: {
        source: "inbox",
        title: "收件箱",
        empty_text: "收件箱是空的。",
        open_kind: DATA_RECORD_RESOURCE_KIND,
      },
    },
    {
      instance: "archive",
      module: DATA_LIST_MODULE_ID,
      slot: "navigation",
      title: "归档箱",
      // The same implementation, a different path, a different purpose.
      config: {
        source: "archive",
        title: "归档箱",
        empty_text: "还没有归档过任何东西。",
        open_kind: DATA_RECORD_RESOURCE_KIND,
      },
    },
    {
      instance: "note",
      module: DATA_DETAIL_MODULE_ID,
      slot: "primary",
      config: {
        source: "byId",
        id_key: "id",
        fields: "detailFields",
        empty_text: "从左边选一条看看。",
      },
    },
    {
      instance: "compose",
      module: DATA_FORM_MODULE_ID,
      slot: "secondary",
      // The form is generated from `addNoteParams` below — the same declaration
      // the backend's handler would validate against.
      config: {
        action: "add_note",
        fields: "addNoteParams",
        title: "写一条",
        submit_label: "记下来",
        hint: "预览里不会真的写进去。",
      },
    },
    {
      instance: "stats",
      module: DATA_DETAIL_MODULE_ID,
      slot: "bottom",
      // No `id_key`, so `source` IS the record: the `kv` widget, for free.
      config: { source: "stats", title: "统计" },
    },
  ],
  open: [{ resource: DATA_RECORD_RESOURCE_KIND, module: DATA_DETAIL_MODULE_ID, slot: "primary", mode: "rebind" }],
};

/** What the App's backend would project. Here, a fixture. */
const projection = {
  inbox: [
    { id: "n1", title: "周报草稿", subtitle: "lht · 今天", badge: "待办", tone: "warn" },
    { id: "n2", title: "部署确认清单", subtitle: "ops · 昨天" },
  ],
  archive: [{ id: "n0", title: "上上周周报", subtitle: "lht · 上周" }],
  byId: {
    n0: { id: "n0", title: "上上周周报", who: "lht", state: "已归档", body: "已经发出去了。" },
    n1: {
      id: "n1",
      title: "周报草稿",
      who: "lht",
      state: "草稿",
      body: "## 本周\n\n- 平台收敛计划 P4\n- 通用数据模块\n\n> 还没发。",
    },
    n2: { id: "n2", title: "部署确认清单", who: "ops", state: "待办", body: "1. land\n2. deploy\n3. confirm" },
  },
  /** Which fields the detail panel puts in its facts table, and their labels. */
  detailFields: { who: "作者", state: "状态" },
  stats: { 收件箱: 2, 归档箱: 1, 未读: 1 },
  /** The action's parameter declaration — the same one its handler validates. */
  addNoteParams: {
    title: { type: "string", required: true, description: "一句话标题" },
    body: { type: "text", description: "正文，支持 Markdown" },
    state: { type: "string", enum: ["草稿", "待办", "已归档"] },
  },
};

export default definePreviewPlan({
  title: "笔记 Demo",
  composition,
  modules: DATA_MODULES,
  // The whole of this App's wiring.
  providers: { [APP_DATA_CONTRACT]: appDataAdapter },
  projection,
  actions: {
    add_note: (params) => ({ ok: true, message: `预览：收到「${params.title ?? ""}」（没有真的写进去）` }),
  },
});
