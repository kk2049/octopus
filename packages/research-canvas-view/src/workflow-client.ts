import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkflowPage } from "@claude-bot/research-canvas-contract";
import { persist, requestId, stored, type Call } from "./client.js";

export function useWorkflowActions(call: Call, storageKey: string) {
  const [pending, setPending] = useState(""), [error, setError] = useState("");
  const inflight = useRef(false), generation = useRef(0), failure = useRef("");
  const requests = useRef<Record<string, string>>(stored(storageKey + ":requests", {}));
  useEffect(() => { generation.current++; requests.current = stored(storageKey + ":requests", {}); return () => { generation.current++; }; }, [call, storageKey]);
  const run = useCallback(async <T,>(action: string, params: Record<string, unknown>): Promise<T | undefined> => {
    if (inflight.current) return undefined;
    inflight.current = true; failure.current = ""; setPending(action); setError("");
    const ticket = generation.current;
    const key = JSON.stringify([action, params]);
    const request = typeof params.request === "string" ? params.request : requests.current[key] ?? requestId();
    requests.current[key] = request;
    for (const oldest of Object.keys(requests.current).slice(0, -64)) delete requests.current[oldest];
    persist(storageKey + ":requests", requests.current);
    try {
      const result = await call<T>(action, { ...params, request });
      if (ticket !== generation.current) return undefined;
      delete requests.current[key];
      persist(storageKey + ":requests", requests.current);
      return result;
    } catch (reason) {
      if (ticket === generation.current) { failure.current = String(reason); setError(failure.current); }
      return undefined;
    } finally {
      inflight.current = false;
      if (ticket === generation.current) setPending("");
    }
  }, [call, storageKey]);
  return { run, pending, error, setError, failure };
}
/** Wakes refresh the same read once; refusals are retried only by a user. */
export function useWorkflowPage(call: Call, epoch = 0, source?: string) {
  const [page, setPage] = useState<WorkflowPage | null>(null), [error, setError] = useState("");
  const generation = useRef(0), flight = useRef<symbol | null>(null), queued = useRef(false), refused = useRef(false);
  const refresh = useCallback(async (explicit = false): Promise<void> => {
    if (refused.current && !explicit) return;
    if (flight.current) { queued.current = true; return; }
    const ticket = generation.current, lease = Symbol();
    flight.current = lease;
    try {
      const next = await call<WorkflowPage>("workflow_read", source ? { source } : {});
      if (ticket !== generation.current) return;
      setPage(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      setError(""); refused.current = false;
    } catch (reason) {
      if (ticket === generation.current) { setError(String(reason)); refused.current = true; }
    } finally {
      if (flight.current === lease) {
        flight.current = null;
        if (ticket === generation.current && queued.current) {
          queued.current = false;
          if (!refused.current) void refresh();
        }
      }
    }
  }, [call, source]);
  useEffect(() => {
    generation.current++; flight.current = null; queued.current = false; refused.current = false; setPage(null); setError("");
    return () => { generation.current++; flight.current = null; };
  }, [refresh]);
  useEffect(() => { void refresh(); }, [refresh, epoch]);
  return { page, error, refresh };
}
