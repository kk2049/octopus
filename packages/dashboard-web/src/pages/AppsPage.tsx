import { dateLocale } from "../lib/format.js";
import { useDashboardLanguage } from "../i18n/react.js";
import { uiText, uiMessage, uiValue, type UiTextValue } from "../i18n/ui-text.js";
/**
 * `/apps` — which release of which Agentic App this host serves.
 *
 * ── What this page is, and what it deliberately is not ──────────────────────
 *
 * It is a local operator's control over one host: which apps this build serves,
 * what is installed for each, what is active, what each release is made of, and
 * the four verbs — install, activate, roll back (activate an older one),
 * deactivate. It is NOT a store. There is no remote catalogue, no search, no
 * download, no rating and no publisher account, because none of those exist on
 * the server either; a page that implied they did would be describing a system
 * nobody built.
 *
 * ── Four rules this screen follows ──────────────────────────────────────────
 *
 *  1. **The server decides, always.** Nothing here computes whether a release
 *     may be activated. `supported` and every refusal sentence are written by
 *     the server, which is also the only thing that knows this build's permission
 *     contract. The page renders that verdict; it does not reach one.
 *  2. **Install and activate are two decisions.** Installing adds an immutable
 *     release and changes nothing about what is being served — the response says
 *     so, and the button that changes what runs is a second, separate click on a
 *     row the operator can see the digest of.
 *  3. **No path, no bytes.** The operator picks a bundle FILE in their browser;
 *     the file's contents are posted. A server path typed into a form would make
 *     the panel read whatever the typist named.
 *  4. **Every verb names its app.** The payload is one block per app, and each
 *     mutation carries the stable App id it is about. There is no "the current
 *     app" in this component's head that a stale render could disagree with the
 *     server about — an install is routed by the descriptor inside the bundle,
 *     and everything else names the row's own app.
 */

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "../lib/api.js";
import { ErrorBox, Loading, StaleDataBanner, Status } from "../ui/misc.js";
import { UiButton, UiCard, UiTag } from "../ui-kit/primitives.js";
import styles from "./AppsPage.module.css";

const APPS_PATH = "/api/apps";
/** Refuse to read an unbounded local file before allocating for it. */
const MAX_BUNDLE_BYTES = 12 * 1024 * 1024;

interface ReleaseAsset {
  name: string;
  sha256: string;
  bytes: number;
}

interface ReleaseRow {
  packageDigest: string;
  hostLabel: string;
  stableAppId: string;
  publisher: string;
  executionProfile: string;
  permissionContractDigest: string;
  assets: ReleaseAsset[];
  totalBytes: number;
  composition: { view: string[]; backend: string[] };
  source: { kind: string; digest: string; repository: string; commit: string; subdir: string };
  buildInput: { entry: string; toolchain: { builder: string; format: string; lockfile: string }; lockfileHash: string };
  provenance: { kind: string; builder: string; statement: string; signatureVerification: string };
  installedBy: string;
  installedAt: string;
  removedBy: string | null;
  removedAt: string | null;
  active: boolean;
  activatedBy?: string;
  activatedAt?: string;
  supported: boolean;
  unsupportedCode?: string;
  unsupportedReason?: string;
}

/** One app's block. The server sends one of these per app it serves. */
interface AppView {
  stableAppId: string;
  publisher: string;
  activeViewOrigin: string | null;
  activePackageDigest: string | null;
  checkout: { packageDigest: string; hostLabel: string; installed: boolean } | null;
  unavailable: { code: string; message: string } | null;
  runtime: { state: string; runtime: string; statePid: number | null; runtimePid: number | null } | null;
  releases: ReleaseRow[];
}

interface HotswapApproval {
  id: string;
  state: "pending" | "approved";
  ticket_id: number;
  app_id: string;
  publisher: string | null;
  source_commit: string;
  package_digest: string;
  previous_digest: string | null;
  contract_digest: string;
  contract_changed: boolean | null;
  coexistence: "multi_version" | "refresh_required";
  coexistence_reason: string | null;
  requested_by: string;
  requested_at: string;
  expires_at: string;
  outcome: string | null;
}

