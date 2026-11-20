/** Trusted binding for one provider-originated, single-use Agent interaction. */

import { currentRuntimeOf } from "@claude-bot/agent-sessions-contract";
import type { RuntimeJson } from "@claude-bot/app-runtime";
import { retainTranscripts } from "./projection.js";
import { decodeResourceId } from "../sessionhub/core.js";
import type { SessionHubService } from "../sessionhub/service.js";
import type { SessionPlusInstanceBinding, SessionPlusPrincipal } from "../app-core/instance.js";
import type { Source as ScanSource } from "@claude-bot/plugin-sessions/scan";
import { SESSION_CLI_KINDS } from "../sessionhub/core.js";

export const SESSION_PLUS_INTERACTION_ACTION = "respond_agent_interaction";

export type BoundInteractionResult =
  | { ok: true; result: RuntimeJson; projection: RuntimeJson }
  | { ok: false; error: string };

/**
 * The View names only what it can already see: a resource, interaction id and
 * bounded answer. Device, provider and session id are rebound on the trusted
 * side from the resource id it minted, and the request itself must still be
 * present and answerable in this instance's own projection, before the
 * existing Session Hub human-response plane is called. The iframe therefore
 * never receives a direct Session Hub credential or an authority-bearing
 * target.
 *
 * The roster row is one place that request may be found, not the thing that
 * makes it answerable (ticket #208): the transcript window carries the same
 * runtime, and a session that has aged out of the truncated roster frame is
 * still on screen with its question. The device remains the authority for
 * whether that interaction is still pending.
 */
export class SessionPlusInteractionBinding {
  constructor(private readonly hub: Pick<SessionHubService, "respondInteraction">) {}

  async submit(
    binding: SessionPlusInstanceBinding,
    principal: SessionPlusPrincipal,
    params: Readonly<Record<string, string>>,
  ): Promise<BoundInteractionResult> {
    if (!principal.session || principal.owner !== binding.owner || binding.actorKind !== "user") {
      return { ok: false, error: "回答 Agent 请求只允许本人当前的网页登录操作" };
    }
    const resource = String(params.resource ?? "");
    const interactionId = String(params.interaction_id ?? "");
    const decoded = decodeResourceId(resource);
    if (!decoded || decoded.owner !== binding.owner || !decoded.device) {
      return { ok: false, error: "这个会话标识无效或不属于当前账户，请重新选择会话" };
    }
    const root = object(binding.projection);
    const session = array(root.sessions).find((row) => String(row.resourceId ?? "") === resource);
    const window = object(object(root.transcript)[resource]);
    const rosterRuntime = session?.runtime ? object(session.runtime) : undefined;
    const transcriptRuntime = window.runtime ? object(window.runtime) : undefined;
    // Use the same newest fact as the card. An old roster receipt must not
    // hide a newer transcript request, nor revive a request already cleared.
    const interaction = object(currentRuntimeOf(rosterRuntime, transcriptRuntime)?.interaction);
    const provider = SESSION_CLI_KINDS.includes(interaction.provider as ScanSource)
      ? interaction.provider
      : null;
    if (
      !provider
      || decoded.cliKind !== provider
      || String(interaction.id ?? "") !== interactionId
      || object(interaction.capabilities).respond !== true
    ) {
      return { ok: false, error: "这个 Agent 请求已经结束或不属于当前会话，请刷新后重试" };
    }
    const decision = responseDecision(params.response_json, interaction);
    if (!decision.ok) return decision;
    const outcome = await this.hub.respondInteraction({
      username: principal.owner,
      admin: false,
      session: principal.session,
      credential: principal.credential,
    }, {
      owner: principal.owner,
      device: decoded.device,
      provider,
      sessionId: decoded.sessionId,
      interactionId,
      responseJson: params.response_json,
    });
    if (!outcome.ok) return { ok: false, error: outcome.error };
    return {
      ok: true,
      result: json(outcome.data),
      projection: clearInteraction(binding.projection, resource, interactionId),
    };
  }
}

