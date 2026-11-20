import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CODEX_CONTINUATION_PROTOCOL, DEFAULT_CODEX_CONTINUATION, readCodexContinuationSettings, validateCodexContinuationPrompt, type CodexContinuationSettings } from "@claude-bot/agent-sessions-contract";
import { normalizeProviderSessionRef, snapshotProviderSessionRef, type ProviderSessionRef, type StoredProviderSessionRef } from "./provider-session-ref.js";

interface Entry { session: ProviderSessionRef; settings: CodexContinuationSettings }

/** User configuration outlives completed/stopped recovery records. No original task prompts. */
export class CodexContinuationStore {
  private entries = new Map<string, Entry>();
  private queue: Promise<void> = Promise.resolve();
  private unavailable = false;
  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (raw.version !== 1 || !Array.isArray(raw.entries) || raw.entries.length > 4096) throw new Error("invalid continuation settings");
      const entries = new Map<string, Entry>();
      for (const row of raw.entries) {
        const session = normalizeProviderSessionRef(row.session);
        const settings = readCodexContinuationSettings(row.settings);
        if (!settings || entries.has(session.logicalId)) throw new Error("invalid continuation entry");
        entries.set(session.logicalId, { session, settings });
      }
      this.entries = entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.unavailable = true;
    }
  }

  sessionRefs(): StoredProviderSessionRef[] {
    return [...this.entries.values()].map(({ session }) => ({ provider: "codex", ...session }));
  }

  read(session: ProviderSessionRef): CodexContinuationSettings {
    if (this.unavailable) throw new Error("续接设置无法读取；未使用默认值覆盖，请检查 Runner 配置文件");
    return { ...(this.entries.get(session.logicalId)?.settings ?? {
      protocol: CODEX_CONTINUATION_PROTOCOL, prompt: null, effectivePrompt: DEFAULT_CODEX_CONTINUATION, revision: "0",
    }) };
  }

  async save(session: ProviderSessionRef, prompt: unknown, expectedRevision: unknown): Promise<CodexContinuationSettings> {
    const text = validateCodexContinuationPrompt(prompt);
    let result!: CodexContinuationSettings;
    await this.mutate(async entries => {
      const current = this.read(session);
      if (typeof expectedRevision !== "string" || current.revision !== expectedRevision) throw new Error("设置已变化，请重新读取后保存");
      if (!entries.has(session.logicalId) && entries.size >= 4096) throw new Error("已达到会话续接设置数量上限");
      result = { protocol: CODEX_CONTINUATION_PROTOCOL, prompt: text, effectivePrompt: text ?? DEFAULT_CODEX_CONTINUATION, revision: randomUUID() };
      entries.set(session.logicalId, { session: snapshotProviderSessionRef(session), settings: result });
    });
    return result;
  }

  async renamed(session: ProviderSessionRef): Promise<void> {
    if (!this.entries.has(session.logicalId)) return;
    await this.mutate(async entries => {
      const entry = entries.get(session.logicalId);
      if (entry) entries.set(session.logicalId, { ...entry, session: snapshotProviderSessionRef(session) });
    });
  }

  private async mutate(change: (entries: Map<string, Entry>) => Promise<void>): Promise<void> {
    const work = this.queue.then(async () => {
      if (this.unavailable) throw new Error("续接设置文件不可用，未保存");
      const next = new Map(this.entries);
      await change(next);
      const directory = path.dirname(this.file);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        const file = await fs.open(temp, "wx", 0o600);
        try { await file.writeFile(JSON.stringify({ version: 1, entries: [...next.values()] }) + "\n"); await file.sync(); }
        finally { await file.close(); }
        await fs.rename(temp, this.file);
        const dir = await fs.open(directory, "r");
        try { await dir.sync(); } finally { await dir.close(); }
        this.entries = next;
      } finally { await fs.unlink(temp).catch(() => {}); }
    });
    this.queue = work.catch(() => {});
    await work;
  }
}
