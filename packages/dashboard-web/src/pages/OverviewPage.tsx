import { RunnerCapabilities } from "./RunnerCapabilities.js";
import type { RunnerCapabilityView } from "../contract.js";
import { RunnerDisplayName } from "../ui/RunnerDisplayName.js";
import { dateLocale } from "../lib/format.js";
import { useDashboardLanguage } from "../i18n/react.js";
import { uiText, uiMessage, uiValue, type UiTextValue } from "../i18n/ui-text.js";
/**
 * `/` — endpoint liveness and onboarding, and nothing else.
 *
 * Style preferences moved to the 秘书 tab in ticket #10; this page keeps exactly
 * two jobs: which tentacles are online, and how to attach a new one.
 *
 * The onboarding commands are composed SERVER-side (`pageProps.commands`) from
 * the bot's real outside address, with shell-safe quoting and `curl -f`, so an
 * auth error cannot masquerade as a downloaded bundle. The browser only prints
 * them.
 *
 * Edit protection, which used to be a `document.activeElement` check before a
 * 30 s repaint clobbered a half-typed form: the form state now lives in React
 * and the poll only replaces server data, so there is nothing left to clobber.
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "../lib/api.js";
import { pollInterval } from "../lib/query.js";
import { bootstrap } from "../lib/bootstrap.js";
import { formatAgo } from "../lib/format.js";
import { Confirm } from "../ui/Dialog.js";
import { ErrorBox, Status, useAction } from "../ui/misc.js";
import {
  UiButton,
  UiCard,
  UiInput,
  UiSelect,
  UiTable,
  UiTabs,
  type UiTableColumn,
} from "../ui-kit/primitives.js";
import type { OverviewPageProps } from "../contract.js";
import styles from "./OverviewPage.module.css";

interface RunnerRow {
  capability_view?: RunnerCapabilityView[];
  device: string;
  display_name?: string;
  online: boolean;
  created_at?: string;
  last_seen_at?: string;
  local_agent_bridge_mode: "disabled" | "manual" | "full_access";
  default_agent_injection: boolean;
  gui_automation_enabled: boolean;
  inventory?: {
    capabilities?: { protocol: string };
    local_mcp?: {
      available: boolean;
      protocol: "runner-local-mcp/v1";
      clients: Array<"claude" | "codex" | "omp">;
    };
    gui_automation?: {
      available: boolean;
      protocol: "runner-macos-gui/v1";
      consent_ttl_seconds: 900;
    };
  };
}

interface UserRow {
  username: string;
  display_name: string;
  last_round_at?: string;
  rounds_7d?: number;
  runners: RunnerRow[];
}

interface Overview {
  generated_at: string;
  gateway_enabled?: boolean;
  runner_ws_port?: number;
  public_host?: string;
  users: UserRow[];
}

interface CheckResult {
  username?: string;
  device?: string;
  online: boolean;
  error?: string;
  rtt_ms?: number;
  sessions_visible?: number;
}

const OVERVIEW_PATH = "/api/overview";

function CheckLine({ result }: { result: CheckResult | undefined }) {
  useDashboardLanguage();
  if (!result) return null;
  if (!result.online) {
    return (
      <div className={styles.checkline}>
        <span className="err">{uiText("✖ 离线")}{result.error ? ` · ${result.error}` : ""}</span>
      </div>
    );
  }
  if (result.error) {
    return (
      <div className={styles.checkline}>
        <span className="err">{uiText("⚠ 在线但异常: ")}{result.error}</span>
      </div>
    );
  }
  return (
    <div className={styles.checkline}>
      <span className="ok">
        {uiText("✔ 正常 · ")}{result.rtt_ms}{uiText("ms · 可见 ")}{result.sessions_visible} {uiText(" 个 session")}</span>
    </div>
  );
}

export function OverviewPage() {
  useDashboardLanguage();
  const props = bootstrap.pageProps as OverviewPageProps;
  const client = useQueryClient();
  const [checks, setChecks] = useState<Record<string, CheckResult>>({});
  const [busyCheck, setBusyCheck] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ username: string; device: string } | null>(null);
  const [mintUser, setMintUser] = useState("");
  const [mintDevice, setMintDevice] = useState("");
  const [mintConfirm, setMintConfirm] = useState(false);
  const [installPlatform, setInstallPlatform] = useState<"posix" | "windows">("posix");
  const [minted, setMinted] = useState<{
    enrollment_code?: string;
    expires_at?: string;
    install_cmd?: string;
  } | null>(null);
  const [mintError, setMintError] = useState<UiTextValue | null>(null);
  const [verify, setVerify] = useState({ username: "", device: "" });
  const [verifyResult, setVerifyResult] = useState<CheckResult | null>(null);
  const [verifyNote, setVerifyNote] = useState<UiTextValue | null>(null);
  const [checkAllLabel, setCheckAllLabel] = useState<UiTextValue>(uiMessage("🩺 检查全部端点"));
  const [bridgeBusy, setBridgeBusy] = useState<string | null>(null);
  const [bridgeErrors, setBridgeErrors] = useState<Record<string, string>>({});
  const [injectionBusy, setInjectionBusy] = useState<string | null>(null);
  const [injectionErrors, setInjectionErrors] = useState<Record<string, string>>({});
  const [guiBusy, setGuiBusy] = useState<string | null>(null);
  const [guiErrors, setGuiErrors] = useState<Record<string, string>>({});

  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>(OVERVIEW_PATH),
    refetchInterval: pollInterval(OVERVIEW_PATH, 30_000),
    refetchIntervalInBackground: false,
  });
  const data = overview.data;
  const users = data?.users ?? [];
  // The select renders the first visible account as its default before the
  // person has interacted with it. The action must submit that SAME derived
  // value: sending `mintUser` directly sends "" on the ordinary first click,
  // which the server correctly refuses as a request for a different account.
  const selectedMintUser = mintUser || users[0]?.username || "";

  const key = (username: string, device: string) => `${username}/${device}`;

  async function checkOne(username: string, device: string) {
    setBusyCheck(key(username, device));
    try {
      const result = await api<CheckResult>("/api/check", {
        method: "POST",
        json: { username, device },
      });
      setChecks((prev) => ({ ...prev, [key(username, device)]: result }));
    } catch (err) {
      setChecks((prev) => ({
        ...prev,
        [key(username, device)]: { online: false, error: errorText(err) },
      }));
    } finally {
      setBusyCheck(null);
    }
  }

  async function setBridgeMode(
    username: string,
    device: string,
    mode: RunnerRow["local_agent_bridge_mode"],
  ) {
    const rowKey = key(username, device);
    setBridgeBusy(rowKey);
    setBridgeErrors((current) => {
      const next = { ...current };
      delete next[rowKey];
      return next;
    });
    try {
      await api("/api/runner-local-agent-bridge", {
        method: "POST",
        json: { username, device, mode },
      });
      await client.invalidateQueries({ queryKey: ["overview"] });
    } catch (error) {
      setBridgeErrors((current) => ({ ...current, [rowKey]: errorText(error) }));
    } finally {
      setBridgeBusy(null);
    }
  }

  async function setDefaultInjection(username: string, device: string, enabled: boolean) {
    const rowKey = key(username, device);
    setInjectionBusy(rowKey);
    setInjectionErrors((current) => {
      const next = { ...current };
      delete next[rowKey];
      return next;
    });
    try {
      await api("/api/runner-default-agent-injection", {
        method: "POST",
        json: { username, device, enabled },
      });
      await client.invalidateQueries({ queryKey: ["overview"] });
    } catch (error) {
      setInjectionErrors((current) => ({ ...current, [rowKey]: errorText(error) }));
    } finally {
      setInjectionBusy(null);
    }
  }

  async function setGuiAutomation(username: string, device: string, enabled: boolean) {
    const rowKey = key(username, device);
    setGuiBusy(rowKey);
    setGuiErrors((current) => {
      const next = { ...current };
      delete next[rowKey];
      return next;
    });
    try {
      await api("/api/runner-gui-automation", {
        method: "POST",
        json: { username, device, enabled },
      });
      await client.invalidateQueries({ queryKey: ["overview"] });
    } catch (error) {
      setGuiErrors((current) => ({ ...current, [rowKey]: errorText(error) }));
    } finally {
      setGuiBusy(null);
    }
  }

  const [checkAll, checkingAll] = useAction(async () => {
    setCheckAllLabel(uiMessage("检查中…"));
    try {
      const out = await api<{ results: CheckResult[]; checked: number }>("/api/check-all", {
        method: "POST",
      });
      setChecks((prev) => {
        const next = { ...prev };
        for (const result of out.results ?? []) {
          if (result.username && result.device) next[key(result.username, result.device)] = result;
        }
        return next;
      });
      setCheckAllLabel(uiMessage("🩺 检查全部端点 ({v0})", { v0: out.checked }));
    } catch (err) {
      setCheckAllLabel(`✖ ${errorText(err)}`);
    } finally {
      setTimeout(() => setCheckAllLabel(uiMessage("🩺 检查全部端点")), 5000);
    }
  });

  const [removeRunner, removing] = useAction(async () => {
    if (!deleting) return;
    try {
      await api("/api/runner-delete", { method: "POST", json: deleting });
      await client.invalidateQueries({ queryKey: ["overview"] });
      setDeleting(null);
    } catch (err) {
      setChecks((prev) => ({
        ...prev,
        [key(deleting.username, deleting.device)]: { online: false, error: errorText(err) },
      }));
      setDeleting(null);
    }
  });

  const [mint, minting] = useAction(async () => {
    setMintConfirm(false);
    setMintError(null);
    setMinted(null);
    try {
      const out = await api<{
        enrollment_code?: string;
        expires_at?: string;
        install_cmd?: string;
      }>(
        "/api/runner-token",
        {
          method: "POST",
          json: {
            username: selectedMintUser,
            device: mintDevice.trim() || "laptop",
            platform: installPlatform === "windows" ? "windows-installed" : "unix",
          },
        },
      );
      setMinted(out);
    } catch (err) {
      setMintError(errorText(err));
    }
  });

  const [runVerify, verifying] = useAction(async () => {
    const username = verify.username.trim();
    const device = verify.device.trim();
    if (!username || !device) {
      setVerifyNote(uiMessage("请填用户名和设备名"));
      return;
    }
    setVerifyNote(null);
    try {
      setVerifyResult(await api<CheckResult>("/api/check", { method: "POST", json: { username, device } }));
    } catch (err) {
      setVerifyResult({ online: false, error: errorText(err) });
    }
  });

  const userColumns: UiTableColumn<UserRow>[] = [
    {
      title: uiText("用户"),
      key: "user",
      render: (_, user) => (
        <>
          <strong>{user.display_name}</strong>
          <div className="muted">{user.username}</div>
        </>
      ),
    },
    {
      title: uiText("活跃"),
      key: "activity",
      render: (_, user) =>
        user.last_round_at ? (
          <>
            {formatAgo(user.last_round_at)} <span className="muted">{uiText("(7天 ")}{user.rounds_7d} {uiText(" 轮)")}</span>
          </>
        ) : (
          <span className="muted">{uiText("无记录")}</span>
        ),
    },
    {
      title: uiText("章鱼端点(octopus endpoint)"),
      key: "runners",
      render: (_, user) =>
        user.runners.length === 0 ? (
          <span className="muted">{uiText("未接入端点")}</span>
        ) : (
          user.runners.map((runner) => (
            <div key={runner.device} className={styles.device}>
              <div className={styles.deviceLine}>
                <span className={`${styles.dot} ${runner.online ? styles.on : styles.off}`} />
                <RunnerDisplayName username={user.username} device={runner.device} displayName={runner.display_name}
                  canEdit={Boolean(bootstrap.viewer.session && (bootstrap.viewer.admin || bootstrap.viewer.username === user.username))}
                  onSaved={() => client.invalidateQueries({ queryKey: ["overview"] })} />{" "}
                <span className="muted">
                  ({runner.online ? uiText("在线") : uiText("离线,最近 {v0}", { v0: formatAgo(runner.last_seen_at) })})
                </span>{" "}
                <UiButton
                  disabled={busyCheck === key(user.username, runner.device)}
                  onClick={() => void checkOne(user.username, runner.device)}
                >
                  {uiText("检查")}</UiButton>{" "}
                <UiButton
                  tone="danger"
                  onClick={() => setDeleting({ username: user.username, device: runner.device })}
                >
                  {uiText("删除")}</UiButton>
              </div>
              <RunnerCapabilities capabilities={runner.capability_view} online={runner.online} hotRegistration={runner.inventory?.capabilities?.protocol === "runner-capabilities/v1"} />
              <div className={styles.bridgeLine}>
                <span>{uiText("本机 Agent 可操作其他端点：")}</span>
                {bootstrap.viewer.session && bootstrap.viewer.username === user.username ? (
                  <UiSelect
                    value={runner.local_agent_bridge_mode}
                    disabled={bridgeBusy === key(user.username, runner.device)}
                    onValueChange={(value) => void setBridgeMode(
                      user.username,
                      runner.device,
                      value as RunnerRow["local_agent_bridge_mode"],
                    )}
                    options={[
                      { value: "disabled", label: uiText("禁用") },
                      { value: "manual", label: uiText("每次审批") },
                      { value: "full_access", label: uiText("完全授权") },
                    ]}
                  />
                ) : (
                  <span>{bridgeModeLabel(runner.local_agent_bridge_mode)}</span>
                )}
                <span className="muted">
                  {localMcpStatus(runner)}
                </span>
              </div>
              {runner.gui_automation_enabled || runner.inventory?.gui_automation?.available ? (
                <div className={styles.bridgeLine}>
                  <span>{uiText("允许 Agent 发现并请求操作此 Mac：")}</span>
                  {bootstrap.viewer.session && bootstrap.viewer.username === user.username ? (
                    <UiButton
                      aria-pressed={runner.gui_automation_enabled}
                      disabled={guiBusy === key(user.username, runner.device)}
                      onClick={() => void setGuiAutomation(
                        user.username,
                        runner.device,
                        !runner.gui_automation_enabled,
                      )}
                    >
                      {runner.gui_automation_enabled ? uiText("关闭 GUI 自动化") : uiText("开启 GUI 自动化")}
                    </UiButton>
                  ) : (
                    <span>{runner.gui_automation_enabled ? uiText("已开启") : uiText("已关闭")}</span>
                  )}
                  <span className="muted">
                    {runner.gui_automation_enabled
                      ? uiText(" · 每次仍须 Mac 本机确认，授权最长 15 分钟，可随时终止")
                      : uiText(" · 仅开放可发现性；开启后也不会直接取得屏幕权限")}
                  </span>
                </div>
              ) : null}
              <div className={styles.bridgeLine}>
                <span>{uiText("普通 Agent 默认注入跨端点 MCP：")}</span>
                {bootstrap.viewer.session && bootstrap.viewer.username === user.username ? (
                  <UiButton
                    aria-pressed={runner.default_agent_injection}
                    disabled={injectionBusy === key(user.username, runner.device)}
                    onClick={() => void setDefaultInjection(
                      user.username,
                      runner.device,
                      !runner.default_agent_injection,
                    )}
                  >
                    {runner.default_agent_injection ? uiText("关闭默认注入") : uiText("开启默认注入")}
                  </UiButton>
                ) : (
                  <span>{runner.default_agent_injection ? uiText("已开启") : uiText("已关闭")}</span>
                )}
                <span className="muted">
                  {runner.default_agent_injection
                    ? uiText(" · Runner 在线时会注册 MCP 与路由提示")
                    : uiText(" · workspace 仍可用 Agent 文档和局部 MCP 配置手动发现")}
                </span>
              </div>
              {bridgeErrors[key(user.username, runner.device)] ? (
                <div className="err">{bridgeErrors[key(user.username, runner.device)]}</div>
              ) : null}
              {injectionErrors[key(user.username, runner.device)] ? (
                <div className="err">{injectionErrors[key(user.username, runner.device)]}</div>
              ) : null}
              {guiErrors[key(user.username, runner.device)] ? (
                <div className="err">{guiErrors[key(user.username, runner.device)]}</div>
              ) : null}
              <CheckLine result={checks[key(user.username, runner.device)]} />
            </div>
          ))
        ),
    },
  ];

  return (
    <div className={styles.wrap}>
      <h1>{uiText("🐙 octopus · 总览")}</h1>
      <div className={styles.sub}>
        {overview.isError ? (
          <span className="err">{errorText(overview.error)}</span>
        ) : data ? (
          <>
            {uiText("生成于 ")}{new Date(data.generated_at).toLocaleString(dateLocale())} {uiText(" · 端点网关:")}{" "}
            {data.gateway_enabled ? uiText("开启 (ws :{v0})", { v0: data.runner_ws_port ?? "" }) : uiText("未开启")}
            {data.public_host ? uiText(" · 对外地址: {v0}", { v0: data.public_host }) : ""} {uiText(" · 用户 ")}{users.length} {uiText(" 人")}</>
        ) : (
          uiText("加载中…")
        )}
      </div>


      <UiCard className={styles.card}>
        <div className={styles.toolbar}>
          <strong>{uiText("用户与端点")}</strong>
          <span className="grow" />
          <UiButton tone="primary" loading={checkingAll} onClick={() => void checkAll()}>
            {uiValue(checkAllLabel)}
          </UiButton>
          <UiButton onClick={() => void overview.refetch()}>
            {uiText("刷新")}</UiButton>
        </div>
        <UiTable<UserRow>
          rowKey="username"
          loading={overview.isPending}
          dataSource={users}
          columns={userColumns}
          pagination={{ pageSize: 8, hideOnSinglePage: true, showSizeChanger: false }}
          locale={{ emptyText: uiText("还没有注册用户") }}
        />
      </UiCard>

      <h2 id="tutorial">{uiText("接入章鱼端点")}</h2>
      <UiCard className={styles.card}>
        <UiTabs
          aria-label={uiText("选择 Runner 安装平台")}
          activeKey={installPlatform}
          onChange={(key) => setInstallPlatform(key as "posix" | "windows")}
          items={[
            { key: "posix", label: "Linux / macOS", children: null },
            { key: "windows", label: "Windows", children: null },
          ]}
        />
        <div className={styles.mint}>
          <div className={styles.mintTitle}>{uiText("签发接入令牌")}</div>
          <div className={styles.rowSettings}>
            <label className="srOnly" htmlFor="mint-user">
              {uiText("用户")}</label>
            <UiSelect
              id="mint-user"
              value={selectedMintUser}
              onValueChange={setMintUser}
              options={users.map((user) => ({
                value: user.username,
                label: `${user.display_name} (${user.username})`,
              }))}
            />
            <label className="srOnly" htmlFor="mint-device">
              {uiText("设备名")}</label>
            <UiInput
              id="mint-device"
              type="text"
              placeholder={uiText("设备名(如 my-macbook)")}
              value={mintDevice}
              onChange={(event) => setMintDevice(event.target.value)}
            />
            <UiButton
              tone="primary"
              loading={minting}
              onClick={() => {
                if (!selectedMintUser) {
                  setMintError(uiMessage("还没有用户可选"));
                  return;
                }
                setMintConfirm(true);
              }}
            >
              {uiText("签发")}</UiButton>
          </div>
          {uiValue(mintError) ? <ErrorBox>✖ {uiValue(mintError)}</ErrorBox> : null}
          {minted ? (
            <div>
              <div className={`${styles.hint} ${styles.warn}`}>
                {uiText("安装凭据只能使用一次，并将在 ")}{minted.expires_at ? new Date(minted.expires_at).toLocaleTimeString(dateLocale()) : uiText("10 分钟内")} {uiText(" 失效。")}</div>
              <div>{uiText("在目标机器上执行:")}</div>
              <pre>{minted.install_cmd}</pre>
              <span className={styles.hint}>
                {installPlatform === "windows"
                  ? uiText("安装器会把永久设备凭据写入当前用户的受限文件，安装并启动登录自启任务；命令和浏览器都不会拿到永久 token。")
                  : uiText("安装器会把永久设备凭据写入本机受限文件，安装并启动 launchd/systemd 用户服务；命令和浏览器都不会拿到永久 token。")}
              </span>
            </div>
          ) : null}
        </div>

        {props.hostIsGuess ? (
          <div className={`${styles.hint} ${styles.warn}`}>
            {uiText("下方地址 ")}<code>{props.tutorialHost}</code> {uiText(" 可能仅本机可达；请替换为 bot 公网地址，或配置")}{" "}
            <code>dashboard.public_host</code> {uiText(" 后重启。")}</div>
        ) : null}

        <ol>
          <li>
            <strong>{uiText("签发安装凭据")}</strong>{uiText("：使用上方签发，或在飞书私聊 bot 发送")}{" "}
            <code>{uiText("/runner-token <设备名>")}</code>{uiText("。同名设备完成安装、兑换凭据时会使旧令牌失效。")}</li>
          {installPlatform === "windows" ? (
            <li>
              <strong>{uiText("一键安装并启动")}</strong>{uiText("：签发后，在普通 PowerShell 中复制上方两行短命令。")}<span className={styles.hint}>
                {uiText("安装器会通过 winget 补齐 Node.js 22 和 Git for Windows，并注册当前用户登录自启任务；仅当 winget 安装依赖需要提权时，才需按错误提示以管理员身份重试。不使用 WSL。")}</span>
              <span className={styles.hint}>
                {uiText("Windows Runner 固定为“仅执行环境”：开放 shell、文件和登记工作区，不扫描 session，也不暴露 Agent、Codex、DSH 或知识索引能力。")}</span>
              <span className={styles.hint}>
                {uiText("安装后可运行 ")}<code>octopus-runner help</code>、<code>status</code>、<code>restart</code>、<code>logs</code> {uiText(" 和 ")}<code>workspace add</code>。
              </span>
            </li>
          ) : (
            <>
              <li>
                <strong>{uiText("一键安装并启动")}</strong>{uiText("（目标设备需 Node ≥ 20）：签发后复制上方安装命令。")}<span className={styles.hint}>
                  {uiText("macOS 使用当前用户 LaunchAgent；systemd Linux 使用 user service。安装后可运行")}{" "}
                  <code>octopus-runner help</code>、<code>status</code>、<code>restart</code> {uiText(" 和")}{" "}
                  <code>workspace add</code>。
                </span>
              </li>
            </>
          )}
          <li>
            <strong>{uiText("验证注册")}</strong>{uiText("：启动日志出现 ")}<code>{uiText("registered as 你的用户名/设备名")}</code> {uiText(" 即已接入；也可在此检查：")}<div className={styles.rowSettings}>
              <label className="srOnly" htmlFor="verify-user">
                {uiText("你的用户名")}</label>
              <UiInput
                id="verify-user"
                type="text"
                placeholder={uiText("你的用户名")}
                value={verify.username}
                onChange={(event) => setVerify((v) => ({ ...v, username: event.target.value }))}
              />
              <label className="srOnly" htmlFor="verify-device">
                {uiText("设备名")}</label>
              <UiInput
                id="verify-device"
                type="text"
                placeholder={uiText("设备名")}
                value={verify.device}
                onChange={(event) => setVerify((v) => ({ ...v, device: event.target.value }))}
              />
              <UiButton tone="primary" loading={verifying} onClick={() => void runVerify()}>
                {uiText("检查注册")}</UiButton>
            </div>
            {uiValue(verifyNote) ? <Status kind="err">{uiValue(verifyNote)}</Status> : null}
            <CheckLine result={verifyResult ?? undefined} />
          </li>
        </ol>
      </UiCard>

      <Confirm
        open={mintConfirm}
        title={uiText("签发接入令牌")}
        body={uiText("为用户 {v0} 的设备「{v1}」签发一次性安装凭据？同名设备的旧令牌会在新凭据完成兑换时作废。", { v0: selectedMintUser, v1: mintDevice.trim() || "laptop" })}
        confirmLabel={uiText("签发")}
        busy={minting}
        onConfirm={() => void mint()}
        onCancel={() => setMintConfirm(false)}
      />
      <Confirm
        open={deleting !== null}
        title={uiText("删除端点")}
        destructive
        confirmLabel={uiText("删除")}
        busy={removing}
        body={
          deleting
            ? uiText("删除用户 {v0} 的设备「{v1}」?其令牌立即作废,在线连接会被断开且无法重连。", { v0: deleting.username, v1: deleting.device })
            : ""
        }
        onConfirm={() => void removeRunner()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

function bridgeModeLabel(mode: RunnerRow["local_agent_bridge_mode"]): string {
  if (mode === "full_access") return uiText("完全授权");
  if (mode === "manual") return uiText("每次审批");
  return uiText("禁用");
}

function localMcpStatus(runner: RunnerRow): string {
  const mcp = runner.inventory?.local_mcp;
  if (!runner.online) return uiText(" · 实际状态：端点离线");
  if (!mcp?.available) return uiText(" · 实际状态：Runner 版本不支持或本机服务不可用");
  if (mcp.clients.length === 0) return uiText(" · MCP 已就绪，尚未注册本机 CLI");
  return uiText(" · MCP 已注册：{v0}", { v0: mcp.clients.join(" / ") });
}
