import fs from "node:fs";
import path from "node:path";
import { GraphDb } from "../graph-db.js";
import { openCodeIndex } from "../code-index.js";
import { KnowledgeRetriever,LexicalIndex,SimilarityRegistry } from "../retrieval.js";
import { LocalE5EmbeddingProvider } from "../model-binding.js";
import { FlatVectorIndex } from "../vector-index.js";
import { REPAIR_CATALOG,parseRepairCatalog,repairJourney } from "../repairs.js";
import { evaluateJourneys } from "./journey-evaluation.js";

async function main(): Promise<void> {
  const args=process.argv.slice(2), options=new Map<string,string>();
  for(let i=0;i<args.length;i+=2) {
    if(!["--graph","--catalog","--code-index","--vector","--model","--json"].includes(args[i]) || !args[i+1]) throw new Error("usage: repair-batch --graph <exact-SHA graph.db> [--catalog <repairs.json>] [--code-index <dir>] [--vector <dir> --model <dir>] [--json <report>]");
    options.set(args[i],args[i+1]);
  }
  const graphFile=options.get("--graph");if(!graphFile)throw new Error("--graph is required");
  const graph=GraphDb.openReadonly(path.resolve(graphFile));if(!graph)throw new Error("graph unavailable");
  const repoSha=String(graph.meta().commit ?? "");
  if(!/^[0-9a-f]{40}$/u.test(repoSha))throw new Error("repair replay requires an exact committed graph, not WORKTREE");
  const code=options.has("--code-index")?openCodeIndex(path.resolve(options.get("--code-index")!)):undefined;
  const provider=options.has("--model")?new LocalE5EmbeddingProvider(path.resolve(options.get("--model")!)):undefined;
  try {
    const indexes=new SimilarityRegistry([new LexicalIndex(graph)]);
    if(provider && options.has("--vector"))indexes.register(FlatVectorIndex.open({directory:path.resolve(options.get("--vector")!),repoSha,provider}));
    const retriever=new KnowledgeRetriever(graph,indexes,code),results=[];
    for(const entry of parseRepairCatalog(fs.readFileSync(options.get("--catalog")??REPAIR_CATALOG,"utf8"))) {
      const outcomes=await evaluateJourneys(retriever,repairJourney(entry),repoSha,code);
      results.push({record_id:entry.record_id,outcomes});
      if(outcomes.some(outcome=>!outcome.passed))process.exitCode=1;
    }
    const report={repo_sha:repoSha,mode:provider?"vector":"lexical",results};
    console.log(JSON.stringify(report,null,2));
    if(options.has("--json"))fs.writeFileSync(path.resolve(options.get("--json")!),JSON.stringify(report,null,2)+"\n");
  }finally{await provider?.close();code?.close();graph.close();}
}
void main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
