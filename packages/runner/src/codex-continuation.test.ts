import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CodexContinuationStore } from "./codex-continuation.js";
import { ManagedRecoveryJournal } from "./managed-recovery.js";
import { ProviderSessionRefs } from "./provider-session-ref.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-continuation-")); roots.push(root);
  const file = join(root, "settings.json");
  return { root, file, settings: new CodexContinuationStore(file), refs: new ProviderSessionRefs() };
}

it.each(["Please continue.\nKeep using English.", "繼續執行", "  请继续  "])("persists exact text after completion, Stop and restart: %s", async prompt => {
  const f = fixture(), ref = f.refs.reference("codex", "one");
  await f.settings.load();
  expect(f.settings.read(ref).effectivePrompt).toBe("继续执行");
  const saved = await f.settings.save(ref, prompt, "0");
  const journal = new ManagedRecoveryJournal({ stateFile: join(f.root, "recovery.json") });
  await journal.prepare({ provider: "codex", session: ref, cwd: f.root }); await journal.activate("codex", ref, "turn");
  await journal.complete("codex", ref, "turn"); await journal.disarm("codex", ref);
  expect(journal.snapshot()).toEqual([]);
  const next = new CodexContinuationStore(f.file); await next.load();
  expect(next.read(ref)).toEqual(saved);
  expect(next.read(f.refs.reference("codex", "other")).effectivePrompt).toBe("继续执行");
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
  await next.save(ref, null, saved.revision);
  const reset = new CodexContinuationStore(f.file); await reset.load();
  expect(reset.read(ref)).toMatchObject({ prompt: null, effectivePrompt: "继续执行" });
});

it("serializes concurrent CAS writes and preserves settings across provider rename", async () => {
  const f = fixture(), ref = f.refs.reference("codex", "original"); await f.settings.load();
  const results = await Promise.allSettled([f.settings.save(ref, "English", "0"), f.settings.save(ref, "繁體", "0")]);
  expect(results.map(x => x.status)).toEqual(["fulfilled", "rejected"]);
  const renamed = { logicalId: "original", currentProviderId: "new", lineage: ["original", "new"] };
  await f.settings.renamed(renamed);
  const next = new CodexContinuationStore(f.file); await next.load();
  const refs = new ProviderSessionRefs({ restored: next.sessionRefs() });
  expect(next.read(refs.reference("codex", "new")).effectivePrompt).toBe("English");
  expect(next.read(refs.reference("codex", "original")).effectivePrompt).toBe("English");
});

it("rejects malformed text and corrupt storage instead of silently resetting it", async () => {
  const f = fixture(), ref = f.refs.reference("codex", "one"); await f.settings.load();
  for (const value of ["", "  ", "x".repeat(4001), "x\0y", 123]) await expect(f.settings.save(ref, value, "0")).rejects.toThrow();
  writeFileSync(f.file, "broken"); const next = new CodexContinuationStore(f.file); await next.load();
  expect(() => next.read(ref)).toThrow(/无法读取/);
  await expect(next.save(ref, "Please continue", "0")).rejects.toThrow(/不可用/);
});

it("does not report a new setting or change memory when persistence fails", async () => {
  const f = fixture(), ref = f.refs.reference("codex", "one");
  const directory = join(f.root, "blocked");
  const settings = new CodexContinuationStore(join(directory, "settings.json"));
  await settings.load();
  writeFileSync(directory, "not a directory");
  await expect(settings.save(ref, "Please continue", "0")).rejects.toThrow();
  expect(settings.read(ref)).toMatchObject({ prompt: null, revision: "0" });
});