function responseDecision(
  source: string | undefined,
  interaction: Record<string, RuntimeJson>,
): { ok: true } | { ok: false; error: string } {
  if (!source || Buffer.byteLength(source, "utf8") > 32 * 1024) {
    return { ok: false, error: "Agent 回答为空或过大" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { ok: false, error: "Agent 回答不是有效 JSON" };
  }
  const response = plain(raw);
  if (!response) return { ok: false, error: "Agent 回答格式无效" };
  const decision = response.decision;
  if (decision !== "allow" && decision !== "deny") {
    return { ok: false, error: "Agent 回答 decision 只能是 allow 或 deny" };
  }
  const capabilities = object(interaction.capabilities);
  if (decision === "allow" ? capabilities.allow !== true : capabilities.deny !== true) {
    return { ok: false, error: decision === "allow" ? "这个请求不能被允许" : "这个请求不能被拒绝" };
  }
  const answers = plain(response.answers);
  if (!answers) return { ok: false, error: "Agent 回答缺少 answers" };
  const questions = array(interaction.questions);
  const known = new Set(questions.map((question) => String(question.id ?? "")));
  for (const [id, values] of Object.entries(answers)) {
    if (!known.has(id) || !Array.isArray(values) || values.length > 16) {
      return { ok: false, error: "Agent 回答包含未知问题或无效选项" };
    }
    if (values.some((value) => typeof value !== "string" || value.length > 4_000)) {
      return { ok: false, error: "Agent 回答包含无效或过长的文本" };
    }
  }
  if (decision === "allow") {
    for (const question of questions) {
      const id = String(question.id ?? "");
      const values = answers[id];
      if (!Array.isArray(values) || values.length === 0) {
        return { ok: false, error: `请回答「${String(question.header || question.prompt || "问题")}"` };
      }
      if (question.multiple !== true && values.length > 1) {
        return { ok: false, error: `「${String(question.header || question.prompt || "问题")}」只能选择一个答案` };
      }
    }
  }
  if (response.message !== undefined && (typeof response.message !== "string" || response.message.length > 2_000)) {
    return { ok: false, error: "Agent 回答附言无效或过长" };
  }
  return { ok: true };
}

function clearInteraction(projection: RuntimeJson, resource: string, interactionId: string): RuntimeJson {
  const root = object(projection);
  let changed = false;
  const sessions = Array.isArray(root.sessions)
    ? root.sessions.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const session = entry as Record<string, RuntimeJson>;
        if (String(session.resourceId ?? "") !== resource) return entry;
        const runtime = object(session.runtime);
        const interaction = object(runtime.interaction);
        if (String(interaction.id ?? "") !== interactionId) return entry;
        const { interaction: _interaction, ...nextRuntime } = runtime;
        changed = true;
        return { ...session, runtime: nextRuntime };
      })
    : root.sessions;
  const transcripts = object(root.transcript);
  const window = object(transcripts[resource]);
  const runtime = object(window.runtime);
  const interaction = object(runtime.interaction);
  let transcript = root.transcript;
  if (String(interaction.id ?? "") === interactionId) {
    const { interaction: _interaction, ...nextRuntime } = runtime;
    changed = true;
    transcript = retainTranscripts(transcripts, resource, { ...window, runtime: nextRuntime });
  }
  return changed ? { ...root, sessions, transcript } : projection;
}

function plain(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function object(value: RuntimeJson | undefined): Record<string, RuntimeJson> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, RuntimeJson>
    : {};
}

function array(value: RuntimeJson | undefined): Array<Record<string, RuntimeJson>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, RuntimeJson> => (
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
      ))
    : [];
}

function json(value: unknown): RuntimeJson {
  return JSON.parse(JSON.stringify(value)) as RuntimeJson;
}
