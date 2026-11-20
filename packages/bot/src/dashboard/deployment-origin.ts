import type { DeploymentOrigin } from "@claude-bot/dashboard-web/contract";
import type { DeployIntentRow, DevTicketRow } from "../store/repositories/dev-tickets.js";
import type { DashboardIdentity } from "./server.js";

type Source = Omit<DeploymentOrigin, "intent_id" | "actor">;
type Viewer = Pick<DashboardIdentity, "username" | "admin" | "dev" | "via">;

/** Attribution is display metadata; it never changes the authenticated actor. */
export function deploymentSource(raw: unknown, viewer: Viewer, getTicket: (id: number) => DevTicketRow | undefined): Source {
  if (raw == null) return { kind: viewer.via === "cookie" ? "web" : "cli_api" };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("更新来源格式不正确");
  const source = raw as Record<string, unknown>;
  if (source.kind === "ticket_agent") {
    const id = source.ticket_id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("更新来源需要有效工单编号");
    const ticket = getTicket(id);
    if (!ticket || (!viewer.admin && ticket.requester !== viewer.username)) throw new Error("不能引用这张工单作为更新来源");
    return { kind: "ticket_agent", ticket_id: id, ticket_title: ticket.title.slice(0, 160), agent: ticket.model };
  }
  if (source.kind === "cli_agent") {
    const text = (value: unknown): string | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== "string" || !value.trim() || value.length > 120 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Agent 来源信息需为 1–120 字的单行文字");
      return value.trim();
    };
    const agent = text(source.agent);
    if (!agent) throw new Error("请注明 CLI Agent 名称");
    return { kind: "cli_agent", agent, session: text(source.session), device: text(source.device) };
  }
  throw new Error("不支持的更新来源；网页与 CLI/API 路径由服务端识别");
}

export function deploymentOrigin(row: DeployIntentRow | undefined, viewer: Viewer): DeploymentOrigin | null {
  if (!row || (!viewer.admin && !viewer.dev && row.triggered_by !== viewer.username)) return null;
  let source: Source = { kind: "unknown" };
  try {
    const parsed = JSON.parse(row.trigger_source ?? "null") as Source | null;
    if (parsed && ["web", "cli_api", "ticket_agent", "cli_agent"].includes(parsed.kind)) source = parsed;
  } catch { /* Historical/unreadable attribution is unknown, never guessed. */ }
  return { ...source, intent_id: row.id, actor: row.triggered_by };
}
