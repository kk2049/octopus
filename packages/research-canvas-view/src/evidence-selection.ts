import { useCallback, useEffect, useRef, useState } from "react";
import type { EvidenceSelection, ResearchNode } from "@claude-bot/research-canvas-contract";
import type { Call } from "./client.js";

/** One authorized read at a time per report; project wakes coalesce behind it. */
export function useEvidenceSelection(node: ResearchNode, call: Call, epoch = 0) {
  const [selection, setSelection] = useState<EvidenceSelection | null>(null), [error, setError] = useState(""), [pending, setPending] = useState(false);
  const generation = useRef(0), loading = useRef<number | null>(null), queued = useRef(false), refused = useRef(false);
  useEffect(() => {
    generation.current++; loading.current = null; queued.current = false; refused.current = false;
    setSelection(null); setError(""); setPending(false);
    return () => { generation.current++; queued.current = false; };
  }, [node.id, call]);
  const refresh = useCallback(async () => {
    if (loading.current === generation.current) { queued.current = true; return; }
    const ticket = generation.current; loading.current = ticket; refused.current = false;
    setPending(true); setError(""); let succeeded = false;
    try {
      const next = await call<EvidenceSelection>("evidence_read", { node: node.id });
      if (ticket !== generation.current) return;
      succeeded = true; setSelection(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    } catch (reason) { if (ticket === generation.current) { refused.current = true; setError(String(reason)); } }
    finally {
      if (ticket === generation.current) {
        loading.current = null; setPending(false);
        const again = queued.current && succeeded; queued.current = false;
        if (again) void refresh();
      }
    }
  }, [node.id, call]);
  useEffect(() => { if (!refused.current) void refresh(); }, [refresh, node.version, node.resourceVersion, epoch]);
  const accept = (next: EvidenceSelection) => {
    // A mutation receipt supersedes any read that began before the receipt.
    const refreshAfterReceipt = loading.current !== null || queued.current;
    generation.current++; loading.current = null; queued.current = false; refused.current = false;
    setSelection(next); setPending(false); setError("");
    if (refreshAfterReceipt) void refresh();
  };
  return { selection, error, pending, refresh, accept };
}
