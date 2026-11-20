import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../lib/api.js";
import { appInstanceHandle } from "../lib/bootstrap.js";
import { uiText, uiMessage, uiValue, type UiTextValue } from "../i18n/ui-text.js";
import { useDashboardLanguage } from "../i18n/react.js";

interface Share { shareId: string; title: string; expiresAt: number; revoked: boolean; tokenLimit: number; tokensUsed: number; canPrompt: boolean; metering?: boolean; issued?: boolean }
interface Renewal { id: number; shareId: string; kind: "budget" | "lease"; status: string; createdAt: number }
interface ShareList { shares: Share[]; requests: Renewal[] }
const presets = () => [["0.5", uiText("75 万 tokens（0.5% 粗估档）")], ["1", uiText("150 万 tokens（1% 粗估档）")], ["5", uiText("750 万 tokens（5% 粗估档）")]];

export function SharedAccessNotice({ shareId, projection }: { shareId: string; projection: unknown }) {
  useDashboardLanguage();
  const candidate = (projection as { sharedAccess?: Share } | null)?.sharedAccess;
  const value = candidate && Number.isFinite(candidate.tokensUsed) ? candidate : null;
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<UiTextValue>("");
  const requestMore = async () => {
    if (pending) return; setPending(true);
    try { await api("/api/session-shares/request", { method: "POST", json: { shareId, kind: "budget" } }); setMessage(uiMessage("已向签发者申请更多 token")); }
    catch (error) { setMessage(errorText(error)); }
    finally { setPending(false); }
  };
  return <details><summary>{uiText("共享额度与租期")}</summary><p>{value ? `${value.tokensUsed.toLocaleString()} / ${value.tokenLimit.toLocaleString()} tokens · ${new Date(value.expiresAt).toLocaleString()} ${uiText("到期")}` : uiText("共享访问已结束")}</p><button disabled={pending} onClick={() => void requestMore()}>{uiText("申请更多 token")}</button> <a href={`/share?id=${shareId}&renew=1`}>{uiText("申请更多时间")}</a>{message ? <p role="status">{uiValue(message)}</p> : null}</details>;
}

