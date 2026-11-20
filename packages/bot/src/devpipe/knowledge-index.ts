import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Store } from "../store/store.js";
import type {
  KnowledgeAuthority,
  KnowledgeRecordInput,
  KnowledgeStatus,
} from "../store/repositories/knowledge.js";
import { gitOrThrow } from "./worktree.js";
import { HISTORICAL_KNOWLEDGE_SEEDS } from "./knowledge-seeds.js";

const REPOSITORY_SOURCE_TYPES = [
  "repo_rule",
  "package_contract",
  "adr",
  "delivery",
  "architecture_module",
  "historical_pattern",
  "architecture_constraint",
] as const;

interface AtlasModule {
  id: string;
  label?: string;
  description?: string;
  zone?: string;
  paths?: string[];
  tags?: string[];
}
interface AtlasConstraint {
  id: string;
  title?: string;
  description?: string;
  concern?: string;
  severity?: string;
  mechanism?: {
    from?: string[];
    to?: string[];
  };
  evidence?: Array<{ command?: string; source?: { path?: string; line?: number } }>;
}

interface DeclaredAtlas {
  modules?: AtlasModule[];
  constraints?: AtlasConstraint[];
}

function recordKey(sourceType: string, sourceRef: string): string {
  const digest = createHash("sha256").update(`${sourceType}\0${sourceRef}`).digest("hex").slice(0, 24);
  return `repo:${sourceType}:${digest}`;
}

function markdownTitle(content: string, fallback: string): string {
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
  return (heading || fallback).slice(0, 240);
}

function adrLifecycle(content: string): { status: KnowledgeStatus; authority: KnowledgeAuthority } {
  const explicit = /(?:decision_status|status|状态)\s*[:：]\s*([^\n]+)/i.exec(content)?.[1]?.trim().toLowerCase() ?? "";
  if (/reject|拒绝/.test(explicit)) return { status: "rejected", authority: "accepted" };
  if (/supersed|取代|废弃/.test(explicit)) return { status: "superseded", authority: "accepted" };
  if (/accept|implemented|已接受|已实现/.test(explicit)) return { status: "active", authority: "accepted" };
  return { status: "proposed", authority: "declared" };
}

/** Rebuildable projection of repository rules, decisions and declared architecture into SQLite. */
export class RepositoryKnowledgeIndex {
  private indexedSha: string | null = null;

  constructor(
    private readonly store: Store,
    private readonly repoDir: string,
  ) {}

