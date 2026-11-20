/** Published documents implement the existing workspace-files port, never a filesystem proxy. */
import { createResourceStream } from '@claude-bot/resource-stream-contract';
import { base64ByteLength, WORKSPACE_MEDIA_CHUNK_PAYLOAD, type WorkspaceMediaPort } from '@claude-bot/workspace-files-contract';
import { WORKSPACE_FILES_CONTRACT, WORKSPACE_FILES_LIMITS, WORKSPACE_TEXT_CHUNK_PAYLOAD, WORKSPACE_TEXT_MEDIA_TYPE, WORKSPACE_DOWNLOAD_CHUNK_PAYLOAD, WORKSPACE_DOWNLOAD_MEDIA_TYPE, workspaceFilesRefusal, type WorkspaceFilesPort, type WorkspaceDownloadPort, type WorkspaceTextChunk, type WorkspaceFilesEntry } from '@claude-bot/workspace-files-contract';
import { normalizedPath, rows, type DocumentRow, type ResearchProjection } from './model.js';
import { readSourceChunks, type Propose } from './source-reader.js';
const ROOT = 'research-documents';
export function researchDocumentContext(document: DocumentRow | undefined) {
  if (!document?.path) return null;
  return { rootRef: ROOT, labels: normalizedPath(document.path).replace(/^\//, '').split('/') };
}
const encoder = new TextEncoder();
function byteStream(bytes: Uint8Array, digest: string, payload: string, mediaType: string) {
  let offset = 0;
  return createResourceStream<{ offset: number; bytes: number; data: string }>({ metadata: { payload, mediaType, totalBytes: bytes.length, digest }, async pull() {
    if (offset >= bytes.length) return { kind: 'end' };
    const part = bytes.slice(offset, offset + 24000); offset += part.length;
    let binary = ''; for (const byte of part) binary += String.fromCharCode(byte);
    return { kind: 'chunk', value: { offset: offset - part.length, bytes: part.length, data: btoa(binary) }, bytes: part.length };
  }, close() {} }, { maxChunkBytes: WORKSPACE_FILES_LIMITS.textChunkBytes, maxStreamBytes: WORKSPACE_FILES_LIMITS.maxTextBytes });
}
export function createResearchDocumentsAdapter(current: () => ResearchProjection, propose: Propose): WorkspaceFilesPort & WorkspaceDownloadPort & WorkspaceMediaPort {
  const documents = () => rows<DocumentRow>(current().documents).filter(row => !row.hidden);
  const path = (doc: DocumentRow) => normalizedPath(doc.path ?? doc.title ?? doc.key ?? '').replace(/^\//, '');
  const folders = new Map<string, string>([[ROOT, '']]);
  const entries = (prefix: string): WorkspaceFilesEntry[] => {
    const out = new Map<string, WorkspaceFilesEntry>();
    for (const doc of documents()) {
      const full = path(doc); if (!full.startsWith(prefix) || !doc.key) continue;
      const rest = full.slice(prefix.length), slash = rest.indexOf('/');
      if (slash < 0) out.set(rest, { ref: doc.key, label: rest, kind: 'file' });
      else { const label = rest.slice(0, slash), folder = `${prefix}${label}/`, ref = `research-directory:${encodeURIComponent(folder)}`; folders.set(ref, folder); out.set(label, { ref, label, kind: 'directory' }); }
    }
    return [...out.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
  };
  async function read(ref: string) {
    const doc = documents().find(row => row.key === ref);
    if (!doc) throw new Error('这份文档不在当前项目中。');
    const source = current().sources?.[ref];
    let text = doc.body ?? '';
    if (source) {
      if (source.next !== source.total) throw new Error(`文档正在同步（${source.next}/${source.total}）；完成后重新读取。`);
      const chunks = await readSourceChunks(source, 0, source.total, propose);
      text = chunks.map(chunk => chunk.payload).join('');
      if (text.length !== source.total) throw new Error('文档分段不完整，请重新读取。');
      if (current().sources?.[ref]?.generation !== source.generation) throw new Error('文档来源已更新，请重新读取。');
    } else if (doc.body_in_history || !text && doc.updated_seq) {
      const reply = await propose('research_read_history', { document: ref, after_seq: String(Math.max(0, (doc.updated_seq ?? doc.first_published_seq ?? 1) - 1)) });
      if (!reply.ok) throw new Error(reply.message || '文档读取被拒绝。');
      const result = reply.result as { events?: Array<{ data?: { document_key?: string; body?: string } }> };
      const event = result.events?.find(row => row.data?.document_key === ref);
      if (!event || typeof event.data?.body !== 'string') throw new Error('未读到完整文档正文。');
      text = event.data.body;
    }
    const png = source?.encoding === 'png-base64';
    let bytes: Uint8Array = encoder.encode(text);
    if (png) {
      const length = base64ByteLength(text);
      if (length === null) throw new Error('PNG 来源编码无效。');
      bytes = Uint8Array.from(atob(text), char => char.charCodeAt(0));
      if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) throw new Error('PNG 来源签名无效。');
    }
    const sizeBytes = bytes.length;
    const digest = !png && source ? source.generation : Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), byte => byte.toString(16).padStart(2, '0')).join('');
    return { text, bytes, document: { ref, label: path(doc).split('/').at(-1) || doc.title || ref, mediaType: png ? 'image/png' : 'text/plain', sizeBytes, digest: `sha256:${digest}`, ...(doc.updated_at ? { modifiedAt: doc.updated_at } : {}) } };
  }
  const fail = (error: unknown) => workspaceFilesRefusal('unavailable', error instanceof Error ? error.message : '文档读取未完成。');
  return {
    contract: WORKSPACE_FILES_CONTRACT,
    async refreshRoots() { return { ok: true, value: { roots: [{ ref: ROOT, label: current().project?.title ?? '项目文档', sourceLabel: '已绑定文档' }], truncated: false } }; },
    async listDirectory(ref) {
      const prefix = folders.get(ref); if (prefix === undefined) return workspaceFilesRefusal('unknown_ref', '目录不在当前项目的文档索引中。');
      return { ok: true, value: { ref, label: prefix || '项目文档', entries: entries(prefix), truncated: false } };
    },
    async resolvePath(ref, labels) {
      const prefix = folders.get(ref); if (prefix === undefined) return workspaceFilesRefusal('unknown_ref', '目录不在当前项目中。');
      const segments = prefix.split('/').filter(Boolean);
      for (const label of labels) {
        if (label === '..') { if (!segments.length) return workspaceFilesRefusal('not_found', '链接超出已发布文档根目录。'); segments.pop(); }
        else if (label !== '.') segments.push(label);
      }
      const wanted = segments.join('/');
      const matches = documents().filter(doc => path(doc) === wanted);
      if (matches.length !== 1 || !matches[0]?.key) return workspaceFilesRefusal('not_found', '没有唯一匹配的已绑定文档。');
      const doc = matches[0];
      return { ok: true, value: { base: ref, path: labels.join('/'), ref: doc.key!, label: path(doc).split('/').at(-1)!, kind: 'file' } };
    },
    async openText(ref) {
      if (current().sources?.[ref]?.encoding === 'png-base64') return workspaceFilesRefusal('not_text', '这份来源是 PNG 图表，请打开媒体预览。');
      try {
        const { text, document } = await read(ref);
        let offset = 0;
        const stream = createResourceStream<WorkspaceTextChunk>({ metadata: { payload: WORKSPACE_TEXT_CHUNK_PAYLOAD, mediaType: WORKSPACE_TEXT_MEDIA_TYPE, totalBytes: document.sizeBytes, digest: document.digest }, async pull() {
          if (offset >= text.length) return { kind: 'end' };
          let end = Math.min(text.length, offset + 32000);
          if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
          const part = text.slice(offset, end); offset = end;
          return { kind: 'chunk', value: { text: part }, bytes: encoder.encode(part).length };
        }, close() {} }, { maxChunkBytes: WORKSPACE_FILES_LIMITS.textChunkBytes, maxStreamBytes: WORKSPACE_FILES_LIMITS.maxTextBytes });
        return { ok: true, value: { document, stream } };
      } catch (error) { return fail(error); }
    },
    async openMedia(ref) {
      if (current().sources?.[ref]?.encoding !== 'png-base64') return { ok: false, code: 'unsupported_media', message: '这份来源不是已绑定的 PNG 图表。' };
      try {
        const file = await read(ref);
        const document = { ...file.document, mediaType: 'image/png' as const };
        return { ok: true, value: { document, stream: byteStream(file.bytes, document.digest, WORKSPACE_MEDIA_CHUNK_PAYLOAD, document.mediaType) } };
      } catch (error) { return fail(error); }
    },
    async downloadFile(ref) {
      try {
        const file = await read(ref), bytes = file.bytes;
        const document = { ...file.document, mediaType: WORKSPACE_DOWNLOAD_MEDIA_TYPE as typeof WORKSPACE_DOWNLOAD_MEDIA_TYPE };
        const stream = byteStream(bytes, document.digest, WORKSPACE_DOWNLOAD_CHUNK_PAYLOAD, WORKSPACE_DOWNLOAD_MEDIA_TYPE);
        return { ok: true, value: { document, stream } };
      } catch (error) { return fail(error); }
    },
  };
}
