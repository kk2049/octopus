import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InstanceConfig } from "@claude-bot/agent-module-contract";
import type { ModuleProps, ModuleRegistryEntry } from "@claude-bot/agent-view-react/workspace";
import { selectPath, useAppData } from "@claude-bot/agent-data-view";
import { BookingGrid, type BookingDraft } from "./components/BookingGrid.js";
import { readSchedule } from "./lib/schedule.js";
import { SCHEDULE_BOOKING_MANIFEST } from "./manifests.js";

function text(config: InstanceConfig | null, key: string, fallback = ""): string {
  const value = config?.[key];
  return typeof value === "string" && value ? value : fallback;
}

function BookingGridModule({ panel }: ModuleProps) {
  const { snapshot, submit, dismissProposal } = useAppData();
  const source = text(panel.config, "source");
  const action = text(panel.config, "action");
  const schedule = useMemo(() => readSchedule(selectPath(snapshot.projection, source)), [snapshot.projection, source]);
  const [dayOverride, setDayOverride] = useState<string | null>(null);
  const day = dayOverride ?? schedule.days[0]?.date ?? "";
  const [draft, setDraft] = useState<BookingDraft | null>(null);
  const [purpose, setPurpose] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "error" | "info"; text: string } | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const busy = snapshot.proposals.some((row) => row.action === action && row.phase === "inflight");
  const refusal = [...snapshot.proposals].reverse().find((row) => row.action === action && row.phase === "refused");

  const onSlot = useCallback((resource: string, hour: number) => {
    setNotice(null);
    if (!day) return;
    setDraft((current) => current && current.date === day && current.resource === resource
      ? { date: day, resource, start: Math.min(current.start, hour), end: Math.max(current.end, hour + 1) }
      : { date: day, resource, start: hour, end: hour + 1 });
  }, [day]);

  const onSubmit = useCallback(() => {
    if (!draft || !purpose.trim() || busy || !action) return;
    if (refusal) dismissProposal(refusal.rid);
    setNotice(null);
    void submit(action, {
      date: draft.date, room: draft.resource, start: String(draft.start), end: String(draft.end), purpose: purpose.trim(),
    }).then((reply) => {
      if (!live.current) return;
      if (!reply.ok) return;
      setDraft(null);
      setPurpose("");
      setNotice({ tone: "ok", text: reply.message || "预约已确认。" });
    }, () => {
      if (live.current) setNotice({ tone: "error", text: "这次预约没有返回结果。" });
    });
  }, [action, busy, dismissProposal, draft, purpose, refusal, submit]);

  return <BookingGrid schedule={schedule} source={source} day={day} draft={draft} purpose={purpose} busy={busy}
    notice={refusal ? { tone: "error", text: refusal.message || "预约被拒绝。" } : notice}
    purposeLabel={text(panel.config, "purpose_label", "用途")}
    submitLabel={text(panel.config, "submit_label", "确认预约")}
    emptyText={text(panel.config, "empty_text")}
    onDay={(next) => { setDayOverride(next); setDraft(null); setNotice(null); }}
    onSlot={onSlot} onPurpose={setPurpose} onSubmit={onSubmit} />;
}

export const SCHEDULE_BOOKING_MODULE: ModuleRegistryEntry = Object.freeze({
  manifest: SCHEDULE_BOOKING_MANIFEST,
  component: BookingGridModule,
});
export const SCHEDULE_MODULES: readonly ModuleRegistryEntry[] = Object.freeze([SCHEDULE_BOOKING_MODULE]);
export const CONFIG_KEYS_READ = Object.freeze({
  booking: Object.freeze(["source", "action", "purpose_label", "submit_label", "empty_text"]),
});
