import { AppAgentActivity } from "./AppAgentActivity.js";
import { SessionShareButton, SharedAccessNotice } from "./SessionSharing.js";
import { Discussions } from './session-plus/Discussions.js';
import { useDashboardLanguage } from "../i18n/react.js";
import { uiText, uiMessage, uiValue, type UiTextValue, localizedLabels } from "../i18n/ui-text.js";
import { UiButton, UiTooltip } from "../ui-kit/primitives.js";
/**
 * `/sessions-plus` — the trusted shell around the Agent View.
 *
 * ── What is on which side of the line ───────────────────────────────────────
 *
 * Everything this file renders is TRUSTED chrome: the navigation, the identity
 * chip, the logout button and the approval pill all come from the app shell, so
 * they live outside the frame and keep working whatever the view does. Inside
 * the frame there is one thing — a document from another origin — and this page
 * gives it nothing but a `MessagePort`.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 *
 * No session id, no CSRF secret, no instance handle, no owner, no username and
 * no scope reach the frame: not in its URL (which is the bare origin), not in
 * its document (which this process does not compose), and not in the boot
 * payload (which carries a projection and nothing else). The per-tab instance
 * handle never becomes React state or a prop — it is read once from its own
 * script block, which is then removed, and it leaves only in the
 * `x-session-plus-instance` header of same-origin instance calls.
 *
 * Failure is state, never an implicit navigation. A network interruption keeps
 * reconnecting the status stream. A 404 means the server-owned instance has
 * actually gone away (expiry, restart or release retirement); it leaves the
 * current iframe and any draft intact and offers an explicit document reload.
 * No action is replayed.
 */

import { useEffect, useRef, useState } from "react";
import { api, errorText, request } from "../lib/api.js";
import { bootstrap, appInstanceHandle } from "../lib/bootstrap.js";
import { createAppHost as createSessionPlusHost, type HostSnapshot, type Proposal } from "../session-plus/app-host.js";
import {
  createSessionPlusPerformanceMonitor,
  type SessionPlusPerformanceMonitor,
} from "../session-plus/performance.js";
import { createSessionPlusRecoveryStore } from "../session-plus/recovery-store.js";
import { createPageFlight, publishFlightHook, type PageFlight } from "../lib/flight.js";
import { createProjectionStream, type ProjectionStream } from "../lib/projection-stream.js";
import { browserDraftStore } from "../lib/browser-drafts.js";
import { useFramePicker } from "../session-plus/use-frame-picker.js";
import { getAppearance, subscribeTheme } from "../styles/themes.js";
import { Status } from "../ui/misc.js";
import { recordAgenticOperation, recordAgenticProposal } from "../app/agentic-activity.js";
import { ShellPageActions } from "../app/Shell.js";
import type {
  SessionPlusAppProps,
  SessionPlusPageProps,
} from "../contract.js";
import { ConsentGate } from "./session-plus/ConsentGate.js";
import {
  OperationHistory,
  recordSessionPlusOperation,
  type SessionPlusOperationRow,
} from "./session-plus/OperationHistory.js";
import styles from "./SessionPlusPage.module.css";

const WORDS = localizedLabels((): Record<string, string> => ({
  idle: uiText("已停止"),
  loading: uiText("加载中…"),
  ready: uiText("已就绪"),
  unavailable: uiText("不可用"),
  degraded: uiText("已崩溃，可点 ♻ 重建"),
}));

function CLOSED_WORDS(): Record<string, UiTextValue> {
  return {
  publisher_trust_revoked: uiMessage("发布者信任已撤销"),
  capability_grant_revoked: uiMessage("App 能力已撤销"),
  credential_ended: uiMessage("浏览器会话已结束"),
  instance_expired: uiMessage("应用实例已过期"),
};
}

