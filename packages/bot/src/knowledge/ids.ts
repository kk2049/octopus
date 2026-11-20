import { createHash } from "node:crypto";
import { MAX_STATEMENT_CHARS, type NodeKind } from "./model.js";

/**
 * Normalised statement key used for deduplication: NFKC, lower-cased Latin,
 * whitespace and punctuation removed. Two statements with the same key are
 * the same claim regardless of spacing or trailing punctuation.
 */
export function statementKey(statement: string): string {
  return statement
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function shortHash(value: string, length = 12): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function nodeId(kind: NodeKind, key: string): string {
  return `${kind}:${key}`;
}

/** Stable id for a statement extracted from a document section. */
export function statementId(kind: NodeKind, sourceRef: string, statement: string): string {
  return nodeId(kind, `${shortHash(sourceRef, 8)}:${shortHash(statementKey(statement), 12)}`);
}

export function pathId(path: string): string {
  return nodeId("path", path);
}

export function moduleId(id: string): string {
  return nodeId("module", id);
}

export function ticketId(id: number): string {
  return nodeId("ticket", String(id));
}

export function capabilityId(id: string): string {
  return nodeId("capability", id);
}

export function capabilityContractId(contract: string): string {
  return nodeId("capability_contract", contract);
}

export function contractEntityId(
  kind: "principle" | "obligation" | "scenario" | "exception" | "desired_conformance" | "observed_conformance",
  contract: string,
  key: string,
): string {
  return nodeId(kind, `${contract}/${key}`);
}

export function sourceId(canonicalCoordinate: string): string {
  return nodeId("source", canonicalCoordinate);
}

export function artifactId(repo: string, kind: string, key: string): string {
  return nodeId("artifact", `${repo}/${kind}/${key}`);
}

export function clipStatement(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= MAX_STATEMENT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_STATEMENT_CHARS - 1)}…`;
}

/** Deterministic fingerprint of the inputs that shaped a build. */
export function fingerprint(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}
