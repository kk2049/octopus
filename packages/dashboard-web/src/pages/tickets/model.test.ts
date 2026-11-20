import { afterEach, describe, expect, it } from "vitest";
import { applyLanguage } from "../../i18n/language.js";
import { ticketModelLabel, ticketModelSource, type TicketModelChoice } from "./model.js";

// A server-shaped catalog fixture; the browser itself keeps no model table.
const catalog: TicketModelChoice[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5", family: "claude" },
  { id: "codex-gpt-6-astra", label: "Codex · GPT-6 Astra", family: "codex" },
  { id: "codex-runner-gpt-6-astra", label: "Codex · GPT-6 Astra", family: "codex-runner" },
  { id: "omp-opus", label: "omp · Opus", family: "omp" },
  { id: "codex-native", label: "Codex · 原生 CLI", family: "codex" },
];

describe("ticket model labels from the server catalog", () => {
  afterEach(() => applyLanguage("zh-CN"));

  it("uses the server label and shows an id the catalog does not name as itself", () => {
    expect(ticketModelLabel("claude-opus-5-5", catalog)).toBe("Opus 5.5");
    expect(ticketModelLabel("omp-opus", catalog)).toBe("omp · Opus");
    expect(ticketModelLabel("claude-retired-model", catalog)).toBe("claude-retired-model");
    expect(ticketModelLabel("codex-gpt-6-astra", undefined)).toBe("codex-gpt-6-astra");
  });

  it("localizes the own-Runner qualifier of the codex-runner lane", () => {
    expect(ticketModelLabel("codex-runner-gpt-6-astra", catalog)).toBe("Codex · GPT-6 Astra · 我的 Runner");
    applyLanguage("en");
    expect(ticketModelLabel("codex-runner-gpt-6-astra", catalog)).toBe("Codex · GPT-6 Astra · My Runner");
  });

  it("puts the Codex account marker only on Codex-family labels", () => {
    expect(ticketModelLabel("codex-gpt-6-astra", catalog, "b")).toBe("Codex-b · GPT-6 Astra");
    expect(ticketModelLabel("codex-runner-gpt-6-astra", catalog, "b")).toBe("Codex-b · GPT-6 Astra · 我的 Runner");
    expect(ticketModelLabel("codex-native", catalog, "a")).toBe("Codex-a · 原生 CLI");
    expect(ticketModelLabel("omp-opus", catalog, "b")).toBe("omp · Opus");
    expect(ticketModelLabel("claude-opus-5-5", catalog, "b")).toBe("Opus 5.5");
  });

  it("maps the routing family to the Agent source family; omp is never Claude", () => {
    expect(ticketModelSource(catalog, "omp-opus")).toBe("omp");
    expect(ticketModelSource(catalog, "codex-runner-gpt-6-astra")).toBe("codex");
    expect(ticketModelSource(catalog, "claude-opus-5-5")).toBe("claude");
    expect(ticketModelSource(catalog, "unknown")).toBeUndefined();
  });
});
