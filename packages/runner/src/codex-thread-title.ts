/**
 * Codex TUI 0.154.0 parity: tui/src/app/thread_title.rs and
 * tui/src/temporary_structured_request.rs in openai/codex (Apache-2.0).
 * Keep title work on the originating account's app-server, outside its conversation.
 */
export const CODEX_TITLE_MODEL = "gpt-5.6-luna";
const TITLE_CHARS = 36;
const REQUEST_BYTES = 960;
const RESPONSE_BYTES = 8 * 1024;
const TIMEOUT_MS = 30_000;

export function codexTitlePrompt(message: string): string {
  const prefix = "Generate a concise, single-line task title of at most 36 characters and under five words where possible. "
    + "Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. "
    + "Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. "
    + "Do not answer the request.\n\nUser prompt:\n";
  let remaining = REQUEST_BYTES - Buffer.byteLength(prefix);
  let bounded = "";
  for (const character of message.trim()) {
    remaining -= Buffer.byteLength(character);
    if (remaining < 0) break;
    bounded += character;
  }
  return prefix + bounded;
}

export function parseCodexTitle(response: string): string | undefined {
  if (Buffer.byteLength(response) > RESPONSE_BYTES) return;
  try {
    const parsed = record(JSON.parse(response));
    if (Object.keys(parsed).length !== 1 || typeof parsed.title !== "string") return;
    const title = parsed.title.trim().replace(/^["'\x60“”‘’]+|["'\x60“”‘’]+$/gu, "")
      .split(/\s+/u).join(" ").replace(/[.?!]+$/u, "").trimEnd();
    return title ? Array.from(title).slice(0, TITLE_CHARS).join("") : undefined;
  } catch { return; }
}

export interface CodexTitleClient {
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  /** The transport rejects all tool/approval requests from this hidden thread. */
  observeIsolatedThread(id: string, listener: (method: string, params: unknown) => void): () => void;
}

export interface CodexTitleOptions {
  threadId: string;
  model: string;
  modelProvider: string;
  /** Omit for split execution: never use an executor path on the model host. */
  cwd?: string;
  config?: Record<string, unknown>;
}

/** One attempt, bounded across all requests; failures never fail/replay the user turn. */
export async function generateCodexThreadTitle(
  client: CodexTitleClient, options: CodexTitleOptions, prompt: string,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("title deadline reached");
    return ms;
  };
  const request = async (method: string, params: unknown) => record(await client.request(method, params, remaining()));
  let title = Array.from(prompt.trim().split(/\r?\n/u)[0] ?? "").slice(0, TITLE_CHARS).join("");
  let temporaryId: string | undefined;
  let unsubscribe: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    if (!options.model || !options.modelProvider) return;
    // A failed configuration read cannot prove MCP isolation.
    const effective = await request("config/read", {
      includeLayers: false, ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    if (!effective.config || typeof effective.config !== "object" || Array.isArray(effective.config)) return;
    const config = isolatedTitleConfig(record(effective.config), options.config);
    let model = options.model;
    if (options.modelProvider === "openai") {
      // Discovery is optional. An older server keeps the resolved conversation model.
      try {
        const account = record((await request("account/read", { refreshToken: false })).account);
        if (account.type === "chatgpt") {
          let cursor: string | undefined;
          for (let page = 0; page < 5; page++) {
            const models = await request("model/list", { includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}) });
            if (Array.isArray(models.data) && models.data.some(row => record(row).model === CODEX_TITLE_MODEL)) {
              model = CODEX_TITLE_MODEL;
              break;
            }
            const next = text(models.nextCursor);
            if (!next || next === cursor) break;
            cursor = next;
          }
        }
      } catch { /* No speculative model substitution or account switch. */ }
    }
    const started = await request("thread/start", {
      model, modelProvider: options.modelProvider,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      approvalPolicy: "never", sandbox: "read-only",
      runtimeWorkspaceRoots: [], ephemeral: true, environments: [],
      dynamicTools: [], selectedCapabilityRoots: [], config,
    });
    temporaryId = text(record(started.thread).id);
    if (!temporaryId || temporaryId === options.threadId) return;
    // Refuse old servers that ignore the isolation contract.
    if (record(started.sandbox).type !== "readOnly" || record(started.thread).ephemeral !== true) return;

    const events = new Map<string, { response?: string; status?: string; oversized?: boolean }>();
    let expectedTurn = "";
    let resolve!: (response: string) => void;
    let reject!: (error: Error) => void;
    const completed = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    // Observe rejection even when a fast completion overtakes turn/start's reply.
    void completed.catch(() => {});
    const settle = () => {
      const event = events.get(expectedTurn);
      if (event?.oversized) reject(new Error("title response too large"));
      else if (event?.status) {
        if (event.status === "completed" && event.response) resolve(event.response);
        else reject(new Error("title turn did not complete"));
      }
    };
    unsubscribe = client.observeIsolatedThread(temporaryId, (method, params) => {
      const row = record(params);
      const id = method === "turn/completed" ? text(record(row.turn).id) : text(row.turnId);
      if (!id || (expectedTurn && id !== expectedTurn)) return;
      if (!events.has(id) && events.size >= 4) return;
      const event = events.get(id) ?? {};
      events.set(id, event);
      if (method === "item/completed" && record(row.item).type === "agentMessage") {
        const value = text(record(row.item).text);
        if (Buffer.byteLength(value) > RESPONSE_BYTES) event.oversized = true;
        else event.response = value;
      } else if (method === "turn/completed") event.status = text(record(row.turn).status);
      settle();
    });
    timer = setTimeout(() => reject(new Error("title turn timed out")), remaining());
    timer.unref?.();
    const turn = await request("turn/start", {
      threadId: temporaryId,
      input: [{ type: "text", text: codexTitlePrompt(prompt), text_elements: [] }],
      outputSchema: {
        type: "object", properties: { title: { type: "string", minLength: 1, maxLength: TITLE_CHARS } },
        required: ["title"], additionalProperties: false,
      },
      ...(model === CODEX_TITLE_MODEL ? { effort: "low" } : {}),
    });
    expectedTurn = text(record(turn.turn).id);
    if (!expectedTurn) return;
    settle();
    title = parseCodexTitle(await completed) ?? title;
  } catch {
    // No prompt, generated text, credentials or provider error in logs.
    console.debug("[codex] generated title unavailable; using prompt title");
  } finally {
    if (timer) clearTimeout(timer);
    // Even an unavailable title model leaves the first task named. Re-read at
    // the last moment so neither generated nor fallback titles replace a user name.
    if (title) {
      try {
        const current = record(record(await client.request("thread/read", { threadId: options.threadId, includeTurns: false }, 5_000)).thread);
        if (current.id === options.threadId && !text(current.name).trim()) {
          await client.request("thread/name/set", { threadId: options.threadId, name: title }, 5_000);
        }
      } catch { /* Naming never fails or replays the user turn. */ }
    }
    unsubscribe?.();
    if (temporaryId && temporaryId !== options.threadId) {
      await client.request("thread/unsubscribe", { threadId: temporaryId }, 5_000).catch(() => {});
    }
  }
}

function isolatedTitleConfig(effective: Record<string, unknown>, perThread?: Record<string, unknown>): Record<string, unknown> {
  const features = [
    "apps", "code_mode", "code_mode_only", "context_management", "current_time_reminder",
    "deferred_executor", "enable_fanout", "goals", "hooks", "image_generation", "memories",
    "multi_agent", "multi_agent_v2", "plugins", "request_permissions_tool", "shell_snapshot",
    "shell_tool", "standalone_web_search", "token_budget", "tool_suggest", "unified_exec", "view_image",
  ];
  const servers = new Set([
    ...Object.keys(record(effective.mcp_servers)),
    ...Object.keys(record(perThread?.mcp_servers)),
  ]);
  return {
    ...Object.fromEntries(features.map(name => ["features." + name, false])),
    "orchestrator.skills.enabled": false,
    "skills.include_instructions": false,
    "token_budget.use_history_notes_extension": false,
    "tools.experimental_request_user_input.enabled": false,
    "tools.update_plan.enabled": false,
    web_search: "disabled",
    mcp_servers: Object.fromEntries([...servers].map(name => [name, { enabled: false }])),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
