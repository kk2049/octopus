import type { AgentModuleManifest, ModuleConfigDeclaration } from "@claude-bot/agent-module-contract";
import { APP_DATA_CONTRACT } from "@claude-bot/agent-data-view/port";

export const INTAKE_WORKFLOW_MODULE_ID = "intake.workflow/v1";
export const INTAKE_WORKFLOW_CONFIG: ModuleConfigDeclaration = Object.freeze({
  source: { type: "string", required: true, description: "投影里 intake 工作台的路径" },
  submit_action: { type: "string", required: true, description: "提交新材料的 App action" },
  approve_action: { type: "string", description: "管理者通过记录的 App action" },
  reject_action: { type: "string", description: "管理者退回记录的 App action" },
  submit_label: { type: "string", description: "提交按钮文案" },
});
export const INTAKE_WORKFLOW_MANIFEST: AgentModuleManifest = {
  id: INTAKE_WORKFLOW_MODULE_ID,
  version: "1.0.0",
  implementation: "@claude-bot/agent-intake-view#IntakeWorkflow",
  title: "材料提交与处理工作台",
  slots: ["primary", "secondary"],
  ports: [APP_DATA_CONTRACT],
  opens: [],
  config: INTAKE_WORKFLOW_CONFIG,
};
export const INTAKE_MANIFESTS: readonly AgentModuleManifest[] = Object.freeze([INTAKE_WORKFLOW_MANIFEST]);
