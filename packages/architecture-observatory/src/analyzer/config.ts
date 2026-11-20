import fs from "node:fs";
import path from "node:path";

import type { AtlasConfig } from "../shared/model.js";

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`architecture config: ${field} must be a non-empty string`);
  }
}
function uniqueIds(items: Array<{ id: string }>, field: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    assertString(item.id, `${field}[].id`);
    if (seen.has(item.id)) throw new Error(`architecture config: duplicate ${field} id "${item.id}"`);
    seen.add(item.id);
  }
}

export function validateConfig(raw: unknown): AtlasConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("architecture config: root must be an object");
  }
  const config = raw as Partial<AtlasConfig>;
  if (!config.system) throw new Error("architecture config: system is required");
  assertString(config.system.id, "system.id");
  assertString(config.system.title, "system.title");
  assertString(config.system.description, "system.description");
  if (!Array.isArray(config.zones) || !Array.isArray(config.modules) || !Array.isArray(config.flows) || !Array.isArray(config.constraints)) {
    throw new Error("architecture config: zones, modules, flows and constraints must be arrays");
  }
  uniqueIds(config.zones, "zones");
  uniqueIds(config.modules, "modules");
  uniqueIds(config.flows, "flows");
  uniqueIds(config.constraints, "constraints");

  const zones = new Set(config.zones.map((zone) => zone.id));
  for (const module of config.modules) {
    assertString(module.label, `modules.${module.id}.label`);
    if (!zones.has(module.zone)) {
      throw new Error(`architecture config: module "${module.id}" references unknown zone "${module.zone}"`);
    }
    if (!Array.isArray(module.pathPrefixes) || module.pathPrefixes.length === 0) {
      throw new Error(`architecture config: module "${module.id}" needs at least one pathPrefix`);
    }
  }
  return config as AtlasConfig;
}

export function loadConfig(root: string, configPath: string): AtlasConfig {
  const absolute = path.resolve(root, configPath);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new Error(`cannot read architecture config ${absolute}: ${String((error as Error).message ?? error)}`);
  }
  return validateConfig(raw);
}
