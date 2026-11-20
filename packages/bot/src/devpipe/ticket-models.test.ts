import { describe, expect, it } from "vitest";
import {
  DEV_TICKET_EFFORT_DEFAULT,
  DEV_TICKET_MODEL_DEFAULT,
  DEV_TICKET_MODELS,
  FABLE_TICKET_MODEL,
  cliFamilyForModel,
  modelIdForCli,
  normalizeCliDeliveryTicketInput,
  normalizeDevTicketInput,
  offeredTicketModels,
  ticketModelCatalog,
} from "./ticket-models.js";

describe("dev ticket model rules", () => {
  it.each(["complex", "simple", "discuss"])("defaults new %s tickets to first-party GPT-6 Astra", (kind) => {
    expect(normalizeDevTicketInput({ title: "t", body: "b", requester: "alice", kind }).model)
      .toBe("codex-gpt-6-astra");
  });

  it.each(["codex-runner"])("offers GPT-6 Astra through explicit %s routing", (family) => {
    const model = `${family}-gpt-6-astra`;
    expect(normalizeDevTicketInput({ title: "t", body: "b", requester: "alice", model }).model).toBe(model);
    expect(cliFamilyForModel(model)).toBe(family);
    expect(modelIdForCli(model)).toBe("gpt-6-astra");
  });

  it("offers GPT-6 Astra through the first-party Codex backend", () => {
    expect(DEV_TICKET_MODELS.has("codex-gpt-6-astra")).toBe(true);
    expect(normalizeDevTicketInput({
      title: "t", body: "b", requester: "alice", model: "codex-gpt-6-astra",
    }).model).toBe("codex-gpt-6-astra");
    expect(cliFamilyForModel("codex-gpt-6-astra")).toBe("codex");
    expect(modelIdForCli("codex-gpt-6-astra")).toBe("gpt-6-astra");
  });

  it("offers Fable 5.1 and retires Fable 5 for newly filed tickets", () => {
    expect(FABLE_TICKET_MODEL).toBe("claude-fable-5-1");
    expect(DEV_TICKET_MODELS.has(FABLE_TICKET_MODEL)).toBe(true);
    expect(DEV_TICKET_MODELS.has("claude-fable-5")).toBe(false);
    expect(normalizeDevTicketInput({
      title: "t", body: "b", requester: "alice", model: FABLE_TICKET_MODEL,
    }).model).toBe(FABLE_TICKET_MODEL);
    expect(normalizeDevTicketInput({
      title: "t", body: "b", requester: "alice", model: "claude-fable-5",
    }).model).toBe(DEV_TICKET_MODEL_DEFAULT);
  });

  it("normalizes defaults and clamps unknown user choices before persistence", () => {
    expect(normalizeDevTicketInput({ title: "t", body: "b", requester: "alice" })).toMatchObject({
      kind: "complex",
      app_id: null,
      model: DEV_TICKET_MODEL_DEFAULT,
      effort: DEV_TICKET_EFFORT_DEFAULT,
    });
    expect(normalizeDevTicketInput({
      title: "t",
      body: "b",
      requester: "alice",
      kind: "trivial",
      app_id: "session-plus",
      model: "sonnet",
      effort: "ultra",
    })).toMatchObject({ kind: "complex", app_id: null, model: DEV_TICKET_MODEL_DEFAULT, effort: "xhigh" });
  });

  it("keeps only a normalized app id on app tickets", () => {
    expect(normalizeDevTicketInput({
      title: "t", body: "b", requester: "alice", kind: "app", app_id: "  session-plus  ",
    }).app_id).toBe("session-plus");
    expect(normalizeDevTicketInput({
      title: "t", body: "b", requester: "alice", kind: "simple", app_id: "session-plus",
    }).app_id).toBeNull();
  });

  it("keeps max effort as an explicit ticket choice", () => {
    expect(normalizeDevTicketInput({
      title: "t", body: "b", requester: "alice", effort: "max",
    }).effort).toBe("max");
  });

  it("preserves one bounded immutable knowledge conflict subject", () => {
    expect(normalizeDevTicketInput({
      title: "t",
      body: "b",
      requester: "alice",
      knowledge_subject_id: `  ${"x".repeat(500)}  `,
    }).knowledge_subject_id).toBe("x".repeat(400));
    expect(normalizeDevTicketInput({
      title: "t",
      body: "b",
      requester: "alice",
      knowledge_subject_id: "   ",
    }).knowledge_subject_id).toBeNull();
  });

  it("routes model ids to the same CLI family and naked id", () => {
    expect(cliFamilyForModel("codex-gpt-5.6-sol")).toBe("codex");
    expect(modelIdForCli("codex-gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(cliFamilyForModel("claude-opus-5")).toBe("claude");
    expect(modelIdForCli("claude-opus-5")).toBe("claude-opus-5");
  });

  it("routes the own-runner Codex model ahead of the plain codex prefix (#358)", () => {
    expect(cliFamilyForModel("codex-runner-gpt-5.6-sol")).toBe("codex-runner");
    expect(modelIdForCli("codex-runner-gpt-5.6-sol")).toBe("gpt-5.6-sol");
    // The stored model is a legal ticket choice, not clamped to the default.
    expect(normalizeDevTicketInput({
      title: "t", body: "b", requester: "lilei", model: "codex-runner-gpt-5.6-sol",
    }).model).toBe("codex-runner-gpt-5.6-sol");
  });

  it("serves one catalog that labels every offered id and keeps retired ids readable", () => {
    const catalog = ticketModelCatalog();
    const ids = catalog.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const model of DEV_TICKET_MODELS) expect(ids).toContain(model);
    expect(ids).toContain(DEV_TICKET_MODEL_DEFAULT);
    // Persisted rows the filing form no longer offers still have a label.
    for (const retired of ["claude-fable-5", "codex-native", "claude-native"]) {
      expect(ids).toContain(retired);
      expect(DEV_TICKET_MODELS.has(retired)).toBe(false);
    }
    for (const row of catalog) {
      expect(row.label.trim()).not.toBe("");
      expect(row.family).toBe(cliFamilyForModel(row.id));
    }
    expect(catalog.find((row) => row.id === "omp-opus")).toEqual({ id: "omp-opus", label: "omp · Opus", family: "omp" });
    expect(catalog.find((row) => row.id === "claude-opus-5-5")).toMatchObject({ label: "Opus 5.5", family: "claude" });
  });

  it("offers every catalogued choice to bot-host tickets and only Runner-placeable ones to Runner tickets", () => {
    expect(offeredTicketModels(false)).toEqual([...DEV_TICKET_MODELS]);
    expect(offeredTicketModels(true)).toEqual([
      "claude-opus-5-5",
      "claude-opus-4-7",
      "claude-opus-5",
      "codex-gpt-6-astra",
      "codex-gpt-5.6-sol",
      "codex-gpt-5.6-terra",
      "codex-gpt-5.6-luna",
      "codex-gpt-5.5",
    ]);
  });

  it("makes CLI delivery defaults explicit before the Store call", () => {
    expect(normalizeCliDeliveryTicketInput({
      title: "CLI",
      body: "done",
      spec: "works",
      requester: "alice",
      branch: "dev/x",
      commit_sha: "a".repeat(40),
    })).toMatchObject({ model: DEV_TICKET_MODEL_DEFAULT, effort: DEV_TICKET_EFFORT_DEFAULT });
  });
});