export function SessionPlusPage({ embeddedProps, workspaceKey }: { embeddedProps?: SessionPlusPageProps; workspaceKey?: string } = {}) {
  useDashboardLanguage();
  const props = embeddedProps ?? bootstrap.pageProps as SessionPlusPageProps;
  return props.mode === "consent" ? <ConsentGate {...props} /> : <TrustedShell {...props} workspaceKey={workspaceKey} />;
}

function TrustedShell(props: SessionPlusAppProps & { workspaceKey?: string }) {
  useDashboardLanguage();
  const id = props.identity;
  // Which account's Sessions+ every trusted request addresses: a share, an
  // administrator acting as another account, or (empty) the viewer's own.
  const scopeQuery = props.shareId
    ? `?share=${encodeURIComponent(props.shareId)}`
    : props.actingAs ? `?as=${encodeURIComponent(props.actingAs)}` : "";
  const [selectedResource, setSelectedResource] = useState<string | null>(null);
  const [sharedProjection, setSharedProjection] = useState<unknown>(props.projection);
  // Exact release scoping is intentional: a later bundle does not inherit
  // text captured by code with a different digest. The viewer namespace is
  // added inside browserDraftStore and never crosses into the opaque frame.
  const browserDrafts = browserDraftStore(`agent-view:${id.stableAppId}:${id.packageDigest}${props.workspaceKey ? `:${props.workspaceKey}` : ""}`);
  const slotRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<ReturnType<typeof createSessionPlusHost> | null>(null);
  const performanceMonitorRef = useRef<SessionPlusPerformanceMonitor | null>(null);
  // One semantic timeline per document (design §3): the trusted side's own
  // account of proposals, frames and wire state. Created before any effect so
  // both the host and the stream record into the same window.
  const flightRef = useRef<PageFlight | null>(null);
  if (!flightRef.current) {
    flightRef.current = createPageFlight("sessions+");
    publishFlightHook(flightRef.current);
  }
  const flight = flightRef.current;
  // One projection decoder per document: the stream rebuilds patched frames on
  // it, and act replies are patched against the frame it holds.
  const projectionsRef = useRef<ProjectionStream | null>(null);
  projectionsRef.current ??= createProjectionStream();
  const projections = projectionsRef.current;
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [backend, setBackend] = useState<{ ok: boolean; word: UiTextValue; reloadRequired?: boolean }>({
    ok: true,
    word: uiMessage("应用后端已连接"),
  });
  const [consentMessage, setConsentMessage] = useState<UiTextValue>("");
  const [operations, setOperations] = useState<SessionPlusOperationRow[]>([]);
  const onDebugEvent = useFramePicker(hostRef);

  const effective = props.authorization.entries.filter((entry) => entry.effective).length;
  const total = props.authorization.entries.length;

  // One host per mount. The instance handle is read from the module that owns
  // it, never threaded through props, and the dispatcher below is the ONLY
  // place it is used besides the stream.
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const instance = appInstanceHandle();
    const recoveryStore = createSessionPlusRecoveryStore({
      storage: () => window.localStorage,
      legacyStorage: () => window.sessionStorage,
      account: bootstrap.viewer.username,
      app: props.shareId ? `${id.stableAppId}:share:${props.shareId}`
        : props.actingAs ? `${id.stableAppId}:as:${props.actingAs}` : id.stableAppId,
    });
    let resourceGeneration = props.resourceGeneration;
    let performanceReportInFlight = false;
    const performanceMonitor = createSessionPlusPerformanceMonitor({
      report: (report) => {
        // Content-free and bounded at the monitor boundary. The local flight
        // record makes the exact browser observation exportable with feedback;
        // the server copy makes aggregate diagnosis possible without devtools.
        flight.recorder.record({
          source: "ui",
          kind: "ui.performance",
          key: "sessions+",
          delta: { ...report },
        });
        // Performance reporting is lossy by design: never queue behind a slow
        // backend and never retry, because diagnostics must not add pressure to
        // the weak-network path they are measuring.
        if (!instance || performanceReportInFlight) return;
        performanceReportInFlight = true;
        void request(`/api/session-plus/performance${scopeQuery}`, {
          method: "POST",
          json: report,
          headers: { "x-session-plus-instance": instance },
        }).catch(() => {}).finally(() => {
          performanceReportInFlight = false;
        });
      },
    });
    performanceMonitorRef.current = performanceMonitor;
    performanceMonitor.start();
    performanceMonitor.observeProjection(props.projection);
    const host = createSessionPlusHost({
      doc: document,
      win: window,
      slot,
      appId: id.stableAppId,
      packageDigest: id.packageDigest,
      appOrigin: id.viewOrigin,
      appUrl: id.viewUrl,
      projection: props.projection,
      // The outer shell's current theme, wrapped in the wire contract id so
      // the View has classic/aurora/ink in hand for its first paint (ticket
      // #45). Live changes are pushed by the subscription below.
      appearance: getAppearance(),
      drafts: browserDrafts,
      recovery: recoveryStore.read() ?? undefined,
      onRecovery: recoveryStore.write,
      onChange: (next) => {
        setSnapshot(next);
        recordAgenticProposal({ id: id.stableAppId, title: uiText("会话+") }, next);
      },
      dispatch: async (proposal: Proposal) => {
        if (proposal.action === "open_session" && typeof proposal.params?.resource === "string") setSelectedResource(proposal.params.resource);
        const rid = flight.propose(proposal.action);
        try {
          const held = projections.act();
          const res = await request(`/api/session-plus/act${scopeQuery}`, {
            method: "POST",
            json: { action: proposal.action, params: proposal.params },
            headers: instance ? {
              ...held.headers,
              "x-session-plus-instance": instance,
              "x-session-plus-resource-generation": String(resourceGeneration),
            } : {},
          });
          const text = await res.text();
          let value: Record<string, unknown>;
          try {
            value = text ? held.rebuild(JSON.parse(text) as Record<string, unknown>) : {};
          } catch {
            value = { error: uiText("服务返回了无法解析的结果") };
          }
          if (!res.ok && res.status >= 500) throw new Error(String(value.error || uiText("请求失败")));
          setBackend(res.status === 404
            ? { ok: false, word: uiMessage("实例已失效，需要重新载入"), reloadRequired: true }
            : { ok: true, word: uiMessage("应用后端已连接") });
          if (!res.ok) {
            flight.settle(rid, false, String(value.code || "request_refused"));
            return {
              ok: false,
              code: String(value.code || "request_refused"),
              message: String(value.error || uiText("请求被拒绝")),
            };
          }
          flight.settle(rid, true);
          if (proposal.action === "open_shared_session" && value.ok !== false && typeof (value.result as { shareId?: unknown } | undefined)?.shareId === "string") {
            window.location.assign(`/sessions-plus?share=${encodeURIComponent((value.result as { shareId: string }).shareId)}`);
          }
          if (Object.prototype.hasOwnProperty.call(value, "projection")) {
            performanceMonitor.observeProjection(value.projection);
            setSharedProjection(value.projection);
            flight.frame(value.projection, typeof value.revision === "number" ? value.revision : undefined, rid);
          }
          return value as { ok?: boolean };
        } catch (err) {
          setBackend({ ok: false, word: uiMessage("应用后端不可用") });
          flight.settle(rid, false, "backend_unavailable");
          return {
            ok: false,
            code: "backend_unavailable",
            message: errorText(err) || uiText("应用后端暂时不可用"),
          };
        }
      },
      onDebugEvent,
      onPerformance: (report) => {
        performanceMonitor.observeView(report);
      },
      resetResources: async () => {
        if (!instance) return false;
        try {
          const res = await request(`/api/session-plus/reconstruct${scopeQuery}`, {
            method: "POST",
            headers: {
              "x-session-plus-instance": instance,
              "x-session-plus-resource-generation": String(resourceGeneration),
            },
          });
          const value = await res.json() as { ok?: unknown; generation?: unknown };
          if (value.ok !== true || !Number.isSafeInteger(value.generation)) return false;
          resourceGeneration = value.generation as number;
          return true;
        } catch {
          return false;
        }
      },
    });
    hostRef.current = host;
    host.mount();
    // Live theme changes (this tab's picker, or a `storage` event bridged
    // in from a sibling tab) forward to the iframe over the same
    // MessagePort. The subscription NEVER fires synchronously — the initial
    // theme was already sent on the boot payload above.
    const offTheme = subscribeTheme((appearance) => {
      hostRef.current?.updateAppearance(appearance);
    });
    return () => {
      offTheme();
      performanceMonitor.stop();
      if (performanceMonitorRef.current === performanceMonitor) performanceMonitorRef.current = null;
      hostRef.current = null;
      host.dispose(uiMessage("页面已离开"));
    };
    // The host owns a DOM node and a channel; it is created once for the life
    // of this screen. Re-running on prop identity would tear down a live view
    // and, with it, the frame the person is looking at.
  }, []);

  // The projection/operation stream. `fetch` + a reader rather than
  // `EventSource` because the instance handle must ride in a header, and
  // `EventSource` cannot set one.
  useEffect(() => {
    const instance = appInstanceHandle();
    let stopped = false;
    let controller: AbortController | null = null;
    let retryTimer: number | null = null;
    let attempt = 0;

    function consume(block: string): void {
      let event = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.slice(0, 6) === "event:") event = line.slice(6).trim();
        if (line.slice(0, 5) === "data:") data.push(line.slice(5).trim());
      }
      if (!data.length) return;
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(data.join("\n")) as Record<string, unknown>;
      } catch {
        return;
      }
      const frame = projections.read(event, value);
      if (frame === null) {
        // A patch that does not fit this tab's frame: reconnect for a full one.
        controller?.abort();
        throw new Error("projection stream resync");
      }
      if (frame) {
        const { projection, revision } = frame;
        flight.frame(projection, revision);
        performanceMonitorRef.current?.observeProjection(projection);
        const dispatchStartedAt = performance.now();
        hostRef.current?.update(projection, revision);
        setSharedProjection(projection);
        performanceMonitorRef.current?.observeProjectionDispatch(performance.now() - dispatchStartedAt);
      }
      if (event === "op" && Object.prototype.hasOwnProperty.call(value, "operation")) {
        const operation = (value.operation ?? {}) as Record<string, unknown>;
        setOperations((current) => recordSessionPlusOperation(current, operation));
        flight.operation(
          String(operation.operation ?? "operation"),
          String(operation.status ?? ""),
          typeof operation.id === "string" ? operation.id : undefined,
        );
        hostRef.current?.operation(value.operation);
        recordAgenticOperation({ id: id.stableAppId, title: uiText("会话+") }, value.operation);
      }
      // ADR 0006: content-free by construction — the server projected exactly
      // these two fields, and the host validates and rate-caps them again.
      if (event === "wake" && typeof value.binding === "string" && typeof value.ref === "string") {
        flight.wake();
        hostRef.current?.wake({ binding: value.binding, ref: value.ref });
      }
      if (event === "closed") {
        stopped = true;
        flight.channel("closed");
        setBackend({
          ok: false,
          word: CLOSED_WORDS()[String(value.reason ?? "")] ?? uiMessage("此实例已关闭"),
        });
      }
    }

    async function connect(): Promise<void> {
      if (stopped) return;
      controller = new AbortController();
      try {
        const res = await request(`/api/session-plus/stream${scopeQuery}`, {
          headers: { ...projections.headers(), ...(instance ? { "x-session-plus-instance": instance } : {}) },
          signal: controller.signal,
        });
        if (res.status === 404) {
          stopped = true;
          flight.channel("closed");
          setBackend({ ok: false, word: uiMessage("实例已失效，需要重新载入"), reloadRequired: true });
          return;
        }
        if (!res.ok || !res.body) throw new Error("stream unavailable");
        attempt = 0;
        flight.channel("connected");
        setBackend({ ok: true, word: uiMessage("应用后端已连接") });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const part = await reader.read();
          if (part.done) throw new Error("stream ended");
          buffer += decoder.decode(part.value, { stream: true });
          let split: number;
          while ((split = buffer.search(/\r?\n\r?\n/)) >= 0) {
            const block = buffer.slice(0, split);
            const match = /^\r?\n\r?\n/.exec(buffer.slice(split));
            buffer = buffer.slice(split + (match ? match[0].length : 2));
            consume(block);
          }
        }
      } catch (err) {
        if (stopped || (err as Error)?.name === "AbortError") return;
        flight.channel("reconnecting");
        setBackend({ ok: false, word: uiMessage("状态流重连中…") });
        const delay = Math.min(10_000, 500 * 2 ** attempt++);
        retryTimer = window.setTimeout(() => void connect(), delay);
      }
    }

    void connect();

    // A closed tab must release its instance; `keepalive` is what makes the
    // request survive the unload.
    const onHide = () => {
      stopped = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      controller?.abort();
      void request(`/api/session-plus/close${scopeQuery}`, {
        method: "POST",
        headers: instance ? { "x-session-plus-instance": instance } : {},
        keepalive: true,
      }).catch(() => {});
    };
    // A page placed in the browser's back/forward cache fires `pagehide` but
    // may later restore the same JS heap without requesting fresh HTML. The
    // hide above intentionally closes this tab's backend instance, so restoring
    // that document would otherwise revive a dead handle and, more importantly,
    // skip the target page's current server-side authorization decision.
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      stopped = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      controller?.abort();
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);

  // The assert monitor over this page's timeline (design §4): findings are
  // archived into the same window and surfaced via the flight hook and the
  // `data-flight-violations` body attribute; nothing is retried or repaired.
  useEffect(() => flight.startMonitor(), [flight]);

  const consentPost = (path: string, body: unknown) => {
    setConsentMessage(uiMessage("正在记录…"));
    void api(path, { method: "POST", json: body }).then(
      () => location.reload(),
      (err) => setConsentMessage(errorText(err) || uiMessage("操作失败")),
    );
  };

  // The trusted side's own account of what it did, written where anything on
  // this origin can read it. It is RENDERED rather than exported through a
  // test-only API, and the browser suite reads it because a MessagePort
  // boundary has no other external observer: "the view proposed X and we
  // refused it" is otherwise unobservable from outside the two documents.
  useEffect(() => {
    const body = document.body;
    body.setAttribute("data-sp-state", snapshot?.state ?? "loading");
    body.setAttribute("data-sp-generation", String(snapshot?.generation ?? 0));
    body.setAttribute("data-sp-ports", String(snapshot?.ports ?? 0));
    body.setAttribute("data-sp-ignored", String(snapshot?.ignored ?? 0));
    body.setAttribute("data-sp-accepted", String(snapshot?.accepted ?? 0));
    body.setAttribute("data-sp-refused", String(snapshot?.refused ?? 0));
    body.setAttribute("data-sp-answer", snapshot?.lastAnswer ? JSON.stringify(snapshot.lastAnswer) : "");
  }, [snapshot]);

  const state = snapshot?.state ?? "loading";
  const healthy = state === "ready" && backend.ok;
  return (
    <>
      <ShellPageActions>
        {props.actingAs ? (
          <span className={styles.warn} role="status">{uiText("管理员视角：正在以 {v0} 的账户查看与操作", { v0: props.actingAs })}</span>
        ) : null}
        {!props.shareId && !props.actingAs && <Discussions />}
        {props.shareId ? <SharedAccessNotice shareId={props.shareId} projection={sharedProjection} />
          : props.actingAs ? null : <SessionShareButton resource={selectedResource} />}
        <details className={`${styles.menu} ${healthy ? "" : styles.menuWarning}`}>
          <summary
            aria-label={uiText("会话信息")}
            title={healthy ? uiText("会话信息") : `${WORDS()[state] ?? state}；${uiValue(backend.word)}`}
          >
            <span className={styles.infoIcon} aria-hidden="true">ⓘ</span>
            <span className={styles.infoLabel}>{uiText("会话信息")}</span>
          </summary>
          <div className={styles.drop}>
            <div className={styles.bar}>
              <h2>{uiText("🧪 会话+（Agentic App）")}</h2>
              <span className="grow" />
              <div className={styles.statuses} aria-label={uiText("连接状态")}>
                <span className={`${styles.state} ${styles[state] ?? ""}`} title={uiValue(snapshot?.notice ?? snapshot?.detail) || ""}>
                  {WORDS()[state] ?? state}</span>
                <span className={`${styles.state} ${backend.ok ? styles.ready : styles.unavailable}`}>
                  {uiValue(backend.word)}
                </span>
              </div>
            </div>
            <p className={styles.lead}>
              {uiText("运行发布者提供的应用代码；使用当前账户已授权的数据与能力。")}</p>
            <p className={styles.lead}>
              {uiText("每个资源与动作请求都由服务端重新授权；View 不是隔离边界。")}</p>
            <dl className={styles.facts}>
              <dt>{uiText("稳定 App ID")}</dt>
              <dd>{id.stableAppId}</dd>
              <dt>{uiText("发布者")}</dt>
              <dd>{id.publisher}</dd>
              <dt>{uiText("包摘要")}</dt>
              <dd>{id.packageDigest}</dd>
              <dt>{uiText("权限契约")}</dt>
              <dd>
                {id.permissionContractDigest}{" "}
                <span className={styles.counts}>（{total} {uiText(" 项权限；本地动作免批，跨边界动作需审批）")}</span>
              </dd>
              <dt>{uiText("View 来源")}</dt>
              <dd>{id.viewOrigin}</dd>
              <dt>frame-ancestors</dt>
              <dd>{id.frameAncestors.join(" ")}</dd>
            </dl>
            {id.development ? (
              <p className={styles.warn}>
                {uiText("本机开发模式：Agent View 走 http 回环主机名，主站 Cookie 因此没有")}{" "}
                <code>__Host-</code> {uiText(" 前缀。生产部署必须配置 https 的")}{" "}
                <code>dashboard.public_url</code>。
              </p>
            ) : null}

            <OperationHistory operations={operations} />

            {!props.shareId && <details className={styles.permissionDetails}>
              <summary>{uiText("授权 ")}{effective}/{total}</summary>
              <div className={styles.permissionBody}>
                <div className={styles.bar}>
                  <b>{uiText("两道门的当前状态")}</b>
                  <span className="grow" />
                  <a href="/api/session-plus/release" target="_blank" rel="noopener noreferrer">
                    {uiText("ReleaseRecord / 源码 ↗")}</a>
                  <a href="/permissions">{uiText("权限中心")}</a>
                </div>
                <p className={styles.lead}>
                  {uiText("发布者信任：")}<b>{uiText("已信任")}</b>（
                  {props.trustReason === "first_party" ? uiText("仓库内第一方，自动信任")
                    : props.trustReason === "exact_release" ? uiText("精确 release") : uiText("跟随同一发布者更新")}
                  {uiText("）。发布者信任与能力授权独立管理。")}</p>
                <table className={styles.perm}>
                  <thead>
                    <tr>
                      <th>{uiText("能力")}</th>
                      <th>{uiText("持久授权")}</th>
                      <th>{uiText("此刻")}</th>
                      <th>{uiText("说明")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {props.authorization.entries.map((entry) => (
                      <tr key={entry.operation}>
                        <td>
                          <b>{entry.title}</b>
                          <br />
                          <code>{entry.operation}</code>
                        </td>
                        <td>{entry.granted ? uiText("✓ 已授权") : uiText("— 未授权")}</td>
                        <td>
                          {entry.effective ? uiText("✓ 当前有效") : uiText("— 当前不可用")}
                          {entry.alwaysApprove ? uiText(" · 每次批准") : ""}
                        </td>
                        <td>{entry.explanation}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {props.authorization.contractChanged ? (
                  <p className={styles.warn}>
                    {uiText("permission contract 已变化；旧 grant 只保留交集，新增能力在重新同意前保持关闭。")}</p>
                ) : null}
                {props.authorization.publisherChanged ? (
                  <p className={styles.warn}>
                    {uiText("发布者已经变化；旧发布者的 capability grant 不会继承，请为当前发布者重新确认。")}</p>
                ) : null}
                <div className={`${styles.bar} ${styles.actionRow}`}>
                  {props.authorization.needsAuthorization && props.authorization.editable ? (
                    <>
                      <UiButton
                        onClick={() =>
                          consentPost("/api/permissions/grant", {
                            subject_type: "app",
                            subject_id: id.stableAppId,
                            operations: id.contractOperations,
                          })
                        }
                      >
                        {uiText("授权声明能力")}</UiButton>
                      <span className={styles.counts}>{uiText("可暂不授权，以空权限打开。")}</span>
                    </>
                  ) : props.authorization.source === "config" ? (
                    <span className={styles.counts}>{uiText("能力来源：部署配置（页面只读）")}</span>
                  ) : (
                    <span className={styles.counts}>{uiText("能力授权已覆盖当前声明。")}</span>
                  )}
                  {props.authorization.source && props.authorization.source !== "config" ? (
                    <UiButton
                      className="danger"
                      onClick={() =>
                        consentPost("/api/permissions/revoke", {
                          subject_type: "app",
                          subject_id: id.stableAppId,
                        })
                      }
                    >
                      {uiText("撤销 App 能力")}</UiButton>
                  ) : null}
                  {props.trustReason === "first_party" ? null : (
                    <UiButton
                      className="danger"
                      onClick={() => consentPost("/api/session-plus/trust", { decision: "revoke" })}
                    >
                      {uiText("撤销发布者信任")}</UiButton>
                  )}
                </div>
                {uiValue(consentMessage) ? <Status kind="err">{uiValue(consentMessage)}</Status> : null}
              </div>
            </details>}
          </div>
        </details>

        <UiTooltip title={uiText("重建 Agent View")}>
          <UiButton
            id="spReconstruct"
            data-testid="reconstruct-agent-view"
            className={styles.icon}
            aria-label={uiText("重建 Agent View")}
            onClick={() => void hostRef.current?.reconstruct()}
          >
            ♻
          </UiButton>
        </UiTooltip>
      </ShellPageActions>

      <AppAgentActivity appId="session-plus" enabled={!props.shareId && !props.actingAs} />
      {/* The explicit test anchor lets browser acceptance measure the trusted
          workspace without turning CSS module or compatibility classes into API. */}
      <main
        className={`${styles.workspace} spwrap spworkspace`}
        data-testid="session-plus-workspace"
        aria-label={uiText("Agent View 工作区")}
      >
        <div className={styles.slot} ref={slotRef}>
          {snapshot?.element}
          {backend.reloadRequired ? (
            <div className={styles.reloadNotice} role="alert">
              <span>{uiText("后台实例已结束；当前页面不会自动刷新。")}</span>
              <UiButton onClick={() => window.location.reload()}>{uiText("重新载入会话+")}</UiButton>
            </div>
          ) : null}
          {state === "ready" ? null : (
            <div className={styles.empty}>{uiValue(snapshot?.notice ?? snapshot?.detail) || WORDS()[state] || uiText("正在加载 Agent View…")}</div>
          )}
        </div>
      </main>
    </>
  );
}