function BudgetChoice({ value, onChange }: { value: string; onChange(v: string): void }) {
  useDashboardLanguage();
  return <label>{uiText("Token 预算")} <select value={value} onChange={(e) => onChange(e.target.value)}>{presets().map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>;
}
function LeaseChoice({ value, onChange }: { value: number; onChange(v: number): void }) {
  useDashboardLanguage();
  return <label>{uiText("访问租期")} <select value={value} onChange={(e) => onChange(Number(e.target.value))}>{[1, 5, 24].map((n) => <option key={n} value={n}>{n === 24 ? uiText("1 天") : uiText("{hours} 小时", { hours: n })}</option>)}</select></label>;
}

/** Issuance is tied to the existing instance and selected chat, never a caller-named owner. */
export function SessionShareButton({ resource }: { resource: string | null }) {
  useDashboardLanguage();
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<Array<{ key: string; label: string; device: string; directoryKey?: string }>>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [preset, setPreset] = useState("1");
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<UiTextValue>("");
  const [link, setLink] = useState("");
  const [title, setTitle] = useState<UiTextValue>("");
  const generation = useRef(0);
  useEffect(() => { generation.current++; setOpen(false); setBusy(false); setLink(""); setTitle(""); setChoices([]); setSelected([]); return () => { generation.current++; }; }, [resource]);
  const headers = () => ({ "x-session-plus-instance": appInstanceHandle() ?? "" });
  const prepare = async () => {
    if (busy || !resource) return;
    setOpen(true); setBusy(true); setMessage(""); const mine = ++generation.current;
    try {
      const answer = await api<{ workspaces: typeof choices; sessions?: Array<{ resourceId: string; directoryKey?: string; title?: string; firstUserText?: string }> }>("/api/session-shares/options", { headers: headers() });
      if (mine === generation.current) {
        setChoices(answer.workspaces);
        const session = answer.sessions?.find((s) => s.resourceId === resource);
        setTitle(session?.title || session?.firstUserText || uiMessage("已选择的 Codex 会话"));
        const directory = session?.directoryKey;
        if (directory) setSelected(answer.workspaces.filter((w) => w.directoryKey === directory).map((w) => w.key));
      }
    }
    catch (error) { if (mine === generation.current) setMessage(errorText(error)); }
    finally { if (mine === generation.current) setBusy(false); }
  };
  const issue = async () => {
    if (busy || !resource) return;
    setBusy(true); setMessage(""); const mine = ++generation.current;
    try { const result = await api<{ link: string }>("/api/session-shares/create", { method: "POST", headers: headers(), json: { resource, workspaces: selected, preset, hours } }); if (mine === generation.current) setLink(new URL(result.link, window.location.origin).href); }
    catch (error) { if (mine === generation.current) setMessage(errorText(error)); }
    finally { if (mine === generation.current) setBusy(false); }
  };
  return <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} style={{ position: "relative" }}>
    <summary onClick={(e) => { e.preventDefault(); if (open) setOpen(false); else void prepare(); }} aria-disabled={!resource}>{uiText("分享此会话")}</summary>
    <div style={{ position: "absolute", right: 0, zIndex: 20, width: "min(380px, 90vw)", padding: 16, background: "var(--bg, white)", border: "1px solid var(--border, #999)" }}>
      {title ? <strong>{uiValue(title)}</strong> : null}
      <p>{uiText("可查看历史、继续对话和操作勾选的工作区。不能新建 Agent。")}</p>
      <BudgetChoice value={preset} onChange={setPreset} /><br /><LeaseChoice value={hours} onChange={setHours} />
      <fieldset><legend>{uiText("同时授权的工作区")}</legend>{choices.length ? choices.map((w) => <label key={w.key} style={{ display: "block" }}><input type="checkbox" checked={selected.includes(w.key)} onChange={(e) => setSelected((old) => e.target.checked ? [...old, w.key] : old.filter((k) => k !== w.key))} />{w.device} · {w.label}</label>) : <p>{uiText("未加载工作区；可在文件索引刷新工作区后重新打开分享。")}</p>}</fieldset>
      <p className="muted">{uiText("按原生输入与输出 token 计数，缓存输入只计一次。百分比档位是历史样本粗估，不是 Codex 官方 weekly 用量。")}</p>
      <button disabled={busy || !resource || Boolean(link)} onClick={() => void issue()}>{busy ? uiText("处理中…") : uiText("生成分享链接")}</button>
      {link ? <label>{uiText("分享链接")}<input aria-label={uiText("分享链接")} readOnly value={link} onFocus={(e) => e.target.select()} /><button onClick={() => { void navigator.clipboard.writeText(link).then(() => setMessage(uiMessage("已复制")), () => setMessage(uiMessage("请选中链接复制"))); }}>{uiText("复制链接")}</button></label> : null}
      {message ? <p role="status">{uiValue(message)}</p> : null}
    </div>
  </details>;
}

