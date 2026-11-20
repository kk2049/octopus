import { useState } from "react";
import type { TicketExecutionOptions } from "../contract.js";
import { useDashboardLanguage } from "../i18n/react.js";
import { uiText } from "../i18n/ui-text.js";
import { AccountQuota } from "./AccountQuota.js";
import { UiSelect } from "../ui-kit/primitives.js";

/**
 * `family` is the Agent source family the chosen model runs on, as the server's
 * model catalog names it (`ticketModelSource`); undefined matches no source.
 */
export function useTicketExecution(
  options: TicketExecutionOptions | undefined,
  family: "claude" | "codex" | "omp" | undefined,
  owner: string,
) {
  const [sources, setSources] = useState<Record<string, string>>({});
  const [workspaces, setWorkspaces] = useState<Record<string, string>>({});
  const sourceKey = `${owner}:${family}`;
  const sourceId = sources[sourceKey] ?? (options?.sources.find((s) => s.id === options.source_default && s.source === family)?.id
    ?? options?.sources.find((s) => s.source === family)?.id ?? "");
  const workspaceId = workspaces[owner] ?? options?.workspace_default ?? "";
  const source = options?.sources.find((s) => s.id === sourceId);
  const workspace = options?.workspaces.find((w) => w.id === workspaceId);
  const compatible = (w: TicketExecutionOptions["workspaces"][number]) => !source || source.device === w.device
    || (source.split_execution && (source.source !== "codex" || w.codex_remote));
  return { options, family, sourceId, workspaceId, compatible,
    ready: !options || Boolean(source?.available && workspace?.available && compatible(workspace)),
    setSource: (value: string) => setSources((old) => ({ ...old, [sourceKey]: value })),
    setWorkspace: (value: string) => setWorkspaces((old) => ({ ...old, [owner]: value })),
    payload: options ? { agent_source: sourceId, workspace: workspaceId } : {},
  };
}

function unavailableReason({ reason }: { reason?: string }): string {
  switch (reason) {
    case "offline": return uiText("Runner 离线");
    case "backend_unavailable": return uiText("Agent 后端不可用");
    case "runner_upgrade_required": return uiText("需要更新 Runner");
    case "account_registration_required": return uiText("账号尚未登记");
    case "workspace_inventory_required": return uiText("工作区尚未登记");
    case "workspace_unavailable": return uiText("工作区执行能力不可用");
    default: return uiText("尚未登记或需要更新 Runner");
  }
}

/** The Runner's own diagnostic (code, offending path, rule) beside the refusal; no new copy. */
function diagnosticText({ diagnostic }: TicketExecutionOptions["sources"][number]): string {
  return diagnostic ? ` (${[diagnostic.code, diagnostic.path, diagnostic.rule].filter(Boolean).join(" · ")})` : "";
}

export function TicketExecutionFields({ selection, idPrefix, wrapLabels = false }: {
  selection: ReturnType<typeof useTicketExecution>; idPrefix: string; wrapLabels?: boolean;
}) {
  useDashboardLanguage();
  const { options } = selection;
  if (!options) return null;
  const unavailable = uiText("尚未登记或需要更新 Runner");
  const sources = options.sources.filter((s) => s.source === selection.family).map((s) => ({
    value: s.id, label: <span style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
      <span>{uiText("Agent 来源")}: {s.label}</span>
      {s.source === "codex" ? <AccountQuota quota={s.quota} offline={s.reason === "offline"} /> : null}
      {!s.available ? <span> · {unavailableReason(s)}{diagnosticText(s)}</span> : null}
    </span>, disabled: !s.available,
  }));
  const workspaces = options.workspaces.map((w) => ({ value: w.id,
    label: `${uiText("工作区选择")}: ${w.label}${!w.available ? ` · ${unavailableReason(w)}`
      : !selection.compatible(w) ? ` · ${uiText("不支持此来源的远程执行")}` : ""}`,
    disabled: !w.available || !selection.compatible(w),
  }));
  // Keep explicit selections visible when a later metadata frame omits them.
  if (selection.sourceId && !sources.some((s) => s.value === selection.sourceId)) sources.push({ value: selection.sourceId, label: <span>{unavailable}</span>, disabled: true });
  if (selection.workspaceId && !workspaces.some((w) => w.value === selection.workspaceId)) workspaces.push({ value: selection.workspaceId, label: unavailable, disabled: true });
  return <>
    <label className="srOnly" htmlFor={`${idPrefix}-source`}>{uiText("Agent 来源")}</label>
    <UiSelect wrapLabels={wrapLabels} id={`${idPrefix}-source`} value={selection.sourceId} onValueChange={selection.setSource} options={sources} />
    <label className="srOnly" htmlFor={`${idPrefix}-workspace`}>{uiText("工作区选择")}</label>
    <UiSelect wrapLabels={wrapLabels} id={`${idPrefix}-workspace`} value={selection.workspaceId} onValueChange={selection.setWorkspace} options={workspaces} />
    {!selection.ready ? <span role="status">{uiText("来源或工作区暂不可用，请选择可用组合。")}</span> : null}
  </>;
}
