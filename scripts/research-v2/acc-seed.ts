import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";
import type { Json, NodeType } from "../../packages/research-canvas-contract/src/model.js";

export interface AccSeedManifest {
  version: 1;
  project: string;
  instance: string;
  sources: AccSource[];
  nodes: AccNode[];
  edges: [string, string, string][];
}
export interface AccSource {
  id: string;
  path?: string;
  display: string;
  purpose: string;
  metadataOnly?: boolean;
}
export interface AccNode {
  key: string;
  type: NodeType;
  title: string;
  summary: string;
  phase: "past" | "present" | "future";
  sourceIds?: string[];
  meta?: Record<string, string | number | boolean | null>;
}
export interface AccSourceReceipt {
  id: string;
  display: string;
  path: string;
  relativePath: string;
  purpose: string;
  bytes: number;
  sha256: string;
  metadataOnly: boolean;
}
export interface AccSeedPlan {
  version: 1;
  project: string;
  instance: string;
  receipts: AccSourceReceipt[];
  nodes: Array<{
    key: string;
    data: {
      type: NodeType;
      title: string;
      summary: string;
      phase: AccNode["phase"];
      data: Record<string, Json>;
    };
  }>;
  edges: Array<{ source: string; target: string; label: string }>;
}

export interface AccSeedOptions {
  /**
   * Override the production roots only for a trusted fixture caller. The CLI
   * keeps the fixed ACC roots below; this exists so the pure planner can be
   * tested without creating production-looking paths on a CI host.
   */
  allowedRoots?: readonly string[];
}

// A seed is deliberately allow-listed. The View never receives these paths;
// the trusted operator reviews this plan and performs explicit file uploads.
const SAFE_ROOTS = [
  "/home/ubuntu/lht/acc-refresh",
  "/home/ubuntu/lht/auto-research/agentcc",
  "/home/ubuntu/lht/report/ACC",
  "/home/ubuntu/lht/report/project-x",
];
const SESSION_PREFIX = "/home/ubuntu/.codex/sessions/";
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const scalar = (value: string | number | boolean | null): Json => value;

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
function safeSource(source: AccSource, allowedRoots: readonly string[]): AccSourceReceipt {
  const metadataOnly = source.metadataOnly === true || !source.path;
  const requested = source.path ? resolve(source.path) : "";
  if (metadataOnly) return {
    id: source.id,
    display: source.display,
    path: "",
    relativePath: source.display,
    purpose: source.purpose,
    bytes: 0,
    sha256: "metadata-only",
    metadataOnly: true,
  };
  if (requested.startsWith(SESSION_PREFIX))
    throw new Error(`session paths must use metadataOnly: ${source.id}`);
  if (!metadataOnly && !allowedRoots.some((root) => within(requested, root)))
    throw new Error(`source outside ACC allow-list: ${source.path}`);
  const canonical = realpathSync(requested);
  if (!metadataOnly && !allowedRoots.some((root) => within(canonical, root)))
    throw new Error(`source resolves outside ACC allow-list: ${source.path}`);
  const stat = statSync(canonical);
  if (!stat.isFile()) throw new Error(`source is not a regular file: ${source.path}`);
  if (stat.size > MAX_SOURCE_BYTES) throw new Error(`source exceeds 64 MiB: ${source.path}`);
  const digest = metadataOnly ? "metadata-only" : createHash("sha256").update(readFileSync(canonical)).digest("hex");
  return {
    id: source.id,
    display: source.display,
    path: canonical,
    relativePath: metadataOnly ? source.display : relative("/home/ubuntu/lht", canonical),
    purpose: source.purpose,
    bytes: stat.size,
    sha256: digest,
    metadataOnly,
  };
}

