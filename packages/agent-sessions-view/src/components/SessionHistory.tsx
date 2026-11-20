import { useEffect, useRef, useState } from "react";
import { AvButton, ModalDialog } from "@claude-bot/agent-view-react/ui";
import type { SessionsPort, SessionsProjection } from "@claude-bot/agent-sessions-contract";
import { rosterOf, withCustomTitle } from "../lib/projection.js";
import { SessionFamilies, SessionFamilyRow } from "./SessionFamilies.js";
import { SessionRow } from "./SessionRow.js";

export function SessionHistory({ devices, deviceLabels, result, customTitles, selected, pinned, onBrowse, onSelect }: {
  devices: readonly string[];
  deviceLabels?: Readonly<Record<string, string>>;
  result: SessionsProjection["sessionHistory"];
  customTitles?: SessionsProjection["customTitles"];
  selected: string | null;
  pinned: readonly string[];
  onBrowse: NonNullable<SessionsPort["browseSessions"]>;
  onSelect(resource: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [device, setDevice] = useState("");
  const [source, setSource] = useState("all");
  const [expected, setExpected] = useState<{ device: string; source: string; cursor: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [previousCursors, setPreviousCursors] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [showChildren, setShowChildren] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const generation = useRef(0);
  const inflight = useRef(false);
  useEffect(() => () => { generation.current += 1; }, []);
  const page = expected && result?.device === expected.device && result.source === expected.source && result.cursor === expected.cursor
    ? result : undefined;
  const rows = rosterOf((page?.sessions ?? []).map((row) => withCustomTitle(row, customTitles)), {}, customTitles);
  const load = async (target: string, cursor = "", direction: "start" | "next" | "previous" = "start"): Promise<void> => {
    if (!target || inflight.current) return;
    inflight.current = true;
    const current = ++generation.current;
    const request = { device: target, source, cursor };
    setExpected(request);
    setError("");
    setBusy(true);
    try {
      const reply = await onBrowse(request);
      if (current !== generation.current) return;
      if (!reply.ok) {
        setError(reply.message || "会话列表读取被拒绝");
        setExpected(expected);
      } else {
        setPreviousCursors((old) => direction === "start" ? [] : direction === "next"
          ? [...old, expected?.cursor ?? ""].slice(-100) : old.slice(0, -1));
      }
    } catch {
      if (current === generation.current) { setError("会话列表读取失败，请重试"); setExpected(expected); }
    } finally {
      inflight.current = false;
      if (current === generation.current) setBusy(false);
    }
  };
  const select = (resource: string): void => { onSelect(resource); setOpen(false); };
  return (
    <span className="session-history-control">
      <AvButton tone="quiet" className="nav-action" aria-label="全部会话" title="浏览全部会话（含更早的会话与其它账号）" onClick={() => {
        setOpen(true);
        if (!expected) {
          const target = device || devices[0] || "";
          setDevice(target);
          void load(target);
        }
      }}>
        <svg className="nav-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8 5v3.2l2.2 1.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </AvButton>
      <ModalDialog open={open} title="浏览全部会话" onClose={() => setOpen(false)}>
        <div className="session-history-tools">
          <label>设备 <select aria-label="会话设备" value={device} disabled={busy} onChange={(event) => { setDevice(event.target.value); setExpected(null); }}>
            {!device ? <option value="">选择设备</option> : null}
            {[...new Set([...devices, ...(device ? [device] : [])])].map((name) => <option value={name} key={name}>{deviceLabels?.[name] || name}</option>)}
          </select></label>
          <label>来源 <select aria-label="会话来源" value={source} disabled={busy} onChange={(event) => { setSource(event.target.value); setExpected(null); }}>
            <option value="all">全部</option><option value="claude">Claude</option><option value="codex">Codex（全部账号）</option><option value="omp">OMP</option>
          </select></label>
          <AvButton disabled={busy || !device} onClick={() => void load(device)}>从头浏览</AvButton>
          <label><input type="checkbox" checked={showChildren} onChange={(event) => setShowChildren(event.target.checked)} /> 显示子 Agent</label>
        </div>
        <p className="small">浏览所选设备的全部会话，包括无头任务和其他 Codex 账号。子 Agent 默认收起。</p>
        {busy ? <p role="status">正在读取会话…</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className="session-history-list" aria-busy={busy}>
          {showChildren ? rows.map((row) => <SessionRow key={row.resourceId} session={row} selected={selected} pinned={pinned} depth={0} flat onSelect={select} />) : (
            <SessionFamilies sessions={rows} pinned={pinned} expanded={expanded} onToggle={(key, value) => setExpanded((old) => ({ ...old, [key]: !value }))}>
              {(roots) => roots.map((row) => <SessionFamilyRow key={row.resourceId} session={row} selected={selected} pinned={pinned} depth={0} flat onSelect={select} />)}
            </SessionFamilies>
          )}
          {page && !rows.length ? <p>没有更多会话。</p> : null}
        </div>
        {page ? <div className="session-history-tools">
          <span>本页 {rows.length} 条 · 设备已发现 {page.totalFound} 条日志</span>
          <AvButton disabled={busy || !previousCursors.length} onClick={() => void load(device, previousCursors.at(-1), "previous")}>上一页</AvButton>
          <AvButton disabled={busy || !page.hasMore || !page.nextCursor} onClick={() => void load(device, page.nextCursor, "next")}>下一页</AvButton>
        </div> : null}
      </ModalDialog>
    </span>
  );
}
