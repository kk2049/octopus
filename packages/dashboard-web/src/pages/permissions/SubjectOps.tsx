import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, errorText } from "../../lib/api.js";
import { Confirm } from "../../ui/Dialog.js";
import { UiButton, UiCheckbox } from "../../ui-kit/primitives.js";
import styles from "../PermissionsPage.module.css";

export interface OpEntry {
  operation: string;
  title: string;
  description: string;
  risk: string;
  granted: boolean;
  effective: boolean;
  autoAllow?: boolean;
  alwaysApprove?: boolean;
  directSelfAutoAllow?: boolean;
  explanation: string;
}

interface SubjectPermissions {
  requestedCount: number;
  grantedCount: number;
  effectiveCount: number;
  needsAuthorization?: boolean;
  entries: OpEntry[];
}

export interface Subject {
  id: string;
  type: string;
  title: string;
  description: string;
  editable?: boolean;
  enforced?: boolean;
  permissions: SubjectPermissions;
  grant?: { source?: string } | null;
  trustedService?: { principal: string; boundaries: string[] } | null;
}

const RISK_CLASS: Record<string, string> = {
  执行命令: "hot",
  修改: "hot",
  跨用户披露: "hot",
  对外发送: "hot",
  特权服务: "hot",
  读取私密内容: "warm",
  枚举与状态: "",
};

function OpRow({
  entry,
  editable,
  checked,
  onToggle,
  busy,
}: {
  entry: OpEntry;
  editable: boolean;
  checked: boolean;
  onToggle: (next: boolean) => void;
  busy: boolean;
}) {
  useDashboardLanguage();
  return (
    <tr>
      <td data-label={uiText("能做什么")} className={styles.op}>
        <b>{entry.title}</b>
        <span className={styles.d}>{entry.description}</span>
      </td>
      <td data-label={uiText("类别")}>
        <span className={`${styles.risk} ${styles[RISK_CLASS[entry.risk] ?? ""] ?? ""}`}>
          {entry.risk}
        </span>
      </td>
      <td data-label={uiText("申请")}><span className={styles.yes}>✓</span></td>
      <td data-label={uiText("已授权")}>
        {editable ? (
          <UiCheckbox
            aria-label={uiText("授权 {v0}", { v0: entry.title })}
            disabled={busy}
            checked={checked}
            onChange={(event) => onToggle(event.target.checked)}
          />
        ) : entry.granted ? (
          <span className={styles.yes}>✓</span>
        ) : (
          <span className={styles.no}>—</span>
        )}
      </td>
      <td data-label={uiText("此刻有效")}>
        {entry.effective ? <span className={styles.yes}>✓</span> : <span className={styles.no}>—</span>}
        {entry.directSelfAutoAllow ? (
          <span className={styles.risk}>{uiText("本人网页免批")}</span>
        ) : entry.alwaysApprove ? (
          <span className={`${styles.risk} ${styles.hot}`}>{uiText("每次批准")}</span>
        ) : entry.autoAllow ? (
          <span className={styles.risk}>{uiText("免批")}</span>
        ) : null}
      </td>
      <td data-label={uiText("为什么")} className={styles.why}>{entry.explanation}</td>
    </tr>
  );
}

