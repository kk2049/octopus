import { useState } from "react";
import type { RunnerCapabilityView } from "../contract.js";
import { useDashboardLanguage } from "../i18n/react.js";
import { uiText } from "../i18n/ui-text.js";
import { UiInput } from "../ui-kit/primitives.js";
import styles from "./RunnerCapabilities.module.css";

export function RunnerCapabilities({ capabilities, online, hotRegistration }: {
  capabilities?: RunnerCapabilityView[]; online: boolean; hotRegistration: boolean;
}) {
  useDashboardLanguage();
  const [query, setQuery] = useState("");
  const rows = capabilities?.filter(row => [row.id, row.title, ...row.tools.map(tool => tool.name)].some(text => text.toLowerCase().includes(query.toLowerCase())));
  const label = (row: RunnerCapabilityView) => row.kind === "extension" ? row.title : ({
    sessions: uiText("会话发现"), "session-operations": uiText("会话任务"), shell: uiText("命令执行"),
    files: uiText("工作区文件"), "file-transfer": uiText("文件传输"), "workspace-jobs": uiText("工作区作业"),
    "workspace-development": uiText("开发工作区"), "knowledge-index": uiText("知识索引"),
    "meeting-transcription": uiText("录音转写"), "local-mcp": uiText("本机 MCP 接入"), gui: uiText("屏幕操作"),
  }[row.id] ?? row.id);
  const status = (state: RunnerCapabilityView["status"]) => ({
    ready: uiText("可用"), loading: uiText("加载中"), disabled: uiText("禁用"), error: uiText("异常"), unavailable: uiText("不可用"),
  }[state]);
  return <details className={styles.root}>
    <summary>{uiText("Runner 能力")} · {capabilities?.filter(row => row.status === "ready").length ?? "—"}</summary>
    {!online ? <p>{uiText("设备离线，当前能力不可调用。")}</p> : null}
    {!capabilities ? <p>{uiText("尚未收到能力目录。")}</p> : <>
      <p className="muted">{uiText("目录来自设备上报；发现能力不等于获得调用授权。")}</p>
      <UiInput aria-label={uiText("搜索能力")} placeholder={uiText("搜索能力")} value={query} onChange={event => setQuery(event.target.value)} />
      <div className={styles.rows}>{rows?.map(row => <details key={row.kind + ":" + row.id} className={styles.provider}>
        <summary>{label(row)} <span className="muted">{row.kind === "builtin" ? uiText("内建") : uiText("扩展")} · {online ? status(row.status) : uiText("离线")}
          {row.version ? " · " + row.version : ""}{row.tools.length ? " · " + row.tools.length : ""}</span></summary>
        <p><code>{row.id}</code>{row.protocol ? " · " + row.protocol : ""}{row.reason ? " · " + row.reason : ""}</p>
        {row.revision ? <p>{uiText("接口版本")} <code>{row.revision}</code></p> : null}
        {row.kind === "builtin" ? <p className="muted">{uiText("通过对应功能和已有授权入口使用。")}</p> :
          <p className="muted">{uiText("通过 MCP 的 runner_capability_list、describe、call 发现和调用；在权限中心单独授权。")}</p>}
        {row.tools.map(tool => <details key={tool.name} className={styles.tool}>
          <summary><code>{tool.name}</code></summary>
          <p>{tool.description}</p>
          <pre>{JSON.stringify({ inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}) }, null, 2)}</pre>
        </details>)}
      </details>)}</div>
      {rows?.length === 0 ? <p>{uiText("没有匹配的能力。")}</p> : null}
    </>}
    <p className="muted">{hotRegistration ? uiText("支持不停机注册。设备本机使用 capabilities register；更新和停用不会重启 Runner。") : uiText("此设备尚未上报热注册支持。")}</p>
    {hotRegistration ? <code>octopus-runner capabilities list</code> : null}
  </details>;
}
