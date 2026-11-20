import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { it,expect } from "vitest";
import { Store } from "./store.js";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { originalEvidenceSource } from "../devpipe/knowledge-evidence.js";
import { verifyEvidenceEvent } from "../knowledge/evidence-verification.js";
import { parseRepairCatalog } from "../knowledge/repairs.js";
import { readFileSync } from "node:fs";

const input={provider:"codex",device:"laptop",session_id:"selected-session",message_id:"m1",source_at:"2026-09-17T00:00:00Z",role:"user",text:"私有原始消息：要求只能读取本人选中的来源。"};
it("upgrades v77 transactionally, preserves users, and persists private imports and new confirmations across restart",()=>{
  const dir=mkdtempSync(join(tmpdir(),"knowledge-workflow-")),file=join(dir,"store.db");
  const db=new Database(file);migrateFixtureTo(db,77);
  db.prepare("INSERT INTO users(username,uid,home_dir,created_at) VALUES(?,?,?,?)").run("alice",1,"/x/alice","2026-09-17");db.close();
  let store=new Store(file);
  try {
    const source=store.knowledgeSources.import("alice",input);
    expect(source.trust).toBe("local_import");
    expect(store.knowledgeSources.import("alice",input)).toEqual(source);
    expect(()=>store.knowledgeSources.import("alice",{...input,text:"forged"})).toThrow(/不同内容/);
    expect(store.knowledgeSources.read("bob",source.id)).toBeNull();
    expect(store.knowledgeSources.list("bob").sources).toEqual([]);
    expect(JSON.stringify(store.knowledgeSources.list("alice"))).not.toContain(input.text);
    expect(()=>store.knowledgeSources.confirm("bob",source.id,source.source_sha256,"requirement","来源必须保持用户之间的隔离边界")).toThrow();
    expect(()=>store.knowledgeSources.confirm("alice",source.id,"0".repeat(64),"requirement","来源必须保持用户之间的隔离边界")).toThrow();
    const agent=store.knowledgeSources.import("alice",{...input,message_id:"m2",role:"assistant"});
    expect(()=>store.knowledgeSources.confirm("alice",agent.id,agent.source_sha256,"requirement","来源必须保持用户之间的隔离边界")).toThrow(/Agent/);
    expect(()=>store.knowledgeSources.confirm("alice",source.id,source.source_sha256,"requirement","好的继续按照你的方案完成")).toThrow(/明确/);
    const proof=store.knowledgeSources.confirm("alice",source.id,source.source_sha256,"requirement","来源必须保持用户之间的隔离边界");
    expect(proof.at).not.toBe(input.source_at);
    expect(store.knowledgeSources.confirm("alice",source.id,source.source_sha256,"requirement",proof.design!)).toEqual(proof);
    expect(originalEvidenceSource(store,proof,"bob")).toBeNull();
    expect(originalEvidenceSource(store,{...proof,design:"替换原确认的要求"},"alice")).toBeNull();
    expect(verifyEvidenceEvent(proof,originalEvidenceSource(store,proof,"alice"))).toBeNull();
    expect(verifyEvidenceEvent({...proof,quote:"伪造的引文"},originalEvidenceSource(store,proof,"alice"))).toMatch(/哈希|引文/);
    store.close();store=new Store(file);
    expect(store.getUser("alice")?.uid).toBe(1);
    expect(store.knowledgeSources.evidence("alice",proof.ref)).toEqual(proof);
    expect(store.knowledgeSources.read("alice",source.id)?.text).toBe(input.text);
    store.deleteUser("alice");
    store.saveUser({username:"alice",uid:2,home_dir:"/x/new-alice",created_at:"2026-09-18"});
    expect(store.knowledgeSources.evidence("alice",proof.ref)).toBeNull();
    expect(store.knowledgeSources.list("alice").sources).toEqual([]);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
it("deduplicates repair observations, separates investigations from design approval, and binds verification to exact SHA/catalog",()=>{
  const store=new Store(":memory:");
  const entry=parseRepairCatalog(readFileSync("architecture/knowledge/repairs.json","utf8"))[0]!;
  try{
    const observed={key:"trace-one",graph_sha:"a".repeat(40),source:"test"};
    const first=store.knowledgeRepairs.observe(entry,observed);
    store.knowledgeRepairs.observe(entry,observed);
    store.knowledgeRepairs.observe(entry,{...observed,key:"trace-two"});
    expect(store.knowledgeRepairs.list().repairs[0]).toMatchObject({id:first.id,state:"candidate",observations:2});
    expect(()=>store.knowledgeRepairs.investigate(first.id,{})).toThrow();
    expect(store.knowledgeRepairs.investigate(first.id,entry.investigation).state).toBe("investigated");
    expect(store.knowledge.listReviews()).toEqual([]);
    const landed=store.knowledgeRepairs.landed(entry,"b".repeat(40));
    expect(landed.state).toBe("landed");
    const replay={graph_sha:"b".repeat(40),generation:"gen-one",passed:true,at:new Date().toISOString(),outcomes:[]};
    expect(()=>store.knowledgeRepairs.replay(first.id,landed.catalog_digest!,{...replay,graph_sha:"a".repeat(40)})).toThrow(/不匹配/);
    expect(store.knowledgeRepairs.replay(first.id,landed.catalog_digest!,replay).state).toBe("verified");
    expect(store.knowledgeRepairs.landed(entry,replay.graph_sha).state).toBe("verified");
    expect(store.knowledgeRepairs.landed(entry,"c".repeat(40)).state).toBe("landed");
    expect(store.knowledgeRepairs.observe({...entry,fingerprint:"d".repeat(64)},observed).id).not.toBe(first.id);
  }finally{store.close();}
});
