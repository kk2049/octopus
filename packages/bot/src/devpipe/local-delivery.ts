import { Store } from "../store/store.js";
import { buildGraph, GraphDb, KnowledgeRetriever, acknowledgementSet } from "../knowledge/index.js";
import { constraintEvidenceTests } from "./landing-knowledge.js";
import { verifyNewHumanEvidence } from "./knowledge-evidence.js";
import { parseCliDeliveryReport, isCliReportPath, type CliDeliveryReportV3 } from "./cli-report.js";
import { checkSpecifications } from "../knowledge/specifications.js";
import { gitOrThrow } from "./worktree.js";

/** Offline admission uses exact Git contents. Specifications and retrieval
 * receipts are optional records: the report keeps their references, the
 * service records them on import, and neither is required to land. Offline
 * admission cannot upgrade unverifiable server-only human evidence.
 */
export async function localDelivery(repo: string, base: string, head: string): Promise<{
  report: CliDeliveryReportV3; path: string; changed: string[]; requiredTests: string[];
}> {
  const changes = (await gitOrThrow(repo, ["diff", "--name-status", "--no-renames", base, head])).split("\n").filter(Boolean);
  const reports = changes.map(row => row.split("\t")).filter(row => isCliReportPath(row[1] ?? ""));
  if (reports.length !== 1 || reports[0]?.[0] !== "A") throw new Error("CLI landing requires exactly one new immutable delivery report");
  const reportPath = reports[0]![1]!;
  const parent = await gitOrThrow(repo, ["rev-parse", `${head}^`]);
  if (await gitOrThrow(repo, ["diff", "--name-only", parent, head]) !== reportPath) {
    throw new Error("the final commit must only add the delivery report, after committing the implementation");
  }
  const report = parseCliDeliveryReport(await gitOrThrow(repo, ["show", `${head}:${reportPath}`]), reportPath);
  if (report.version !== 3 || report.base_sha !== base) {
    throw new Error("delivery requires a v3 report written at the current integration base");
  }
  const changed = changes.map(row => row.split("\t")[1]!);
  const tree = await gitOrThrow(repo, ["ls-tree", "-r", head]);
  const files = new Set(tree.split("\n").flatMap(line => /^(100644|100755) blob [a-f0-9]+\t(.+)$/u.exec(line)?.[2] ?? []));
  const specifications = checkSpecifications(report, files);
  if (specifications.some(spec => spec.provenance.events.length)) {
    throw new Error("offline CLI landing cannot verify server-only human evidence; retain agent-inferred attribution or use the authenticated service lane");
  }
  const store = new Store(":memory:"), graph = GraphDb.openInMemory();
  try {
    await verifyNewHumanEvidence({ repoDir: repo, from: base, to: head, files: changed, store, owner: report.requester });
    graph.fill((await buildGraph({ repoDir: repo, ref: base })).snapshot);
    const ack = acknowledgementSet(new KnowledgeRetriever(graph), changed);
    const known = new Set(graph.allNodes().map(node => node.id));
    if (report.supersedes.some(id => !known.has(id) || !report.changes?.some(change => change.record_id === id))
      || report.changes?.some(change => !known.has(change.record_id))) throw new Error("offline knowledge changes require Git-backed records and explicit change evidence");
    return { report, path: reportPath, changed, requiredTests: [...new Set([
      ...specifications.flatMap(spec => spec.verified_by), ...constraintEvidenceTests(ack.constraints),
    ])] };
  } finally { graph.close(); store.close(); }
}
