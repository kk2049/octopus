import { useEffect, useRef, useState } from "react";
import { filesFromItems, MAX_CHAT_ATTACHMENTS, nextAttachmentId, promptWithAttachments, type ChatAttachment } from "../lib/attachments.js";
import { AccountQuota } from "@claude-bot/chat-ui-commons/quota";
import { AvButton, AvInput, AvTextArea } from "@claude-bot/agent-view-react/ui";
/**
 * Starting a local agent, in any directory that device's account can reach.
 *
 * ── It looks like an empty chat, on purpose (ticket #767) ───────────────────
 *
 * This used to be a page-long form: a heading, paired fields, a "第一条需求"
 * box and a separate 启动 button at the bottom. People reach this surface to
 * talk to an Agent, so it is now the same shape as the conversation it turns
 * into: an empty transcript, one input, one send button. Sending the first
 * message IS the launch. Every setting is a compact item in the shared
 * run-configuration bar directly under the input (`RunConfig.tsx`, the same
 * bar the chat composer renders for later turns), and the rare ones — Codex
 * account, permission profile, split placement — fold behind the ⚙ card the
 * chat composer also uses. After the launch succeeds the module opens the new
 * session and closes this panel, so the empty chat simply becomes the chat.
 *
 * ── What changed earlier, and why the old restriction was the wrong shape ───
 *
 * This form used to be reachable only from a registered directory row's `＋`,
 * on the reasoning that the device and workspace should come from something the
 * reader pointed at rather than from a free-text field a View could prefill.
 * That reasoning does not hold up: a View can prefill a workspace id it read out
 * of the projection just as easily, while the trusted side still binds the
 * proposal to this release, owner and current permission contract.
 *
 * What the restriction did cost was real: a directory had to be enumerated by a
 * background pass before an agent could be started in it, so "start work in the
 * folder I just made" was not expressible. Now the directory is a text field,
 * the `＋` on a known directory prefills it, and the whole form is usable before
 * any enumeration finishes.
 *
 * ── What this form is allowed to claim ──────────────────────────────────────
 *
 * Nothing. Directory, CLI, model, effort and the first instruction are sent to
 * the trusted side, whose release contract decides whether the operation runs
 * silently, is refused or needs approval. The device itself decides whether
 * that directory exists, is a directory, and is reachable by the account it
 * would run as. This code cannot grant anything and does not try to look like
 * it can: the safety note says the directory is a starting point, not a boundary.
 */

import {
  AGENT_PERMISSION_PROFILES,
  type AgentPermissionProfile,
  type CliKind,
  type PlacementDevice,
  type WorkspaceGroup,
} from "@claude-bot/agent-sessions-contract";
import { handleModifierSubmitKeyDown } from "@claude-bot/chat-ui-commons/composer";
import { useCompactChatViewport } from "@claude-bot/chat-ui-commons/composer-react";
import {
  LAUNCH_CHOICES,
  launchChoiceIdOf,
  launchChoiceOf,
  type LaunchChoiceId,
  cliKindLabel,
  supportsManualPermissionProfile,
  modelChoices,
  codexModelsForDevice,
  normalizeEffort,
} from "../lib/cli.js";
import { scopedDomId } from "../lib/dom.js";
import { AgentPermissionField, EffortPicker, ModelPicker, RunConfigBar, RunConfigField } from "./RunConfig.js";

export { AgentPermissionField } from "./RunConfig.js";

/**
 * The same three POSIX shapes the current device protocol accepts, checked here
 * only to say so early.
 *
 * This is a HINT, not a check: the authority is `packages/runner/src/directories.ts`,
 * and the trusted executor applies that same rule before an approval card is
 * ever drawn. Repeating a loose version of it here would be worse than nothing —
 * so this is deliberately the same three-way question, and its only job is to
 * disable the button instead of letting somebody wait for a refusal. Windows
 * drive paths need a platform-bearing trusted request before they can be
 * supported; accepting their shape here would disagree with today's Linux Bot
 * and Runner resolver.
 */
export function directoryHint(value: string): string {
  const text = value.trim();
  if (!text) return "请填写要启动 Agent 的目录";
  if (text !== value) return "目录前后不能有空白";
  if (text === "~" || text.startsWith("~/")) return "";
  if (text.startsWith("~")) return "只支持 ~ 或 ~/… 形式的家目录写法";
  if (text.startsWith("/")) return "";
  return "请写 POSIX 绝对路径，或以 ~/ 开头的路径";
}