  async refresh(ref: string): Promise<string> {
    const sha = await gitOrThrow(this.repoDir, ["rev-parse", `${ref}^{commit}`]);
    if (sha === this.indexedSha) return sha;

    const listed = await gitOrThrow(this.repoDir, [
      "ls-files",
      "AGENTS.md",
      ".claude/rules/*.md",
      "packages/*/CLAUDE.md",
      "packages/*/README.md",
      "packages/*/DEVELOPMENT.md",
      "plugins/*/CLAUDE.md",
      "plugins/*/README.md",
      "plugins/*/DEVELOPMENT.md",
      "doc/adr/*.md",
      "doc/deliveries/*.md",
    ]);
    const files = listed.split("\n").filter(Boolean);
    const records: KnowledgeRecordInput[] = [];
    for (const relative of files) {
      // The whole document is indexed: a rule or decision near the end of a
      // long file must be as findable as one near the top. Display surfaces
      // window the body themselves (formatKnowledgeContext marks its cut).
      const content = await readFile(path.join(this.repoDir, relative), "utf8");
      let sourceType: typeof REPOSITORY_SOURCE_TYPES[number];
      let status: KnowledgeStatus;
      let authority: KnowledgeAuthority;
      if (relative === "AGENTS.md" || relative.startsWith(".claude/rules/")) {
        sourceType = "repo_rule";
        status = "active";
        authority = "declared";
      } else if (relative.startsWith("doc/adr/")) {
        sourceType = "adr";
        ({ status, authority } = adrLifecycle(content));
      } else if (relative.startsWith("doc/deliveries/")) {
        sourceType = "delivery";
        status = "historical";
        authority = "historical";
      } else {
        sourceType = "package_contract";
        status = "active";
        authority = "declared";
      }
      records.push({
        record_key: recordKey(sourceType, relative),
        kind: sourceType === "delivery" ? "outcome" : sourceType === "adr" ? "decision" : "constraint",
        status,
        authority,
        title: markdownTitle(content, relative),
        body: content,
        source_type: sourceType,
        source_ref: relative,
        source_sha: sha,
        confidence: sourceType === "delivery" ? 0.8 : 1,
        links: [{ relation: "defined_in", target_type: "path", target_key: relative }],
      });
    }
    for (const seed of HISTORICAL_KNOWLEDGE_SEEDS) {
      records.push({
        record_key: `historical:pattern:${seed.id}`,
        kind: "risk",
        status: "active",
        authority: "historical",
        title: seed.title,
        body: `${seed.body}\n\nFalse-positive boundary: ${seed.false_positive}`,
        source_type: "historical_pattern",
        source_ref: `runtime tickets ${seed.tickets.map((id) => `#${id}`).join(", ")}`,
        source_sha: sha,
        confidence: seed.confidence,
        metadata: {
          tickets: seed.tickets,
          tests: seed.tests,
          replay_query: seed.replay_query,
          false_positive: seed.false_positive,
        },
        links: [
          ...seed.tickets.map((ticket) => ({ relation: "observed_in", target_type: "ticket", target_key: String(ticket) })),
          ...seed.paths.map((item) => ({ relation: "affects", target_type: "path", target_key: item })),
          ...seed.tests.map((item) => ({ relation: "verified_by", target_type: "test", target_key: item })),
        ],
      });
    }
    records.push(...await this.atlasRecords(sha));
    this.store.knowledge.syncSourceRecords(REPOSITORY_SOURCE_TYPES, records);
    this.indexedSha = sha;
    return sha;
  }

  private async atlasRecords(sha: string): Promise<KnowledgeRecordInput[]> {
    const relative = "architecture/atlas.json";
    const atlas = JSON.parse(await readFile(path.join(this.repoDir, relative), "utf8")) as DeclaredAtlas;
    const records: KnowledgeRecordInput[] = [];
    for (const module of atlas.modules ?? []) {
      const paths = module.paths ?? [];
      records.push({
        record_key: `architecture:module:${module.id}`,
        kind: "source",
        status: "active",
        authority: "declared",
        title: `${module.label ?? module.id} (${module.id})`,
        body: [module.description, `zone: ${module.zone ?? "unknown"}`, `paths: ${paths.join(", ")}`]
          .filter(Boolean)
          .join("\n"),
        source_type: "architecture_module",
        source_ref: relative,
        source_sha: sha,
        confidence: 1,
        metadata: module as unknown as Record<string, unknown>,
        links: [
          { relation: "defined_in", target_type: "path", target_key: relative },
          ...paths.map((item) => ({ relation: "owns", target_type: "path", target_key: item })),
        ],
      });
    }
    for (const constraint of atlas.constraints ?? []) {
      const modules = [
        ...(constraint.mechanism?.from ?? []),
        ...(constraint.mechanism?.to ?? []),
      ];
      const commands = (constraint.evidence ?? []).flatMap((item) => item.command ? [item.command] : []);
      const body = [
        constraint.description,
        `concern: ${constraint.concern ?? "unknown"}`,
        `severity: ${constraint.severity ?? "unknown"}`,
        commands.length ? `verification: ${commands.join("; ")}` : null,
      ].filter(Boolean).join("\n");
      records.push({
        record_key: `architecture:constraint:${constraint.id}`,
        kind: "constraint",
        status: "active",
        authority: "declared",
        title: `${constraint.title ?? constraint.id} (${constraint.id})`,
        body,
        source_type: "architecture_constraint",
        source_ref: relative,
        source_sha: sha,
        confidence: 1,
        metadata: constraint as unknown as Record<string, unknown>,
        links: [
          { relation: "defined_in", target_type: "path", target_key: relative },
          ...modules.map((module) => ({ relation: "constrains", target_type: "module", target_key: module })),
        ],
      });
    }
    return records;
  }
}
