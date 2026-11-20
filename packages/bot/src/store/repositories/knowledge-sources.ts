import type Database from "better-sqlite3";
import { confirmationEvent, parseCliSource, sourceHash, type CliSource, type CliSourceSummary, type SourceDraft } from "../../knowledge/source-workflow.js";
import type { KnowledgeEvidenceEvent } from "../../knowledge/provenance.js";

/** Private imports are observations, never proof of authorship. Only a separate browser input can be human evidence. */
export class KnowledgeSourcesRepository {
  constructor(private readonly db: Database.Database) {}
  saveDraft(ticketId: number, draft: SourceDraft): void {
    this.db.prepare(`INSERT INTO knowledge_source_drafts(ticket_id, source_ref, source_sha256, record, updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(ticket_id,source_ref) DO UPDATE SET source_sha256=excluded.source_sha256,record=excluded.record,updated_at=excluded.updated_at`)
      .run(ticketId, draft.ref, draft.source_sha256, JSON.stringify(draft), new Date().toISOString());
  }
  saveDrafts(ticketId: number, drafts: SourceDraft[]): void {
    this.db.transaction(() => { for (const draft of drafts) this.saveDraft(ticketId,draft); })();
  }
  drafts(ticketId: number): SourceDraft[] {
    return (this.db.prepare("SELECT record FROM knowledge_source_drafts WHERE ticket_id=? ORDER BY source_ref").all(ticketId) as Array<{record: string}>).map(r => JSON.parse(r.record) as SourceDraft);
  }
  import(owner: string, raw: unknown): CliSource {
    if (!owner) throw new Error("需要命名用户");
    const input = parseCliSource(raw);
    const id = `ks_${sourceHash(JSON.stringify([owner,input.provider,input.device,input.session_id,input.message_id])).slice(0,32)}`;
    return this.db.transaction(() => {
      const prior = this.read(owner,id);
      if (prior) {
        if (JSON.stringify([prior.text,prior.role,prior.source_at]) !== JSON.stringify([input.text,input.role,input.source_at])) throw new Error("同一来源身份已有不同内容；拒绝覆盖原始字节");
        return prior;
      }
      const count = (this.db.prepare("SELECT count(*) AS n FROM knowledge_cli_sources WHERE owner=?").get(owner) as {n:number}).n;
      if (count >= 2000) throw new Error("本人来源条目已达 2000 条上限");
      const source: CliSource = { ...input, id, owner, source_sha256: sourceHash(input.text), imported_at: new Date().toISOString(), trust: "local_import" };
      this.db.prepare("INSERT INTO knowledge_cli_sources(id,owner,record) VALUES(?,?,?)").run(id, owner, JSON.stringify(source));
      return source;
    })();
  }
  read(owner: string, id: string): CliSource | null {
    const row = this.db.prepare("SELECT record FROM knowledge_cli_sources WHERE owner=? AND id=?").get(owner,id) as {record:string}|undefined;
    return row ? JSON.parse(row.record) as CliSource : null;
  }
  list(owner: string, after = "", limit = 20): { sources: CliSourceSummary[]; next_after: string | null } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("来源分页参数无效");
    const size = limit;
    const rows = this.db.prepare("SELECT record FROM knowledge_cli_sources WHERE owner=? AND id>? ORDER BY id LIMIT ?").all(owner,after,size+1) as Array<{record:string}>;
    const sources = rows.slice(0,size).map(row => {
      const {text: _text,...source} = JSON.parse(row.record) as CliSource;
      return { ...source, confirmations: this.confirmations(owner,source.id) };
    });
    return { sources, next_after: rows.length > size ? sources.at(-1)!.id : null };
  }
  confirmations(owner: string,id: string): KnowledgeEvidenceEvent[] {
    return (this.db.prepare("SELECT event FROM knowledge_cli_confirmations WHERE owner=? AND source_id=? ORDER BY id").all(owner,id) as Array<{event:string}>).map(r => JSON.parse(r.event) as KnowledgeEvidenceEvent);
  }
  /** Caller must establish an authenticated owner browser session; MCP never calls this method. */
  confirm(owner: string,id: string,expectedHash: string,kind: "requirement"|"endorsement",statement: string): KnowledgeEvidenceEvent {
    return this.db.transaction(() => {
      const source = this.read(owner,id);
      if (!source || source.source_sha256 !== expectedHash) throw new Error("来源不存在、不可访问或内容已变更");
      if (source.role !== "user") throw new Error("Agent 消息不能被追认为人类来源；请从真实的人类输入建立要求");
      if (kind !== "requirement" && kind !== "endorsement") throw new Error("确认类型无效");
      const confirmationId = sourceHash(JSON.stringify([id,kind,statement])).slice(0,32);
      const ref = `knowledge-source:${id}#confirmation:${confirmationId}`;
      const old = this.evidence(owner,ref);
      if (old) return old;
      const event = confirmationEvent({ ref,owner,at:new Date().toISOString(),kind,statement });
      if (this.confirmations(owner,id).length >= 20) throw new Error("单条来源最多 20 条明确确认");
      this.db.prepare("INSERT INTO knowledge_cli_confirmations(id,owner,source_id,event) VALUES(?,?,?,?)").run(confirmationId,owner,id,JSON.stringify(event));
      return event;
    })();
  }
  evidence(owner: string,ref: string): KnowledgeEvidenceEvent | null {
    const match = /^knowledge-source:(ks_[0-9a-f]{32})#confirmation:([0-9a-f]{32})$/u.exec(ref);
    if (!match || !owner) return null;
    const row = this.db.prepare("SELECT event FROM knowledge_cli_confirmations WHERE owner=? AND source_id=? AND id=?").get(owner,match[1],match[2]) as {event:string}|undefined;
    return row ? JSON.parse(row.event) as KnowledgeEvidenceEvent : null;
  }
}
