import type { Store } from "../store/store.js";
import type { KnowledgeRetriever } from "../knowledge/retrieval.js";
import type { CodeIndexResolver } from "../knowledge/code-index.js";
import { REPAIR_CATALOG, parseRepairCatalog, repairJourney } from "../knowledge/repairs.js";
import { evaluateJourneys } from "../knowledge/eval/journey-evaluation.js";
import { git } from "./worktree.js";

/** One bounded Git batch; only an exact, still-active artifact generation can close it. */
export async function replayKnowledgeRepairs(input:{store:Pick<Store,"knowledgeRepairs">;repoDir:string;sha:string;generation:string|null;
  retriever:KnowledgeRetriever;codeIndex?:CodeIndexResolver;isCurrent:()=>boolean}): Promise<{observed:number;verified:number;stale:boolean}> {
  const out={observed:0,verified:0,stale:false};
  const file=await git(input.repoDir,["show",`${input.sha}:${REPAIR_CATALOG}`]);
  if(!file.ok) return out;
  const entries=parseRepairCatalog(file.stdout);
  for(const entry of entries) {
    if(!input.isCurrent()) return {...out,stale:true};
    const record=input.store.knowledgeRepairs.landed(entry,input.sha);out.observed++;
    if(!input.generation || input.codeIndex?.gitSha!==input.sha) continue;
    const outcomes=await evaluateJourneys(input.retriever,repairJourney(entry),input.sha,input.codeIndex);
    if(!input.isCurrent()) return {...out,stale:true};
    const passed=outcomes.every(o=>o.passed);
    input.store.knowledgeRepairs.replay(record.id,record.catalog_digest!,{graph_sha:input.sha,generation:input.generation,passed,at:new Date().toISOString(),outcomes});
    if(passed) out.verified++;
  }
  return out;
}
