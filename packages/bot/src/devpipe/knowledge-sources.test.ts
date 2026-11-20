import { it,expect } from "vitest";
import { Store } from "../store/store.js";
import { processTicketSources,sourceCoverage,ticketSourcePage,SOURCE_WINDOW_CHARS } from "./knowledge-sources.js";
import type { KnowledgeSpecification } from "../knowledge/specifications.js";

it("pages oldest unprocessed human input, isolates ticket scope, and validates hashes/batches before writing",()=>{
  const store=new Store(":memory:");
  store.saveUser({username:"alice",uid:1,home_dir:"/x/alice",created_at:"2026-09-17"});
  const create=()=>store.devTickets.createDevTicket({title:"sources",body:"原始需求必须保留最早的来源",requester:"alice",kind:"simple",app_id:null,model:"fixture",effort:"medium"});
  const ticket=create(),other=create();
  try{
    for(let i=0;i<13;i++)store.devTickets.addTicketMessage(ticket.id,"alice","web",`人类补充 ${i}`);
    store.devTickets.addTicketMessage(ticket.id,"agent","agent","自称必须执行的 Agent 输出");
    const first=ticketSourcePage(store,ticket.id);
    expect(first.pending).toBe(14);expect(first.sources).toHaveLength(10);expect(first.sources[0].ref).toBe(`ticket:${ticket.id}`);
    const second=ticketSourcePage(store,ticket.id,first.next_after!);
    expect(second.sources).toHaveLength(4);expect(second.next_after).toBeNull();expect(ticketSourcePage(store,ticket.id).pending).toBe(14);
    expect(JSON.stringify(first)).not.toContain("人类补充");
    expect(()=>processTicketSources(store,ticket.id,{read_ref:`ticket:${other.id}`})).toThrow(/不属于/);
    const source=first.sources[0];
    const draft={ref:source.ref,source_sha256:source.source_sha256,disposition:"requirement",statements:["必须保留所有未处理来源"],reason:"原始输入提出的要求"};
    expect(()=>processTicketSources(store,ticket.id,{items:[draft,{...draft,ref:`ticket:${other.id}`}]})).toThrow();
    expect(store.knowledgeSources.drafts(ticket.id)).toEqual([]);
    expect(()=>processTicketSources(store,ticket.id,{items:[{...draft,source_sha256:"0".repeat(64)}]})).toThrow(/hash/);
    processTicketSources(store,ticket.id,{items:[draft]});
    expect(sourceCoverage(store,ticket.id,[]).knowledge_next_actions[0]).toMatchObject({reason:"unmapped_requirement",source_ref:source.ref});
    const spec={statement:draft.statements[0],provenance:{events:[]}} as unknown as KnowledgeSpecification;
    expect(sourceCoverage(store,ticket.id,[spec]).knowledge_next_actions.some(x=>x.reason==="unmapped_requirement")).toBe(false);
    expect(ticketSourcePage(store,ticket.id).sources[0].ref).toBe(first.sources[1].ref);
    const question=first.sources[1];
    expect(()=>processTicketSources(store,ticket.id,{items:[{...draft,...question,disposition:"question",statements:[],reason:"无关"}]})).toThrow();
    processTicketSources(store,ticket.id,{items:[{ref:question.ref,source_sha256:question.source_sha256,disposition:"question",statements:[],reason:"此消息询问当前进度，不增加需求"}]});
    expect(ticketSourcePage(store,ticket.id).pending).toBe(12);
  }finally{store.close();}
});

it("reads a long human source whole, in windows, instead of refusing it",()=>{
  const store=new Store(":memory:");
  store.saveUser({username:"alice",uid:1,home_dir:"/x/alice",created_at:"2026-09-17"});
  try{
    const body="需求开头。"+"中间说明😀".repeat(12_000)+"结尾的硬性约束：必须保留最后一句。";
    expect(body.length).toBeGreaterThan(SOURCE_WINDOW_CHARS*3);
    const ticket=store.devTickets.createDevTicket({title:"long",body,requester:"alice",kind:"simple",app_id:null,model:"fixture",effort:"medium"});
    const ref=`ticket:${ticket.id}`;
    let offset:number|undefined=0;
    let assembled="";
    let hash="";
    while(offset!==undefined){
      const out=processTicketSources(store,ticket.id,{read_ref:ref,offset}) as {source:{body:string;offset:number;total_chars:number;next_offset?:number;source_sha256:string}};
      expect(out.source.offset).toBe(offset);
      expect(out.source.total_chars).toBe(body.length);
      expect(out.source.body.length).toBeLessThanOrEqual(SOURCE_WINDOW_CHARS);
      assembled+=out.source.body;
      hash=out.source.source_sha256;
      offset=out.source.next_offset;
    }
    expect(assembled).toBe(body);
    expect(hash).toBe(ticketSourcePage(store,ticket.id).sources[0]!.source_sha256);
    expect(()=>processTicketSources(store,ticket.id,{read_ref:ref,offset:body.length+1})).toThrow(/offset/);
  }finally{store.close();}
});
