import { useEffect, useRef, useState } from "react";
import type { ProposalReply } from "@claude-bot/agent-view-react";
import type { ResearchEdge } from "@claude-bot/research-canvas-contract";
import { encodeParams, persist, requestId, stored } from "./client.js";

type ArchiveParams = { request: string; edge?: string; node?: string; version: number; snapshot?: string };
export interface EdgeArchiveState {
  params: ArchiveParams;
  phase: "pending" | "unknown" | "refused" | "confirmed";
  message: string;
}
type Propose = (action: string, params: Record<string, string>) => Promise<ProposalReply>;
const bounded = (message: string) => message.slice(0, 500);
function restore(value: unknown, kind: "edge" | "node"): EdgeArchiveState | undefined {
  if (!value || typeof value !== "object") return;
  const state = value as EdgeArchiveState, params = state.params;
  if (!params || typeof params.request !== "string" || !params.request || typeof params[kind] !== "string" || !params[kind]
    || !Number.isInteger(params.version) || params.version < 1 || params.snapshot !== undefined && typeof params.snapshot !== "string"
    || !["pending", "unknown", "confirmed"].includes(state.phase)) return;
  return { params, phase: state.phase === "confirmed" ? "confirmed" : "unknown", message: state.phase === "confirmed" ? `${kind === "node" ? "节点" : "关系"}已删除，等待图谱刷新。` : "上次删除结果未确认，请先核对原操作。" };
}
/** One durable operation per viewer/project. A transport failure keeps the exact
 * request; an acknowledged write stays confirmed even if the following read fails. */
export function useEdgeArchive(propose: Propose, storageKey: string, kind: "edge" | "node" = "edge") {
  const [state, setState] = useState(() => restore(stored(storageKey, null), kind));
  const current = useRef(state), generation = useRef(0);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [propose, storageKey]);
  const save = (next: EdgeArchiveState | undefined) => {
    if (next && kind === "node") next = { ...next, message: next.message.replaceAll("关系", "节点") };
    current.current = next;
    persist(storageKey, next?.phase === "refused" ? null : next ?? null);
    setState(next);
  };
  const dispatch = async (params: ArchiveParams) => {
    const owner = generation.current;
    save({ params, phase: "pending", message: "正在删除关系…" });
    let next: EdgeArchiveState;
    try {
      const reply = await propose(`${kind}_archive`, encodeParams(params));
      const result = reply.result as { edge?: ResearchEdge; node?: ResearchEdge; status?: string; error?: { message?: string } } | undefined;
      if (!reply.ok) {
        // Resource dispatch can report action_rejected / instance_stale after
        // the write ran. Only explicit admission refusals release this request.
        const unknown = !["denied", "forbidden", "busy", "invalid_params", "unknown_action", "not_supported", "request_refused"].includes(reply.code ?? "");
        next = { params, phase: unknown ? "unknown" : "refused", message: bounded(reply.message || (unknown ? "删除结果未确认，请核对原操作。" : "删除被拒绝")) };
      } else if (result?.status === "rejected") {
        next = { params, phase: "refused", message: bounded(result.error?.message || "删除被拒绝") };
      } else if (result?.[kind]?.id === params[kind] && result?.[kind]?.archived === true) {
        next = { params, phase: "confirmed", message: "关系已删除，等待图谱刷新。" };
      } else if (result?.[kind]?.id === params[kind] && result?.[kind]?.archived === false) {
        next = { params, phase: "refused", message: "关系有并发修改，未删除；请刷新后检查。" };
      } else {
        next = { params, phase: "unknown", message: "未收到删除确认，请核对原操作。" };
      }
    } catch {
      next = { params, phase: "unknown", message: "连接中断，删除结果未确认；请核对原操作。" };
    }
    if (owner !== generation.current || current.current?.params.request !== params.request) return false;
    save(next);
    return next.phase === "confirmed";
  };
  return {
    state,
    start(edge: Pick<ResearchEdge, "id" | "version" | "archived">, snapshot?: string) {
      if (current.current && current.current.phase !== "refused" || edge.archived || !Number.isInteger(edge.version) || edge.version < 1) return Promise.resolve(false);
      return dispatch({ request: requestId(), [kind]: edge.id, version: edge.version, ...(snapshot ? { snapshot } : {}) });
    },
    retry() {
      return current.current?.phase === "unknown" ? dispatch(current.current.params) : Promise.resolve(false);
    },
    clearRefusal() {
      if (current.current?.phase === "refused") save(undefined);
    },
    // Capture before starting the read: a stale pre-write frame cannot retire
    // a later receipt. Active-only full reads intentionally omit tombstones.
    reconcileRead() {
      const operation = current.current, owner = generation.current;
      return (records: ReadonlyArray<{ id: string; archived?: boolean }>) => {
        if (!operation || operation.phase === "pending" || owner !== generation.current
          || current.current?.params.request !== operation.params.request) return;
        if (!records.some(record => record.id === operation.params[kind] && !record.archived)) save(undefined);
      };
    },
    observedArchived(edge: string) {
      if (current.current?.params[kind] === edge && current.current.phase !== "pending") save(undefined);
    },
  };
}