/** Read-only list plus explicit renewal decisions in the existing permissions card. */
export function SessionSharingPermissions() {
  useDashboardLanguage();
  const [data, setData] = useState<ShareList>({ shares: [], requests: [] });
  const [message, setMessage] = useState<UiTextValue>("");
  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState("1");
  const [hours, setHours] = useState(24);
  const generation = useRef(0);
  const refresh = async () => { const mine = ++generation.current; try { const next = await api<ShareList>("/api/session-shares/list"); if (mine === generation.current) setData(next); } catch (error) { if (mine === generation.current) setMessage(errorText(error)); } };
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 15_000);
    return () => { generation.current++; window.clearInterval(timer); };
  }, []);
  const act = async (action: string, json: unknown) => { if (busy) return; setBusy(true); setMessage(""); try { await api(`/api/session-shares/${action}`, { method: "POST", json }); await refresh(); } catch (error) { setMessage(errorText(error)); } finally { setBusy(false); } };
  return <section className="card"><h3>{uiText("共享会话授权")}</h3><button disabled={busy} onClick={() => void refresh()}>{uiText("刷新申请")}</button>
    <p>{uiText("额度用完只停止接收新 prompt；租期到期后需要续期才能访问。")}</p>
    <BudgetChoice value={preset} onChange={setPreset} /> <LeaseChoice value={hours} onChange={setHours} />
    {data.requests.filter((r) => r.status === "pending").map((r) => <div key={r.id}><p>{data.shares.find((s) => s.shareId === r.shareId)?.title} · {r.kind === "budget" ? uiText("申请更多 token") : uiText("申请更多时间")}</p><button disabled={busy} onClick={() => void act("decide", { requestId: r.id, approve: true, preset, hours })}>{uiText("批准所选额度")}</button><button disabled={busy} onClick={() => void act("decide", { requestId: r.id, approve: false })}>{uiText("拒绝")}</button></div>)}
    {data.shares.filter((s) => s.issued).map((s) => <div key={s.shareId}><a href={`/sessions-plus?share=${s.shareId}`}>{s.title}</a> · {s.tokensUsed.toLocaleString()} / {s.tokenLimit.toLocaleString()} tokens · {new Date(s.expiresAt).toLocaleString()} {uiText("到期")} <button disabled={busy || s.revoked} onClick={() => void act("revoke", { shareId: s.shareId })}>{s.revoked ? uiText("已撤销") : uiText("撤销共享")}</button>{s.metering ? <button disabled={busy} onClick={() => void act("reset", { shareId: s.shareId })}>{uiText("重置用量结算")}</button> : null}</div>)}
    {message ? <p role="status">{uiValue(message)}</p> : null}
  </section>;
}

export function SharePage() {
  useDashboardLanguage();
  const [id, setId] = useState(new URLSearchParams(window.location.search).get("id") ?? "");
  const [message, setMessage] = useState<UiTextValue>(uiMessage("正在打开共享…"));
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState<Share | null>(null);
  const opening = useRef<Promise<{ target: string; found: Share; renew: boolean }> | null>(null);
  useEffect(() => {
    let alive = true;
    const open = async (): Promise<{ target: string; found: Share; renew: boolean }> => {
      const secret = window.location.hash.slice(1);
      const renew = new URLSearchParams(window.location.search).has("renew");
      // Remove the bearer fragment from history before any resource is opened.
      window.history.replaceState(null, "", `/share${id ? `?id=${id}${new URLSearchParams(window.location.search).has("renew") ? "&renew=1" : ""}` : ""}`);
        let target = id;
        if (secret) { const result = await api<{ shareId: string; expired: boolean }>("/api/session-shares/redeem", { method: "POST", json: { secret } }); target = result.shareId; window.history.replaceState(null, "", `/share?id=${target}${renew ? "&renew=1" : ""}`); }
        const data = await api<ShareList>("/api/session-shares/list");
        const found = data.shares.find((s) => s.shareId === target);
        if (!found || found.revoked) throw new Error(uiText("共享链接无效或已撤销"));
        return { target, found, renew };
    };
    opening.current ??= open();
    void opening.current.then(({ target, found, renew }) => {
      if (!alive) return;
      setId(target); setShare(found);
      if (found.expiresAt > Date.now() && !renew) window.location.replace(`/sessions-plus?share=${target}`);
      else setMessage(found.expiresAt <= Date.now() ? uiMessage("共享租期已到期。签发者批准更多时间后，可使用同一个链接继续访问。") : uiMessage("可向签发者申请延长当前共享租期。"));
    }).catch((error) => { if (alive) setMessage(errorText(error)); });
    return () => { alive = false; };
  }, []);
  const renew = async () => { if (busy) return; setBusy(true); try { await api("/api/session-shares/request", { method: "POST", json: { shareId: id, kind: "lease" } }); setMessage(uiMessage("续期申请已送到签发者的共享会话授权卡片。")); } catch (error) { setMessage(errorText(error)); } finally { setBusy(false); } };
  return <main style={{ maxWidth: 600, margin: "10vh auto", padding: 24 }}><h1>{uiText("共享会话")}</h1>{share ? <h2>{share.title}</h2> : null}<p role="status">{uiValue(message)}</p>{id && share ? <><button disabled={busy} onClick={() => void renew()}>{uiText("申请更多时间")}</button> <a href={`/sessions-plus?share=${id}`}>{uiText("重新进入会话")}</a></> : null}</main>;
}
