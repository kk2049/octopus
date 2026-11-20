/** Test-only scripted ingress for direct runtime consumers. No browser channel. */
import { MSG } from "@claude-bot/web-trust/frame-protocol";
import { createAppRuntimeClient, type AppRuntimeReply, type AgentViewOperation } from "./runtime.js";

export function directHarness() {
  let sequence = 0;
  const pending = new Map<string, (reply: AppRuntimeReply) => void>();
  const host: {
    onmessage: ((event: { data: Record<string, unknown> }) => void) | null;
    postMessage(message: Record<string, unknown>): void;
  } = {
    onmessage: null,
    postMessage(message) {
      if (message.t === MSG.boot || message.t === MSG.view) client.update(message.projection, message.revision as number | undefined);
      if (message.t === MSG.boot && message.appearance !== undefined || message.t === MSG.appearance) client.updateAppearance(message.appearance);
      if (message.t === MSG.op) client.operation(message.operation as AgentViewOperation);
      if (message.t === MSG.result) {
        const rid = String(message.rid ?? "");
        const resolve = pending.get(rid);
        pending.delete(rid);
        const result = message.result as { message?: string } | undefined;
        resolve?.({ ok: message.ok === true, code: message.code as string | undefined, result: message.result, message: result?.message ?? "" });
      }
    },
  };
  const client = createAppRuntimeClient({
    dispatch: (action, params) => new Promise((resolve) => {
      const rid = "test-" + ++sequence;
      pending.set(rid, resolve);
      host.onmessage?.({ data: { t: MSG.propose, rid, action, params } });
    }),
  });
  return { client, host };
}
export type DirectTestHost = ReturnType<typeof directHarness>["host"];
