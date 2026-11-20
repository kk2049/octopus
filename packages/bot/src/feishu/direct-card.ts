/**
 * Direct Feishu card delivery — app-authored interactive cards sent straight
 * to a user's private chat (agent-completion notices) or a group, without any
 * chat channel object in this process.
 *
 * The private-chat and group-chat sends differ only in `receive_id_type` and
 * in the wording of their two error messages, so both go through one function.
 * Moved here from the retired v2 chat router (2026-10-15); behaviour unchanged.
 */

import type { FeishuChannelConfig } from "../config.js";
import type { Store } from "../store/store.js";

const FEISHU_API = "https://open.feishu.cn/open-apis";
/** A direct send never waits longer than this on Feishu: its callers report, and some act on, the outcome. */
const SEND_TIMEOUT_MS = 15_000;

/** Card payload for structured Feishu UI. */
export interface CardPayload {
  header?: {
    title: string | { tag: "plain_text"; content: string };
    template?: string;
  };
  elements: Array<Record<string, unknown>>;
}

/** First Feishu open_id bound to a user (direct sends). */
export function feishuOpenIdOf(store: Store, username: string): string | undefined {
  return store.getIdentitiesByUser(username).find((i) => i.provider === "feishu")?.external_id ?? undefined;
}

/** Tenant credential for app-authored sends. Throws with the platform message. */
export async function feishuAppAccessToken(feishu: FeishuChannelConfig): Promise<string> {
  const tokenResp = await fetch(`${FEISHU_API}/auth/v3/app_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: feishu.app_id, app_secret: feishu.app_secret }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const tokenData = await tokenResp.json() as Record<string, unknown>;
  if (tokenData.code !== 0 || typeof tokenData.app_access_token !== "string") {
    throw new Error(`获取飞书 app_access_token 失败: ${String(tokenData.msg ?? tokenData.code)}`);
  }
  return tokenData.app_access_token;
}

export interface DirectCardSend {
  feishu: FeishuChannelConfig | undefined;
  receiveIdType: "open_id" | "chat_id";
  receiveId: string;
  card: CardPayload;
  /** Thrown when the Feishu channel is off — wording is caller-specific. */
  disabledError: string;
  /** Prefix of the send failure, e.g. `发送飞书群卡片失败`. */
  sendErrorLabel: string;
  /**
   * Private sends only: translate the one platform error operators actually
   * hit (recipient outside the app's availability scope) into a fix.
   */
  availabilityHint?: boolean;
}

export async function sendFeishuCardDirect(params: DirectCardSend): Promise<void> {
  const { feishu } = params;
  if (!feishu?.enabled) {
    throw new Error(params.disabledError);
  }
  const token = await feishuAppAccessToken(feishu);

  const sendResp = await fetch(`${FEISHU_API}/im/v1/messages?receive_id_type=${params.receiveIdType}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: params.receiveId,
      msg_type: "interactive",
      content: JSON.stringify(params.card),
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const sendData = await sendResp.json() as Record<string, unknown>;
  if (sendData.code !== 0) {
    const msg = String(sendData.msg ?? sendData.code);
    const hint = params.availabilityHint && msg.includes("availability")
      ? "(对方不在应用可用范围内——去开发者后台把应用可用范围设为全员,或 PATCH /application/v6/applications/{app_id}/visibility)"
      : "";
    throw new Error(`${params.sendErrorLabel}: ${msg}${hint}`);
  }
}