interface RegistryView {
  apps: AppView[];
  /**
   * Stable app ids this panel will host at `/apps/<id>/open`.
   *
   * A composition fact the server answers, not a rule this page derives: an
   * app is openable here when this process composed a coordinator and a view
   * origin for it, which is exactly what "a declared app with an active
   * release" means.
   */
  openable?: string[];
  /** Agent-requested activation of one exact installed digest. */
  hotswap_approvals?: HotswapApproval[];
  /** Registry-wide: an orphaned artifact belongs to no app by definition. */
  reconcile: {
    activeUnusable: Array<{ packageDigest: string; code: string; message: string }>;
    installedUnusable: Array<{ packageDigest: string; code: string; message: string }>;
    undescribable: string[];
    orphanContent: number;
  };
}

function short(digest: string): string {
  return digest.slice(0, 16);
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function when(value: string | null | undefined): string {
  if (!value) return "—";
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString(dateLocale());
}

function ReleaseDetail({ release }: { release: ReleaseRow }) {
  useDashboardLanguage();
  return (
    <div className={styles.detail}>
      <dl>
        <dt>{uiText("包摘要")}</dt>
        <dd className={styles.mono}>{release.packageDigest}</dd>
        <dt>{uiText("主机名标签")}</dt>
        <dd className={styles.mono}>{release.hostLabel}</dd>
        <dt>{uiText("权限契约")}</dt>
        <dd className={styles.mono}>{release.permissionContractDigest}</dd>
        <dt>{uiText("执行 profile")}</dt>
        <dd>{release.executionProfile}</dd>
        <dt>{uiText("来源")}</dt>
        <dd className={styles.mono}>
          {release.source.kind} · {release.source.repository} · {release.source.commit}
        </dd>
        <dt>{uiText("构建输入")}</dt>
        <dd className={styles.mono}>
          {release.buildInput.toolchain.builder} · {release.buildInput.toolchain.format} ·{" "}
          {release.buildInput.toolchain.lockfile}@{short(release.buildInput.lockfileHash)}
        </dd>
        <dt>{uiText("来源信息")}</dt>
        <dd>
          {release.provenance.kind} · {release.provenance.builder}
          <div className={styles.muted}>{release.provenance.statement}</div>
          <div className={styles.muted}>
            {uiText("签名验证：")}{release.provenance.signatureVerification}
          </div>
        </dd>
        <dt>{uiText("组成")}</dt>
        <dd className={styles.mono}>
          {uiText("View：")}{release.composition.view.join(", ")} {uiText("· 后端：")}{release.composition.backend.join(", ")}
        </dd>
      </dl>
      <table className={styles.assets}>
        <thead>
          <tr>
            <th>{uiText("资产")}</th>
            <th>sha256</th>
            <th>{uiText("字节")}</th>
          </tr>
        </thead>
        <tbody>
          {release.assets.map((asset) => (
            <tr key={asset.name}>
              <td className={styles.mono}>{asset.name}</td>
              <td className={styles.mono}>{short(asset.sha256)}…</td>
              <td>{kb(asset.bytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HotswapApprovals({
  approvals,
  busy,
  act,
}: {
  approvals: HotswapApproval[];
  busy: boolean;
  act: (input: { path: string; json: Record<string, unknown> }) => void;
}) {
  useDashboardLanguage();
  if (!approvals.length) return null;
  return (
    <UiCard className={styles.card}>
      <h3>{uiText("待管理员批准的 activation")}</h3>
      <p className={styles.muted}>
        {uiText("候选已安装但未激活。批准前服务端会复核工单 commit、前驱版本、权限契约与并存策略。")}</p>
      {approvals.map((approval) => (
        <section className={styles.approval} key={approval.id} aria-label={uiText("{v0} activation 审批", { v0: approval.app_id })}>
          <div className={styles.approvalHead}>
            <strong>{approval.publisher ? `${approval.publisher}/` : ""}{approval.app_id}</strong>
            <UiTag tone={approval.state === "approved" ? "danger" : undefined}>
              {approval.state === "approved" ? uiText("已批，执行待恢复") : uiText("等待审批")}
            </UiTag>
          </div>
          <dl className={styles.inline}>
            <dt>{uiText("审批 / 工单")}</dt>
            <dd><span className={styles.mono}>{approval.id}</span> · #{approval.ticket_id}</dd>
            <dt>{uiText("来源 commit")}</dt>
            <dd className={styles.mono}>{approval.source_commit}</dd>
            <dt>{uiText("候选 digest")}</dt>
            <dd className={styles.mono}>{approval.package_digest}</dd>
            <dt>{uiText("当前前驱")}</dt>
            <dd className={styles.mono}>{approval.previous_digest ?? uiText("首次激活")}</dd>
            <dt>{uiText("权限契约")}</dt>
            <dd className={styles.mono}>
              {approval.contract_digest}
              {approval.contract_changed === true ? uiText("（相对前驱有变化）") : approval.contract_changed === false ? uiText("（未变化）") : uiText("（无可比前驱）")}
            </dd>
            <dt>{uiText("旧实例处理")}</dt>
            <dd>
              {approval.coexistence === "multi_version" ? uiText("多版本并存") : uiText("保留 iframe，下一次提交要求刷新")}
              {approval.coexistence_reason ? ` · ${approval.coexistence_reason}` : ""}
            </dd>
            <dt>{uiText("申请 / 到期")}</dt>
            <dd>{approval.requested_by} · {when(approval.requested_at)} → {when(approval.expires_at)}</dd>
          </dl>
          {approval.outcome && <p className={styles.muted}>{uiText("上次执行结果：")}{approval.outcome}</p>}
          <div className={styles.actions}>
            <UiButton
              tone="primary"
              disabled={busy}
              onClick={() => act({ path: `/api/apps/hotswap/${approval.id}/approve`, json: {} })}
            >
              {approval.state === "approved" ? uiText("重试确切 digest") : uiText("批准并激活")}
            </UiButton>
            {approval.state === "pending" && (
              <UiButton
                tone="danger"
                disabled={busy}
                onClick={() => act({ path: `/api/apps/hotswap/${approval.id}/reject`, json: {} })}
              >
                {uiText("拒绝")}</UiButton>
            )}
          </div>
        </section>
      ))}
    </UiCard>
  );
}

/** One app: its current state and its installed releases. */
function AppBlock({
  app,
  openable,
  busy,
  act,
}: {
  app: AppView;
  openable: boolean;
  busy: boolean;
  act: (input: { path: string; json: Record<string, unknown> }) => void;
}) {
  useDashboardLanguage();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <UiCard className={styles.card}>
        <h3>{uiText("当前状态")}</h3>
        {app.unavailable ? (
          <ErrorBox>{uiText("当前没有可服务的 release：")}{app.unavailable.message}</ErrorBox>
        ) : (
          <dl className={styles.inline}>
            <dt>{uiText("正在服务")}</dt>
            <dd className={styles.mono}>{app.activePackageDigest ? short(app.activePackageDigest) + "…" : "—"}</dd>
            <dt>{uiText("View 来源")}</dt>
            <dd className={styles.mono}>{app.activeViewOrigin ?? "—"}</dd>
          </dl>
        )}
        {app.runtime && (
          <p className={styles.muted}>
            {uiText("后端进程：state=")}{app.runtime.state}
            {app.runtime.statePid ? `(pid ${app.runtime.statePid})` : ""} {uiText("· 运行时=")}{app.runtime.runtime}
            {app.runtime.runtimePid ? `(pid ${app.runtime.runtimePid})` : ""}
          </p>
        )}
        {app.checkout && (
          <p className={styles.muted}>
            {uiText("本机 checkout 会构建出 ")}<span className={styles.mono}>{short(app.checkout.packageDigest)}…</span>（
            {app.checkout.hostLabel}）
            {app.checkout.installed ? uiText("，已安装。") : uiText("，尚未安装 — 请先打包并上传。")}
          </p>
        )}
        {/* Where a person actually opens what this page publishes.
         *
         * Rendered from the server's `openable` list rather than from a rule
         * this page invented: which apps have a trusted host page is a fact
         * about the composition (declared apps do; Session Plus is compiled in
         * and has its own surface with the capability chrome its contract
         * needs), and a browser guessing at it would be a link that 404s the
         * day the composition changes. */}
        {openable && (
          <p>
            <a href={`/apps/${encodeURIComponent(app.stableAppId)}/open`}>{uiText("打开这个 App →")}</a>
          </p>
        )}
      </UiCard>

      <UiCard className={styles.card}>
        <h3>{uiText("已安装的 release")}</h3>
        {app.releases.length === 0 && <p className={styles.muted}>{uiText("还没有任何 release。")}</p>}
        <table className={styles.list}>
          <thead>
            <tr>
              <th>{uiText("摘要")}</th>
              <th>{uiText("主机名")}</th>
              <th>{uiText("安装")}</th>
              <th>{uiText("状态")}</th>
              <th>{uiText("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {app.releases.map((release) => (
              <tr key={release.packageDigest} className={release.active ? styles.activeRow : undefined}>
                <td className={styles.mono}>
                  <UiButton
                    className={styles.link}
                    onClick={() => setOpen(open === release.packageDigest ? null : release.packageDigest)}
                    aria-expanded={open === release.packageDigest}
                  >
                    {short(release.packageDigest)}…
                  </UiButton>
                  {open === release.packageDigest && <ReleaseDetail release={release} />}
                </td>
                <td className={styles.mono}>{release.hostLabel}</td>
                <td>
                  <div>{when(release.installedAt)}</div>
                  <div className={styles.muted}>{release.installedBy}</div>
                </td>
                <td>
                  {release.active && <UiTag tone="success">{uiText("正在服务")}</UiTag>}
                  {!release.supported && (
                    <UiTag tone="danger" title={release.unsupportedReason}>
                      {uiText("不受支持")}</UiTag>
                  )}
                  {release.removedAt && <UiTag>{uiText("已卸载")}</UiTag>}
                  {!release.supported && release.unsupportedReason && (
                    <div className={styles.muted}>{release.unsupportedReason}</div>
                  )}
                  {release.active && release.activatedBy && (
                    <div className={styles.muted}>
                      {when(release.activatedAt)} · {release.activatedBy}
                    </div>
                  )}
                </td>
                <td className={styles.actions}>
                  {!release.active && release.supported && !release.removedAt && (
                    <UiButton
                      disabled={busy}
                      onClick={() =>
                        act({
                          path: "/api/apps/activate",
                          json: { app: release.stableAppId, package_digest: release.packageDigest },
                        })}
                    >
                      {app.activePackageDigest ? uiText("切换到这一版") : uiText("激活")}
                    </UiButton>
                  )}
                  {release.active && (
                    <UiButton
                      disabled={busy}
                      onClick={() => act({ path: "/api/apps/deactivate", json: { app: release.stableAppId } })}
                    >
                      {uiText("停用")}</UiButton>
                  )}
                  {!release.active && !release.removedAt && (
                    <UiButton
                      tone="danger"
                      disabled={busy}
                      onClick={() =>
                        act({
                          path: "/api/apps/uninstall",
                          json: { app: release.stableAppId, package_digest: release.packageDigest },
                        })}
                    >
                      {uiText("卸载")}</UiButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={styles.muted}>
          {uiText("卸载不删除持久状态、信任、权限意图或产物；本页不提供永久清除。")}</p>
      </UiCard>
    </>
  );
}

export function AppsPage() {
  useDashboardLanguage();
  const client = useQueryClient();
  const [note, setNote] = useState<UiTextValue>("");
  const [failed, setFailed] = useState<UiTextValue>("");
  const [selected, setSelected] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const view = useQuery<RegistryView>({
    queryKey: [APPS_PATH],
    queryFn: () => api<RegistryView>(APPS_PATH),
  });

  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: [APPS_PATH] });
  };

  const install = useMutation({
    mutationFn: async (bundle: unknown) =>
      await api<{ app: string; package_digest: string; deduplicated: boolean }>("/api/apps/install", {
        method: "POST",
        json: { bundle },
      }),
    onSuccess: async (result) => {
      setFailed("");
      setNote(
        result.deduplicated
          ? uiMessage("{v0} 的这个 release 已经安装过：{v1}…（没有任何改变）", { v0: result.app, v1: short(result.package_digest) })
          : uiMessage("已为 {v0} 安装 {v1}…。**它还没有被激活** — 请在下面的列表里决定是否切换。", { v0: result.app, v1: short(result.package_digest) }),
      );
      // The bundle names its own app; follow it so the operator lands on the
      // block their upload actually changed.
      setSelected(result.app);
      if (fileInput.current) fileInput.current.value = "";
      await refresh();
    },
    onError: (err) => {
      setNote("");
      setFailed(errorText(err));
    },
  });

  const act = useMutation({
    mutationFn: async (input: { path: string; json: Record<string, unknown> }) =>
      await api<Record<string, unknown>>(input.path, { method: "POST", json: input.json }),
    onSuccess: async (result, input) => {
      setFailed("");
      setNote(
        typeof result.message === "string"
          ? result.message
          : input.path.endsWith("/activate") ? uiMessage("已切换：刷新该 App 的页面即可看到新 release。") : uiMessage("已完成。"),
      );
      await refresh();
    },
    onError: (err) => {
      setNote("");
      setFailed(errorText(err));
    },
  });

  const busy = install.isPending || act.isPending;

  const onPick = (): void => {
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    if (file.size > MAX_BUNDLE_BYTES) {
      setFailed(uiMessage("这个文件有 {v0}，超过了本页接受的上限。", { v0: kb(file.size) }));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setFailed(uiMessage("读不出这个文件。"));
    reader.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch {
        setFailed(uiMessage("这个文件不是 release bundle（不是合法 JSON）。"));
        return;
      }
      install.mutate(parsed);
    };
    reader.readAsText(file);
  };

  if (view.isLoading) return <Loading what={uiText("读取应用发布状态…")} />;
  if (!view.data) {
    return view.error ? <ErrorBox>{errorText(view.error)}</ErrorBox> : <Loading what={uiText("读取应用发布状态…")} />;
  }
  const data = view.data;
  // Selection follows the server's list rather than a remembered id: an app can
  // stop being served between two reads, and a page pointing at one that is
  // gone would show an empty screen with no way back.
  const current = data.apps.find((app) => app.stableAppId === selected) ?? data.apps[0] ?? null;

  return (
    <div className={styles.page}>
      {view.error && (
        <StaleDataBanner message={errorText(view.error)} dataUpdatedAt={view.dataUpdatedAt} />
      )}
      <header className={styles.head}>
        <h2>{uiText("应用发布")}</h2>
        <p className={styles.muted}>
          {uiText("安装本机构建的 release bundle；服务端将从文件字节重新计算 digest。")}</p>
        {data.apps.length > 1 && (
          <nav className={styles.actions} aria-label={uiText("本机服务的 App")}>
            {data.apps.map((app) => (
              <UiButton
                key={app.stableAppId}
                tone={app.stableAppId === current?.stableAppId ? "primary" : "default"}
                disabled={busy}
                aria-pressed={app.stableAppId === current?.stableAppId}
                onClick={() => setSelected(app.stableAppId)}
              >
                {app.publisher}/{app.stableAppId}
              </UiButton>
            ))}
          </nav>
        )}
        {current && (
          <p className={styles.mono}>
            {current.publisher}/{current.stableAppId}
          </p>
        )}
      </header>

      <HotswapApprovals approvals={data.hotswap_approvals ?? []} busy={busy} act={act.mutate} />

      {!current && <p className={styles.muted}>{uiText("本进程没有组合任何 Agentic App。")}</p>}

      {current && (
        <>
          <UiCard className={styles.card}>
            <h3>{uiText("安装一个预构建 release")}</h3>
            <p className={styles.muted}>
              {uiText("在 bot 主机执行 ")}<code>pnpm run app:pack -- --out release.json</code> {uiText(" 生成 bundle 后上传。 安装不会切换当前版本。")}</p>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={onPick}
              aria-label={uiText("release bundle 文件")}
            />
            {install.isPending && <Status>{uiText("正在校验并安装…")}</Status>}
          </UiCard>

          {uiValue(note) && <Status kind="ok">{uiValue(note)}</Status>}
          {uiValue(failed) && <ErrorBox>{uiValue(failed)}</ErrorBox>}

          <AppBlock
            key={current.stableAppId}
            app={current}
            openable={(data.openable ?? []).includes(current.stableAppId)}
            busy={busy}
            act={act.mutate}
          />
        </>
      )}

      {data.reconcile.activeUnusable.length > 0 && (
        <ErrorBox>
          {uiText("对账发现正在激活的 release 产物有问题：")}{data.reconcile.activeUnusable.map((row) => `${short(row.packageDigest)}… ${row.message}`).join("；")}
        </ErrorBox>
      )}
      {(data.reconcile.installedUnusable.length > 0
        || data.reconcile.undescribable.length > 0
        || data.reconcile.orphanContent > 0) && (
        <p className={styles.muted}>
          {uiText("对账：")}{data.reconcile.installedUnusable.length} {uiText(" 个已安装但不可用、")}{data.reconcile.undescribable.length} {uiText(" 个无法重新校验、")}{data.reconcile.orphanContent} {uiText(" 份无引用产物。 对账只报告，不自动删除。")}</p>
      )}
    </div>
  );
}
