/** Transport-neutral contracts between the trusted coordinator and resources. */

import type { RuntimeJson } from "@claude-bot/app-runtime";

export interface ResourcePatchResult {
  ok: true;
  result: RuntimeJson;
  patch: Record<string, RuntimeJson>;
}

export interface ResourceRefusal {
  ok: false;
  code: "no_authority" | "approval_required" | "invalid_resource" | "resource_denied" | "resource_failed";
  message: string;
  pendingCallId?: string;
}

export type SessionResourceResult = ResourcePatchResult | ResourceRefusal;

/**
 * Trusted-only lifecycle hooks for one resource execution.
 *
 * The coordinator owns generation identity. Providers may publish an early,
 * bounded patch, but only while that execution is still the current one.
 */
export interface SessionResourceExecuteOptions {
  /** False after a newer request starts or the owning App instance closes. */
  isCurrent?: () => boolean;
  /** Publishes a bounded partial patch without exposing the callback to a View. */
  onPatch?: (patch: Record<string, RuntimeJson>) => void;
}

export type SessionResourceWatchEvent =
  | { type: "data"; resource: string; data: RuntimeJson }
  | { type: "status"; resource: string; state: "live" }
  | { type: "error"; resource: string; message: string; terminal: boolean };

export interface SessionResourceSubscription {
  close(): void;
}

export type SessionResourceWatchResult =
  | { ok: true; subscription: SessionResourceSubscription }
  | ResourceRefusal;

/** Trusted coordinator port. App Runtime and Agent View never receive it. */
export interface SessionResourcePort {
  execute(
    instanceId: string,
    action: string,
    params: Readonly<Record<string, string>>,
    current: RuntimeJson,
    options?: SessionResourceExecuteOptions,
  ): Promise<SessionResourceResult>;
  /** Re-key only the latest roster after a workspace read; never restore its pre-await copy. */
  reconcileWorkspacePatch?(instanceId: string, current: RuntimeJson, patch: Record<string, RuntimeJson>): Record<string, RuntimeJson>;
  watchTranscript?(
    instanceId: string,
    resource: string,
    listener: (event: SessionResourceWatchEvent) => void,
    maxMessages?: number,
  ): SessionResourceWatchResult;
}

export function noResourceAuthority(): ResourceRefusal {
  return {
    ok: false,
    code: "no_authority",
    message: "当前实例没有可用于这个资源动作的有效权限",
  };
}
