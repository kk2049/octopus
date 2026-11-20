import type { FeishuCapabilities } from "../feishu/gateway.js";
import { FEISHU_SLOT } from "../feishu/gateway.js";
import type { CloudDocumentProvider } from "./documents.js";
import { digest, object, text } from "./validation.js";

export function cloudResult(value: unknown): Record<string, unknown> {
  let result = object(value);
  if (result.isError === true) throw new Error("飞书文档操作被拒绝或执行失败");
  if (Array.isArray(result.content)) {
    const content = result.content.filter(item => item && typeof item === "object" && item.type === "text").map(item => item.text).join("\n");
    if (typeof content !== "string" || content.length > 600000) throw new Error("飞书返回内容超过边界");
    try { result = object(JSON.parse(content)); } catch { throw new Error("飞书未返回可核对的结构化文档结果"); }
  }
  if (result.code !== undefined && result.code !== 0) throw new Error(`飞书文档操作失败 (${String(result.code)})`);
  return object(result.data ?? result);
}
const DISABLED_TEXT_STYLES = new Set(["bold", "italic", "underline", "strikethrough", "inline_code"]);
/** Only an unstyled text paragraph can be replaced by the Markdown outline synchronizer. */
export function plainCloudBlock(value: unknown): { id: string; text: string; supported: boolean } {
  const block = object(value), body = block.text && typeof block.text === "object" ? object(block.text) : {};
  const elements = Array.isArray(body.elements) ? body.elements : [];
  const supported = block.block_type === 2 && elements.every(value => {
    const part = object(value), run = part.text_run ? object(part.text_run) : null;
    // The official TextElementStyle also serializes disabled boolean defaults as false.
    const style = run?.text_element_style;
    const unstyled = style === undefined || (style !== null && typeof style === "object" && !Array.isArray(style)
      && Object.entries(style).every(([key, value]) => DISABLED_TEXT_STYLES.has(key) && value === false));
    return Object.keys(part).every(key => key === "text_run") && run && typeof run.content === "string" && unstyled;
  });
  return { id: text(block.block_id, "云端文本块 ID", 160), text: elements.map(value => {
    const part = object(value); return part.text_run ? String(object(part.text_run).content ?? "") : "[非文本内容]";
  }).join(""), supported };
}
/** Reuses the OAuth-only Gateway. A bound task cannot supply credentials, owners or arbitrary tools. */
export class FeishuResearchDocuments implements CloudDocumentProvider {
  constructor(private readonly capabilities: FeishuCapabilities) {}
  private async call(owner: string, operation: string, args: Record<string, unknown>, current: () => void) {
    current();
    const grant = this.capabilities.open({ username: owner, purpose: "自动科研 v2 · 明确绑定的论文材料", kind: "controller-run", rights: [operation], autoAllow: [operation] });
    if (!grant) throw new Error("飞书账号或所需文档权限尚未连接");
    try {
      current();
      const response = await grant.capabilities.request(FEISHU_SLOT, operation, args);
      current();
      if (response.status !== "succeeded") throw new Error(response.status === "denied" ? response.reason : "飞书操作尚未确认，请核对文档；不会自动重发");
      return cloudResult(response.result);
    } finally { grant.close(); }
  }
  async read(owner: string, document: string, current: () => void) {
    current();
    const raw = await this.call(owner, "doc_read", { document_id: document }, current);
    current();
    const content = text(raw.content, "云文档正文", 196608, "");
    const meta = await this.call(owner, "doc_metadata_read", { document_id: document }, current);
    current();
    const revision = String(object(meta.document).revision_id ?? "");
    const page = await this.call(owner, "doc_blocks_list", { document_id: document, page_size: 100 }, current);
    current();
    const blocks = (Array.isArray(page.items) ? page.items : []).filter(value => object(value).block_type === 2).map(plainCloudBlock);
    // Reading the whole document and editing a selected plain-text block are separate scopes.
    return { text: content, revision, blocks };
  }
  async readBlock(owner: string, document: string, block: string, guard: () => void) {
    guard();
    const meta = await this.call(owner, "doc_metadata_read", { document_id: document }, guard);
    guard();
    const revision = Number(object(meta.document).revision_id);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("无法核对飞书文档版本");
    const answer = await this.call(owner, "doc_block_read", { document_id: document, block_id: block, revision }, guard);
    guard();
    const current = plainCloudBlock(answer.block);
    if (current.id !== block || !current.supported) throw new Error("同步仅支持明确选中的纯文本大纲块；富文本、图片和批注不会被自动改写");
    if (current.text.length > 20000) throw new Error("大纲块超过 20000 字符，请将完整论文与短大纲分开");
    return { text: current.text, digest: digest(current.text), revision };
  }
  async writeBlock(owner: string, document: string, block: string, value: string, expected: { digest: string; revision: number }, request: string, guard: () => void) {
    guard();
    const current = await this.readBlock(owner, document, block, guard);
    guard();
    if (current.digest !== expected.digest || current.revision !== expected.revision) throw new Error("云端文档已变化，未覆盖；请重新比较");
    text(value, "中文大纲", 20000, "");
    cloudResult(await this.capabilities.approvedOutlineWrite(owner, { document_id: document, block_id: block, revision: expected.revision, text: value, client_token: digest([owner, request]).slice(0, 32) }, guard));
    guard();
  }
}
