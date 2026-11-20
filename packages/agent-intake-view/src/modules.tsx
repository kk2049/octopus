import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InstanceConfig } from "@claude-bot/agent-module-contract";
import type { ModuleProps, ModuleRegistryEntry } from "@claude-bot/agent-view-react/workspace";
import { selectPath, useAppData } from "@claude-bot/agent-data-view";
import { IntakeWorkflow } from "./components/IntakeWorkflow.js";
import { INTAKE_LIMITS, readIntake } from "./lib/intake.js";
import { INTAKE_WORKFLOW_MANIFEST } from "./manifests.js";

function text(config: InstanceConfig | null, key: string): string { const value = config?.[key]; return typeof value === "string" ? value : ""; }

function IntakeWorkflowModule({ panel }: ModuleProps) {
  const { snapshot, submit, dismissProposal } = useAppData();
  const source = text(panel.config, "source");
  const submitAction = text(panel.config, "submit_action");
  const approveAction = text(panel.config, "approve_action");
  const rejectAction = text(panel.config, "reject_action");
  const intake = useMemo(() => readIntake(selectPath(snapshot.projection, source)), [snapshot.projection, source]);
  const [file, setFile] = useState<File | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "error" | "info"; text: string } | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const actions = new Set([submitAction, approveAction, rejectAction]);
  const pending = snapshot.proposals.some((row) => actions.has(row.action) && row.phase === "inflight");
  const refusal = [...snapshot.proposals].reverse().find((row) => actions.has(row.action) && row.phase === "refused");
  const run = useCallback(async (action: string, params: Record<string, string>) => {
    if (!action || pending) return false;
    if (refusal) dismissProposal(refusal.rid);
    setNotice(null);
    const reply = await submit(action, params);
    if (!live.current || !reply.ok) return false;
    setNotice({ tone: "ok", text: reply.message || "操作已提交。" });
    return true;
  }, [dismissProposal, pending, refusal, submit]);
  const onSubmit = useCallback(async (values: Record<string, string>) => {
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) { setNotice({ tone: "error", text: "只能提交 PDF 文件。" }); return; }
    if (file.size > INTAKE_LIMITS.pdfBytes) { setNotice({ tone: "error", text: "PDF 超过 180 KiB 的演示上限。" }); return; }
    try {
      const receipt_pdf = await pdfEnvelope(file);
      const accepted = await run(submitAction, { ...values, receipt_pdf });
      if (accepted && live.current) setFile(null);
    } catch { if (live.current) setNotice({ tone: "error", text: "PDF 读取失败。" }); }
  }, [file, run, submitAction]);
  return <IntakeWorkflow intake={intake} busy={pending} notice={refusal ? { tone: "error", text: refusal.message || "操作被拒绝。" } : notice}
    file={file} submitLabel={text(panel.config, "submit_label")} onFile={setFile} onSubmit={onSubmit}
    onDecide={(id, decision) => { void run(decision === "approve" ? approveAction : rejectAction, { expense_id: id }); }} />;
}

async function pdfEnvelope(file: File): Promise<string> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result.split(",", 2)[1] ?? "" : "");
    reader.readAsDataURL(file);
  });
  return JSON.stringify({ name: file.name, type: file.type || "application/pdf", size: file.size, data });
}

export const INTAKE_WORKFLOW_MODULE: ModuleRegistryEntry = Object.freeze({ manifest: INTAKE_WORKFLOW_MANIFEST, component: IntakeWorkflowModule });
export const INTAKE_MODULES: readonly ModuleRegistryEntry[] = Object.freeze([INTAKE_WORKFLOW_MODULE]);
export const CONFIG_KEYS_READ = Object.freeze({ workflow: Object.freeze(["source", "submit_action", "approve_action", "reject_action", "submit_label"]) });