/**
 * What this form knows about the launch it asked for (ticket #191).
 *
 * `null` means nobody has pressed the button in this View yet. Everything else
 * is a phase the person can read: the click is in flight, the trusted side took
 * it, the device is working on it, or it ended — and the two endings that used
 * to be invisible (`refused`, `failed`) carry the sentence whoever refused it
 * wrote.
 */
export interface NewSessionLaunch {
  phase: "sending" | "submitted" | "running" | "succeeded" | "refused" | "failed" | "uncertain";
  prompt?: string;
  message: string;
}

/** Wording per phase, in one place so the form body stays a form body. */
const LAUNCH_NOTES: Readonly<Record<NewSessionLaunch["phase"], string>> = Object.freeze({
  sending: "正在提交启动请求…",
  submitted: "已提交，等待设备执行…",
  running: "正在启动…",
  succeeded: "已启动。新的会话会出现在左侧列表里。",
  refused: "启动被拒绝",
  failed: "启动失败",
  uncertain: "启动结果未确认",
});

/** The phases during which pressing 启动 again would be a second launch. */
const LAUNCH_BUSY: ReadonlySet<NewSessionLaunch["phase"]> = new Set<NewSessionLaunch["phase"]>([
  "sending",
  "submitted",
  "running",
  "uncertain",
]);

export interface NewSessionProps {
  domIdScope?: string;
  devices: readonly string[];
  placementDevices: readonly PlacementDevice[];
  workspaces: Readonly<Record<string, WorkspaceGroup>>;
  advanced: boolean;
  runtimeDevice: string;
  codexAccount?: string;
  onCodexAccount?(value: string): void;
  workspaceId: string;
  device: string;
  directory: string;
  source: CliKind;
  /** Bilingual Claude lane; see LAUNCH_CHOICES. */
  translatePrompt: boolean;
  model: string;
  effort: string;
  permissionProfile: AgentPermissionProfile;
  prompt: string;
  /** The lifecycle of the launch this form last asked for. */
  launch?: NewSessionLaunch | null;
  /** Drop a settled launch note. Absent when the caller tracks nothing. */
  onDismissLaunch?(): void;
  onAdvanced(value: boolean): void;
  onRuntimeDevice(value: string): void;
  onWorkspace(value: string): void;
  onDevice(value: string): void;
  onDirectory(value: string): void;
  onSource(value: LaunchChoiceId): void;
  onModel(value: string): void;
  onEffort(value: string): void;
  onPermissionProfile(value: AgentPermissionProfile): void;
  onPrompt(value: string): void;
  onCancel(): void;
  onStart(prompt?: string): void;
  onAttachFile?(file: File, onProgress?: (uploaded: number, total: number) => void): Promise<
    { ok: true; attachment: Omit<ChatAttachment, "id"> } | { ok: false; message: string }>;

}

/**
 * Ticket #180 kept this short because a textarea shows the whole hint; on a
 * phone a sentence filled the box with grey text. The chat-shaped launcher
 * (ticket #767) keeps the same two lengths.
 */
export const NEW_SESSION_PROMPT_PLACEHOLDER = {
  wide: "给新的 Agent 发第一条消息，发送即启动…",
  compact: "第一条消息…",
} as const;

const DIAGNOSTIC_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  unsafe_permissions: "已找到程序，但被本机安装信任策略拒绝；请用 agents list 查看原因",
  interpreter_unavailable: "已找到程序，但缺少可用解释器",
  unsupported_interpreter: "程序需要明确指定解释器",
  invalid_bindings: "本机 Agent 绑定配置不可用",
  binding_unavailable: "本机指定的 Agent 安装已失效",
  selection_unavailable: "先前选择的 Agent 安装已失效",
  multiple_installations: "存在多个安装，需要在本机用 agents bind 选择",
  selection_write_failed: "无法保存本机 Agent 选择",
  not_executable: "程序文件不可执行",
  invalid_path: "程序路径无效",
  permission_denied: "操作系统拒绝访问或执行程序",
  probe_timeout: "程序探测超时",
  executable_changed: "程序在启动准备期间已变更，请核对本机安装",
  execution_only: "此设备仅提供执行环境",
});

