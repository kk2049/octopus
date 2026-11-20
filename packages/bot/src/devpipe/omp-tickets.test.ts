import { describe, it, expect } from "vitest";
import {
  MCP_CONFIG_FILE,
  MCP_EXCLUDE_ENTRIES,
  ompMcpConfigPath,
} from "./pipeline.js";
import {
  DEV_TICKET_MODELS,
  cliFamilyForModel,
  modelIdForCli,
  normalizeDevTicketInput,
} from "./ticket-models.js";

describe("cliFamilyForModel — omp", () => {
  it("routes omp- ids to their own family and strips the prefix for the CLI", () => {
    expect(cliFamilyForModel("omp-gpt-5.6-sol")).toBe("omp");
    expect(modelIdForCli("omp-gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(cliFamilyForModel("claude-opus-5")).toBe("claude");
    expect(cliFamilyForModel("codex-gpt-5.6-sol")).toBe("codex");
  });
});

describe("omp's per-turn MCP credential", () => {
  it("lands inside the ticket's own worktree, where omp discovers it", () => {
    // omp has no --mcp-config: <cwd>/.omp/mcp.json is the only handoff.
    expect(ompMcpConfigPath("/w/ticket-9")).toBe("/w/ticket-9/.omp/mcp.json");
  });

  it("is excluded from git alongside the other copy of the same token", () => {
    // An agent running `git add -A` must not be able to commit either file.
    expect(MCP_EXCLUDE_ENTRIES).toContain(MCP_CONFIG_FILE);
    expect(MCP_EXCLUDE_ENTRIES).toContain(".omp/");
  });
});

describe("omp ticket models", () => {
  it("remain selectable while first-party Codex is the default", () => {
    expect(DEV_TICKET_MODELS.has("omp-gpt-5.6-sol")).toBe(true);
    expect(DEV_TICKET_MODELS.has("omp-opus")).toBe(true);
    expect(normalizeDevTicketInput({ title: "t", body: "b", requester: "u" }).model)
      .toBe("codex-gpt-6-astra");
  });

  it("survive normalization instead of being clamped to the default", () => {
    const row = normalizeDevTicketInput({ title: "t", body: "b", requester: "u", model: "omp-opus" });
    expect(row.model).toBe("omp-opus");
    expect(cliFamilyForModel(row.model)).toBe("omp");
  });
});
