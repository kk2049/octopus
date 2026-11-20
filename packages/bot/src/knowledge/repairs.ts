import type { KnowledgeNode } from "./model.js";
import { parseKnowledgeChanges, type KnowledgeChange } from "./changes.js";
import { sourceHash } from "./source-workflow.js";
import { parseJourneyStep, type JourneyDocument, type JourneyStep, type JourneyStepOutcome } from "./eval/journey-evaluation.js";

export const REPAIR_CATALOG = "architecture/knowledge/repairs.json";
export const REPAIR_PROBLEMS = ["wrong_scope","wrong_lifecycle","missing_slot","invalid_anchor","evaluation_failed"] as const;
export type RepairProblem = typeof REPAIR_PROBLEMS[number];
export type RepairState = "candidate"|"investigated"|"landed"|"verified";
export interface RepairIdentity {record_id:string;fingerprint:string;problem:RepairProblem}
export interface RepairObservation {key:string;graph_sha:string;trace_id?:string;source:string}
export interface RepairEntry extends RepairIdentity { investigation:KnowledgeChange; steps:JourneyStep[] }
export interface RepairRecord extends RepairIdentity {
  id:string;state:RepairState;investigation?:KnowledgeChange;catalog_digest?:string;landed_sha?:string;
  replay?:{graph_sha:string;generation:string;passed:boolean;at:string;outcomes:JourneyStepOutcome[]};
}
/** Excludes build timestamps and commit identity so unchanged knowledge keeps its candidate identity. */
export function repairFingerprint(node: KnowledgeNode): string {
  return sourceHash(JSON.stringify([node.id,node.statement,node.status,node.certainty,node.source_ref,node.metadata?.provenance ?? null,node.metadata?.scope ?? null]));
}
export function parseRepairIdentity(raw: unknown): RepairIdentity {
  const item = raw as Partial<RepairIdentity>|null;
  if (!item || typeof item.record_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._/@#-]{0,511}$/u.test(item.record_id)
    || typeof item.fingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(item.fingerprint) || !REPAIR_PROBLEMS.includes(item.problem!)) throw new Error("纠错记录身份、指纹或问题类别无效");
  return {record_id:item.record_id,fingerprint:item.fingerprint,problem:item.problem!};
}
export function parseRepairCatalog(text: string): RepairEntry[] {
  if (Buffer.byteLength(text)>200_000) throw new Error("repair catalog exceeds bounded batch");
  const raw = JSON.parse(text) as {version:unknown;repairs:unknown};
  if (raw.version!==1 || !Array.isArray(raw.repairs) || raw.repairs.length>12 || Object.keys(raw).some(k=>!["version","repairs"].includes(k))) throw new Error("repair catalog must be version 1 with at most 12 repairs");
  const seen = new Set<string>();
  return raw.repairs.map((value: Record<string,unknown>) => {
    if (Object.keys(value).some(k=>!["record_id","fingerprint","problem","investigation","steps"].includes(k))) throw new Error("unknown repair catalog field");
    const identity = parseRepairIdentity(value);
    const key = JSON.stringify(identity);
    if (seen.has(key)) throw new Error("duplicate repair identity");
    seen.add(key);
    const investigation = parseKnowledgeChanges([value.investigation])[0]!;
    if (investigation.record_id!==identity.record_id) throw new Error("repair investigation record mismatch");
    if (!Array.isArray(value.steps) || value.steps.length<2 || value.steps.length>4) throw new Error("repair needs 2–4 positive/negative replay steps");
    const steps = value.steps.map((step,index)=>parseJourneyStep(step,"J001",index));
    if (!steps.some(s=>s.qrels.length) || !steps.some(s=>s.forbidden.length || s.no_answer || s.expected_unknown.length)) throw new Error("repair needs positive and negative judgments");
    return {...identity,investigation,steps};
  });
}
export function repairJourney(entry: RepairEntry): JourneyDocument {
  return {schema_version:1,targets:{recall_at_10:1,ndcg_at_10:0,mrr:0,forbidden_at_10:0,judged_noise_at_10:0},
    journeys:[{id:"J001",class:"negative",title:entry.record_id,hard_gate:true,steps:entry.steps}]};
}