export function NewSession(props: NewSessionProps) {
  const effort = normalizeEffort(props.source, props.effort);
  const compactLayout = useCompactChatViewport();
  const launch = props.launch ?? null;
  const busy = Boolean(launch && LAUNCH_BUSY.has(launch.phase));
  const succeeded = launch?.phase === "succeeded";
  const locked = busy || succeeded;
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState("");
  const uploadTarget = JSON.stringify([props.device, props.advanced ? props.workspaceId : ""]);
  const targetRef = useRef({ key: uploadTarget, generation: 0 });
  if (targetRef.current.key !== uploadTarget) targetRef.current = { key: uploadTarget, generation: targetRef.current.generation + 1 };
  const mounted = useRef(true);
  const slots = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    slots.current = 0;
    setAttachments([]);
    setUploading(0);
    setUploadError("");
  }, [uploadTarget]);
  const attachFiles = (files: File[]) => {
    if (locked || !props.device || !props.onAttachFile || (props.advanced && !props.workspaceId)) return;
    const target = targetRef.current;
    const current = () => mounted.current && targetRef.current === target;
    setUploadError("");
    for (const file of files) {
      if (slots.current >= MAX_CHAT_ATTACHMENTS) { setUploadError(`最多附加 ${MAX_CHAT_ATTACHMENTS} 个文件`); break; }
      slots.current++;
      setUploading(count => count + 1);
      const id = nextAttachmentId();
      void props.onAttachFile(file).then(reply => {
        if (!current()) return;
        if (reply.ok) setAttachments(rows => [...rows, { id, ...reply.attachment }]);
        else { slots.current--; setUploadError(reply.message); }
      }).catch(() => {
        if (current()) { slots.current--; setUploadError("上传结果未确认，请核对后重新选择文件"); }
      }).finally(() => { if (current()) setUploading(count => count - 1); });
    }
  };
  const failed = launch?.phase === "refused" || launch?.phase === "failed";
  const runtimeDevice = props.advanced ? props.runtimeDevice || props.device : props.device;
  const runtime = props.placementDevices.find((row) => row.device === runtimeDevice);
  const execution = props.placementDevices.find((row) => row.device === props.device);
  const accounts = runtime?.codexAccounts ?? [];
  const selectedAccount = props.codexAccount ?? "";
  const models = codexModelsForDevice(runtime, { id: selectedAccount });
  const accountMissing = props.source === "codex" && Boolean(selectedAccount) && !accounts.some((account) => account.id === selectedAccount);
  const backend = runtime?.agentBackends?.find((row) => row.kind === props.source);
  const diagnostic = backend?.diagnosticCode ? DIAGNOSTIC_MESSAGES[backend.diagnosticCode] : undefined;
  const split = props.advanced && Boolean(runtimeDevice) && runtimeDevice !== props.device;
  const workspaceRows = props.workspaces[props.device]?.workspaces ?? [];
  const selectedWorkspace = workspaceRows.find((row) => row.id === props.workspaceId);
  const directoryProblem = accountMissing ? "所选 Codex 账号已不在当前注册中，请重新选择" : props.advanced ? "" : directoryHint(props.directory);
  const placementProblem = !props.advanced
    ? ""
    : !runtimeDevice || !props.device
      ? "请选择 Agent 运行机与执行机"
      : !runtime || !execution
        ? "设备资产尚未就绪；请刷新后重试"
        : runtime.online !== true || execution.online !== true
          ? "所选设备已经离线；请刷新资产"
          : backend?.available !== true
            ? diagnostic ? `${runtimeDevice} 的 ${cliKindLabel(props.source)}：${diagnostic}`
            : backend?.reason === "authentication_unavailable"
              ? `${runtimeDevice} 已安装 ${cliKindLabel(props.source)}，但没有可用登录态`
              : backend?.reason === "command_unavailable"
                ? `${runtimeDevice} 的 Runner 进程找不到 ${cliKindLabel(props.source)} 命令`
                : backend?.reason === "probe_failed"
                  ? `${runtimeDevice} 的 Runner 无法完成 ${cliKindLabel(props.source)} 版本探测`
                  : `${runtimeDevice} 没有可用的 ${cliKindLabel(props.source)} 后端`
            : split && backend.splitExecution !== true
              ? backend.splitExecutionReason === "local_tools_unfilterable"
                ? `${cliKindLabel(props.source)} 目前不能关闭运行机上的本地工具，不能安全分机`
                : `${runtimeDevice} 没有报告 ${cliKindLabel(props.source)} 的安全跨机器执行能力`
              : split && props.source === "codex" && execution.execution?.codexExecServer !== true
                ? `${props.device} 没有可用的 Codex exec-server`
                : execution.execution?.shell !== true || execution.execution?.workspaceFiles !== true
                  ? `${props.device} 没有报告命令和工作区文件能力`
                  : !selectedWorkspace
                    ? "请选择执行机上已登记的工作区"
                    : "";
  const ready = Boolean(props.device)
    && !directoryProblem
    && !placementProblem
    && Boolean(props.prompt.trim() || attachments.length)
    && uploading === 0
    && !locked;
  const id = (base: string): string => scopedDomId(base, props.domIdScope);
  const placementSummary = props.advanced && selectedWorkspace
    ? `${cliKindLabel(props.source)} @ ${runtimeDevice} → ${selectedWorkspace.label || selectedWorkspace.display} @ ${props.device}`
    : "";
  const choiceId = launchChoiceIdOf(props.source, props.translatePrompt);
  const choice = launchChoiceOf(choiceId);
  const modelLabel = modelChoices(props.source, props.model, models).find((row) => row.value === props.model)?.label
    ?? props.model;
  const accountLabel = props.source !== "codex"
    ? ""
    : selectedAccount
      ? accounts.find((account) => account.id === selectedAccount)?.label ?? selectedAccount
      : accounts.length ? "自动选择" : "";
  const where = props.advanced
    ? placementSummary || "跨机器放置（待选择）"
    : props.device && props.directory.trim()
      ? `${props.device} · ${props.directory.trim()}`
      : props.device || "（先选择设备和目录）";
  // The folded choices are summarised in the empty transcript, so a value
  // behind ⚙ is never a silent one.
  const settingsSummary = [
    choice.label,
    props.model ? modelLabel : "Runner 默认模型",
    `effort ${effort}`,
    accountLabel ? `账号 ${accountLabel}` : "",
    supportsManualPermissionProfile(props.source) && props.permissionProfile === AGENT_PERMISSION_PROFILES.manual
      ? "权限手动确认"
      : "",
  ].filter(Boolean).join(" · ");
  const start = (): void => {
    if (ready) props.onStart(attachments.length ? promptWithAttachments(props.prompt, attachments) : undefined);
  };
  const problem = directoryProblem || placementProblem;
  const safety = props.advanced
    ? props.source === "codex"
      ? `${placementSummary || "跨机器放置"}。Codex 的 shell/文件调用只经所选执行机的 exec-server；Agent 只看到无凭据 loopback MCP。服务端凭证绑定账户、两台设备、工作区和允许工具，最多存活 24 小时；同会话续跑逐轮重建通道，过期、服务端重启或撤销后失败关闭。`
      : `${placementSummary || "跨机器放置"}。Agent 只看到无凭据 loopback MCP；服务端凭证绑定账户、两台设备、工作区和允许工具，最多存活 24 小时。同会话续跑逐轮重建通道，过期、服务端重启或撤销后失败关闭。`
    : "目录决定新会话的起点，不是访问边界。CLI 以该设备上你的系统账号运行，能访问该账号可访问的一切。";

  const placementFields = props.advanced ? (
    <>
      <RunConfigField label="运行机" htmlFor={id("runtimeDevice")} hint="Agent 进程所在的物理机">
        <select
          id={id("runtimeDevice")}
          aria-label="Agent 运行机"
          data-av-new-session-control="runtime-device"
          value={runtimeDevice}
          disabled={locked}
          onChange={(event) => props.onRuntimeDevice(event.target.value)}
        >
          <option value="">选择运行机…</option>
          {props.placementDevices.map((row) => (
            <option value={row.device ?? ""} key={row.device}>
              {row.deviceLabel || row.device} · {row.online ? "在线" : "离线"}
            </option>
          ))}
        </select>
      </RunConfigField>
      <RunConfigField label="执行机" htmlFor={id("executionDevice")} hint="命令与工作区文件实际运行的物理机">
        <select
          id={id("executionDevice")}
          data-av-new-session-control="execution-device"
          value={props.device}
          disabled={locked}
          onChange={(event) => props.onDevice(event.target.value)}
        >
          <option value="">选择执行机…</option>
          {props.placementDevices.map((row) => (
            <option
              value={row.device ?? ""}
              key={row.device}
              disabled={row.execution?.shell !== true
                || row.execution?.workspaceFiles !== true
                || (props.source === "codex"
                  && Boolean(runtimeDevice)
                  && runtimeDevice !== row.device
                  && row.execution?.codexExecServer !== true)}
            >
              {row.deviceLabel || row.device} · {row.execution?.platform || "未知系统"} · {row.online ? "在线" : "离线"}
            </option>
          ))}
        </select>
      </RunConfigField>
      <RunConfigField label="工作区" htmlFor={id("newWorkspace")} hint="跨机器模式只接受执行机上已登记的工作区">
        <select
          id={id("newWorkspace")}
          aria-label="执行工作区"
          data-av-new-session-control="workspace"
          value={props.workspaceId}
          disabled={locked || !props.device}
          onChange={(event) => props.onWorkspace(event.target.value)}
        >
          <option value="">选择已登记工作区…</option>
          {workspaceRows.map((row) => (
            <option value={row.id} key={row.id}>{row.label} · {row.display}</option>
          ))}
        </select>
      </RunConfigField>
    </>
  ) : (
    <>
      <RunConfigField label="设备" htmlFor={id("newDevice")} hint="Agent、命令和工作区放在同一台设备">
        <AvInput
          id={id("newDevice")}
          data-av-new-session-control="device"
          list={id("deviceOptions")}
          value={props.device}
          disabled={locked}
          placeholder="端点名"
          onChange={(event) => props.onDevice(event.target.value)}
        />
        <datalist id={id("deviceOptions")}>
          {props.devices.map((value) => <option value={value} key={value} label={props.placementDevices.find((row) => row.device === value)?.deviceLabel} />)}
        </datalist>
      </RunConfigField>
      <RunConfigField
        label="目录"
        htmlFor={id("newDirectory")}
        hint={directoryProblem || "绝对路径，或 ~ / ~/…；目录不必事先登记。"}
        invalid={Boolean(props.directory) && Boolean(directoryProblem)}
        className="run-config-wide"
      >
        <AvInput
          id={id("newDirectory")}
          data-av-new-session-control="directory"
          value={props.directory}
          disabled={locked}
          aria-invalid={Boolean(props.directory) && Boolean(directoryProblem)}
          placeholder="/home/you/project 或 ~/project"
          onChange={(event) => props.onDirectory(event.target.value)}
        />
      </RunConfigField>
    </>
  );

  const configBar = (
    <RunConfigBar label="新 Agent 设置" className="new-session-config">
      {placementFields}
      <RunConfigField label="后端" htmlFor={id("newSource")}>
        <select
          id={id("newSource")}
          aria-label="Agent 后端"
          data-av-new-session-control="source"
          value={choiceId}
          disabled={locked}
          onChange={(event) => props.onSource(event.target.value as LaunchChoiceId)}
        >
          {LAUNCH_CHOICES.map((entry) => {
            // Availability is a fact about the provider, so both Claude lanes
            // read the same backend row: the translator runs on the Agent
            // machine beside Claude, and there is no separate backend to
            // report.
            const fact = runtime?.agentBackends?.find((row) => row.kind === entry.source);
            const unavailable = props.advanced && (
              fact?.available !== true || (split && fact.splitExecution !== true)
            );
            return (
              <option value={entry.id} key={entry.id} disabled={unavailable}>
                {entry.label}{unavailable ? " · 此放置不可用" : ""}
              </option>
            );
          })}
        </select>
      </RunConfigField>
      <RunConfigField label="模型" htmlFor={id("newModel")}>
        <ModelPicker
          id={id("newModel")}
          data-av-new-session-control="model"
          source={props.source}
          value={props.model}
          models={models}
          disabled={locked}
          onValue={props.onModel}
        />
      </RunConfigField>
      <RunConfigField label="Effort" htmlFor={id("newEffort")}>
        <EffortPicker
          id={id("newEffort")}
          data-av-new-session-control="effort"
          source={props.source}
          value={effort}
          disabled={locked}
          onValue={props.onEffort}
        />
      </RunConfigField>
    </RunConfigBar>
  );

  const accountField = props.source === "codex" && (accounts.length > 0 || selectedAccount) ? <div className="field">
    <span id={id("newCodexAccountLabel")}>Codex 账号 · {runtime?.deviceLabel || runtimeDevice}</span>
    <div role="radiogroup" aria-labelledby={id("newCodexAccountLabel")} className="codex-account-choices">
      <label>
        <input type="radio" name={id("newCodexAccount")} value="" checked={!selectedAccount} disabled={locked}
          onChange={() => props.onCodexAccount?.("")} />自动选择
      </label>
      {accounts.map((account) => <label key={account.id}>
        <input type="radio" name={id("newCodexAccount")} value={account.id} checked={selectedAccount === account.id} disabled={locked}
          onChange={() => props.onCodexAccount?.(account.id)} />
        <span>{account.label}</span>
        <AccountQuota quota={account.quota} offline={runtime?.online === false} />
        {runtime?.online === false ? <small>离线</small> : null}
      </label>)}
      {accountMissing ? <label><input type="radio" name={id("newCodexAccount")} value={selectedAccount} checked disabled />所选账号已不在当前注册中</label> : null}
    </div>
  </div> : null;

  const permissionField = (
    <AgentPermissionField
      id={id("newPermissionProfile")}
      label={`${cliKindLabel(props.source)} 权限`}
      value={props.permissionProfile}
      onChange={props.onPermissionProfile}
      allowManual={supportsManualPermissionProfile(props.source)}
      disabled={locked}
      hint={!supportsManualPermissionProfile(props.source)
        ? `${cliKindLabel(props.source)} 的托管通道没有审批界面，只能使用完整访问档。`
        : props.advanced && split
          ? "这个档位管理 Agent 决策；跨机器执行入口仍绑定所选执行机和工作区。"
          : props.permissionProfile === AGENT_PERMISSION_PROFILES.fullAccess
            ? `${cliKindLabel(props.source)} 不请求普通工具批准；Octopus 的操作 Gate 仍然生效。`
            : `${cliKindLabel(props.source)} 的普通工具权限请求会交给你确认。`}
    />
  );

  const placementControl = (
    <div className="field new-session-placement">
      <AvButton
        id={id("togglePlacement")}
        data-av-new-session-action="toggle-placement"
        disabled={locked}
        onClick={() => props.onAdvanced(!props.advanced)}
      >
        {props.advanced ? "返回自动放置" : "进阶放置"}
      </AvButton>
      <span className="small">
        {props.advanced
          ? "已打开：分别选择 Agent 运行机、执行机与一个已登记工作区"
          : "默认把 Agent、命令和工作区放在同一台设备"}
      </span>
      {props.advanced && runtime ? (
        <span className="small">
          Agent 资产：{(runtime.agentBackends ?? []).map((row) =>
            `${cliKindLabel(row.kind ?? "claude")} ${
              row.available ? row.version || "可用" : "不可用"
            }${split && row.available && row.splitExecution !== true ? "（不可分机）" : ""}`
          ).join(" · ") || "未报告"}
        </span>
      ) : null}
      {props.advanced ? (
        <span className="small">
          执行资产：命令 · 工作区文件
          {props.source === "codex"
            ? ` · Codex exec-server ${execution?.execution?.codexExecServer ? "可用" : "未报告"}`
            : ""}
          。所有调用只通过这台 Runner 的受限凭证。
          {workspaceRows.length
            ? " 跨机器模式不接受任意路径；工作区 id 由执行机解析，不向 Agent 机暴露真实路径。"
            : props.device ? " 这台设备尚未返回已登记工作区。" : " 先选择执行机。"}
        </span>
      ) : null}
    </div>
  );

  const moreOptions = (
    <details className="composer-options new-session-options" data-av-new-session-options>
      <summary aria-label="更多启动设置" title="更多启动设置">⚙</summary>
      <div className="composer-options-card" data-av-new-session-options-card>
        {accountField}
        {permissionField}
        {placementControl}
        <div className="safety">{safety}</div>
      </div>
    </details>
  );

  const uncertain = launch?.phase === "uncertain";
  const startLabel = uncertain ? "等待核对启动结果" : busy ? "启动中…" : "发送并启动 Agent";
  const startButton = (
    <AvButton
      className="primary"
      id={id("startSession")}
      data-av-new-session-action="start"
      aria-label={startLabel}
      title={ready ? "发送第一条消息并启动新的 Agent（⌘/Ctrl + Enter）" : problem || undefined}
      disabled={!ready}
      onClick={start}
    >
      {uncertain ? (compactLayout ? "待核对" : "等待核对启动结果") : busy ? "启动中…" : "发送"}
    </AvButton>
  );

  return (
    <div className="new-session-chat" data-av-new-session>
      <div className="detailhead new-session-head">
        <div className="title">
          <h2>启动新的本地 Agent</h2>
          <div className="meta">{where}</div>
        </div>
        <AvButton id={id("cancelNew")} data-av-new-session-action="cancel" onClick={props.onCancel}>取消</AvButton>
      </div>

      <div className="new-session-stage" data-av-new-session-stage>
        {launch ? (
          <div className="new-session-turn">
            {launch.prompt ? <div className="new-session-echo" data-av-new-session-echo>{launch.prompt}</div> : null}
            <div
              className={failed ? "launchnote err" : "launchnote"}
              data-launch-phase={launch.phase}
              role="status"
            >
              <span>
                {LAUNCH_NOTES[launch.phase]}
                {launch.message ? `：${launch.message}` : ""}
                {succeeded && placementSummary ? ` ${placementSummary}` : ""}
              </span>
              {launch.phase === "uncertain" && launch.prompt ? <details><summary>保留的启动指令</summary><pre>{launch.prompt}</pre></details> : null}
              {launch.phase !== "sending" && props.onDismissLaunch ? (
                <AvButton id={id("dismissLaunch")} onClick={props.onDismissLaunch}>知道了</AvButton>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="new-session-empty">
            <div className="new-session-empty-title">给新的 Agent 发第一条消息</div>
            <div className="small">发送即启动：{settingsSummary}</div>
            <div className="small">位置：{where}</div>
          </div>
        )}
        {choice.hint ? <div className="hint new-session-lane-hint">{choice.hint}</div> : null}
        {problem && (props.advanced || props.directory || props.prompt.trim()) ? (
          <div className="new-session-problem" role="alert">{problem}</div>
        ) : null}
      </div>

      <div className="command-pane new-session-command-pane">
        <div className={`composer${compactLayout ? " composer-compact" : ""}`}>
          <div className="chat-attachments" aria-live="polite">
            {attachments.map(item => <span className="chat-attachment" key={item.id}>
              <span className="chat-attachment-name">{item.label}</span>
              <AvButton aria-label={`移除附件 ${item.label}`} disabled={locked} onClick={() => {
                slots.current--; setAttachments(rows => rows.filter(row => row.id !== item.id));
              }}>×</AvButton>
            </span>)}
            {uploading > 0 ? <span role="status">正在上传 {uploading} 个文件…</span> : null}
            {uploadError ? <span className="chat-attachment-bad" role="alert">{uploadError}</span> : null}
          </div>
          <div className="composer-entry composer-entry-configured new-session-entry"
            onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
            onDrop={event => {
              if (event.dataTransfer.files.length) { event.preventDefault(); attachFiles(Array.from(event.dataTransfer.files)); }
            }}>
            <input ref={fileInput} type="file" multiple hidden aria-label="选择新 Agent 附件"
              onChange={event => { attachFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
            <div className="composer-input-shell">
              <AvTextArea
                id={id("newPrompt")}
                data-av-new-session-control="prompt"
                aria-label="第一条需求"
                disabled={locked}
                placeholder={locked
                  ? "Agent 启动中…"
                  : compactLayout
                    ? NEW_SESSION_PROMPT_PLACEHOLDER.compact
                    : NEW_SESSION_PROMPT_PLACEHOLDER.wide}
                // While the launch is in flight its words are the bubble
                // above; a refusal leaves the retained draft here again.
                value={locked ? "" : props.prompt}
                autoSize={compactLayout ? { minRows: 2, maxRows: 6 } : undefined}
                onChange={(event) => props.onPrompt(event.target.value)}
                onPaste={event => {
                  const files = filesFromItems(Array.from(event.clipboardData.items));
                  if (files.length) { event.preventDefault(); attachFiles(files); }
                }}
                // A launch is not a chat line: an early Enter on a phone would
                // start an Agent with half a brief (ticket #180's rule), so
                // only Ctrl/⌘+Enter or the send button submits here.
                onKeyDown={(event) => handleModifierSubmitKeyDown(event, start)}
              />
              {compactLayout ? moreOptions : null}
            </div>
            {configBar}
            {compactLayout ? null : moreOptions}
            {props.onAttachFile ? <AvButton className="chat-upload-button" aria-label="上传文件"
              disabled={locked || !props.device || slots.current >= MAX_CHAT_ATTACHMENTS || (props.advanced && !props.workspaceId)}
              onClick={() => fileInput.current?.click()}>＋ 附件</AvButton> : null}
            {startButton}
          </div>
        </div>
      </div>
    </div>
  );
}