export function buildAccSeedPlan(manifest: AccSeedManifest, options: AccSeedOptions = {}): AccSeedPlan {
  if (manifest.version !== 1 || !manifest.project || !manifest.instance)
    throw new Error("invalid ACC seed manifest");
  const allowedRoots = (options.allowedRoots ?? SAFE_ROOTS).map((root) => resolve(root));
  const sourceKeys = new Set<string>();
  for (const source of manifest.sources) {
    if (!source.id || sourceKeys.has(source.id))
      throw new Error(`duplicate or empty source id: ${source.id}`);
    sourceKeys.add(source.id);
  }
  const nodeKeys = new Set<string>(["board"]);
  for (const node of manifest.nodes) {
    if (!node.key || nodeKeys.has(node.key))
      throw new Error(`duplicate or reserved node key: ${node.key}`);
    nodeKeys.add(node.key);
    const sourceIds = node.sourceIds ?? [];
    if (new Set(sourceIds).size !== sourceIds.length)
      throw new Error(`duplicate source reference: ${node.key}`);
  }
  const receipts = manifest.sources.map((source) => safeSource(source, allowedRoots));
  const bySource = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const nodes: AccSeedPlan["nodes"] = [];
  const edges: AccSeedPlan["edges"] = [];
  for (const receipt of receipts) {
    const source = manifest.sources.find((item) => item.id === receipt.id)!;
    const type: NodeType = receipt.metadataOnly ? "note" : "file";
    nodes.push({
      key: `source-${receipt.id}`,
      data: {
        type,
        title: source.display,
        summary: source.purpose,
        phase: "past",
        data: {
          ...(type === "note" ? { text: `历史 Agent 会话元数据：${source.purpose}\n\n原始 rollout 不直接投影。` } : {}),
          meta: {
            source_id: receipt.id,
            source_ref: receipt.relativePath,
            sha256: receipt.sha256,
            bytes: receipt.bytes,
            read_only: true,
            metadata_only: receipt.metadataOnly,
          },
        },
      },
    });
  }
  for (const node of manifest.nodes) {
    const sourceIds = node.sourceIds ?? [];
    for (const id of sourceIds) if (!bySource.has(id)) throw new Error(`${node.key} references unknown source ${id}`);
    nodes.push({
      key: node.key,
      data: {
        type: node.type,
        title: node.title,
        summary: node.summary,
        phase: node.phase,
        data: {
          ...(node.type === "collection" ? { description: node.summary } : {}),
          ...(node.type === "agent"
            ? { instructions: node.summary }
            : node.type !== "file" && node.type !== "collection"
              ? { text: node.summary }
              : {}),
          meta: {
            ...(node.meta ?? {}),
            source_ids: sourceIds.join(","),
            read_only: node.meta?.read_only ?? true,
          },
        },
      },
    });
    for (const sourceId of sourceIds) edges.push({ source: `source-${sourceId}`, target: node.key, label: "来源" });
  }
  for (const [source, target, label] of manifest.edges) {
    if (source === target) throw new Error(`self edge is not allowed: ${source}`);
    if ([...label].length > 4) throw new Error(`edge label too long: ${label}`);
    if (!nodeKeys.has(source) || !nodeKeys.has(target))
      throw new Error(`edge references unknown node: ${source} -> ${target}`);
    edges.push({ source, target, label });
  }
  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    const key = `${edge.source}\u0000${edge.target}\u0000${edge.label}`;
    if (edgeKeys.has(key)) throw new Error(`duplicate edge: ${edge.source} -> ${edge.target}`);
    edgeKeys.add(key);
  }
  return { version: 1, project: manifest.project, instance: manifest.instance, receipts, nodes, edges };
}

function main(): void {
  const at = process.argv.indexOf("--manifest"), outAt = process.argv.indexOf("--out");
  if (at < 0 || outAt < 0) throw new Error("usage: tsx scripts/research-v2/acc-seed.ts --manifest <file> --out <file>");
  const manifest = JSON.parse(readFileSync(resolve(process.argv[at + 1]!), "utf8")) as AccSeedManifest;
  const plan = buildAccSeedPlan(manifest);
  writeFileSync(resolve(process.argv[outAt + 1]!), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(JSON.stringify({ project: plan.project, nodes: plan.nodes.length, edges: plan.edges.length, receipts: plan.receipts.length }) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
