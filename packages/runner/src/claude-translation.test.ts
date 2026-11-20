import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fakeExecutables } from "../../../tools/test-support/fake-executables.mjs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionRich } from "@claude-bot/plugin-sessions/scan";
import {
  ClaudeTranslationService,
  finalAssistantText,
  ompAcpTranslationArgs,
  parseAcpTranslationEnvelope,
  runOmpAcpTranslation,
  type OmpTranslationRequest,
} from "./claude-translation.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-translation-"));
  roots.push(root);
  return root;
}

describe("ClaudeTranslationService", () => {
  it("uses one ephemeral capability-free no-thinking OMP ACP turn", () => {
    const args = ompAcpTranslationArgs("zh-en", "/work/project", "/tmp/acp-store");
    expect(args).toEqual(expect.arrayContaining([
      "acp",
      "--model", "gpt-5.6-sol",
      "--thinking", "off",
      "--no-tools",
      "--no-session",
      "--session-dir", "/tmp/acp-store",
      "--no-extensions",
      "--no-skills",
      "--no-rules",
      "--no-lsp",
      "--cwd", "/work/project",
    ]));
    expect(args).not.toContain("-p");
    expect(args.join(" ")).not.toContain("检查构建");
  });


  it("rejects ACP provider errors that arrive as ordinary assistant prose", () => {
    expect(parseAcpTranslationEnvelope(
      '{"nonce":"turn-1","translation":"Check the build."}',
      "turn-1",
    )).toBe("Check the build.");
    expect(() => parseAcpTranslationEnvelope("HTTP 400 model_not_supported", "turn-1"))
      .toThrow(/结构化翻译/);
    expect(() => parseAcpTranslationEnvelope(
      '{"nonce":"wrong","translation":"HTTP 400 model_not_supported"}',
      "turn-1",
    )).toThrow(/信封校验失败/);
  });

  it("reads the first envelope when the ACP session speaks more than once", () => {
    // An advisor pass makes the model answer twice in one prompt turn; the two
    // envelopes concatenated are not JSON, which used to abort the launch.
    const envelope = '{"nonce":"turn-1","translation":"Check the {build}."}';
    expect(parseAcpTranslationEnvelope(`${envelope}${envelope}`, "turn-1"))
      .toBe("Check the {build}.");
    expect(parseAcpTranslationEnvelope(`\`\`\`json\n${envelope}\n\`\`\``, "turn-1"))
      .toBe("Check the {build}.");
  });
  it("persists and decorates only user and final assistant prose", async () => {
    const root = await home();
    const requests: OmpTranslationRequest[] = [];
    const service = new ClaudeTranslationService(root, {
      run: async (request) => {
        requests.push(request);
        return request.direction === "zh-en" ? "Check the build." : "构建已通过。";
      },
      now: () => new Date("2026-08-21T10:00:00.000Z"),
    });

    const prompt = await service.translateUser("  检查构建。\n", root);
    expect(prompt).toMatchObject({ zh: "  检查构建。\n", en: "Check the build." });
    await service.recordUser("claude-session", prompt!);
    await expect(service.translateAssistant(
      "claude-session",
      prompt!.turnId,
      "The build\n\npasses.",
      root,
    )).resolves.toEqual({
      ok: true,
      bilingual: { zh: "构建已通过。", en: "The build\n\npasses." },
    });

    const decorated = await service.decorateTranscript({
      meta: { id: "claude-session", source: "claude" },
      rich: true,
      messages: [
        { role: "user", blocks: [{ type: "text", text: "Check the build." }] },
        { role: "assistant", blocks: [{ type: "tool", tool: "Bash", output: "private tool material" }] },
        { role: "assistant", blocks: [{ type: "text", text: "The build" }, { type: "text", text: "passes." }] },
      ],
    }) as Record<string, any>;

    expect(decorated.messages[0].blocks[0].bilingual)
      .toEqual({ zh: "检查构建。", en: "Check the build." });
    expect(decorated.messages[1].blocks[0]).not.toHaveProperty("bilingual");
    expect(decorated.messages[2].blocks).toEqual([expect.objectContaining({
      text: "The build\n\npasses.",
      bilingual: { zh: "构建已通过。", en: "The build\n\npasses." },
    })]);
    expect(requests.map(({ direction, text }) => ({ direction, text }))).toEqual([
      { direction: "zh-en", text: "  检查构建。\n" },
      { direction: "en-zh", text: "The build\n\npasses." },
    ]);
    expect(JSON.stringify(requests)).not.toContain("private tool material");
  });

  it("preserves complete long user and assistant prose in both display languages", async () => {
    const root = await home();
    const chinese = `${"中文\n".repeat(7_000)}最后一段🙂`;
    const english = `${"English\n".repeat(3_000)}Final paragraph.`;
    const service = new ClaudeTranslationService(root, {
      run: async ({ direction }) => direction === "zh-en" ? english : chinese,
    });
    const prompt = await service.translateUser(chinese, root);
    await service.recordUser("long-session", prompt);
    await service.translateAssistant("long-session", prompt.turnId, english, root);

    const transcript = parseSessionRich("claude", ["user", "assistant"].map((role) => JSON.stringify({
      type: role,
      sessionId: "long-session",
      message: { role, content: [{ type: "text", text: english }] },
    })).join("\n"));

    const decorated = await service.decorateTranscript(transcript) as Record<string, any>;
    expect(decorated.messages).toHaveLength(2);
    for (const message of decorated.messages) {
      const block = message.blocks[0];
      expect(block.bilingual?.en.length).toBe(english.length);
      expect(block.bilingual?.zh.length).toBe(chinese.length);
      expect(block).toEqual({ type: "text", text: english, bilingual: { en: english, zh: chinese } });
    }
  });

  it("tracks English-only prompts without a translation model call", async () => {
    const root = await home();
    let calls = 0;
    const service = new ClaudeTranslationService(root, {
      run: async () => {
        calls += 1;
        return "unused";
      },
    });
    await expect(service.translateUser("Check the build.", root)).resolves.toMatchObject({
      en: "Check the build.",
    });
    expect(calls).toBe(0);
  });

  it("extracts the last human-facing assistant text and ignores tools", () => {
    expect(finalAssistantText([
      { role: "assistant", blocks: [{ type: "text", text: "Earlier" }] },
      {
        role: "assistant",
        blocks: [
          { type: "thinking", text: "private reasoning" },
          { type: "tool", tool: "Bash", input: "private input", output: "private output" },
        ],
      },
      {
        role: "assistant",
        blocks: [
          { type: "text", text: "Final paragraph one." },
          { type: "text", text: "Final paragraph two." },
        ],
      },
    ])).toBe("Final paragraph one.\n\nFinal paragraph two.");
  });

  it("translates a pending external Claude turn from its Stop transcript", async () => {
    const root = await home();
    const transcriptDir = path.join(root, ".claude", "projects", "project");
    await mkdir(transcriptDir, { recursive: true });
    const transcript = path.join(transcriptDir, "session.jsonl");
    await writeFile(transcript, [
      JSON.stringify({
        type: "user",
        timestamp: "2026-08-21T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Check it." }] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-21T10:00:01.000Z",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { secret: "no" } }] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-21T10:00:02.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "It is done." }] },
      }),
    ].join("\n"));

    const requests: OmpTranslationRequest[] = [];
    const service = new ClaudeTranslationService(root, {
      run: async (request) => {
        requests.push(request);
        return request.direction === "zh-en" ? "Check it." : "完成了。";
      },
    });
    const prompt = await service.translateUser("检查一下。", root);
    await service.recordUser("session", prompt!);
    await service.observeClaudeHook({
      hook_event_name: "Stop",
      session_id: "session",
      transcript_path: transcript,
      cwd: root,
    });

    expect(requests.map((request) => request.text)).toEqual(["检查一下。", "It is done."]);
    expect(JSON.stringify(requests)).not.toContain("secret");
  });
});

