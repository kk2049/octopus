import { describe, expect, it } from "vitest";
import { readModuleManifest } from "@claude-bot/agent-module-contract";
import { CONFIG_KEYS_READ } from "./modules.js";
import { INTAKE_WORKFLOW_CONFIG, INTAKE_WORKFLOW_MANIFEST } from "./manifests.js";
describe("intake module declaration", () => { it("declares exactly the config it reads", () => { expect(Object.keys(INTAKE_WORKFLOW_CONFIG).sort()).toEqual([...CONFIG_KEYS_READ.workflow].sort()); expect(readModuleManifest(INTAKE_WORKFLOW_MANIFEST).ok).toBe(true); }); });
