import type { ProposalReply } from '@claude-bot/agent-view-react';
import type { SourceRow } from './model.js';

export type Propose = (action: string, params?: Record<string, string>) => Promise<ProposalReply>;
interface Chunk { seq: number; offset: number; count: number; payload: string; fragment_offset?: number; fragment_total?: number }
/** Read exactly the indexed chunks; unrelated stream events never become blank UI pages. */
export async function readSourceChunks(source: SourceRow, start: number, end: number, propose: Propose): Promise<Chunk[]> {
  const needed = source.ranges.filter(([, offset, count]) => offset < end && offset + count > start);
  const found = new Map<number, Chunk>();
  for (const [seq] of needed) {
    if (found.has(seq)) continue;
    const reply = await propose('research_read_source', { source_key: source.source_key, generation: source.generation, after_seq: String(seq - 1) });
    if (!reply.ok) throw new Error(reply.message || '来源读取被拒绝，请重读项目后重试。');
    const result = reply.result as { chunks?: Chunk[] } | undefined;
    for (const chunk of result?.chunks ?? []) if (needed.some(([wanted]) => wanted === chunk.seq)) found.set(chunk.seq, chunk);
    if (!found.has(seq)) throw new Error('来源分段未返回；保留当前位置，请重新读取。');
  }
  const result: Chunk[] = [];
  let partial: Chunk | undefined;
  for (const [seq] of needed) {
    const chunk = found.get(seq)!;
    if (chunk.fragment_total === undefined) {
      if (partial) throw new Error('长消息来源缺少后续分段。');
      result.push(chunk); continue;
    }
    if (!Number.isSafeInteger(chunk.fragment_total) || chunk.fragment_total < 1 || chunk.fragment_total > 4_194_304) throw new Error('长消息来源长度无效。');
    if (chunk.fragment_offset === 0) {
      if (partial) throw new Error('长消息来源分段重复。');
      partial = { ...chunk, count: 1 };
    } else {
      if (!partial || partial.offset !== chunk.offset || partial.fragment_total !== chunk.fragment_total || partial.payload.length !== chunk.fragment_offset) throw new Error('长消息来源分段不连续。');
      partial.payload += chunk.payload;
    }
    if (partial.payload.length > chunk.fragment_total) throw new Error('长消息来源超过声明长度。');
    if (partial.payload.length === chunk.fragment_total) {
      const messages = JSON.parse(partial.payload);
      if (!Array.isArray(messages) || messages.length !== 1 || !['user', 'assistant', 'system'].includes(messages[0]?.role) || !Array.isArray(messages[0]?.blocks) || messages[0].blocks.some((block: any) => !block || !['text', 'thinking', 'tool'].includes(block.type) || ['text', 'input', 'output', 'tool'].some(field => block[field] !== undefined && block[field] !== null && typeof block[field] !== 'string'))) throw new Error('长消息来源不是完整的原生会话消息。');
      result.push(partial); partial = undefined;
    }
  }
  if (partial) throw new Error('长消息来源尚未完整。');
  return result;
}
