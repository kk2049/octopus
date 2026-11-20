/** Strictly recognised Feishu/Lark document links; never a general URL opener. */

export const FEISHU_DOCUMENT_RESOURCE_KIND = "feishu-document";
export const FEISHU_DOCUMENT_KINDS = Object.freeze([
  "docx", "docs", "wiki", "sheets", "base", "file", "mindnotes", "slides",
] as const);
export type FeishuDocumentKind = (typeof FEISHU_DOCUMENT_KINDS)[number];

export interface FeishuDocumentLink {
  /** Canonical HTTPS origin + path. Queries/fragments are deliberately dropped. */
  url: string;
  host: string;
  kind: FeishuDocumentKind;
  token: string;
}

const TOKEN = /^[A-Za-z0-9_-]{6,160}$/;
const MAX_RESOURCE_REF = 200;

function acceptedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host.endsWith(".feishu.cn") || host.endsWith(".larksuite.com");
}

export function readFeishuDocumentLink(value: string): FeishuDocumentLink | null {
  const authored = String(value ?? "").trim();
  if (!authored || authored.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(authored);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password || !acceptedHost(parsed.hostname)) {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const kind = segments[0] as FeishuDocumentKind | undefined;
  const token = segments[1] ?? "";
  if (!kind || !FEISHU_DOCUMENT_KINDS.includes(kind) || segments.length !== 2 || !TOKEN.test(token)) return null;
  // Only the origin and document locator define the resource. Dropping query
  // and fragment avoids tracking/referrer values becoming Dock identity.
  const url = `https://${parsed.hostname.toLowerCase()}/${kind}/${token}`;
  if (url.length > MAX_RESOURCE_REF) return null;
  return { url, host: parsed.hostname.toLowerCase(), kind, token };
}

export function feishuDocumentLabel(link: FeishuDocumentLink, authoredLabel = ""): string {
  const label = authoredLabel.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (label && label !== link.url && label.length <= 120) return label;
  const kind = {
    docx: "飞书文档", docs: "飞书文档", wiki: "飞书 Wiki", sheets: "飞书表格",
    base: "飞书多维表格", file: "飞书文件", mindnotes: "飞书思维笔记", slides: "飞书幻灯片",
  }[link.kind];
  return `${kind} · ${link.token.slice(0, 10)}`;
}
