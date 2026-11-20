/**
 * 模块演示, on screen in a second.
 *
 *     pnpm run app:preview -- packages/showcase-view/examples/showcase.preview.ts
 *
 * ── What is real here and what is not ───────────────────────────────────────
 *
 * The composition and the module list are the RELEASE's — imported from
 * `src/plan.ts` and `src/modules.ts`, not copied — so what a preview shows is
 * what a release would assemble. The projection is real too, in the sense that
 * matters: it is `app/projection.ts` run over an event log, so a rename in the
 * backend shows up here rather than in production.
 *
 * What is a fixture is the CHANNEL. `actions` are canned answers; nothing is
 * committed, no event is appended, and the projection does not move when you
 * submit. That is deliberate and is the line this harness must not cross:
 * approval, capability, identity and revocation are the Host's, and a preview
 * that appeared to model them would be teaching an author that their App is
 * authorised.
 */

import { definePreviewPlan } from "@claude-bot/agent-view-preview";
import { APP_DATA_CONTRACT, appDataAdapter } from "@claude-bot/agent-data-view";
import { project } from "../app/projection.js";
import { SHOWCASE_COMPOSITION } from "../src/plan.js";
import { SHOWCASE_MODULES } from "../src/modules.js";

/** Events shaped the way the trusted coordinator commits them: it owns `at`/`by`. */
const EVENTS = [
  {
    type: "note_added",
    data: { id: "n1", title: "上上周周报", body: "已经发出去了。", state: "已归档" },
    at: "2026-08-05T02:10:00.000Z",
    by: "user:lht",
  },
  {
    type: "note_added",
    data: {
      id: "n2",
      title: "周报草稿",
      body: "## 本周\n\n- 平台收敛计划 P4\n- 通用数据模块\n\n> 还没发。",
      state: "草稿",
    },
    at: "2026-08-07T01:20:00.000Z",
    by: "user:lht",
  },
  {
    type: "note_added",
    data: { id: "n3", title: "部署确认清单", body: "1. land\n2. deploy\n3. confirm", state: "待办" },
    at: "2026-08-07T03:40:00.000Z",
    by: "user:ops",
  },
];

export default definePreviewPlan({
  title: "模块演示（笔记 + 幻灯）",
  composition: SHOWCASE_COMPOSITION,
  modules: SHOWCASE_MODULES,
  // The whole of this App's wiring — the same line `App.tsx` writes.
  providers: { [APP_DATA_CONTRACT]: appDataAdapter },
  projection: project(EVENTS) as Record<string, unknown>,
  actions: {
    add_note: (params) => ({ ok: true, message: `预览：收到「${params.title ?? ""}」（没有真的写进去）` }),
    deck_command: (params) => ({
      ok: true,
      message: `预览：收到 ${params.op ?? ""} 命令（deck 不会真的改变）`,
    }),
  },
});
