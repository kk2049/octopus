import fs from "node:fs";
import path from "node:path";

import type {
  ArchitectureWaiver,
  ArchitectureWaiverFile,
  ConstraintResult,
  ReviewFinding,
} from "../shared/model.js";

const WAIVER_KEYS = new Set(["constraintId", "witness", "reason", "owner", "created_at", "expires_at"]);
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`architecture waivers: ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`architecture waivers: ${field} must be a non-empty string`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const output = stringField(value, field);
  if (!DATE_TIME.test(output) || !Number.isFinite(Date.parse(output))) {
    throw new Error(`architecture waivers: ${field} must be an RFC 3339 date-time`);
  }
  return output;
}

export function validateWaivers(raw: unknown): ArchitectureWaiverFile {
  const root = record(raw, "root");
  const rootKeys = new Set(["$schema", "version", "waivers"]);
  const unknownRoot = Object.keys(root).find((key) => !rootKeys.has(key));
  if (unknownRoot) throw new Error(`architecture waivers: unknown root field "${unknownRoot}"`);
  if (root.$schema !== undefined && typeof root.$schema !== "string") {
    throw new Error("architecture waivers: $schema must be a string");
  }
  if (root.version !== 1) throw new Error("architecture waivers: version must be 1");
  if (!Array.isArray(root.waivers)) throw new Error("architecture waivers: waivers must be an array");

  const seen = new Set<string>();
  const waivers = root.waivers.map((rawWaiver, index): ArchitectureWaiver => {
    const item = record(rawWaiver, `waivers[${index}]`);
    const unknown = Object.keys(item).find((key) => !WAIVER_KEYS.has(key));
    if (unknown) throw new Error(`architecture waivers: waivers[${index}] has unknown field "${unknown}"`);
    const waiver = {
      constraintId: stringField(item.constraintId, `waivers[${index}].constraintId`),
      witness: stringField(item.witness, `waivers[${index}].witness`),
      reason: stringField(item.reason, `waivers[${index}].reason`),
      owner: stringField(item.owner, `waivers[${index}].owner`),
      created_at: timestamp(item.created_at, `waivers[${index}].created_at`),
      expires_at: timestamp(item.expires_at, `waivers[${index}].expires_at`),
    };
    if (!ID.test(waiver.constraintId)) {
      throw new Error(`architecture waivers: waivers[${index}].constraintId has an invalid identifier`);
    }
    if (Date.parse(waiver.created_at) >= Date.parse(waiver.expires_at)) {
      throw new Error(`architecture waivers: waivers[${index}].expires_at must be after created_at`);
    }
    const key = `${waiver.constraintId}\0${waiver.witness}`;
    if (seen.has(key)) {
      throw new Error(`architecture waivers: duplicate waiver for ${waiver.constraintId} / ${waiver.witness}`);
    }
    seen.add(key);
    return waiver;
  });
  return {
    ...(typeof root.$schema === "string" ? { $schema: root.$schema } : {}),
    version: 1,
    waivers,
  };
}

export function loadWaivers(root: string, waiverPath = "architecture/waivers.json"): ArchitectureWaiverFile {
  const absolute = path.resolve(root, waiverPath);
  try {
    return validateWaivers(JSON.parse(fs.readFileSync(absolute, "utf8")));
  } catch (error) {
    throw new Error(`cannot read architecture waivers ${absolute}: ${String((error as Error).message ?? error)}`);
  }
}

export function applyWaivers(args: {
  constraints: ConstraintResult[];
  waivers: ArchitectureWaiver[];
  now?: Date;
  sourcePath?: string;
}): { constraints: ConstraintResult[]; findings: ReviewFinding[] } {
  const now = (args.now ?? new Date()).getTime();
  const source = { path: args.sourcePath ?? "architecture/waivers.json", line: 1 };
  const findings: ReviewFinding[] = [];
  const active = new Map<string, ArchitectureWaiver>();

  for (const [index, waiver] of args.waivers.entries()) {
    if (Date.parse(waiver.expires_at) <= now) {
      findings.push({
        id: `waiver:expired:${index}`,
        severity: "medium",
        title: `约束豁免已过期：${waiver.constraintId}`,
        description: `${waiver.witness} 已于 ${waiver.expires_at} 到期；豁免不再生效，请删除或重新审阅。`,
        moduleIds: [],
        source,
        constraintId: waiver.constraintId,
        signal: "waiver",
      });
      continue;
    }
    active.set(`${waiver.constraintId}\0${waiver.witness}`, waiver);
  }

  const matched = new Set<string>();
  const constraints = args.constraints.map((constraint): ConstraintResult => {
    if (constraint.status !== "fail") return constraint;
    const violations = [];
    const waivedViolations = [...constraint.waivedViolations];
    for (const item of constraint.violations) {
      const key = `${constraint.id}\0${item.witness}`;
      const waiver = active.get(key);
      if (!waiver) {
        violations.push(item);
        continue;
      }
      matched.add(key);
      waivedViolations.push({ ...item, waiver });
    }
    if (waivedViolations.length === constraint.waivedViolations.length) return constraint;
    const newlyWaived = waivedViolations.length - constraint.waivedViolations.length;
    return {
      ...constraint,
      status: violations.length === 0 ? "waived" : "fail",
      summary: violations.length === 0
        ? `${newlyWaived} 条失败见证已被未过期豁免覆盖`
        : `${constraint.summary}；另有 ${newlyWaived} 条失败见证已豁免`,
      violations,
      waivedViolations,
    };
  });

  for (const [index, waiver] of args.waivers.entries()) {
    const key = `${waiver.constraintId}\0${waiver.witness}`;
    if (Date.parse(waiver.expires_at) <= now || matched.has(key)) continue;
    findings.push({
      id: `waiver:stale:${index}`,
      severity: "medium",
      title: `Stale waiver：${waiver.constraintId}`,
      description: `${waiver.witness} 未命中当前失败见证；请删除这条不再需要的豁免。`,
      moduleIds: [],
      source,
      constraintId: waiver.constraintId,
      signal: "waiver",
    });
  }
  return { constraints, findings };
}
