import { AvButton } from "@claude-bot/agent-view-react/ui";
import type { ActionSetStatus, ActionSpec } from "../lib/select.js";

export interface DataActionsProps {
  title: string;
  source: string;
  actions: readonly ActionSpec[];
  status: ActionSetStatus;
  booting: boolean;
  onSelect(action: ActionSpec): void;
}

/** A dense, fixed action surface; the selected form is rendered in a dialog. */
export function DataActions({ title, source, actions, status, booting, onSelect }: DataActionsProps) {
  const note = booting
    ? "⏳ 正在等待第一份投影…"
    : status === "missing"
      ? `这个组合指向的动作菜单不存在：${source}`
      : status === "not_a_collection"
        ? `投影路径 ${source} 不是动作菜单。`
        : actions.length === 0
          ? "当前角色没有可用动作。"
          : "";
  return (
    <section className="dv-action-launcher" data-dv-source={source} data-dv-status={status}>
      <header className="dv-action-head">
        <b>{title || "可用动作"}</b>
        {actions.length ? <small>{actions.length} 项</small> : null}
      </header>
      {note ? <p className="dv-note" role="note">{note}</p> : (
        <div className="dv-action-buttons" role="toolbar" aria-label={title || "可用动作"}>
          {actions.map((action, index) => (
            <AvButton
              key={action.action}
              className={index === 0 ? "primary" : undefined}
              aria-haspopup="dialog"
              data-dv-action={action.action}
              onClick={() => onSelect(action)}
            >
              {action.label}
            </AvButton>
          ))}
        </div>
      )}
    </section>
  );
}