/**
 * A stand-in `omp acp` that answers the prompt turn twice — the shape a real
 * OMP session takes when its advisor runtime reviews the turn — and then never
 * closes session/prompt. Only a client that finishes on the first envelope can
 * translate against it.
 */
const FAKE_OMP = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.OMP_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
const say = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const chunk = (text) => say({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
});
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  buffer += data;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === 1) say({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
    else if (message.id === 2) say({ jsonrpc: "2.0", id: 2, result: { sessionId: "s1" } });
    else if (message.id === 3) {
      const { nonce } = JSON.parse(message.params.prompt[0].text);
      const envelope = JSON.stringify({ nonce, translation: "Check the build." });
      chunk(envelope.slice(0, 20));
      chunk(envelope.slice(20));
      chunk(envelope);
    }
  }
});
`;

describe("runOmpAcpTranslation", () => {
  it("finishes on the first envelope and keeps its session out of the roster", async () => {
    const root = await home();
    // Only this fake omp is reachable; a real one never answers the test.
    const fake = fakeExecutables({ omp: FAKE_OMP }, { home: root });
    const argvFile = path.join(root, "argv.json");
    const priorArgvFile = process.env.OMP_ARGV_FILE;
    fake.apply();
    process.env.OMP_ARGV_FILE = argvFile;
    try {
      await expect(runOmpAcpTranslation({ direction: "zh-en", text: "检查构建。", cwd: root }))
        .resolves.toBe("Check the build.");
    } finally {
      fake.cleanup();
      if (priorArgvFile === undefined) delete process.env.OMP_ARGV_FILE;
      else process.env.OMP_ARGV_FILE = priorArgvFile;
    }

    const argv: string[] = JSON.parse(await readFile(argvFile, "utf8"));
    const sessionDir = argv[argv.indexOf("--session-dir") + 1];
    expect(path.dirname(String(sessionDir))).toBe(os.tmpdir());
    expect(path.basename(String(sessionDir))).toMatch(/^octopus-acp-translation-/);
    await expect(readdir(String(sessionDir))).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);
});
