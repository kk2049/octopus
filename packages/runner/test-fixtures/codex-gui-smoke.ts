/** Opt-in real GUI smoke: xvfb-run -a pnpm exec tsx <this file> <ChatGPT executable>.
 * No production auth/config is read. All model responses come from loopback.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { _electron } from "playwright";
import { CodexDesktopSession } from "../src/codex-desktop.js";

const executablePath = process.argv[2];
assert(executablePath, "Pass the isolated official Codex GUI executable");
const root = await mkdtemp(join(tmpdir(), "octopus-gui-smoke-"));
const codexHome = join(root, ".codex"); await mkdir(codexHome);
let mode: "success" | "failure" | "hold" = "success";
let requests = 0;
const server = createServer(async (req, res) => {
  // Drain request data locally, never forward it or use real credentials.
  for await (const _chunk of req) { /* discard fixture prompts */ }
  if (!req.url?.includes("/responses")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [], models: [] })); return; }
  requests++;
  if (mode === "failure") { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "placeholder failure", type: "invalid_request_error" } })); return; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const id = "fixture-" + requests;
  const event = (value: unknown) => res.write("data: " + JSON.stringify(value) + "\n\n");
  event({ type: "response.created", response: { id, status: "in_progress", output: [] } });
  if (mode === "hold") return;
  const item = { id: "msg-" + id, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "placeholder reply", annotations: [] }] };
  event({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  event({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "placeholder reply" });
  event({ type: "response.output_item.done", output_index: 0, item });
  event({ type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
  res.end();
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
await writeFile(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-placeholder-not-real" }));
await writeFile(join(codexHome, "config.toml"), `model="gpt-5.4"
model_provider="placeholder"
[model_providers.placeholder]
name="Placeholder"
base_url="http://127.0.0.1:${port}/v1"
wire_api="responses"
requires_openai_auth=false
[analytics]
enabled=false
`);
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
let follower: CodexDesktopSession | null = null;
try {
  app = await _electron.launch({ executablePath,
    args: ["--no-sandbox", "--disable-gpu", "--user-data-dir=" + join(root, "gui"), "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=localhost;127.0.0.1"],
    env: { PATH: "/usr/bin:/bin", HOME: root, CODEX_HOME: codexHome, DISPLAY: process.env.DISPLAY!, XAUTHORITY: process.env.XAUTHORITY!,
      OPENAI_API_KEY: "sk-placeholder-not-real", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "localhost,127.0.0.1",
      CODEX_CLI_PATH: join(dirname(executablePath), "resources/codex") } });
  const page = await app.firstWindow(); await page.waitForTimeout(8000);
  if (await page.getByRole("button", { name: "Skip", exact: true }).count()) await page.getByRole("button", { name: "Skip", exact: true }).click();
  const guiSend = async (prompt: string) => {
    await page.getByRole("textbox").fill(prompt); await page.getByRole("textbox").press("Enter");
    await page.getByText("placeholder reply", { exact: true }).last().waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    assert(!(await page.locator("body").innerText()).includes("hit a snag"));
  };
  await guiSend("placeholder GUI initial");
  const sessionId = JSON.parse((await readFile(join(codexHome, "session_index.jsonl"), "utf8")).trim().split("\n").at(-1)!).id;
  const open = async () => { follower = await CodexDesktopSession.connect(sessionId, { codexHome, timeoutMs: 15000 }); assert(follower); return follower; };
  const good = await (await open()).dispatch("placeholder Runner success");
  assert.equal((await good.completion).ok, true); await follower!.close();
  await page.getByText("placeholder Runner success", { exact: true }).waitFor();
  await guiSend("placeholder GUI after Runner success");
  console.log("PASS GUI -> Runner follower -> GUI, no competing writer");

  mode = "failure";
  const failed = await (await open()).dispatch("placeholder Runner provider error");
  assert.equal((await failed.completion).ok, false); await follower!.close(); mode = "success";
  await guiSend("placeholder GUI after provider error");
  console.log("PASS provider error releases follower; GUI continues");

  mode = "hold";
  const held = await (await open()).dispatch("placeholder Runner interrupt");
  await follower!.interrupt(); assert.equal((await held.completion).status, "interrupted"); await follower!.close(); mode = "success";
  await guiSend("placeholder GUI after interrupt");
  console.log("PASS exact-turn stop; GUI continues");

  mode = "hold";
  const detached = await (await open()).dispatch("placeholder Runner disconnect");
  await follower!.close(); assert.equal((await detached.completion).ok, false);
  const stop = page.getByRole("button", { name: /stop/i });
  await stop.first().click(); mode = "success"; await page.waitForTimeout(600);
  await guiSend("placeholder GUI after Runner disconnect");
  console.log("PASS Runner close disconnects only its follower; GUI can stop and continue");
  assert(requests >= 8); console.log(JSON.stringify({ result: "passed", local_api_requests: requests, real_api_tokens: 0 }));
} finally {
  await follower?.close(); await app?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
