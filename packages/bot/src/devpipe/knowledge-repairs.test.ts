import { readFileSync } from "node:fs";
import { it,expect,vi,afterEach } from "vitest";
import { Store } from "../store/store.js";
import { replayKnowledgeRepairs } from "./knowledge-repairs.js";
import { git } from "./worktree.js";
import { evaluateJourneys } from "../knowledge/eval/journey-evaluation.js";
import type { KnowledgeRetriever } from "../knowledge/retrieval.js";
import type { CodeIndexResolver } from "../knowledge/code-index.js";
vi.mock("./worktree.js",()=>({git:vi.fn()}));
vi.mock("../knowledge/eval/journey-evaluation.js",async(importOriginal)=>({...await importOriginal<typeof import("../knowledge/eval/journey-evaluation.js")>(),evaluateJourneys:vi.fn()}));
afterEach(()=>vi.resetAllMocks());
it("observes Git corrections without activation, rejects stale completion and only verifies exact active generations",async()=>{
 const store=new Store(":memory:");const sha="a".repeat(40);
 vi.mocked(git).mockResolvedValue({ok:true,stdout:readFileSync("architecture/knowledge/repairs.json","utf8"),stderr:"",code:0} as never);
 vi.mocked(evaluateJourneys).mockResolvedValue([{id:"J001.1",passed:true,missing:[]}] as never);
 let current=true;
 const input={store,repoDir:"/fixture",sha,generation:null as string|null,retriever:{} as KnowledgeRetriever,codeIndex:{gitSha:sha} as CodeIndexResolver,isCurrent:()=>current};
 try{
  expect(await replayKnowledgeRepairs(input)).toMatchObject({observed:2,verified:0});
  expect(evaluateJourneys).not.toHaveBeenCalled();
  vi.mocked(evaluateJourneys).mockImplementationOnce(async()=>{current=false;return [{id:"J001.1",passed:true,missing:[]}] as never;});
  expect(await replayKnowledgeRepairs({...input,generation:"generation-one"})).toMatchObject({stale:true,verified:0});
  expect(store.knowledgeRepairs.list().repairs.every(r=>r.state==="landed")).toBe(true);
  current=true;
  expect(await replayKnowledgeRepairs({...input,generation:"generation-two"})).toMatchObject({verified:2,stale:false});
  expect(store.knowledgeRepairs.list().repairs.every(r=>r.replay?.generation==="generation-two")).toBe(true);
  vi.mocked(evaluateJourneys).mockResolvedValue([{id:"J001.1",passed:false,missing:["expected record"]}] as never);
  expect(await replayKnowledgeRepairs({...input,generation:"generation-three"})).toMatchObject({verified:0});
  expect(store.knowledgeRepairs.list().repairs.every(r=>r.state==="landed")).toBe(true);
 }finally{store.close();}
});
