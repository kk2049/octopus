import type Database from "better-sqlite3";
import { parseRepairIdentity, type RepairIdentity, type RepairObservation, type RepairRecord, type RepairEntry } from "../../knowledge/repairs.js";
import { parseKnowledgeChanges } from "../../knowledge/changes.js";
import { sourceHash } from "../../knowledge/source-workflow.js";

export class KnowledgeRepairsRepository {
  constructor(private readonly db:Database.Database) {}
  get(id:string): RepairRecord|null {
    const row=this.db.prepare("SELECT record FROM knowledge_repairs WHERE id=?").get(id) as {record:string}|undefined;
    return row?JSON.parse(row.record) as RepairRecord:null;
  }
  list(after="",limit=30): {repairs:Array<RepairRecord & {observations:number}>;next_after:string|null} {
    if (!Number.isSafeInteger(limit)||limit<1||limit>50) throw new Error("纠错分页参数无效");
    const rows=this.db.prepare(`SELECT r.record,(SELECT count(*) FROM knowledge_repair_observations o WHERE o.repair_id=r.id) AS observations
      FROM knowledge_repairs r WHERE r.id>? ORDER BY r.id LIMIT ?`).all(after,limit+1) as Array<{record:string;observations:number}>;
    const repairs=rows.slice(0,limit).map(row=>({...JSON.parse(row.record) as RepairRecord,observations:row.observations}));
    return {repairs,next_after:rows.length>limit?repairs.at(-1)!.id:null};
  }
  private save(record:RepairRecord): void {
    this.db.prepare(`INSERT INTO knowledge_repairs(id,record_id,fingerprint,problem,state,record,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,record=excluded.record,updated_at=excluded.updated_at`).run(record.id,record.record_id,record.fingerprint,record.problem,record.state,JSON.stringify(record),new Date().toISOString());
  }
  observe(identity:RepairIdentity,observation:RepairObservation): RepairRecord {
    const checked=parseRepairIdentity(identity);
    const id=`repair_${sourceHash(JSON.stringify(checked)).slice(0,32)}`;
    if (!observation.key || observation.key.length>200 || observation.source.length>200 || !/^[0-9a-f]{40,64}$/u.test(observation.graph_sha)) throw new Error("纠错观察身份无效");
    return this.db.transaction(()=>{
      const record=this.get(id)??{...checked,id,state:"candidate" as const};
      this.save(record);
      // A repeated trace is idempotent; bound per-candidate telemetry growth.
      const n=(this.db.prepare("SELECT count(*) AS n FROM knowledge_repair_observations WHERE repair_id=?").get(id) as {n:number}).n;
      if(n<1000) this.db.prepare("INSERT OR IGNORE INTO knowledge_repair_observations(repair_id,observation_key,record) VALUES(?,?,?)").run(id,observation.key,JSON.stringify(observation));
      return record;
    })();
  }
  investigate(id:string,raw:unknown): RepairRecord {
    const record=this.get(id); if(!record) throw new Error("纠错候选不存在");
    const investigation=parseKnowledgeChanges([raw])[0]!;
    if(investigation.record_id!==record.record_id) throw new Error("调查与候选记录不匹配");
    if(record.state==="landed"||record.state==="verified") throw new Error("修正已落地；新的问题请按当前记录指纹重新报告");
    const next={...record,investigation,state:"investigated" as const};this.save(next);return next;
  }
  landed(entry:RepairEntry,sha:string): RepairRecord {
    return this.db.transaction(()=>{
      const prior=this.observe(entry,{key:`catalog:${sourceHash(JSON.stringify(entry))}`,graph_sha:sha,source:"Git repair catalog"});
      const digest=sourceHash(JSON.stringify(entry));
      // Re-observing an identical landing never erases an exact-generation receipt.
      const same=prior.catalog_digest===digest&&prior.landed_sha===sha;
      const next:RepairRecord={...prior,investigation:entry.investigation,catalog_digest:digest,landed_sha:sha,state:same?prior.state:"landed",...(same?{}:{replay:undefined})};
      this.save(next);return next;
    })();
  }
  replay(id:string,catalogDigest:string,replay:NonNullable<RepairRecord["replay"]>): RepairRecord {
    const record=this.get(id);
    if(!record || record.catalog_digest!==catalogDigest || record.landed_sha!==replay.graph_sha || !replay.generation) throw new Error("纠错回放与当前落地版本不匹配");
    const next:RepairRecord={...record,state:replay.passed?"verified":"landed",replay};this.save(next);return next;
  }
}
