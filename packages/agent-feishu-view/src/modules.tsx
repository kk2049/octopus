import { useState } from "react";
import type { ModuleProps, ModuleRegistryEntry } from "@claude-bot/agent-view-react/workspace";
import { FEISHU_DOCUMENT_MANIFEST } from "./manifests.js";
import { feishuDocumentLabel, readFeishuDocumentLink } from "./links.js";

export function FeishuDocumentModule({ panel }: ModuleProps) {
  const link = panel.resourceRef ? readFeishuDocumentLink(panel.resourceRef) : null;
  const [copied, setCopied] = useState(false);
  if (!link) {
    return <div className="fv-empty" role="note">这个标签页没有合法的飞书文档链接。</div>;
  }
  const copy = (): void => {
    setCopied(false);
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    void clipboard.writeText(link.url).then(() => setCopied(true), () => setCopied(false));
  };
  return (
    <article className="fv-document" data-feishu-document={link.kind}>
      <header>
        <span className="fv-mark" aria-hidden="true">飞</span>
        <div>
          <h2>{feishuDocumentLabel(link, panel.label)}</h2>
          <p>{link.host} · {link.kind}</p>
        </div>
      </header>
      <section className="fv-safe" aria-label="飞书文档安全预览">
        <p>文档已作为独立 Dock 资源打开。</p>
        <p>
          当前 App View 不持有飞书凭据，也不允许第三方脚本联网；因此不会把会话正文暴露给飞书页面。
          如需让 Agent 读取正文，仍由 Octopus 的用户 OAuth 网关执行，租户 Bot 不会代替你的身份。
        </p>
      </section>
      <label className="fv-link-label" htmlFor={`fv-link-${panel.panelId}`}>规范链接</label>
      <div className="fv-link-row">
        <input id={`fv-link-${panel.panelId}`} value={link.url} readOnly aria-label="飞书文档链接" />
        <button type="button" onClick={copy}>{copied ? "已复制" : "复制链接"}</button>
      </div>
    </article>
  );
}

export const FEISHU_DOCUMENT_MODULE: ModuleRegistryEntry = Object.freeze({
  manifest: FEISHU_DOCUMENT_MANIFEST,
  component: FeishuDocumentModule,
});
export const FEISHU_MODULES: readonly ModuleRegistryEntry[] = Object.freeze([FEISHU_DOCUMENT_MODULE]);
