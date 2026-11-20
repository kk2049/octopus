import type { Store } from "../store/store.js";
import { isNonPersonActor } from "../store/repositories/dev-tickets.js";
import type { KnowledgeSpecification } from "../knowledge/specifications.js";
import { knowledgeDesignKey } from "../knowledge/provenance.js";
import { parseSourceDraft, sourceHash, type SourceIdentity, type SourcePage, type KnowledgeNextAction } from "../knowledge/source-workflow.js";

/**
 * Human sources only. Review 6.10: a ticket or message known to be written
 * through a token, MCP or the Head is not one — it carries the requester's
 * name, not their typing — so it is neither listed for mapping nor citable as
 * human evidence (`originalEvidenceSource` classifies it as an agent message).
 */
function ticketSources(store: Store,ticketId: number): Array<SourceIdentity & { sequence: number; body: string }> {
  const ticket = store.devTickets.getDevTicket(ticketId);
  if (!ticket || ticket.kind === "cli") return [];
  const identity = (ref: string,actor: string,at: string,body: string,sequence: number,source_kind: SourceIdentity["source_kind"]) => ({ref,actor,at,body,sequence,source_kind,source_sha256:sourceHash(body)});
  return [...(isNonPersonActor(ticket.actor_kind) ? [] : [identity(`ticket:${ticketId}`,ticket.requester,ticket.created_at,ticket.body,0,"original_prompt")]),
    ...store.devTickets.listTicketMessages(ticketId).filter((m,index) => !(index===0 && m.author===ticket.requester && m.body===ticket.body)).filter(m => ["web","feishu"].includes(m.via) && !isNonPersonActor(m.actor_kind))
      .map(m => identity(`ticket:${ticketId}#message:${m.id}`,m.author,m.created_at,m.body,m.id,"human_message"))];
}
/** Oldest outstanding identities, never just the last eight messages. Read cursors don't acknowledge sources. */
export function ticketSourcePage(store: Store,ticketId: number,after = -1,limit = 10,specs: readonly KnowledgeSpecification[] = []): SourcePage {
  if (!Number.isSafeInteger(after) || after < -1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("来源分页参数无效");
  const drafts = new Map(store.knowledgeSources.drafts(ticketId).map(d => [d.ref,d]));
  const covered = new Set(specs.flatMap(s => s.provenance.events.map(e => `${e.ref}:${e.source_sha256}`)));
  const outstanding = ticketSources(store,ticketId).filter(s => drafts.get(s.ref)?.source_sha256 !== s.source_sha256 && !covered.has(`${s.ref}:${s.source_sha256}`));
  const page = outstanding.filter(s => s.sequence > after).slice(0,limit+1);
  const sources = page.slice(0,limit).map(({body:_body,sequence:_sequence,...s}) => s);
  return {sources,pending:outstanding.length,next_after:page.length>limit?page[limit-1].sequence:null,
    knowledge_next_actions:sources.map(s => ({reason:drafts.has(s.ref)?"source_changed":"unaccounted_human_source",source_ref:s.ref,next_action:"调用 devpipe_sources 读取原文并分类；要求映射规格，其余说明不纳入的理由。"}))};
}
/** Characters of one source a single read returns; `next_offset` continues it, and the hash always covers the whole body. */
export const SOURCE_WINDOW_CHARS = 24_000;
function sourceWindowEnd(body: string,offset: number): number {
  let end = Math.min(body.length,offset+SOURCE_WINDOW_CHARS);
  // Never split a surrogate pair between two windows.
  if (end < body.length && end > offset+1) { const code = body.charCodeAt(end-1); if (code >= 0xd800 && code <= 0xdbff) end -= 1; }
  return end;
}
export function processTicketSources(store: Store,ticketId: number,input: Record<string,unknown>): unknown {
  const sources = ticketSources(store,ticketId);
  if (input.items !== undefined) {
    if (!Array.isArray(input.items) || input.items.length > 20) throw new Error("每次最多处理 20 条来源");
    // Validate the entire batch before writing any draft.
    const drafts = input.items.map(parseSourceDraft);
    for (const d of drafts) if (!sources.some(s => s.ref===d.ref && s.source_sha256===d.source_sha256)) throw new Error("来源不属于本票或 hash 已变化；重新读取原文");
    store.knowledgeSources.saveDrafts(ticketId,drafts);
  }
  if (input.read_ref !== undefined) {
    const source = sources.find(s => s.ref === input.read_ref);
    if (!source) throw new Error("来源不属于本票");
    const {sequence:_sequence,body,...result} = source;
    const offset = input.offset === undefined ? 0 : Number(input.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > body.length) throw new Error("offset 无效：请用上一次返回的 next_offset");
    const end = sourceWindowEnd(body,offset);
    return {ok:true,source:{...result,body:body.slice(offset,end),offset,total_chars:body.length,...(end<body.length?{next_offset:end}:{})}};
  }
  return {ok:true,...ticketSourcePage(store,ticketId,input.after===undefined?-1:Number(input.after),input.limit===undefined?10:Number(input.limit))};
}
export function sourceCoverage(store: Store,ticketId: number,specs: readonly KnowledgeSpecification[]): {pending:number; knowledge_next_actions:KnowledgeNextAction[]} {
  const page = ticketSourcePage(store,ticketId,-1,10,specs);
  const current = new Map(ticketSources(store,ticketId).map(s => [s.ref,s.source_sha256]));
  // Earlier completed landings already discharged their mappings; prepared/aborted rows do not.
  const previous = store.knowledge.listLandings(ticketId).filter(row => row.status === "landed")
    .flatMap(row => (JSON.parse(row.knowledge_json) as {specifications?: KnowledgeSpecification[]}).specifications ?? []);
  const statements = new Set([...specs,...previous].map(s => knowledgeDesignKey(s.statement)));
  const unmapped = store.knowledgeSources.drafts(ticketId).filter(d => current.get(d.ref)===d.source_sha256 && d.statements.some(s=>!statements.has(knowledgeDesignKey(s))))
    .map(d => ({reason:"unmapped_requirement" as const,source_ref:d.ref,next_action:"已记录的要求/约束/修正没有完整映射到本次 specifications；补齐规格或依据当前原文修正分类。"}));
  return {pending:page.pending+unmapped.length,knowledge_next_actions:[...unmapped,...page.knowledge_next_actions].slice(0,20)};
}
export function sourcePromptReminder(store: Store,ticketId: number): string {
  const pending = ticketSourcePage(store,ticketId).pending;
  return pending ? `知识回流提醒：本票还有 ${pending} 条人类来源未记录处理结果。定位路径后 devpipe_context 会给出来源身份；用 devpipe_sources 按原文分类和映射，问题/背景可说明理由后排除，不把普通确认升级成人类背书。` : "";
}
