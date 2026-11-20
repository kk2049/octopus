import { ScopedMcpProxy } from "./scoped-mcp-proxy.js";

interface Entry { proxy: ScopedMcpProxy; url: string; leases: number; lastUsed: number; timer?: NodeJS.Timeout }
export interface DevelopmentMcpCredential { developmentId: string; endpoint: string; token: string }
const ID = /^[a-zA-Z0-9_-]{1,100}$/;

/** Live credentials never enter a journal. One provider configuration survives Head token rotation. */
export class DevelopmentMcpManager {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private closed = false;
  private opening = 0;
  constructor(private readonly options: { idleMs?: number; capacity?: number } = {}) {}

  credential(raw: Readonly<Record<string, unknown>>): DevelopmentMcpCredential | null {
    const values = [raw._octopus_development_id, raw._octopus_development_mcp_url, raw._octopus_development_mcp_token];
    if (values.every((value) => value === undefined)) return null;
    if (values.some((value) => typeof value !== "string" || !value)
      || !ID.test(String(values[0])) || String(values[1]).length > 2048 || String(values[2]).length > 512) {
      throw new Error("开发 MCP 绑定不完整");
    }
    return { developmentId: String(values[0]), endpoint: String(values[1]), token: String(values[2]) };
  }

  async renew(site: string | undefined, credential: DevelopmentMcpCredential): Promise<string> {
    if (this.closed) throw new Error("开发 MCP 已关闭");
    const key = JSON.stringify([site ?? "primary", credential.developmentId]);
    const run = async () => {
      if (this.closed) throw new Error("开发 MCP 已关闭");
      let entry = this.entries.get(key);
      if (entry) {
        this.touch(key, entry);
        await entry.proxy.renew(new URL(credential.endpoint), credential.token);
        if (this.closed || this.entries.get(key) !== entry) throw new Error("开发 MCP 已关闭");
      } else {
        let evict: [string, Entry] | undefined;
        if (this.entries.size + this.opening >= (this.options.capacity ?? 64)) {
          const idle = [...this.entries.entries()].filter(([, value]) => value.leases === 0)
            .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
          if (!idle) throw new Error("开发 MCP 并发容量已满");
          evict = idle;
        }
        const proxy = new ScopedMcpProxy(new URL(credential.endpoint), credential.token,
          { revokeOnClose: false, requiredTool: "devpipe_status", onRequest: () => {
            const current = this.entries.get(key); if (current) this.touch(key, current);
          } });
        this.opening++;
        try {
          if (evict) await this.remove(evict[0], evict[1]);
          const url = await proxy.start();
          if (this.closed) throw new Error("开发 MCP 已关闭");
          entry = { proxy, url, leases: 0, lastUsed: Date.now() };
          this.entries.set(key, entry);
        } catch (error) { await proxy.close(); throw error; }
        finally { this.opening--; }
      }
      this.touch(key, entry);
      return entry.url;
    };
    const promise = (this.pending.get(key) ?? Promise.resolve()).then(run, run);
    this.pending.set(key, promise);
    try { return await promise; } finally { if (this.pending.get(key) === promise) this.pending.delete(key); }
  }

  retain(site: string | undefined, developmentId: string): () => void {
    const key = JSON.stringify([site ?? "primary", developmentId]), entry = this.entries.get(key);
    if (!entry || this.closed) throw new Error("开发 MCP 未准备");
    entry.leases++; this.touch(key, entry);
    let released = false;
    return () => {
      if (released) return; released = true; entry.leases--;
      if (this.entries.get(key) === entry) this.touch(key, entry);
    };
  }

  private touch(key: string, entry: Entry): void {
    entry.lastUsed = Date.now(); clearTimeout(entry.timer);
    if (entry.leases) return;
    entry.timer = setTimeout(() => { void this.remove(key, entry); }, this.options.idleMs ?? 30 * 60_000);
    entry.timer.unref();
  }
  private async remove(key: string, entry: Entry): Promise<void> {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key); clearTimeout(entry.timer);
    await entry.proxy.close();
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.entries].map(([key, entry]) => this.remove(key, entry)));
    await Promise.allSettled([...this.pending.values()]);
  }
}
