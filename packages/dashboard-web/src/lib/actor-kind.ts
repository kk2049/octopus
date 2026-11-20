import { uiText } from "../i18n/ui-text.js";

/**
 * How a ticket or ticket message was written (bot.db v86, review 6.10). The
 * server derives it from the credential the write arrived on; rows written
 * before it was recorded have none.
 */
export type ActorKind = "browser" | "token" | "mcp" | "system" | "feishu";

/** Known not to have been typed by the named person in an interactive client. */
export function isNonPersonActor(kind: string | null | undefined): boolean {
  return kind === "token" || kind === "mcp" || kind === "system";
}

/**
 * A short plain label for text that carries a person's name but was not typed
 * by them: null for a browser (or Feishu) row and for an unrecorded (older)
 * row, which therefore show nothing rather than a guess.
 */
export function actorKindLabel(kind: string | null | undefined): string | null {
  switch (kind) {
    case "token": return uiText("脚本/令牌提交");
    case "mcp": return uiText("由 agent 代写");
    case "system": return uiText("系统生成");
    default: return null;
  }
}

/** Tooltip shared by every place the label appears. */
export function actorKindHint(): string {
  return uiText("不是本人在浏览器中输入的，不作为本人原话");
}