export function SubjectOps({
  subject,
  editable,
  owner,
  onChanged,
  onMessage,
}: {
  subject: Subject;
  editable: boolean;
  owner: string;
  onChanged: () => Promise<void>;
  onMessage: (kind: "ok" | "err", text: string) => void;
}) {
  const language = useDashboardLanguage();
  const initial = useMemo(
    () => new Set(subject.permissions.entries.filter((entry) => entry.granted).map((entry) => entry.operation)),
    [subject],
  );
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const selected = draft ?? initial;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const generation = useRef(0);
  useEffect(() => { generation.current += 1; return () => { generation.current += 1; }; }, [owner, subject.id]);
  const groups = useMemo(() => {
    const result = new Map<string, OpEntry[]>();
    for (const entry of subject.permissions.entries) {
      const key = entry.risk || uiText("其他操作");
      result.set(key, [...(result.get(key) ?? []), entry]);
    }
    return [...result];
  }, [subject, language]);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [diff, setDiff] = useState<{ added: string[]; removed: string[] } | null>(null);

  const save = useMutation({
    mutationFn: (_generation: number) =>
      api<{ diff: { added: string[]; removed: string[]; unchanged?: boolean } }>(
        "/api/permissions/grant",
        {
          method: "POST",
          json: {
            username: owner,
            subject_type: subject.type,
            subject_id: subject.id,
            operations: subject.permissions.entries.filter((entry) => selected.has(entry.operation)).map((entry) => entry.operation),
          },
        },
      ),
    onSuccess: async (out, requestGeneration) => {
      if (requestGeneration !== generation.current) return;
      setDiff(out.diff?.unchanged ? { added: [], removed: [] } : out.diff);
      onMessage("ok", uiText("已保存。"));
      await onChanged();
      if (requestGeneration === generation.current) setDraft(null);
    },
    onError: (err, requestGeneration) => { if (requestGeneration === generation.current) onMessage("err", errorText(err)); },
  });

  const revoke = useMutation({
    mutationFn: (_generation: number) =>
      api("/api/permissions/revoke", {
        method: "POST",
        json: { username: owner, subject_type: subject.type, subject_id: subject.id },
      }),
    onSuccess: async (_out, requestGeneration) => {
      if (requestGeneration !== generation.current) return;
      setConfirmRevoke(false);
      onMessage("ok", uiText("已撤销。"));
      await onChanged();
      if (requestGeneration === generation.current) { setDraft(null); setDiff(null); }
    },
    onError: (err, requestGeneration) => {
      if (requestGeneration !== generation.current) return;
      setConfirmRevoke(false);
      onMessage("err", errorText(err));
    },
  });

  const pending = useMemo(() => {
    const added: string[] = [];
    const removed: string[] = [];
    for (const entry of subject.permissions.entries) {
      const now = selected.has(entry.operation);
      if (now && !entry.granted) added.push(entry.operation);
      if (!now && entry.granted) removed.push(entry.operation);
    }
    return { added, removed };
  }, [selected, subject]);

  const busy = save.isPending || revoke.isPending;
  const selectEntries = (entries: OpEntry[], checked: boolean) => {
    setDiff(null);
    setDraft((previous) => {
      const next = new Set(previous ?? initial);
      for (const entry of entries) { if (checked) next.add(entry.operation); else next.delete(entry.operation); }
      return next;
    });
  };
  const shown = diff ?? (pending.added.length || pending.removed.length ? pending : null);
  return (
    <>
      <div className={styles.counts}>
        <span>{uiText("申请 ")}<b>{subject.permissions.requestedCount}</b></span>
        <span>{uiText("已授权 ")}<b>{subject.permissions.grantedCount}</b></span>
        <span>{uiText("此刻有效 ")}<b>{subject.permissions.effectiveCount}</b></span>
        {subject.permissions.needsAuthorization ? (
          <span className={`${styles.risk} ${styles.warm}`}>{uiText("有待确认的新增权限")}</span>
        ) : null}
      </div>
      {editable ? <div className={styles.bulkActions}>
        <UiButton size="small" disabled={busy} onClick={() => selectEntries(subject.permissions.entries, true)}>{uiText("全选")}</UiButton>
        <UiButton size="small" disabled={busy} onClick={() => selectEntries(subject.permissions.entries, false)}>{uiText("全不选")}</UiButton>
        <span className={styles.why}>{uiText("已选 ")}{subject.permissions.entries.filter((entry) => selected.has(entry.operation)).length} / {subject.permissions.entries.length} {uiText(" 项 · 保存后生效")}</span>
      </div> : null}
      {groups.map(([group, entries]) => <details className={styles.opGroup} key={group}
        open={expanded[group] ?? subject.permissions.entries.length <= 6}
        onToggle={(event) => { const open = event.currentTarget.open; setExpanded((previous) => previous[group] === open ? previous : { ...previous, [group]: open }); }}>
        <summary>{group}<span>{entries.length} {uiText(" 项 · 已授权 ")}{entries.filter((entry) => entry.granted).length} {uiText(" · 当前有效 ")}{entries.filter((entry) => entry.effective).length}</span></summary>
        {editable ? <div className={styles.bulkActions}>
          <UiCheckbox aria-label={uiText("整组授权 {v0}", { v0: group })} disabled={busy}
            checked={entries.every((entry) => selected.has(entry.operation))}
            indeterminate={entries.some((entry) => selected.has(entry.operation)) && !entries.every((entry) => selected.has(entry.operation))}
            onChange={(event) => selectEntries(entries, event.target.checked)}>{uiText("整组选择")}</UiCheckbox>
        </div> : null}
        <table className={styles.ops}>
          <thead><tr><th style={{ width: "28%" }}>{uiText("能做什么")}</th><th>{uiText("类别")}</th><th>{uiText("申请")}</th><th>{uiText("已授权")}</th><th>{uiText("此刻有效")}</th><th style={{ width: "25%" }}>{uiText("为什么")}</th></tr></thead>
          <tbody>{entries.map((entry) => <OpRow key={entry.operation} entry={entry} editable={editable}
            busy={busy} checked={selected.has(entry.operation)} onToggle={(next) => selectEntries([entry], next)} />)}</tbody>
        </table>
      </details>)}
      {editable ? (
        <div className={styles.rowacts}>
          <UiButton loading={save.isPending} disabled={busy} onClick={() => save.mutate(generation.current)}>{uiText("保存授权")}</UiButton>
          <UiButton tone="danger" disabled={busy} onClick={() => setConfirmRevoke(true)}>{uiText("全部撤销")}</UiButton>
          {shown ? (
            <span className={styles.diff}>
              {diff && !diff.added.length && !diff.removed.length ? (
                uiText("没有变化")
              ) : (
                <>
                  {diff ? "" : uiText("将要变更： ")}
                  {shown.added.length ? <span className={styles.add}>+{shown.added.join(" +")}</span> : null}{" "}
                  {shown.removed.length ? <span className={styles.rm}>{shown.removed.join(" ")}</span> : null}
                </>
              )}
            </span>
          ) : null}
        </div>
      ) : null}
      <Confirm
        open={confirmRevoke}
        title={uiText("撤销全部权限")}
        destructive
        confirmLabel={uiText("撤销")}
        busy={revoke.isPending}
        body={uiText("撤销「{v0}」的全部权限？正在跟随的实时流会立刻断开，未决的批准卡会作废。", { v0: subject.id })}
        onConfirm={() => revoke.mutate(generation.current)}
        onCancel={() => setConfirmRevoke(false)}
      />
    </>
  );
}
