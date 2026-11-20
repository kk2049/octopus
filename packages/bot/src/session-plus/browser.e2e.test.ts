/// <reference lib="dom" />
/**
 * Real-browser acceptance of an independently released App in the Dashboard's
 * React tree. The actual registry, Runtime, State and Gate remain composed here;
 * only the Runner's device I/O is a deterministic fixture.
 *
 * Current releases use digest-pinned ESM/CSS and the shell's shared runtime.
 * Authorization remains server-side. Legacy iframe protocol/isolation coverage
 * stays in the frame-host and view-server suites; it is not the current App's
 * execution boundary. Chromium is required for layout, workers and interaction.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFailed, vi } from "vitest";
import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page } from "playwright";
import { Store } from "../store/store.js";
import { createLightweightPdf, exercisePdfZoomThenResize, observePdfWorkers } from "./pdf-browser-scenarios.js";
import { exerciseFourLiveWindows, exerciseLoadedWorkspaceResize, readOlderPage, readTranscriptWorkload } from "./read-browser-scenarios.js";
import { AppRuntimeService, InProcessRuntimeClient } from "@claude-bot/app-runtime";
import { AppStateService, InProcessStateClient } from "@claude-bot/app-state";
import { DashboardServer, mintDashboardToken } from "../dashboard/server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { resolveSessionPlus, type SessionPlusSettings } from "../app-core/settings.js";
import { sessionPlusIdentity } from "../app-core/identity.js";
import { bundledAppDir } from "../app-core/app-path.js";
import { SessionPlusAppService } from "./app-service.js";
import { RunnerCapabilities } from "../runner/capability.js";
import { hashRunnerToken, type RunnerTransport } from "../runner/gateway.js";
import { createHash } from "node:crypto";
import { AppReleaseRegistry, FileReleaseContentStore } from "@claude-bot/app-registry";
import { WorkspaceFilesCapabilities } from "../workspace-files/capability.js";
import { AgentInteractionCapabilities } from "../agent-interactions/capability.js";
import { StoreReleaseCatalog } from "../app-registry/store-catalog.js";
import { appReleasePaths } from "../app-registry/paths.js";
import {
  SessionPlusReleaseAdapter,
  type PreparedSessionPlusRelease,
} from "../app-registry/session-plus-adapter.js";
import { AppReleaseHost, HostedApp } from "../app-registry/release-host.js";
import { PANEL_RESOURCE_CONTRACTS } from "../dashboard/server.js";
import { DASHBOARD_THEME_SETTING } from "../dashboard/theme-preference.js";
import {
  SESSION_PLUS_OWNER_FILES_WRITE_OPERATIONS,
  SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT,
} from "../session-resource/contract.js";

/** Chromium present? A missing binary is a skip with a reason, never a rewrite. */
function chromiumAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const HAVE_BROWSER = chromiumAvailable();
if (!HAVE_BROWSER) {
  console.warn(
    "[session-plus] Chromium is not installed, so the browser boundary suite is skipped.\n"
      + "  Install it with:  npx playwright install chromium\n"
      + "  Skipped here: same-tree App mounting, immutable assets, CSS scope, server Gate,\n"
      + "  and real session/file/terminal interaction and reconstruction.",
  );
}

const NOW = "2026-08-04T10:00:00.000Z";
const LABEL = sessionPlusIdentity().packageHostLabel;
const APPLE_SCREENSHOT_DIR = process.env.APPLE_THEME_SCREENSHOT_DIR?.trim() || null;

async function captureAppleScreenshot(page: Page, name: string): Promise<void> {
  if (!APPLE_SCREENSHOT_DIR) return;
  mkdirSync(APPLE_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: join(APPLE_SCREENSHOT_DIR, `${name}.jpg`),
    type: "jpeg",
    quality: 82,
  });
}

/**
 * The workspace the fake laptop serves, by relative path.
 *
 * Text, image, PDF and generic download fixtures make the browser exercise the
 * current v4 contract rather than merely asserting its package metadata.
 */
const WS_FILES: Record<string, string> = {
  "readme.md": "# 可编辑工作区浏览\n第一行来自假设备。\n\n![工作区像素](./pixel.png)\n",
  "docs/notes.md": "第二个文件，用来证明独立 editor 标签保持自己的缓冲区。\r\n"
    + Array.from({ length: 90 }, (_, index) => {
      const line = index + 1;
      return line === 74 ? `line-${line}-${"x".repeat(600)}` : `line-${line}`;
    }).join("\n")
    + "\n\n![聊天链接图片](../pixel.png)\n",
};
let ownerDraftText = "owner draft\n";
const WS_MEDIA_FILES: Readonly<Record<string, Buffer>> = Object.freeze({
  "archive.bin": Buffer.from([0x00, 0xff, 0x10, 0x42, 0x7f]),
  "stress.pdf": createLightweightPdf(20),
  "pixel.png": Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
  "sample.pdf": Buffer.from(
    "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUiA0IDAgUl0gL0NvdW50IDIgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgNTAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA2IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgNTAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA2IDAgUiA+PiA+PiAvQ29udGVudHMgNyAwIFIgPj4KZW5kb2JqCjUgMCBvYmoKPDwgL0xlbmd0aCAzOSA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDUwIDQyMiBUZCAoUERGIHBhZ2UgMSkgVGogRVQKZW5kc3RyZWFtCmVuZG9iago2IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKNyAwIG9iago8PCAvTGVuZ3RoIDM5ID4+CnN0cmVhbQpCVCAvRjEgMjQgVGYgNTAgNDIyIFRkIChQREYgcGFnZSAyKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA4CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMjEgMDAwMDAgbiAKMDAwMDAwMDI0NyAwMDAwMCBuIAowMDAwMDAwMzczIDAwMDAwIG4gCjAwMDAwMDA0NjQgMDAwMDAgbiAKMDAwMDAwMDUzNCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDggL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjYyNQolJUVPRgo=",
    "base64",
  ),
});
/**
 * The same laptop seen through the owner's OS account (`access_owner_files`).
 *
 * The registered workspace above lives at `~/projects/session-plus`, which is
 * also the demo session's cwd, so a chat link the Runner resolves against that
 * cwd reaches the very bytes the workspace browser lists. Modes and reply
 * shapes follow `packages/runner/src/workspace-files.ts` and
 * `owner-file-link.ts`; `RunnerWorkspaceFilesBackend` re-validates each one.
 */
const OWNER_HOME = "/home/alice";
const OWNER_SESSION_CWD = `${OWNER_HOME}/projects/session-plus`;
function fakeOwnerFiles(): Map<string, string | Buffer> {
  const files = new Map<string, string | Buffer>([["/owner-draft.txt", ownerDraftText]]);
  for (const [relative, body] of Object.entries(WS_FILES)) files.set(`${OWNER_SESSION_CWD}/${relative}`, body);
  for (const [relative, body] of Object.entries(WS_MEDIA_FILES)) {
    if (relative !== "stress.pdf" || includeStressPdf) files.set(`${OWNER_SESSION_CWD}/${relative}`, body);
  }
  return files;
}
function accessFakeOwnerFiles(args: Record<string, unknown>): Record<string, unknown> {
  const files = fakeOwnerFiles();
  const isDirectory = (at: string) => at === "/" || [...files.keys()].some((file) => file.startsWith(`${at}/`));
  const stat = (at: string) => {
    const body = files.get(at);
    if (body !== undefined) return { status: "ok", mode: "stat", absolute_path: at, kind: "file", size: Buffer.byteLength(body) };
    return isDirectory(at) ? { status: "ok", mode: "stat", absolute_path: at, kind: "directory", size: 4096 }
      : { status: "refused", code: "not_found" };
  };
  if (args.mode === "resolve") {
    // Runner side of `resolve_file_link`: the session (or workspace) fixes the cwd.
    const href = String(args.path ?? "");
    const known = args.workspace_id === "ws_0123456789abcdef01234567"
      || (args.source === "codex" && (args.id === "demo-codex" || liveSessionRows.has(String(args.id))));
    if (!known) return { status: "refused", code: "not_found" };
    return stat(href.startsWith("~/") ? posix.resolve(OWNER_HOME, href.slice(2)) : posix.resolve(OWNER_SESSION_CWD, href));
  }
  const at = String(args.absolute_path ?? "");
  if (!posix.isAbsolute(at) || posix.normalize(at) !== at) return { status: "refused", code: "invalid_path" };
  if (args.mode === "stat") return stat(at);
  if (args.mode === "list") {
    if (!isDirectory(at)) return { status: "refused", code: files.has(at) ? "not_a_directory" : "not_found" };
    const prefix = at === "/" ? "/" : `${at}/`;
    const children = new Map<string, "file" | "directory">();
    for (const file of files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const [name, ...rest] = file.slice(prefix.length).split("/");
      children.set(name!, rest.length > 0 ? "directory" : "file");
    }
    const entries = [...children].sort(([a, ak], [b, bk]) => (ak === bk ? a.localeCompare(b) : ak === "directory" ? -1 : 1))
      .map(([name, kind]) => ({ name, kind, absolute_path: posix.join(at, name),
        ...(kind === "file" ? { size: Buffer.byteLength(files.get(posix.join(at, name))!) } : {}) }));
    return { status: "ok", mode: "list", absolute_path: at, truncated: false, entries };
  }
  const body = files.get(at);
  if (body === undefined) return { status: "refused", code: isDirectory(at) ? "not_a_file" : "not_found" };
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const offset = Number(args.offset) || 0;
  const slice = bytes.subarray(offset, offset + Number(args.max_bytes ?? bytes.byteLength));
  const window = { absolute_path: at, digest, modified_at: NOW, size: bytes.byteLength, offset,
    bytes: slice.byteLength, eof: offset + slice.byteLength === bytes.byteLength };
  if (args.mode === "text") {
    return Buffer.isBuffer(body) ? { status: "refused", code: "not_text" }
      : { status: "ok", mode: "text", encoding: "utf-8", ...window, text: slice.toString("utf8") };
  }
  if (args.mode === "binary" || args.mode === "download") {
    return { status: "ok", mode: args.mode, encoding: "base64", ...window, data: slice.toString("base64") };
  }
  return { status: "refused", code: "invalid_request" };
}
const TERMINAL_FIXTURE_ID = `term_${"a".repeat(48)}`;
let terminalFixtureScreen = "alice@fixture:~/projects/session-plus$ ";

/** Caddy's public observer is the only network fixture substituted in the browser. */
async function idleDeploymentObserver(context: BrowserContext): Promise<void> {
  await context.route((url) => url.pathname === "/__octopus/deploy", (route) => route.fulfill({
    json: { id: null, status: "idle", http_ready: true, observed_at: Date.now() },
  }));
}

/** A port nothing is listening on yet. Good enough for a local test. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

let dir: string;
let store: Store;
let dash: DashboardServer;
let settings: SessionPlusSettings;
let browser: Browser;
let page: Page;
let panelOrigin = "";
let viewOrigin = "";
let token = "";
let app: SessionPlusAppService;
let appState: AppStateService;
let appRuntime: AppRuntimeService;
let caps: RunnerCapabilities;
let workspaceFiles: WorkspaceFilesCapabilities;
let agentInteractions: AgentInteractionCapabilities;
let releases: HostedApp<PreparedSessionPlusRelease, SessionPlusSettings>;
let pendingInteraction = false;
const interactionResponses: Array<Record<string, unknown>> = [];
const runnerFrames: Array<{ owner: string; operation: string; args: Record<string, unknown> }> = [];
let sessionChangeListener: ((owner: string, device: string) => void) | null = null;
/** Browser-side failures retained so a handshake timeout names its real cause. */
const browserDiagnostics: string[] = [];
const appAssetRequests: string[] = [];
let activeInstance = "";
let activeResourceGeneration = "0";
let fixtureReadSequence = 1;
const liveSessionRows = new Map<string, { title: string; sequence: number; text: string; epoch: string }>();
let liveFixtureEpoch = 0;
let includeStressPdf = false;
/** A source event advances the version; reading another window does not. */
function publishFixtureSessionChange(): void {
  fixtureReadSequence++;
  sessionChangeListener?.("alice", "laptop");
}
/** A server on a third origin, so "blocked" is measured rather than assumed. */
let external: import("node:http").Server;
let externalOrigin = "";
const externalHits: string[] = [];

/**
 * Real-browser work, with a real bundle to fetch.
 *
 * Vitest's 5 s default was already marginal for a suite whose每 step is a page
 * navigation plus a MessagePort handshake; the panel now also has a script to
 * fetch, parse and mount on each `goto`. The assertions below are unchanged —
 * this only stops a slow box from looking like a broken boundary.
 */
// Compound real-browser flows have a bounded budget; all compute runs on 4090.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

describe.skipIf(!HAVE_BROWSER)("Session Plus in a real browser", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sp-browser-"));
    store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: join(dir, "alice"), created_at: NOW });
    // Run the composed shell and App under the full Apple profile.
    // The theme-sync case below still traverses every theme, then restores
    // Apple so later cases continue exercising its generated token chain.
    store.setSetting("alice", DASHBOARD_THEME_SETTING, "apple");
    store.saveRunnerToken(hashRunnerToken("rt_session_plus_browser"), "alice", "laptop", NOW);
    const runnerTransport: RunnerTransport = {
      dispatch: async (owner: string, operation: string, args: Record<string, unknown>) => {
        runnerFrames.push({ owner, operation, args });
        if (operation === "respond_agent_interaction") {
          interactionResponses.push(args);
          pendingInteraction = false;
          return { ok: true, interaction_id: args.interaction_id, decision: "allow" };
        }
        if (operation === "get_session_operation") return { ok: false, code: "not_found" };
        if (operation === "list_recent_sessions") {
          return {
            devices: ["laptop"], history_supported: true, has_more: false, total_found: 1 + liveSessionRows.size,
            sessions: [{
              id: "demo-codex",
              source: "codex",
              device: "laptop",
              project: "Session Plus",
              // The `~/…` display path a current Runner sends. Without it the
              // Hub falls back to `project` for `cwdDisplay`, and the tree then
              // builds a `/Session Plus` node whose name happens to equal the
              // workspace's label — at which point `matchingWorkspace` (in
              // agent-sessions-view) folds the registered workspace INTO the
              // synthetic node and the `~/projects/session-plus` row never
              // renders. Two tests wait for `[data-new-directory="~/…"]` and
              // then time out with a chain snapshot showing the collapsed
              // shape (`newDirectoryValues:["/Session Plus"]`). Providing
              // `cwd_display` here reproduces what a real Runner sends and
              // makes the tree render the expected resolvable path.
              cwd_display: "~/projects/session-plus",
              last_activity: new Date().toISOString(),
              activity: { state: "tool", tool: "Bash" },
              first_user_text: "收敛 Session Plus 架构",
              message_count: 260,
            }, ...[...liveSessionRows].map(([id, row]) => ({
              id, source: "codex", device: "laptop", project: "Session Plus",
              cwd_display: "~/projects/session-plus", last_activity: new Date().toISOString(),
              activity: { state: "tool", tool: "Bash" }, first_user_text: row.title, message_count: 1_200,
            }))],
          };
        }
        if (operation === "list_session_workspaces") {
          return { workspaces: [{
            id: "ws_0123456789abcdef01234567",
            label: "Session Plus",
            display: "~/projects/session-plus",
          }] };
        }
        if (operation === "start_session") {
          return { ok: true, session_id: "started-browser-session", agent: args.source, duration_ms: 10 };
        }
        if (operation === "append_session") {
          return { ok: true, agent: "codex", duration_ms: 10, result_text: "continued" };
        }
        if (operation === "upload_session_file") {
          return {
            upload_id: "abcdefghijklmnopqrstuvwx",
            complete: true,
            attachment: {
              label: args.name,
              path: `/tmp/octopus-session-browser/${String(args.name)}`,
              bytes: Buffer.from(String(args.data), "base64").length,
              media_type: args.media_type,
            },
          };
        }
        if (operation === "read_session") {
          const live = liveSessionRows.get(String(args.id ?? args.session_id));
          const total = live ? 1_200 : 260;
          const limit = Math.min(total, Math.max(1, Number(args.max_messages) || 200));
          const requestedOffset = Number(args.offset);
          const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0
            ? Math.min(total, requestedOffset)
            : total - limit;
          const returned = Math.min(limit, total - offset);
          return {
            rich: true,
            total_messages: total,
            offset,
            messages: Array.from({ length: returned }, (_, index) => {
              const absolute = offset + index;
              const role = absolute % 2 === 0 ? "user" : "assistant";
              // The last assistant turn carries a Markdown file link, so the
              // browser suite can follow the chat-link route a reader takes.
              const text = live
                ? (absolute === total - 1 ? live.text : `${live.title} ${role === "user" ? "需求" : "答复"} ${absolute + 1}`)
                : role === "assistant" && absolute === total - 1
                  ? `答复 ${absolute + 1}\n\n设计稿在这里：[notes.md](docs/notes.md)`
                  : `${role === "user" ? "需求" : "答复"} ${absolute + 1}`;
              return { role, blocks: [{ type: "text", text }] };
            }),
            projection_version: live
              ? { epoch: live.epoch, sequence: live.sequence }
              : { epoch: "browser-fixture", sequence: fixtureReadSequence },
            meta: {
              activity: live ? { state: "tool", tool: "Bash" } : { state: "idle" },
              ...(pendingInteraction ? {
                runtime: {
                  process_state: "alive",
                  turn_state: "needs_input",
                  control_mode: "octopus_headless",
                  observed_at: NOW,
                  event: "AgentInteraction",
                  capabilities: { observe: true, respond: true },
                  interaction: {
                    id: "ai_browser_acceptance",
                    provider: "codex",
                    kind: "question",
                    title: "Codex 需要你的回答",
                    tool: "request_user_input",
                    questions: [{
                      id: "acceptance",
                      header: "验收结果",
                      prompt: "新版 Agent adaptor 的网页提问闭环是否验收通过？",
                      options: [
                        { label: "通过", description: "网页卡片正常出现" },
                        { label: "不通过", description: "没有出现或交互异常" },
                      ],
                      multiple: false,
                      allow_other: false,
                      secret: false,
                    }],
                    created_at: NOW,
                    expires_at: "2099-08-04T10:10:00.000Z",
                    capabilities: { respond: true, allow: true, deny: true },
                  },
                },
              } : {}),
            },
          };
        }
        if (operation === "search_sessions") return { results: [], returned: 0, scanned: 1 };
        if (operation === "access_owner_files") {
          // Model a remote snapshot arriving after the editor has mounted.
          // An immediate in-memory read hides typing into its loading surface.
          if (args.mode === "text" && args.absolute_path === "/owner-draft.txt") {
            await new Promise<void>((resolve) => setTimeout(resolve, 500));
          }
          return accessFakeOwnerFiles(args);
        }
        if (operation === "replace_owner_text") {
          if (args.absolute_path !== "/owner-draft.txt") return { status: "refused", code: "not_found" };
          const previous = `sha256:${createHash("sha256").update(ownerDraftText).digest("hex")}`;
          if (args.expected_digest !== previous) return { status: "refused", code: "digest_mismatch" };
          ownerDraftText = String(args.text);
          return {
            status: "ok", absolute_path: args.absolute_path, encoding: "utf-8", previous_digest: previous,
            digest: `sha256:${createHash("sha256").update(ownerDraftText).digest("hex")}`,
            modified_at: NOW, size: Buffer.byteLength(ownerDraftText),
          };
        }
        // ── The workspace browser's bounded v4 reads ────────────────────────
        //
        // Contract-valid and harmless: two directories plus small text/image/
        // PDF files, shaped exactly as `RunnerWorkspaceFilesBackend`
        // re-validates them. A child's `relative_path` is the parent's plus its
        // name, and every text/binary window accounts for itself byte for byte.
        if (operation === "list_workspace_entries") {
          const at = String(args.relative_path ?? "");
          if (at === "") {
            return {
              status: "ok",
              workspace_id: args.workspace_id,
              relative_path: "",
              truncated: false,
              entries: [
                { name: "docs", kind: "directory", relative_path: "docs" },
                { name: "archive.bin", kind: "file", relative_path: "archive.bin", size: WS_MEDIA_FILES["archive.bin"].byteLength },
                { name: "pixel.png", kind: "file", relative_path: "pixel.png", size: WS_MEDIA_FILES["pixel.png"].byteLength },
                { name: "readme.md", kind: "file", relative_path: "readme.md", size: WS_FILES["readme.md"].length },
                { name: "sample.pdf", kind: "file", relative_path: "sample.pdf", size: WS_MEDIA_FILES["sample.pdf"].byteLength },
                ...(includeStressPdf ? [{ name: "stress.pdf", kind: "file", relative_path: "stress.pdf", size: WS_MEDIA_FILES["stress.pdf"].byteLength }] : []),
                { name: "link", kind: "other" },
              ],
            };
          }
          if (at === "docs") {
            return {
              status: "ok",
              workspace_id: args.workspace_id,
              relative_path: "docs",
              truncated: false,
              entries: [
                { name: "notes.md", kind: "file", relative_path: "docs/notes.md", size: WS_FILES["docs/notes.md"].length },
              ],
            };
          }
          return { status: "not_found" };
        }
        if (operation === "read_workspace_text") {
          if (String(args.relative_path ?? "") === "archive.bin") {
            return { status: "refused", code: "not_text" };
          }
          const at = String(args.relative_path ?? "");
          const body = WS_FILES[at];
          if (body === undefined) return { status: "not_found" };
          const offset = Number(args.offset) || 0;
          const size = Buffer.byteLength(body, "utf8");
          const slice = Buffer.from(body, "utf8").subarray(offset, offset + Number(args.max_bytes ?? size));
          return {
            status: "ok",
            encoding: "utf-8",
            workspace_id: args.workspace_id,
            relative_path: at,
            digest: `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`,
            modified_at: NOW,
            size,
            offset,
            bytes: slice.byteLength,
            eof: offset + slice.byteLength === size,
            text: slice.toString("utf8"),
          };
        }
        if (operation === "read_workspace_binary") {
          const at = String(args.relative_path ?? "");
          const body = WS_MEDIA_FILES[at];
          if (!body) return { status: "not_found" };
          const offset = Number(args.offset) || 0;
          const slice = body.subarray(offset, offset + Number(args.max_bytes ?? body.byteLength));
          return {
            status: "ok",
            encoding: "base64",
            workspace_id: args.workspace_id,
            relative_path: at,
            digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
            modified_at: NOW,
            size: body.byteLength,
            offset,
            bytes: slice.byteLength,
            eof: offset + slice.byteLength === body.byteLength,
            data: slice.toString("base64"),
          };
        }
        if (operation === "download_workspace_file") {
          const at = String(args.relative_path ?? "");
          const media = WS_MEDIA_FILES[at];
          const text = WS_FILES[at];
          const body = media ?? (text === undefined ? undefined : Buffer.from(text, "utf8"));
          if (!body) return { status: "not_found" };
          const offset = Number(args.offset) || 0;
          const slice = body.subarray(offset, offset + Number(args.max_bytes ?? body.byteLength));
          return {
            status: "ok",
            encoding: "base64",
            workspace_id: args.workspace_id,
            relative_path: at,
            digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
            modified_at: NOW,
            size: body.byteLength,
            offset,
            bytes: slice.byteLength,
            eof: offset + slice.byteLength === body.byteLength,
            data: slice.toString("base64"),
          };
        }
        if (operation === "workspace_terminal") {
          const action = String(args.action ?? "");
          if (action === "open") terminalFixtureScreen = "alice@fixture:~/projects/session-plus$ ";
          if (action === "input") {
            terminalFixtureScreen += `${String(args.input ?? "")}\nterminal-ok\nalice@fixture:~/projects/session-plus$ `;
          }
          return {
            terminal_id: TERMINAL_FIXTURE_ID,
            screen: action === "close" ? "" : terminalFixtureScreen,
            closed: action === "close",
          };
        }
        throw new Error(`unexpected browser fixture operation: ${operation} ${JSON.stringify(args)}`);
      },
      listDevices: () => [{ device: "laptop", online: true, created_at: NOW, last_seen_at: NOW }],
      isOnline: () => true,
      ping: async () => 1,
      subscribeSessionChanges: (listener: (owner: string, device: string) => void) => {
        sessionChangeListener = listener;
        return () => { if (sessionChangeListener === listener) sessionChangeListener = null; };
      },
      disconnect: () => true,
    } as unknown as RunnerTransport;
    caps = new RunnerCapabilities(store, runnerTransport);
    // The SECOND capability plane, over the same laptop and the same trusted
    // transport, with its own Object and its own version line. Production wires
    // it from one `claimTransport()`; here the fixture transport stands in for
    // the socket, and everything above it is the real thing.
    workspaceFiles = new WorkspaceFilesCapabilities({
      service: caps.service,
      transport: runnerTransport,
      userExists: (username) => Boolean(store.getUser(username)),
      hasDevice: (username) => store.listRunnerTokens(username).length > 0,
    });
    agentInteractions = new AgentInteractionCapabilities({
      service: caps.service,
      transport: runnerTransport,
      userExists: (username) => Boolean(store.getUser(username)),
      hasDevice: (username) => store.listRunnerTokens(username).length > 0,
    });
    token = mintDashboardToken(store, "alice");
    appState = new AppStateService(join(dir, "app-state"));
    appRuntime = new AppRuntimeService(bundledAppDir("session-plus"));

    const panelPort = await freePort();
    const viewPort = await freePort();
    panelOrigin = `http://localhost:${panelPort}`;
    viewOrigin = `http://${LABEL}.localhost:${viewPort}`;

    const resolved = resolveSessionPlus({
      config: {
        enabled: true,
        view_origin: viewOrigin,
        view_port: viewPort,
        grants: {
          // The release contract grants the right to request one terminal
          // opening, but deliberately withholds auto-allow for that operation.
          // Use inside the resulting instance lease is the only silent half.
          alice: {
            operations: [...SESSION_PLUS_OWNER_FILES_WRITE_OPERATIONS],
            auto_allow: [...SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT.autoAllow],
          },
        },
      },
      dashboardPort: panelPort,
    });
    if (!resolved.enabled || !resolved.settings) throw new Error(resolved.errors.join("; "));
    settings = resolved.settings;

    // A real registry, content store and adapter, seeded from this checkout —
    // the same path production takes. Without it there is no active release,
    // and without an active release there is no binding plan for the App
    // service to open a resource handle against.
    const paths = appReleasePaths(dir);
    const registry = new AppReleaseRegistry({
      catalog: new StoreReleaseCatalog(store),
      content: new FileReleaseContentStore(paths.contentRoot),
    });
    releases = new HostedApp({
      registry,
      adapter: new SessionPlusReleaseAdapter({
        preparedRoot: paths.preparedRoot,
        resourceContracts: () => new Set(PANEL_RESOURCE_CONTRACTS),
        baseSettings: settings,
      }),
    });
    const active = await releases.start();
    if (!active) throw new Error(`no active release: ${JSON.stringify(releases.unavailable())}`);
    settings = active.settings;

    app = new SessionPlusAppService({
      state: new InProcessStateClient(appState),
      runtime: new InProcessRuntimeClient(appRuntime),
      identity: () => releases.active()?.prepared.identity ?? null,
      manifest: () => releases.active()?.prepared.manifest ?? null,
    });

    const externalPort = await freePort();
    externalOrigin = `http://127.0.0.1:${externalPort}`;
    external = createServer((req, res) => {
      externalHits.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<h1>external</h1>");
    });
    await new Promise<void>((r) => external.listen(externalPort, "127.0.0.1", () => r()));

    dash = createDashboardTestServer(store, caps, {
      port: panelPort,
      host: "127.0.0.1",
      authToken: "sekrit",
      adminUsers: [],
      surface: "bootstrap-v3",
      sessionHubUi: "unified-v3",
      sessionPlus: () => releases.active()?.settings ?? null,
      sessionPlusApp: app,
      // Production composes both: the catalog manages every app, the hosted
      // release answers the Session Plus surface's questions about the one
      // being served. This suite keeps both so the panel it drives is the panel
      // the composition root builds — including the 应用 tab.
      appReleases: new AppReleaseHost({ registry, apps: [releases] }),
      sessionPlusRelease: releases,
      workspaceFiles,
      agentInteractions,
    });
    await dash.start();

    browser = await chromium.launch();
    const context = await browser.newContext();
    // Caddy owns this public observer in production; the composed Dashboard
    // fixture has no edge service. Keep its idle response distinct from real
    // App, permission and action requests, which all reach the server.
    await idleDeploymentObserver(context);
    page = await context.newPage();
    // Observe real requests without changing the product's runtime or fetch.
    // These bindings stay test-private and are used only for server refusal cases.
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/ui/apps/")) appAssetRequests.push(path);
      if (path === "/api/session-plus/stream") {
        const headers = request.headers();
        if (headers["x-session-plus-instance"]) activeInstance = headers["x-session-plus-instance"];
      }
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        browserDiagnostics.push(`http ${response.status()}: ${new URL(response.url()).pathname}`);
        if (new URL(response.url()).pathname === "/api/session-plus/act") {
          void response.json().then((body) => browserDiagnostics.push(`action refusal: ${JSON.stringify({ code: body.code, error: body.error, reason: body.reason }).slice(0, 500)}`)).catch(() => {});
        }
      }
    });
    page.on("requestfailed", (request) => {
      browserDiagnostics.push(`requestfailed: ${new URL(request.url()).pathname} ${request.failure()?.errorText ?? "unknown"}`);
    });
    page.on("pageerror", (error) => browserDiagnostics.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") browserDiagnostics.push(`console: ${message.text()}`);
    });

    // Log in as a person would: the token is typed into the login form and
    // POSTed, so the browser ends up holding the same cookie a user would.
    await page.goto(`${panelOrigin}/login`);
    await page.fill('input[type="password"]', token);
    await page.click('button[type="submit"]');
    await page.waitForURL(`${panelOrigin}/sessions-plus`);
  }, 120_000);

  let browserErrorStart = 0;
  beforeEach(async () => {
    browserErrorStart = browserDiagnostics.length;
    const diagnosticStart = browserDiagnostics.length;
    const readsStart = runnerFrames.length;
    onTestFailed(async () => {
      const snapshot = await page.evaluate(() => ({
        path: location.pathname,
        state: document.body.dataset.spState ?? "",
        text: document.body.innerText.slice(0, 1_200),
        appRoots: document.querySelectorAll("[data-session-plus-app]").length,
        dialogs: Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).filter((node) => node.getBoundingClientRect().width > 0)
          .map((node) => ({ text: node.textContent?.slice(0, 800), classes: node.getAttribute("class") })),
        viewport: { scrollX, scrollY, innerWidth, innerHeight,
          clientHeight: document.documentElement.clientHeight, documentScrollHeight: document.documentElement.scrollHeight,
          bodyScrollHeight: document.body.scrollHeight, rootScrollHeight: document.getElementById("root")?.scrollHeight },
        transcriptWindows: Array.from(document.querySelectorAll<HTMLElement>("[data-av-chat-transcript]")).map((node) => ({
          offset: node.dataset.avChatOffset, count: node.dataset.avChatCount, total: node.dataset.avChatTotal,
          scrollTop: Math.round(node.scrollTop), scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
        })),
      })).catch(() => ({ path: "unreadable" }));
      console.error("[session-plus browser failure]", JSON.stringify({
        snapshot,
        precedingNetworkAndRuntime: browserDiagnostics.slice(0, diagnosticStart).slice(-20),
        networkAndRuntime: browserDiagnostics.slice(diagnosticStart).slice(-100),
        reads: runnerFrames.slice(readsStart).filter((row) => row.operation === "read_session").slice(-20)
          .map(({ args }) => ({ id: args.id ?? args.session_id, offset: args.offset, max_messages: args.max_messages })),
      }));
    });
    // Browser recovery intentionally survives page navigation. Cases own
    // independent starting layouts; reloads WITHIN a case still use the cache.
    // Unmount first so a pending Dock capture cannot repopulate the old state.
    await page.goto(`${panelOrigin}/`);
    await clearRecovery();
  });

  afterEach(() => {
    expect(browserDiagnostics.slice(browserErrorStart).filter((message) => message.startsWith("pageerror:"))).toEqual([]);
  });

  afterAll(async () => {
    await browser?.close();
    await dash?.stop();
    app?.stop();
    await appRuntime?.stop();
    appState?.close();
    await new Promise<void>((r) => external?.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  async function clearRecovery(): Promise<void> {
    await page.evaluate(() => {
      for (const storage of [localStorage, sessionStorage]) {
        for (const key of Object.keys(storage)) if (key.startsWith("octopus-session-plus-recovery-v1:")) storage.removeItem(key);
      }
    });
  }

  /** Keep the existing interaction helpers on Playwright's main Frame. */
  async function openReady(): Promise<Frame> {
    activeInstance = "";
    const assetsBefore = appAssetRequests.length;
    await page.goto(`${panelOrigin}/sessions-plus`);
    try {
      // A focused case owns its own first-run setup. Wait for the lazy route
      // before deciding whether publisher trust still needs a real click.
      await page.waitForFunction(() => document.body.dataset.spState === "ready"
        || document.querySelector("[data-testid=trust-app]") !== null, null, { timeout: 55_000 });
      if (await page.locator("[data-testid=trust-app]").count()) {
        expect(await page.locator("[data-session-plus-app]").count()).toBe(0);
        expect(appAssetRequests.slice(assetsBefore)).toEqual([]);
        await page.click("[data-testid=trust-app]");
      }
      await page.waitForFunction(() => document.body.dataset.spState === "ready", null, { timeout: 55_000 });
    } catch (error) {
      const state = await page.evaluate(() => ({
        state: document.body.dataset.spState ?? "",
        text: document.body.innerText.slice(0, 500),
      })).catch(() => ({ state: "unreadable", text: "" }));
      const frames = page.frames().map((frame) => frame.url());
      throw new Error(
        `Session Plus did not become ready: ${JSON.stringify({ state, frames, browserDiagnostics })}`,
        { cause: error },
      );
    }
    await expect.poll(() => activeInstance, { timeout: 10_000 }).not.toBe("");
    activeResourceGeneration = await page.evaluate(() => {
      const boot = JSON.parse(document.getElementById("octopus-bootstrap")!.textContent!);
      return String(boot.pageProps.resourceGeneration ?? 0);
    });
    const frame = page.mainFrame();
    expect(await page.locator("[data-testid=session-plus-frame]").count()).toBe(0);
    // The App root appears only after the first projection reaches the View,
    // and unlike a feature row it survives presentation changes. In
    // particular, file-first navigation deliberately keeps `[data-av-session-row]` rows out
    // of the initial DOM until a directory's compact session list is opened.
    await frame.waitForSelector("[data-session-plus-app]", { state: "attached", timeout: 55_000 });
    // Most scenarios below exercise the file tree, which is one view of the
    // navigator (sessions / files / search) since 2026-10-22.
    await showNavigatorView(frame, "files");
    return frame;
  }

  /** Select one navigator view; every view stays mounted, only one is visible. */
  async function showNavigatorView(frame: Frame, view: "sessions" | "files" | "search"): Promise<void> {
    const tab = frame.locator(`[data-av-nav-view="${view}"]:visible`).first();
    await tab.waitFor({ timeout: 55_000 });
    if (await tab.getAttribute("aria-selected") !== "true") await tab.click();
    await expect.poll(() => tab.getAttribute("aria-selected"), { timeout: 10_000 }).toBe("true");
  }

  async function postAction(
    body: Record<string, unknown>,
    options: { instance?: string; csrf?: boolean } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return page.evaluate(async ({ payload, instance, generation, csrf }) => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-session-plus-instance": instance,
        "x-session-plus-resource-generation": generation,
      };
      if (csrf) {
        const cookie = document.cookie.split(";").map((part) => part.trim())
          .find((part) => part.startsWith("octopus_csrf="));
        if (cookie) headers["x-csrf-token"] = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
      }
      const response = await fetch("/api/session-plus/act", {
        method: "POST", credentials: "same-origin", headers, body: JSON.stringify(payload),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    }, { payload: body, instance: options.instance ?? activeInstance, generation: activeResourceGeneration, csrf: options.csrf !== false });
  }

  /** Open the file-first rail's compact session surface for the fixture workspace. */
  async function openFixtureSessionDialog(frame: Frame): Promise<Locator> {
    // Dockview's `renderer="always"` keeps inactive copies mounted so their
    // React state survives presentation changes. A document-wide `.first()`
    // can therefore resolve to a hidden copy and spend Playwright's whole
    // action timeout waiting for an element that is intentionally inert. The
    // Every resolvable ancestor deliberately has its own history trigger. The
    // fixture's exact launch action identifies the row we mean; a global
    // `.first()` would open `~` after the file-first navigation landed.
    const fixtureLaunch = frame.locator(
      '[data-new-directory="~/projects/session-plus"]:visible',
    ).first();
    await fixtureLaunch.waitFor({ timeout: 55_000 });
    const fixtureRow = fixtureLaunch.locator(
      "xpath=ancestor::*[@data-av-file-row][1]",
    );
    const trigger = fixtureRow.locator("[data-av-session-action=directory-sessions]:visible");
    await trigger.click({ timeout: 55_000 });
    const dialog = frame.getByRole("dialog", { name: "「session-plus」下的会话", exact: true });
    await dialog.waitFor({ timeout: 55_000 });
    return dialog;
  }

  /** Find a visible Dockview resize sash by geometry, not a private group id. */
  async function orientedSash(sashes: Locator, orientation: "tall" | "wide"): Promise<Locator> {
    for (let index = 0; index < await sashes.count(); index += 1) {
      const candidate = sashes.nth(index);
      if (!(await candidate.getAttribute("class"))?.split(/\s+/).includes("dv-enabled")) continue;
      const box = await candidate.boundingBox();
      if (!box || box.width === 0 || box.height === 0) continue;
      if (orientation === "tall" ? box.height > box.width : box.width > box.height) return candidate;
    }
    throw new Error(`visible ${orientation} Dockview sash not found`);
  }

  /** Find the vertical sash which owns the left edge of one visible Dockview group. */
  async function leftEdgeSash(sashes: Locator, contentLeft: number): Promise<Locator> {
    let nearest: { sash: Locator; distance: number } | undefined;
    for (let index = 0; index < await sashes.count(); index += 1) {
      const candidate = sashes.nth(index);
      if (!(await candidate.getAttribute("class"))?.split(/\s+/).includes("dv-enabled")) continue;
      const box = await candidate.boundingBox();
      if (!box || box.width === 0 || box.height <= box.width) continue;
      const centre = box.x + box.width / 2;
      const distance = Math.abs(contentLeft - centre);
      if (distance <= 24 && (!nearest || distance < nearest.distance)) {
        nearest = { sash: candidate, distance };
      }
    }
    if (nearest) return nearest.sash;
    throw new Error("visible Dockview sash beside group not found");
  }

  /** Read the surface geometry from the exact visible marker Playwright resolved. */
  async function dockSurfaceBox(marker: Locator): Promise<{ left: number; top: number; width: number; height: number }> {
    return marker.evaluate((node) => {
      const surface = node.matches("[data-av-dock-document], [data-av-dock-flow]")
        ? node as HTMLElement
        : node.closest<HTMLElement>("[data-av-dock-document], [data-av-dock-flow]");
      const box = surface?.getBoundingClientRect();
      if (!box || box.width <= 0 || box.height <= 0) throw new Error("visible Dockview surface not found");
      return { left: box.left, top: box.top, width: box.width, height: box.height };
    });
  }

  /** Only geometry and public layout markers; no document content or authority. */
  async function dockGeometry(frame: Frame) {
    return frame.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(
      ".dv-groupview, [data-av-dock-document], [data-av-dock-flow]",
    )).flatMap((node) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (box.width <= 0 || box.height <= 0 || style.visibility === "hidden") return [];
      return [{
        classes: node.className,
        attributes: Object.fromEntries(Array.from(node.attributes)
          .filter((attribute) => attribute.name.startsWith("data-av-dock-") || attribute.name === "data-group-id")
          .map((attribute) => [attribute.name, attribute.value])),
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        style: { display: style.display, minWidth: style.minWidth, maxWidth: style.maxWidth, flexBasis: style.flexBasis },
      }];
    }));
  }

  async function dockPresentationGeometry(frame: Frame) {
    return frame.evaluate(() => {
      const presentations: unknown[] = [];
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key?.startsWith("octopus-session-plus-recovery-v1:")) continue;
        try { presentations.push(JSON.parse(localStorage.getItem(key) ?? "{}").presentation ?? null); }
        catch { presentations.push("invalid presentation checkpoint"); }
      }
      const surfaces = Array.from(document.querySelectorAll<HTMLElement>("[data-app-surface], .av-dock-host"))
        .map((node) => {
          const box = node.getBoundingClientRect();
          const ancestors = [];
          let ancestor: HTMLElement | null = node;
          for (let depth = 0; ancestor && depth < 8; depth++, ancestor = ancestor.parentElement) {
            const rect = ancestor.getBoundingClientRect();
            ancestors.push({ tag: ancestor.tagName, classes: ancestor.className,
              y: rect.y, height: rect.height, scrollTop: ancestor.scrollTop, scrollLeft: ancestor.scrollLeft,
              clientHeight: ancestor.clientHeight, scrollHeight: ancestor.scrollHeight,
              overflowY: getComputedStyle(ancestor).overflowY });
          }
          return { classes: node.className, scope: node.getAttribute("data-app-surface"),
            box: { x: box.x, y: box.y, width: box.width, height: box.height }, ancestors };
        });
      return { presentations, surfaces };
    });
  }

  /**
   * A `[data-new-directory]` wait with chain-specific diagnostics on failure.
   *
   * The two callers below sit on the workspace-refresh chain (View → Panel →
   * App Service → Runtime → State → Gate → Runner), several hops longer than
   * the App-root wait that arrives with the first projection. Pipelines 49242 /
   * 49244 / 49246 / 49248 all timed out here; every prior response was to raise
   * the ceiling, and every prior raise was insufficient — the ceiling has now
   * been reverted (see the note above `vi.setConfig`) and CI parallelism was
   * lowered instead. If the next Runner failure fires here again, the operator
   * note asks for chain-specific evidence before another timeout hike. This
   * helper produces exactly that: on timeout it reads roster/device/button
   * counts from the frame's DOM so the log names which hop stalled — first
   * projection missing, devices absent, or the workspace reply late.
   */
  async function waitForNewDirectory(frame: Frame, dir: string, timeout: number): Promise<void> {
    try {
      await frame.waitForSelector(`[data-new-directory="${dir}"]`, { timeout });
    } catch (err) {
      const snap = await frame.evaluate(() => ({
        sessRows: document.querySelectorAll("[data-av-session-row][data-id]").length,
        deviceHeads: document.querySelectorAll("[data-av-directory-row]").length,
        directoryButtons: document.querySelectorAll("[data-new-directory]").length,
        newDirectoryValues: Array.from(document.querySelectorAll("[data-new-directory]"))
          .map((el) => (el as HTMLElement).dataset.newDirectory ?? "")
          .slice(0, 8),
        rosterText: (document.querySelector("[data-av-session-roster]")?.textContent ?? "").slice(0, 400),
      })).catch((evalErr) => ({ evalError: String(evalErr) }));
      const original = err instanceof Error ? err.message : String(err);
      throw new Error(
        `waitForNewDirectory(${dir}) after ${timeout}ms: ${original}\n`
          + `chain snapshot: ${JSON.stringify(snap)}`,
      );
    }
  }

  /**
   * Toggle a `[data-av-file-directory]` open by every path that can still be tried in this box,
   * in order, and insist its chevron published `data-open="1"`.
   *
   * Attempt ladder (each step waits ~2 s for the open fact before the next):
   *   1. `Locator.click()` — a synthetic mouse gesture. This is the real user
   *      action. Pipelines 49281 / 49283 failed here (identical snapshots).
   *   2. `HTMLElement.click()` via `Locator.evaluate` — a native DOM click.
   *      Pipeline 49284 failed here too (identical error shape), which is
   *      what rules out playwright's mouse hit-testing as the variable.
   *   3. Invoke the React `onClick` handler directly through the button's
   *      `__reactProps$` fiber — bypasses the whole browser event system.
   *      If this succeeds, the browser-side click path was the problem; if
   *      this ALSO fails, the setter itself is being held from the current
   *      mount (state race or a re-mount that discarded the setter), and the
   *      failure message names that explicitly for the next iteration.
   *
   * On the final failure, print the SAME chain snapshot `waitForFileRow`
   * would have printed 55 s later, so the next Runner log names which hop
   * stalled without a second speculative round-trip.
   */
  async function toggleWsdirOpen(root: Locator, frame: Frame, label: string): Promise<void> {
    // FileTree now rotates one › glyph in CSS and exposes the semantic state
    // through data-open. Text matching ▾ would retry an already-successful
    // click, close it again, and report a false failure with file rows visible.
    const flipped = root.locator('[data-av-file-chevron][data-open="1"]').first();
    let failure: unknown;
    try {
      await root.click();
      await flipped.waitFor({ timeout: 7_000 });
      return;
    } catch (error) { failure = error; }
    const snap = await frame.evaluate(() => {
      const text = (el: Element): string => (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
      const wsdir = Array.from(document.querySelectorAll("[data-av-file-directory]")) as HTMLElement[];
      const wsfile = Array.from(document.querySelectorAll("[data-av-file]")) as HTMLElement[];
      const wsrow = Array.from(document.querySelectorAll(
        "[data-av-file-row], [data-av-directory-row], [data-av-device-row]",
      ));
      const wstree = Array.from(document.querySelectorAll("[data-av-file-tree-rows]"));
      const dhead = Array.from(document.querySelectorAll("[data-av-directory-row]"));
      const wsrefusal = Array.from(document.querySelectorAll("[data-av-file-refusal]"));
      const wsfilesEl = document.querySelector("[data-av-file-tree]");
      return {
        wsdirCount: wsdir.length,
        wsdirs: wsdir.slice(0, 12).map((el) => ({
          text: text(el),
          ref: el.dataset.ref ?? "",
          disabled: el.hasAttribute("disabled"),
        })),
        wsfileCount: wsfile.length,
        wsfiles: wsfile.slice(0, 12).map((el) => text(el)),
        wsrowCount: wsrow.length,
        wstreeCount: wstree.length,
        dheadCount: dhead.length,
        dheads: dhead.slice(0, 12).map((el) => text(el)),
        wsrefusals: wsrefusal.slice(0, 6).map((el) => text(el)),
        wsfilesText: wsfilesEl ? text(wsfilesEl) : null,
      };
    }).catch((evalErr) => ({ evalError: String(evalErr) }));
    throw new Error(
      `toggleWsdirOpen(${label}) did not publish data-open=1 after real pointer input: ${String(failure)}\n`
        + `chain snapshot: ${JSON.stringify(snap)}`,
    );
  }

  /**
   * The workspace-browser wait, with chain-specific diagnostics on failure.
   *
   * Pipeline 49277 timed out at the "click the workspace root and see the file
   * rows appear" step. Every prior read of the code came back "this should
   * work" — the workspace projection mints its directoryKey, the file-plane
   * root mints the same key from the same inputs, so the workspace row is
   * emitted as `type:"workspace"` with a rootRef, the `[data-av-file-directory]` button is
   * clickable, and after `directories.load()` the file layer is emitted with
   * the `[data-av-file]` rows. Something in that chain does not, in practice, do
   * what the code says it does — and without evidence from the failing box we
   * are guessing at what. Same reasoning as `waitForNewDirectory`: a helper
   * that names which hop stalled beats another guess.
   *
   * What the snapshot captures, and why each field:
   *   - `wsdirs`: the button the test just clicked. Its `data-ref` reveals
   *     whether the workspace row had a rootRef (workspace-type emit) or the
   *     ref belongs to a loose-root path, and `aria-expanded` distinguishes
   *     the two — the workspace-type button emits none, the file-tree row's
   *     button carries `true`/`false` from `decorate()`.
   *   - `wsfiles`, `wsrows`, `wstrees`: whether ANY file row landed in the
   *     DOM. Zero across the board means the file layer never emitted; a
   *     count without "readme.md" means it emitted a note (loading / refusal)
   *     or a different subset than the fixture returned.
   *   - `dheads`: whether the workspace merged with a session's directory
   *     node (a `[data-av-directory-row]` at `~/projects/session-plus`). If it did, the
   *     `[data-av-file-directory]` button never rendered at all and the test is looking at the
   *     wrong element.
   *   - `wsrefusals`, `wsfilesText`: the panel's own words when a listing
   *     was refused — an approval card, a stale grant, an unavailable
   *     backend all land here as a bounded sentence.
   *
   * A longer wait cannot hide a real defect — the false readings still fail
   * the assertion when they land, so the ceiling only costs wall-clock in
   * the failure path.
   */
  async function waitForFileRow(
    frame: Frame,
    treeSelector: string,
    filename: string,
    timeout: number,
  ): Promise<void> {
    try {
      await frame.locator(treeSelector).locator("[data-av-file]").filter({ hasText: filename }).first()
        .waitFor({ timeout });
    } catch (err) {
      const snap = await frame.evaluate((name) => {
        const text = (el: Element): string => (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
        const wsdir = Array.from(document.querySelectorAll("[data-av-file-directory]")) as HTMLElement[];
        const wsfile = Array.from(document.querySelectorAll("[data-av-file]")) as HTMLElement[];
        const wsrow = Array.from(document.querySelectorAll(
          "[data-av-file-row], [data-av-directory-row], [data-av-device-row]",
        ));
        const wstree = Array.from(document.querySelectorAll("[data-av-file-tree-rows]"));
        const dhead = Array.from(document.querySelectorAll("[data-av-directory-row]"));
        const wsrefusal = Array.from(document.querySelectorAll("[data-av-file-refusal]"));
        const wsfilesEl = document.querySelector("[data-av-file-tree]");
        return {
          target: name,
          wsdirCount: wsdir.length,
          wsdirs: wsdir.slice(0, 12).map((el) => ({
            text: text(el),
            ref: el.dataset.ref ?? "",
            expanded: el.getAttribute("aria-expanded") ?? null,
            disabled: el.hasAttribute("disabled"),
          })),
          wsfileCount: wsfile.length,
          wsfiles: wsfile.slice(0, 12).map((el) => text(el)),
          wsrowCount: wsrow.length,
          wstreeCount: wstree.length,
          dheadCount: dhead.length,
          dheads: dhead.slice(0, 12).map((el) => text(el)),
          wsrefusals: wsrefusal.slice(0, 6).map((el) => text(el)),
          wsfilesText: wsfilesEl ? text(wsfilesEl) : null,
        };
      }, filename).catch((evalErr) => ({ evalError: String(evalErr) }));
      const original = err instanceof Error ? err.message : String(err);
      throw new Error(
        `waitForFileRow(${filename}) after ${timeout}ms: ${original}\n`
          + `chain snapshot: ${JSON.stringify(snap)}`,
      );
    }
  }

  it("loads the first-party App directly, with no per-release publisher consent page (O12)", async () => {
    await page.goto(`${panelOrigin}/sessions-plus`);
    const record = await page.request.get(`${panelOrigin}/api/session-plus/release`);
    expect(record.status()).toBe(200);
    expect((await record.json()).packageDigest).toBe(releases.active()!.prepared.identity.packageDigest);
    await page.waitForFunction(() => document.body.dataset.spState === "ready", null, { timeout: 55_000 });
    expect(await page.locator("[data-testid=trust-app]").count()).toBe(0);
    expect(await page.locator("body").innerText()).not.toContain("第一道门 · 发布者信任");
    await page.locator("[data-session-plus-app]").waitFor();
    expect(await page.locator("[data-testid=session-plus-frame]").count()).toBe(0);
    expect(appAssetRequests.some((path) => path.endsWith("/agent-view.js"))).toBe(true);
  });

  it("loads a declared digest-pinned App module with the shell's shared runtime", async () => {
    const frame = await openReady();
    const digest = releases.active()!.prepared.identity.packageDigest;
    const base = `${panelOrigin}/ui/apps/${digest}/`;
    const response = await page.request.get(base + "agent-view.entry.json");
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("immutable");
    const manifest = await response.json() as { schema: string; runtime: string; appId: string; scope: string; entry: string; styles: string[] };
    expect(manifest).toMatchObject({ schema: "octopus-app-module/v1", runtime: "octopus-ui/v1", entry: "agent-view.js" });
    expect(manifest.scope).toMatch(new RegExp(`^${manifest.appId}--[0-9a-f]{16}$`));
    expect(await page.locator("[data-testid=session-plus-workspace] > [data-app-surface]").getAttribute("data-app-surface"))
      .toBe(manifest.scope);
    expect(manifest.styles.length).toBeGreaterThan(0);
    for (const asset of [manifest.entry, ...manifest.styles]) {
      const loaded = await page.request.get(base + asset);
      expect(loaded.status(), asset).toBe(200);
      expect(loaded.headers()["cache-control"], asset).toContain("immutable");
      expect((await loaded.body()).length, asset).toBeGreaterThan(0);
    }
    const imports = JSON.parse(await page.locator('script[type="importmap"]').textContent() ?? "{}").imports as Record<string, string>;
    expect(imports.react).toMatch(/^\/ui\/a\/.*\.js$/);
    expect(imports["react-dom/client"]).toMatch(/^\/ui\/a\/.*\.js$/);
    expect(imports["@claude-bot/agent-view-react"]).toMatch(/^\/ui\/a\/.*\.js$/);
    expect(frame).toBe(page.mainFrame());
    // The tail is visibly rendered; the first loaded row may be virtualized out.
    await expect.poll(() => frame.locator("[data-session-plus-app]").textContent(),
      { timeout: 15_000 }).toContain("答复 260");
    expect(await page.locator("[data-testid=session-plus-workspace]").textContent()).toContain("答复 260");
  });

  it("uses the remaining viewport, opens a bounded tail and keeps the composer editable across projection updates", async () => {
    const frame = await openReady();
    await frame.waitForSelector("[data-av-session-composer]:not([disabled])", { timeout: 55_000 });
    const transcript = frame.locator("[data-av-chat-transcript]");
    await expect.poll(async () => (await readTranscriptWorkload(transcript)).loadedMessages,
      { timeout: 55_000 }).toBe(200);
    expect(await frame.locator("[data-av-chat-window]").count()).toBe(0);
    expect(await transcript.getByRole("button", { name: "加载更早", exact: true }).count()).toBe(0);
    expect(await transcript.getByRole("button", { name: "搜索已读取记录" }).count()).toBe(0);
    expect(await transcript.getByText("实时跟随", { exact: true }).count()).toBe(0);
    const tail = await transcript.evaluate((node) => ({
      scrollable: node.scrollHeight > node.clientHeight, scrollTop: node.scrollTop,
    }));
    expect(tail.scrollable).toBe(true);
    expect(tail.scrollTop).toBeGreaterThan(0);

    const viewport = page.viewportSize()!;
    const workspace = await page.locator("[data-testid=session-plus-workspace]").boundingBox();
    const frameBox = await page.locator("[data-testid=session-plus-workspace] > [data-app-surface]").boundingBox();
    expect(workspace).toBeTruthy();
    expect(frameBox).toBeTruthy();
    expect(workspace!.height).toBeGreaterThan(viewport.height * 0.72);
    expect(Math.abs(workspace!.y + workspace!.height - viewport.height)).toBeLessThan(3);
    expect(Math.abs(frameBox!.height - workspace!.height)).toBeLessThan(3);

    const readsBefore = runnerFrames.filter((row) => row.operation === "read_session").length;
    // Typed through the real input path rather than by assigning `.value`.
    // That is not cosmetic: a controlled React field owns its own `value`
    // property, so a direct assignment updates the DOM and the framework's
    // tracker at once and no change event is ever produced — the field would
    // then be re-rendered back to empty and this test would "prove" a
    // regression that only its own technique caused.
    await frame.fill("[data-av-session-composer]", "继续收敛这个实现");
    await frame.evaluate(() => {
      const composer = document.getElementById("composer") as HTMLTextAreaElement;
      composer.focus();
      composer.setSelectionRange(5, 5);
    });
    publishFixtureSessionChange();
    await expect.poll(() => runnerFrames.filter((row) => row.operation === "read_session").length,
      { timeout: 55_000 }).toBeGreaterThan(readsBefore);
    expect(await frame.evaluate(() => ({
      active: (document.activeElement as HTMLElement | null)?.id,
      value: (document.getElementById("composer") as HTMLTextAreaElement).value,
      selection: (document.getElementById("composer") as HTMLTextAreaElement).selectionStart,
      sendDisabled: (document.getElementById("sendPrompt") as HTMLButtonElement).disabled,
    }))).toEqual({ active: "composer", value: "继续收敛这个实现", selection: 5, sendDisabled: false });

    // Reading upward still loads history without a toolbar or a button.
    await readOlderPage(page, transcript, 200, 55_000);
    await expect.poll(async () => (await readTranscriptWorkload(transcript)).loadedMessages,
      { timeout: 55_000 }).toBe(260);
    expect((await readTranscriptWorkload(transcript)).firstMessage).toBe(1);
  });

  it("renders and answers a real provider interaction through the trusted Host", async () => {
    pendingInteraction = true;
    interactionResponses.length = 0;
    const frame = await openReady();
    // A real Runner announces interaction/runtime changes with a content-free
    // session hint. The View then reuses its existing authority to refresh the
    // selected transcript instead of trusting stale cached content.
    publishFixtureSessionChange();
    const card = frame.locator('[data-av-agent-interaction][data-agent-interaction="ai_browser_acceptance"]');
    await card.waitFor({ timeout: 55_000 });
    await card.getByLabel(/通过网页卡片正常出现/).click();
    await card.getByRole("button", { name: "提交回答并继续" }).click();
    await expect.poll(() => interactionResponses.length, { timeout: 55_000 }).toBe(1);
    const sent = interactionResponses[0];
    expect(sent).toMatchObject({
      device: "laptop",
      provider: "codex",
      session_id: "demo-codex",
      interaction_id: "ai_browser_acceptance",
    });
    expect(JSON.parse(String(sent.response_json))).toEqual({
      decision: "allow",
      answers: { acceptance: ["通过"] },
    });
    await expect.poll(
      () => card.getAttribute("data-agent-interaction-state"),
      { timeout: 55_000 },
    ).toBe("resolved");
    expect(await card.getByText("已提交：通过").count()).toBe(1);
    expect(await card.getByRole("button", { name: "提交回答并继续" }).count()).toBe(0);
    expect(await card.getByText("新版 Agent adaptor 的网页提问闭环是否验收通过？").count()).toBe(0);
  });

  it("uses the compact default workbench, shares the roster and resizes through Dockview sashes", async () => {
    const frame = await openReady();

    // Empty standing resource declarations are lifecycle placeholders. They
    // stay mounted for stable React identity, but the default workbench must
    // not spend a third of its width on empty tabs/groups. This is deliberately
    // measured in Chromium: Dockview's outer tab and renderer overlay live
    // outside the React component DOM, so jsdom cannot prove their geometry or
    // accessibility state.
    const defaultWorkbench = await frame.evaluate(() => {
      const rect = (selector: string) => {
        const node = document.querySelector<HTMLElement>(selector);
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { width: box.width, height: box.height };
      };
      const dormantTabs = Array.from(document.querySelectorAll<HTMLElement>(
        '[data-av-dock-dormant-tab="1"]',
      )).map((marker) => {
        const tab = marker.closest<HTMLElement>(".dv-tab");
        const box = tab?.getBoundingClientRect();
        return {
          width: box?.width ?? -1,
          height: box?.height ?? -1,
          display: tab ? getComputedStyle(tab).display : "missing",
          ariaHidden: tab?.getAttribute("aria-hidden") ?? null,
          inert: tab?.inert ?? false,
        };
      });
      const dormantSurfaces = Array.from(document.querySelectorAll<HTMLElement>(
        '[data-av-dock-dormant="1"]',
      )).map((surface) => ({
        hidden: surface.hidden,
        ariaHidden: surface.getAttribute("aria-hidden"),
        inert: surface.inert,
      }));
      return {
        dock: rect('[data-av-dock-workspace]'),
        navigation: rect('[data-av-dock-flow="navigation"]'),
        main: rect('[data-av-dock-document="chat"]'),
        status: rect('[data-av-dock-flow="bottom"]'),
        visibleGroupCount: Array.from(document.querySelectorAll<HTMLElement>(".dv-groupview"))
          .filter((group) => {
            const box = group.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && getComputedStyle(group).visibility !== "hidden";
          }).length,
        dormantTabs,
        dormantSurfaces,
      };
    });
    expect(defaultWorkbench.dock).toBeTruthy();
    expect(defaultWorkbench.navigation!.width).toBeGreaterThanOrEqual(220);
    expect(defaultWorkbench.navigation!.width).toBeLessThanOrEqual(340);
    expect(defaultWorkbench.main!.width).toBeGreaterThanOrEqual(defaultWorkbench.dock!.width * 0.65);
    // Ticket #438 moved terminal tabs into the document surface and removed
    // the standing bottom flow, so the compact workbench starts with only the
    // navigation and main groups visible.
    expect(defaultWorkbench.status).toBeNull();
    expect(defaultWorkbench.visibleGroupCount).toBe(2);
    expect(defaultWorkbench.dormantTabs).toHaveLength(3);
    expect(defaultWorkbench.dormantTabs).toEqual(defaultWorkbench.dormantTabs.map(() => ({
      width: 0,
      height: 0,
      display: "none",
      ariaHidden: "true",
      inert: true,
    })));
    expect(defaultWorkbench.dormantSurfaces).toHaveLength(3);
    expect(defaultWorkbench.dormantSurfaces.every((surface) =>
      surface.hidden && surface.ariaHidden === "true" && surface.inert)).toBe(true);

    // 120s, not 55s: this selector rides on the workspace refresh chain (see
    // the config-line note), which under --maxWorkers=8 had more tail than
    // the projection/App-root wait above. Pipeline 49246 exceeded 120s here
    // too, but the fix landed in .gitlab-ci.yml (`--maxWorkers=4`) rather
    // than as another timeout hike — see the note above the `vi.setConfig`.
    // `waitForNewDirectory` prints a chain snapshot on timeout so the next
    // Runner failure names which hop stalled instead of asking for a hike.
    await waitForNewDirectory(frame, "~/projects/session-plus", 120_000);
    // One rail, one activity bar; each view keeps its own controls on one row.
    const centers = (ids: readonly string[]) => frame.evaluate((names) => names.map((id) => {
      const node = document.getElementById(id);
      if (!(node instanceof HTMLElement)) return null;
      const box = node.getBoundingClientRect();
      return box.width && box.height ? box.top + box.height / 2 : null;
    }), ids);
    const sameRow = (values: readonly (number | null)[]) => {
      expect(values.every((value) => value !== null)).toBe(true);
      const numbers = values as number[];
      expect(Math.max(...numbers) - Math.min(...numbers)).toBeLessThanOrEqual(2);
    };
    const railChrome = await frame.evaluate(() => ({
      views: Array.from(document.querySelectorAll("[data-av-nav-view]")).map((node) => node.getAttribute("data-av-nav-view")),
      fileHeading: Array.from(document.querySelectorAll("h2"))
        .some((heading) => heading.textContent?.trim() === "文件"),
      sourceNoteCount: document.querySelectorAll("[data-av-session-source-note]").length,
      accessCount: document.querySelectorAll("[data-av-session-access]").length,
    }));
    expect(railChrome.views).toEqual(["sessions", "files", "search"]);
    sameRow(await centers(["railHidden", "railRefresh"]));
    expect(railChrome.fileHeading).toBe(false);
    expect(railChrome.sourceNoteCount).toBe(0);
    expect(railChrome.accessCount).toBe(0);
    await showNavigatorView(frame, "search");
    sameRow(await centers(["search", "doSearch"]));
    await showNavigatorView(frame, "sessions");
    const sessionsChrome = await centers(["newAnywhere", "navRefresh", "navFilter"]);
    sameRow(sessionsChrome.slice(0, 2));
    expect(sessionsChrome[2]!).toBeGreaterThan(sessionsChrome[0]!);
    await showNavigatorView(frame, "files");
    expect(await frame.locator("[data-av-file-directory]").filter({ hasText: "Session Plus" }).first().innerText())
      .toContain("Session Plus");
    const sessionDialog = await openFixtureSessionDialog(frame);
    expect(await sessionDialog.locator('[data-av-session-row][data-id]').first().locator("[data-av-session-live]").count()).toBe(1);
    await sessionDialog.getByRole("button", { name: "关闭目录会话列表" }).click();
    await sessionDialog.waitFor({ state: "hidden", timeout: 55_000 });

    // Docking is presentation only, but a real person must be able to resize
    // it. Pick the tall sash beside the navigation group rather than relying
    // on Dockview's private group ids.
    const navigation = frame.locator('[data-av-dock-flow="navigation"]');
    const before = (await navigation.boundingBox())!.width;
    const main = frame.locator('[data-av-dock-document="chat"]:visible');
    const tall = await leftEdgeSash(frame.locator(".dv-sash"), (await main.boundingBox())!.x);
    try {
      await expect.poll(() => tall.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === node;
      }), { timeout: 5_000 }).toBe(true);
    } catch (error) {
      console.error("[session-plus sash hit target]", JSON.stringify(await tall.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const x = box.x + box.width / 2; const y = box.y + box.height / 2;
        const hit = document.elementFromPoint(x, y);
        const root = document.getElementById("root"); const rootBox = root?.getBoundingClientRect();
        return {
          target: { classes: node.className, x: box.x, y: box.y, width: box.width, height: box.height },
          center: { x, y }, hit: hit ? { tag: hit.tagName, classes: hit.className,
            scope: hit.closest("[data-app-surface]")?.getAttribute("data-app-surface") } : null,
          scrollX, scrollY, innerWidth, innerHeight, clientHeight: document.documentElement.clientHeight,
          documentScrollHeight: document.documentElement.scrollHeight, bodyScrollHeight: document.body.scrollHeight,
          root: rootBox ? { y: rootBox.y, height: rootBox.height, scrollHeight: root?.scrollHeight } : null,
        };
      })));
      console.error("[session-plus sash scroll ancestors]", JSON.stringify(await dockPresentationGeometry(frame)));
      throw error;
    }
    const box = (await tall.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2, { steps: 5 });
    const during = (await navigation.boundingBox())!.width;
    await page.mouse.up();
    await frame.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    const resized = (await navigation.boundingBox())!.width;
    console.info("[session-plus navigation sash]", JSON.stringify({ before, during, resized,
      sash: { box, classes: await tall.getAttribute("class") },
      dock: await dockGeometry(frame),
    }));
    expect(resized).toBeGreaterThan(before + 50);

    // A new Agent joins the existing chat group (#786). Opening and closing
    // its exact tab must preserve the resized rail and usable document width.
    const chatWidth = (await dockSurfaceBox(frame.locator('[data-av-dock-document="chat"]'))).width;
    await showNavigatorView(frame, "sessions");
    await frame.locator("[data-av-session-action=new-anywhere]").click();
    const newSession = frame.locator("[data-av-new-session]:visible");
    await newSession.waitFor({ timeout: 55_000 });
    const newDocument = newSession.locator("xpath=ancestor::*[@data-av-dock-document][1]");
    expect(await newDocument.getAttribute("data-av-dock-slot")).toBe("primary");
    const newPanelId = await newDocument.getAttribute("data-av-dock-document");
    expect(newPanelId).toBeTruthy();
    const newTab = frame.locator(`[data-av-dock-tab="${newPanelId}"]`);
    expect(await newTab.evaluate((tab) => Boolean(
      tab.closest(".dv-groupview")?.querySelector('[data-av-dock-tab="chat"]'),
    ))).toBe(true);
    expect(Math.abs((await dockSurfaceBox(newSession)).width - chatWidth)).toBeLessThanOrEqual(5);
    await captureAppleScreenshot(page, "session-plus-new-agent-chat-group");
    await newTab.locator(".dv-default-tab-action").click();
    await newSession.waitFor({ state: "hidden", timeout: 55_000 });
    await frame.locator('[data-av-dock-document="chat"]:visible').waitFor({ timeout: 55_000 });
    expect(Math.abs((await navigation.boundingBox())!.width - resized)).toBeLessThanOrEqual(5);

    const postCloseSash = await orientedSash(frame.locator(".dv-sash"), "tall");
    const postCloseBox = (await postCloseSash.boundingBox())!;
    await page.mouse.move(
      postCloseBox.x + postCloseBox.width / 2,
      postCloseBox.y + postCloseBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      postCloseBox.x + postCloseBox.width / 2 - 60,
      postCloseBox.y + postCloseBox.height / 2,
      { steps: 5 },
    );
    await page.mouse.up();
    const narrowed = (await navigation.boundingBox())!.width;
    expect(narrowed).toBeLessThan(resized - 40);
    await frame.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    expect(Math.abs((await navigation.boundingBox())!.width - narrowed)).toBeLessThanOrEqual(5);

  });

  /**
   * The editable, media-capable workspace browser in Chromium through the whole chain.
   *
   * Everything below the DOM here is production wiring: a real MessagePort, the
   * App's `resource.*` proposals, `SessionPlusAppService`, the instance handle
   * the sealed catalog issued, the App's shipped binding plan, the same grant
   * decision the panel makes, the capability Gate, the independent
   * `workspace-files-runner-v5` Object, and the fake laptop at the far end.
   *
   * This belongs in a real browser because it verifies panel lifecycle and
   * Chromium's actual image/PDF/download elements over assembled blob URLs.
   */
  it("saves an owner Runner file from the editor after explicit write consent", async () => {
    ownerDraftText = "owner draft\n";
    const frame = await openReady();
    const root = frame.locator("[data-av-file-directory]")
      .filter({ has: frame.getByText("/", { exact: true }) }).first();
    await root.waitFor({ timeout: 55_000 });
    await root.click();
    const file = frame.locator("[data-av-file]").filter({ hasText: "owner-draft.txt" }).first();
    await file.waitFor({ timeout: 55_000 });
    await file.click();
    const viewer = frame.locator('[data-av-module="workspace.file-viewer/v1"]').filter({ hasText: "owner-draft.txt" }).first();
    await viewer.getByRole("button", { name: "编辑", exact: true }).click();
    const editor = frame.locator('[data-av-module="workspace.editor/v1"]').filter({ hasText: "owner-draft.txt" }).first();
    // CodeMirror mounts read-only while the snapshot/digest is loading.
    // click() waits for visibility, not editability; typing at that point is
    // discarded and leaves Save disabled (GitLab pipeline 50378).
    const content = editor.locator('.cm-content[contenteditable="true"]');
    await content.click();
    expect(await content.textContent()).toContain("owner draft");
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("saved from browser");
    await expect.poll(() => content.textContent()).toBe("saved from browser");
    const before = runnerFrames.length;
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await editor.locator('[data-status="saved"]').waitFor({ timeout: 55_000 });
    expect(ownerDraftText).toBe("saved from browser");
    expect(runnerFrames.slice(before).filter((row) => row.operation === "replace_owner_text"))
      .toMatchObject([{ owner: "alice", args: { device: "laptop", absolute_path: "/owner-draft.txt", text: "saved from browser" } }]);
    expect(await editor.getByText("当前授权只覆盖读取，这个文件不能在这里保存。", { exact: true }).count()).toBe(0);
  });

  it("browses text, image and PDF files with independent v4 tabs and negotiated dirty close", async () => {
    const frame = await openReady();

    // File-centred navigation enumerates workspaces on mount and renders roots
    // without a second navigation mode or switch.
    const tree = frame.locator("[data-av-file-tree]");
    await tree.waitFor({ timeout: 55_000 });
    const root = tree.locator("[data-av-file-directory]").filter({ hasText: "Session Plus" }).first();
    await root.waitFor({ timeout: 55_000 });

    // Nothing was listed until somebody asked: the file rows appear only after
    // the click. (The laziness itself is pinned in the module suite; what this
    // proves is that the real chain answers at all.)
    expect(await tree.locator("[data-av-file]").count()).toBe(0);
    // Pipelines 49281 / 49283 / 49284 all timed out here with identical
    // snapshots (arrow still ▸). `toggleWsdirOpen` walks the three click
    // paths and prints the chain snapshot on total failure; see its header.
    await toggleWsdirOpen(root, frame, "Session Plus");
    await waitForFileRow(frame, "[data-av-file-tree]", "readme.md", 55_000);
    const readmeRow = tree.locator("[data-av-file]").filter({ hasText: "readme.md" }).first();
    // A symlink is reported with no control to click.
    expect(await tree.locator("[data-av-file-other]").count()).toBeGreaterThan(0);

    const beforeNavigationBox = await dockSurfaceBox(
      frame.locator('[data-av-dock-flow="navigation"]:visible').first(),
    );
    const beforeMainBox = await dockSurfaceBox(
      frame.locator('[data-av-dock-document="chat"]:visible').first(),
    );
    const beforeFileOpen = {
      navigationWidth: beforeNavigationBox.width,
      mainWidth: beforeMainBox.width,
    };
    const beforeDock = await dockGeometry(frame);
    const beforePresentation = await dockPresentationGeometry(frame);

    // A plain Markdown click lands in the viewer, renders safely, and keeps the
    // download action present. Editing is a second explicit gesture that hands
    // the same opaque ref to the peer editor.
    await readmeRow.click();
    const readmeViewer = frame.locator('[data-av-module="workspace.file-viewer/v1"]')
      .filter({ has: frame.locator("[data-av-file-markdown]") })
      .filter({ hasText: "可编辑工作区浏览" })
      .first();
    await readmeViewer.locator("[data-av-file-markdown] h1").waitFor({ timeout: 55_000 });
    expect(await readmeViewer.locator("[data-av-file-markdown] h1").innerText()).toBe("可编辑工作区浏览");
    const afterNavigationBox = await dockSurfaceBox(
      frame.locator('[data-av-dock-flow="navigation"]:visible').first(),
    );
    const afterMainBox = await dockSurfaceBox(
      frame.locator('[data-av-dock-document="chat"]:visible').first(),
    );
    const afterResourceBox = await dockSurfaceBox(readmeViewer);
    const afterFileOpen = {
      navigationWidth: afterNavigationBox.width,
      mainWidth: afterMainBox.width,
      resourceWidth: afterResourceBox.width,
    };
    console.info("[session-plus file-open geometry]", JSON.stringify({
      before: { ...beforeFileOpen, navigation: beforeNavigationBox, main: beforeMainBox, dock: beforeDock,
        presentation: beforePresentation },
      after: { ...afterFileOpen, navigation: afterNavigationBox, main: afterMainBox,
        resource: afterResourceBox, dock: await dockGeometry(frame), presentation: await dockPresentationGeometry(frame) },
    }));
    await frame.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    console.info("[session-plus file-open geometry after two frames]", JSON.stringify({
      dock: await dockGeometry(frame), presentation: await dockPresentationGeometry(frame),
    }));
    // Measure Dockview surfaces rather than their module roots: the file viewer
    // has its own content inset, while the draggable window boundary is the
    // full document surface. Dockview may still round the sash to whole pixels.
    expect(Math.abs(afterFileOpen.navigationWidth - beforeFileOpen.navigationWidth)).toBeLessThanOrEqual(5);
    expect(Math.abs(afterFileOpen.mainWidth - afterFileOpen.resourceWidth)).toBeLessThanOrEqual(8);
    expect(afterFileOpen.mainWidth + afterFileOpen.resourceWidth)
      .toBeGreaterThanOrEqual(beforeFileOpen.mainWidth - 16);
    expect(afterFileOpen.mainWidth + afterFileOpen.resourceWidth)
      .toBeLessThanOrEqual(beforeFileOpen.mainWidth + 4);

    // The document split is independent of the navigation rail. Drag the
    // exact sash on the file group's left edge: resizing only the rail would
    // miss the user-facing chat | file gesture this assertion protects.
    const resourceContentBox = await readmeViewer.boundingBox();
    if (!resourceContentBox) throw new Error("visible file viewer not found");
    const resourceSash = await leftEdgeSash(frame.locator(".dv-sash"), resourceContentBox.x);
    expect(await resourceSash.getAttribute("class")).toContain("dv-enabled");
    expect(await resourceSash.evaluate((sash) => {
      const box = sash.getBoundingClientRect();
      return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === sash;
    })).toBe(true);
    const resourceSashBox = await resourceSash.evaluate((sash) => {
      const box = sash.getBoundingClientRect();
      return { x: box.left, y: box.top, width: box.width, height: box.height };
    });
    const resourceSashX = resourceSashBox.x + resourceSashBox.width / 2;
    const resourceSashY = resourceSashBox.y + resourceSashBox.height / 2;
    await page.mouse.move(
      resourceSashX,
      resourceSashY,
    );
    await page.mouse.down();
    await page.mouse.move(
      resourceSashX - 80,
      resourceSashY,
      { steps: 5 },
    );
    const draggingMainBox = await dockSurfaceBox(
      frame.locator('[data-av-dock-document="chat"]:visible').first(),
    );
    const draggingResourceBox = await dockSurfaceBox(readmeViewer);
    expect(draggingMainBox.width).toBeLessThan(afterFileOpen.mainWidth - 60);
    expect(draggingResourceBox.width).toBeGreaterThan(afterFileOpen.resourceWidth + 60);
    await page.mouse.up();
    await frame.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    const resizedNavigationBox = await dockSurfaceBox(
      frame.locator('[data-av-dock-flow="navigation"]:visible').first(),
    );
    const resizedMainBox = await dockSurfaceBox(
      frame.locator('[data-av-dock-document="chat"]:visible').first(),
    );
    const resizedResourceBox = await dockSurfaceBox(readmeViewer);
    const afterFileResize = {
      navigationWidth: resizedNavigationBox.width,
      mainWidth: resizedMainBox.width,
      resourceWidth: resizedResourceBox.width,
    };
    expect(Math.abs(afterFileResize.navigationWidth - afterFileOpen.navigationWidth)).toBeLessThanOrEqual(5);
    expect(afterFileResize.mainWidth).toBeLessThan(afterFileOpen.mainWidth - 60);
    expect(afterFileResize.resourceWidth).toBeGreaterThan(afterFileOpen.resourceWidth + 60);
    const markdownImage = readmeViewer.locator("img[data-av-markdown-image]");
    try {
      await markdownImage.waitFor({ timeout: 55_000 });
    } catch (error) {
      const fallback = readmeViewer.locator("[data-av-markdown-image-missing]").first();
      throw new Error(`Markdown image did not resolve: ${JSON.stringify({
        state: await fallback.getAttribute("data-state").catch(() => null),
        text: await fallback.innerText().catch(() => ""),
      })}`, { cause: error });
    }
    expect(await markdownImage.getAttribute("src")).toMatch(/^blob:/);
    expect(await markdownImage.getAttribute("alt")).toBe("工作区像素");
    expect(await readmeViewer.getByRole("button", { name: "下载 readme.md" }).count()).toBe(1);
    const markdownToolbar = readmeViewer.getByRole("group", { name: "文件批注" });
    const addMarkdownAnnotation = markdownToolbar.getByRole("button", { name: "新增批注" });
    await addMarkdownAnnotation.waitFor();
    await readmeViewer.locator("[data-av-file-markdown] h1").evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await addMarkdownAnnotation.click();
    const markdownComposer = frame.getByRole("dialog", { name: "新增批注" });
    await markdownComposer.getByLabel("批注内容").fill("调整文档标题");
    await markdownComposer.getByRole("button", { name: "保存" }).click();
    await expect.poll(() => markdownComposer.count()).toBe(0);
    const markdownMarker = readmeViewer.getByRole("button", { name: "编辑批注：调整文档标题" });
    await markdownMarker.waitFor({ timeout: 55_000 });
    await markdownMarker.click();
    const markdownEdit = frame.getByRole("dialog", { name: "编辑批注" });
    expect(await markdownEdit.getByLabel("编辑批注").inputValue()).toBe("调整文档标题");
    await markdownEdit.getByRole("button", { name: "取消" }).click();
    await readmeViewer.getByRole("button", { name: "编辑", exact: true }).click();
    const editorPanel = frame.locator('[data-av-module="workspace.editor/v1"]')
      .filter({ has: frame.locator("[data-av-text-surface=editable]") })
      .first();
    const editor = editorPanel.locator("[data-av-text-surface=editable]");
    await editor.waitFor({ timeout: 55_000 });
    expect((await editor.boundingBox())!.height).toBeGreaterThan(120);
    const afterEditorOpen = {
      navigationWidth: (await dockSurfaceBox(
        frame.locator('[data-av-dock-flow="navigation"]:visible').first(),
      )).width,
      mainWidth: (await dockSurfaceBox(
        frame.locator('[data-av-dock-document="chat"]:visible').first(),
      )).width,
      resourceWidth: (await dockSurfaceBox(editorPanel)).width,
    };
    // A new document joins the resized resource group. App-owned group sizes
    // must survive that reconciliation instead of letting Dockview redistribute
    // the navigation/main/resource grid.
    expect(Math.abs(afterEditorOpen.navigationWidth - afterFileResize.navigationWidth)).toBeLessThanOrEqual(5);
    expect(Math.abs(afterEditorOpen.mainWidth - afterFileResize.mainWidth)).toBeLessThanOrEqual(5);
    expect(Math.abs(afterEditorOpen.resourceWidth - afterFileResize.resourceWidth)).toBeLessThanOrEqual(5);
    const editable = editor.locator(".cm-content");
    await editable.click();
    await page.keyboard.type("未保存的浏览器草稿");
    const editorDocument = editorPanel.locator("xpath=ancestor::*[@data-av-dock-document][1]");
    const editorPanelId = await editorDocument.getAttribute("data-av-dock-document");
    expect(editorPanelId).toBeTruthy();
    await frame.locator(`[data-av-dock-tab="${editorPanelId}"] .dv-default-tab-action`).click();
    const closeDialog = frame.getByRole("alertdialog", { name: /要放弃.*的本地草稿并关闭吗/ });
    await closeDialog.waitFor({ timeout: 55_000 });
    await closeDialog.getByRole("button", { name: "取消" }).click();
    expect(await editable.innerText()).toContain("未保存的浏览器草稿");
    await frame.locator(`[data-av-dock-tab="${editorPanelId}"] .dv-default-tab-action`).click();
    expect(await closeDialog.innerText()).toContain("不会撤销已经提交到可信审批栏的操作");
    await closeDialog.getByRole("button", { name: "放弃本地草稿并关闭" }).click();
    await frame.waitForFunction(
      (panelId) => Boolean(document.querySelector(`[data-av-dock-document="${panelId}"]`))
        && !document.querySelector(`[data-av-dock-document="${panelId}"] [data-av-text-surface=editable]`),
      editorPanelId,
      { timeout: 55_000 },
    );
    // Media uses the same file tree and provider scope, but opens the typed
    // binary viewer instead of feeding bytes through the text editor.
    await tree.locator("[data-av-file]").filter({ hasText: "pixel.png" }).first().click();
    const image = frame.locator("[data-av-media-image]").first();
    await image.waitFor({ timeout: 55_000 });
    expect(await image.getAttribute("src")).toMatch(/^blob:/);
    expect(await image.getAttribute("alt")).toContain("pixel.png");
    await image.locator("xpath=ancestor::*[@data-av-module='workspace.file-viewer/v1'][1]")
      .getByRole("button", { name: "关闭" }).click();
    await expect.poll(() => frame.locator("[data-av-media-image]").count()).toBe(0);

    const pdfWorkers = observePdfWorkers(page);
    await tree.locator("[data-av-file]").filter({ hasText: "sample.pdf" }).first().click();
    const pdf = frame.locator("[data-av-pdf]").first();
    await pdf.waitFor({ timeout: 55_000 });
    const pdfViewer = pdf.locator("xpath=ancestor::*[@data-av-module='workspace.file-viewer/v1'][1]");
    const annotationToolbar = pdfViewer.getByRole("group", { name: "文件批注" });
    const addAnnotation = annotationToolbar.getByRole("button", { name: "新增批注" });
    const pageScrollBeforeReveal = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    await pdfViewer.getByRole("button", { name: "在文件索引中定位此文件" }).click();
    const revealedPdf = tree.locator("[data-av-file]").filter({ hasText: "sample.pdf" }).first();
    await expect.poll(() => revealedPdf.evaluate((node) => node === document.activeElement)).toBe(true);
    expect(await revealedPdf.locator('xpath=ancestor::*[@role="treeitem"][1]').getAttribute("aria-selected")).toBe("true");
    expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(pageScrollBeforeReveal);
    expect(await pdf.getAttribute("aria-label")).toContain("sample.pdf");
    expect(await pdf.locator("[data-av-pdf-page]").count()).toBe(2);
    expect(await pdf.getByRole("button", { name: /上一页|下一页/ }).count()).toBe(0);
    await addAnnotation.waitFor({ timeout: 55_000 });
    expect(await annotationToolbar.getByRole("button", { name: "导出" }).isDisabled()).toBe(true);
    expect(await annotationToolbar.getByRole("button", { name: "清空批注" }).isDisabled()).toBe(true);
    const firstPage = pdf.locator("[data-av-pdf-page]").first();
    const firstCanvas = firstPage.locator("canvas[data-av-pdf-canvas]");
    await expect.poll(() => firstCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0);
    const resizeEvidence = await exercisePdfZoomThenResize(page, pdf, frame.locator(".dv-sash"));
    expect(pdfWorkers.created()).toBeGreaterThanOrEqual(1);
    expect(pdfWorkers.warnings()).toEqual([]);
    console.info("[session-plus PDF resize]", JSON.stringify(resizeEvidence));
    const initialBitmapWidth = await firstCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement).width);
    // Sharpness is a real-browser property: the bitmap must be denser than the
    // box it fills, or the page is upsampled and no CSS can put the detail
    // back. Playwright runs at dpr 1, so this is the oversampling floor and
    // nothing else — a renderer that went back to `min(dpr, 2)` would fail here.
    expect(await firstCanvas.evaluate((node) => {
      const canvas = node as HTMLCanvasElement;
      return canvas.width / canvas.getBoundingClientRect().width;
    })).toBeGreaterThanOrEqual(2);
    const wheelZoom = await firstPage.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const pdf = node.closest<HTMLElement>("[data-av-pdf]")!;
      const clientX = rect.left + rect.width * 0.72;
      const clientY = rect.top + rect.height * 0.38;
      node.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        deltaY: -120,
      }));
      const ordinaryZoom = pdf.dataset.zoom;
      const modified = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        ctrlKey: true,
        deltaY: -120,
      });
      const accepted = node.dispatchEvent(modified);
      return { accepted, ordinaryZoom, clientX, clientY, beforeWidth: rect.width };
    });
    expect(wheelZoom.ordinaryZoom).toBe("1.000");
    expect(wheelZoom.accepted, "local zoom must prevent Chrome's whole-page Ctrl+wheel action").toBe(false);
    await expect.poll(async () => Number(await pdf.getAttribute("data-zoom"))).toBeGreaterThan(1);
    await expect.poll(() => firstCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement).width))
      .toBeGreaterThan(initialBitmapWidth);
    const zoomedPage = await firstPage.evaluate((node, anchor) => {
      const rect = node.getBoundingClientRect();
      return {
        width: rect.width,
        anchorX: rect.left + rect.width * 0.72,
        anchorY: rect.top + rect.height * 0.38,
        clientX: anchor.clientX,
        clientY: anchor.clientY,
      };
    }, wheelZoom);
    expect(zoomedPage.width).toBeGreaterThan(wheelZoom.beforeWidth);
    expect(Math.abs(zoomedPage.anchorX - zoomedPage.clientX)).toBeLessThanOrEqual(2);
    expect(Math.abs(zoomedPage.anchorY - zoomedPage.clientY)).toBeLessThanOrEqual(2);
    await firstPage.evaluate((node, anchor) => {
      node.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: anchor.clientX,
        clientY: anchor.clientY,
        ctrlKey: true,
        deltaY: 2_000,
      }));
    }, wheelZoom);
    await expect.poll(() => pdf.getAttribute("data-zoom")).toBe("1.000");
    const firstTextLayer = pdf.locator("[data-av-pdf-text-layer]").first();
    await expect.poll(() => firstTextLayer.textContent()).toContain("PDF page 1");
    await firstTextLayer.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await addAnnotation.click();
    const annotationComposer = frame.getByRole("dialog", { name: "新增批注" });
    await annotationComposer.getByLabel("批注内容").fill("检查首页标题");
    await annotationComposer.getByRole("button", { name: "保存" }).click();
    await expect.poll(() => annotationComposer.count()).toBe(0);
    await expect.poll(() => annotationToolbar.getByRole("button", { name: "导出" }).isEnabled()).toBe(true);
    const marker = pdf.getByRole("button", { name: /编辑第 1 页批注：检查首页标题/ });
    await marker.waitFor({ timeout: 55_000 });
    await marker.click();
    const editComposer = frame.getByRole("dialog", { name: "编辑批注" });
    expect(await editComposer.getByLabel("编辑批注").inputValue()).toBe("检查首页标题");
    await editComposer.getByRole("button", { name: "取消" }).click();
    const exportButton = annotationToolbar.getByRole("button", { name: "导出" });
    await exportButton.click();
    const exportPopover = frame.getByRole("dialog", { name: "导出批注" });
    const exportArea = exportPopover.getByLabel("可手动复制的批注导出文本");
    await exportArea.waitFor();
    expect(await exportArea.inputValue()).toContain("检查首页标题");
    expect(await pdfViewer.locator("[data-av-annotations-toggle]").getAttribute("aria-expanded")).toBe("false");
    const [exportButtonRect, exportPopoverRect] = await Promise.all([
      exportButton.boundingBox(),
      exportPopover.boundingBox(),
    ]);
    expect(exportButtonRect).not.toBeNull();
    expect(exportPopoverRect).not.toBeNull();
    expect(
      exportPopoverRect!.y >= exportButtonRect!.y + exportButtonRect!.height
      || exportPopoverRect!.y + exportPopoverRect!.height <= exportButtonRect!.y,
    ).toBe(true);
    expect(Math.abs(
      exportPopoverRect!.x + exportPopoverRect!.width
      - exportButtonRect!.x - exportButtonRect!.width,
    )).toBeLessThanOrEqual(16);
    await exportPopover.getByRole("button", { name: "关闭" }).click();
    const pdfDocument = pdfViewer.locator("xpath=ancestor::*[@data-av-dock-document][1]");
    const pdfPanelId = await pdfDocument.getAttribute("data-av-dock-document");
    expect(pdfPanelId).toBeTruthy();
    await frame.locator(`[data-av-dock-tab="${pdfPanelId}"]`).click();
    const desktop = page.viewportSize() ?? { width: 1280, height: 720 };
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await frame.waitForSelector('[data-av-dock-workspace][data-av-narrow="1"]', { timeout: 55_000 });
      await frame.locator("[data-av-dock-mobile-bar]").getByRole("tab", { name: "文件" }).click();
      // The responsive handoff can briefly retain the hidden desktop surface.
      // Re-enter through the visible mobile resource layer instead of letting
      // the desktop `.first()` locator choose that stale copy.
      const mobileResource = frame.locator('[data-av-dock-mobile-section="resource"]');
      const mobilePdf = mobileResource.locator("[data-av-pdf]:visible").first();
      await mobilePdf.waitFor({ timeout: 55_000 });
      const mobilePdfViewer = mobilePdf.locator("xpath=ancestor::*[@data-av-module='workspace.file-viewer/v1'][1]");
      const mobileAddAnnotation = mobilePdfViewer
        .getByRole("group", { name: "文件批注" })
        .getByRole("button", { name: "新增批注" });
      const media = mobilePdf.locator("xpath=parent::*");
      await media.evaluate((node) => { node.scrollTop = 0; });
      const mobileAnnotationControl = await mobileAddAnnotation.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return {
          position: getComputedStyle(node).position,
          width: rect.width,
          height: rect.height,
          right: window.innerWidth - rect.right,
          bottom: window.innerHeight - rect.bottom,
        };
      });
      expect(mobileAnnotationControl.position).toBe("fixed");
      expect(mobileAnnotationControl.width).toBeGreaterThanOrEqual(42);
      expect(mobileAnnotationControl.height).toBeGreaterThanOrEqual(42);
      expect(mobileAnnotationControl.right).toBeGreaterThanOrEqual(0);
      expect(mobileAnnotationControl.bottom).toBeGreaterThanOrEqual(0);
      const bounds = await media.evaluate((node) => {
        const first = node.querySelector("[data-av-pdf-page]")!;
        const canvas = first.querySelector("canvas")!;
        const outer = node.getBoundingClientRect();
        const pageBox = first.getBoundingClientRect();
        const canvasBox = canvas.getBoundingClientRect();
        return {
          outer: { top: outer.top, left: outer.left, right: outer.right },
          page: { top: pageBox.top, left: pageBox.left, right: pageBox.right },
          canvas: { left: canvasBox.left, right: canvasBox.right },
          scrollable: node.scrollHeight > node.clientHeight,
        };
      });
      expect(bounds.scrollable).toBe(true);
      expect(bounds.page.top).toBeGreaterThanOrEqual(bounds.outer.top - 1);
      expect(bounds.page.left).toBeGreaterThanOrEqual(bounds.outer.left - 1);
      expect(bounds.page.right).toBeLessThanOrEqual(bounds.outer.right + 1);
      expect(bounds.canvas.left).toBeGreaterThanOrEqual(bounds.page.left - 1);
      expect(bounds.canvas.right).toBeLessThanOrEqual(bounds.page.right + 1);
      // Mobile Chromium does not apply outer-page pinch zoom through this
      // cross-origin sandbox. Inject two real touch points instead: only the
      // PDF's local scale changes, while the trusted page stays at scale 1.
      const mobileFirstPage = mobilePdf.locator("[data-av-pdf-page]").first();
      const localZoomBeforePinch = Number(await mobilePdf.getAttribute("data-zoom"));
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: 390,
          height: 844,
          deviceScaleFactor: 3,
          mobile: true,
          screenWidth: 390,
          screenHeight: 844,
        });
        await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        const pinchTarget = await mobileFirstPage.boundingBox();
        expect(pinchTarget).not.toBeNull();
        const x = Math.round(pinchTarget!.x + pinchTarget!.width / 2);
        const y = Math.round(pinchTarget!.y + Math.min(pinchTarget!.height, 480) / 2);
        const scaleBefore = await page.evaluate(() => window.visualViewport?.scale ?? 1);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ id: 0, x: x - 40, y }, { id: 1, x: x + 40, y }],
        });
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ id: 0, x: x - 70, y }, { id: 1, x: x + 70, y }],
        });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect.poll(async () => Number(await mobilePdf.getAttribute("data-zoom")))
          .toBeGreaterThan(localZoomBeforePinch);
        expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(scaleBefore);
        expect((await mobileFirstPage.boundingBox())!.width).toBeGreaterThan(pinchTarget!.width);
        await media.evaluate((node) => { node.scrollTop = node.scrollHeight; });
        await expect.poll(() => media.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
        const secondPage = mobilePdf.locator("[data-av-pdf-page]").nth(1);
        await expect.poll(() => secondPage.getAttribute("data-painted")).toBe("1");
        const secondCanvas = secondPage.locator("canvas[data-av-pdf-canvas]");
        await expect.poll(() => secondCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0);
      } finally {
        await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
        await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
        await cdp.send("Emulation.clearDeviceMetricsOverride");
        await cdp.detach();
      }
    } finally {
      await page.setViewportSize(desktop);
      await frame.waitForFunction(
        () => !document.querySelector("[data-av-dock-workspace]")?.hasAttribute("data-av-narrow"),
        null,
        { timeout: 55_000 },
      );
    }
    // The independently released renderer paints the authorized bytes itself;
    // it does not hand the document to an embedded browser PDF viewer.
    expect(await frame.locator("[data-av-media] iframe").count()).toBe(0);
    await frame.locator(`[data-av-dock-tab="${pdfPanelId}"]`).click();
    const restoredDesktopPdf = frame.locator("[data-av-pdf]:visible").first();
    await restoredDesktopPdf.waitFor({ timeout: 55_000 });
    const restoredDesktopViewer = restoredDesktopPdf
      .locator("xpath=ancestor::*[@data-av-module='workspace.file-viewer/v1'][1]");
    await restoredDesktopViewer.locator("[data-av-document-bar]").getByRole("button", { name: "关闭" }).click();
    await expect.poll(() => frame.locator("[data-av-pdf]").count()).toBe(0);
    await expect.poll(() => pdfWorkers.closed(), { timeout: 10_000 }).toBe(pdfWorkers.created());
    expect(pdfWorkers.warnings()).toEqual([]);
    pdfWorkers.dispose();

    // An unsupported regular file opens a truthful placeholder rather than
    // refusing navigation, and Chromium receives the download from that state.
    await tree.locator("[data-av-file]").filter({ hasText: "archive.bin" }).first().click();
    const unsupported = frame.locator('[data-av-module="workspace.file-viewer/v1"]')
      .filter({ has: frame.locator("[data-av-download-empty]") })
      .filter({ hasText: "archive.bin" })
      .first();
    await unsupported.locator("[data-av-download-empty]").waitFor({ timeout: 55_000 });
    const [downloaded] = await Promise.all([
      page.waitForEvent("download"),
      unsupported.locator("[data-av-download-empty]").getByRole("button", { name: "下载 archive.bin" }).click(),
    ]);
    expect(downloaded.suggestedFilename()).toBe("archive.bin");
    const downloadedPath = await downloaded.path();
    expect(downloadedPath).toBeTruthy();
    expect(readFileSync(downloadedPath!)).toEqual(WS_MEDIA_FILES["archive.bin"]);
    await unsupported.getByRole("button", { name: "关闭" }).click();

    // Re-open the named viewer, then explicitly return to the named editor.
    await readmeRow.click();
    await readmeViewer.getByRole("button", { name: "编辑", exact: true }).click();
    const firstEditor = frame.locator('[data-av-panel="editor"]');
    await firstEditor.waitFor({ timeout: 55_000 });
    await frame.waitForFunction(
      () => document.querySelector('[data-av-panel="editor"] .cm-content')?.textContent?.includes("第一行来自假设备"),
      null,
      { timeout: 55_000 },
    );
    expect(await frame.locator('[data-av-dock-document="editor"] [data-av-panel="editor"]').count()).toBe(1);

    // ── The blocker this test exists for ────────────────────────────────────
    //
    // A second, DIFFERENT file derives a bounded panel from the v2 editor
    // prototype. It inherits the same trusted binding but keeps its own read
    // snapshot, tab lifecycle and CodeMirror buffer.
    const docs = tree.locator("[data-av-file-directory]").filter({ hasText: "docs" }).first();
    await docs.waitFor({ timeout: 55_000 });
    await toggleWsdirOpen(docs, frame, "docs");
    await waitForFileRow(frame, "[data-av-file-tree]", "notes.md", 55_000);
    await tree.locator("[data-av-file]").filter({ hasText: "notes.md" }).first().click();
    const notesViewer = frame.locator('[data-av-module="workspace.file-viewer/v1"]')
      .filter({ has: frame.locator("[data-av-file-markdown]") })
      .filter({ hasText: "第二个文件" })
      .first();
    await notesViewer.locator("[data-av-file-markdown]").waitFor({ timeout: 55_000 });
    await notesViewer.getByRole("button", { name: "编辑" }).click();
    await frame.waitForFunction(
      () => Array.from(document.querySelectorAll('[data-av-module="workspace.editor/v1"] .cm-content'))
        .some((node) => node.textContent?.includes("第二个文件")),
      null,
      { timeout: 55_000 },
    );
    const editors = frame.locator('[data-av-module="workspace.editor/v1"]');
    expect(await editors.count()).toBe(2);
    expect(await firstEditor.locator(".cm-content").textContent()).toContain("第一行来自假设备");
    const secondEditor = editors.filter({ hasText: "第二个文件" }).first();
    const secondDocument = secondEditor.locator("xpath=ancestor::*[@data-av-dock-document][1]");
    const secondPanelId = await secondDocument.getAttribute("data-av-dock-document");
    expect(secondPanelId).toMatch(/^panel-/);
    expect(await frame.locator('[data-av-dock-tab="editor"]').count()).toBe(1);
    expect(await frame.locator(`[data-av-dock-tab="${secondPanelId}"]`).count()).toBe(1);

    // Closing the derived tab removes only that semantic panel. The prototype
    // and its first ResourceRef remain untouched.
    await secondEditor.locator("button", { hasText: "关闭" }).first().click();
    await frame.waitForFunction(
      (panelId) => !document.querySelector(`[data-av-dock-document="${panelId}"]`),
      secondPanelId,
      { timeout: 55_000 },
    );
    expect(await frame.locator('[data-av-module="workspace.editor/v1"]').count()).toBe(1);
    expect(await firstEditor.locator(".cm-content").textContent()).toContain("第一行来自假设备");

    // Keyboard close must remain coordinator-owned too. Editing now replaces
    // the original viewer tab, so there is no same-file viewer to restore. A
    // visible focus ring precedes the action, and clearing the declared editor
    // hands focus to a surviving visible document instead of <body>/a hidden tab.
    const editorDockTab = frame.locator('[data-av-dock-tab="editor"]')
      .locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' dv-tab ')][1]");
    await editorDockTab.focus();
    const focusRing = await editorDockTab.evaluate((tab) => {
      const style = getComputedStyle(tab, "::after");
      return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
    });
    expect(focusRing.style).toBe("solid");
    expect(focusRing.width).toBeGreaterThanOrEqual(2);
    await page.keyboard.press("Delete");
    await frame.waitForFunction(
      () => document.querySelector('[data-av-dock-tab="editor"]')?.closest(".dv-tab")?.hasAttribute("hidden"),
      null,
      { timeout: 55_000 },
    );
    const focusedTab = await frame.evaluate(() => document.activeElement
      ?.closest(".dv-tab")
      ?.querySelector<HTMLElement>("[data-av-dock-tab]")
      ?.dataset.avDockTab ?? null);
    expect(focusedTab).not.toBeNull();
    expect(await frame.locator(
      `[data-av-dock-document="${focusedTab}"]:not([hidden])`,
    ).count()).toBe(1);
  });

  it("switches phone sections explicitly and keeps an editor draft", async () => {
    const desktop = page.viewportSize() ?? { width: 1280, height: 720 };
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      const frame = await openReady();
      const workspace = frame.locator("[data-av-dock-workspace]");
      await frame.waitForSelector('[data-av-dock-workspace][data-av-narrow="1"]', { timeout: 55_000 });

      // Browser recovery may legitimately restore the last non-chat phone
      // layer. Enter navigation explicitly, then prove it STAYS there (ticket
      // #349): binding the standing chat to the boot selection is an accepted
      // open intent, and on a narrow viewport the shell once read that as a
      // jump into whichever session sorted first.
      //
      // A settled roster is the window in which that used to happen, and a
      // VISIBLE session row is proof of both halves at once: the roster has
      // settled, and the layer showing it is still the one the reader opened.
      const navigationTab = frame.locator("[data-av-dock-mobile-bar]").getByRole("tab", { name: "导航" });
      await navigationTab.click();
      await showNavigatorView(frame, "sessions");
      await frame.locator("[data-av-session-row]:visible").first().waitFor({ timeout: 55_000 });
      expect(await workspace.getAttribute("data-av-dock-mobile-section")).toBe("navigation");

      // Navigation is an explicit region, not a squeezed three-column desktop
      // workbench; selecting it again is a no-op that keeps the rest honest.
      await navigationTab.click();
      await showNavigatorView(frame, "files");
      const tree = frame.locator("[data-av-file-tree]");
      const root = tree.locator("[data-av-file-directory]").filter({ hasText: "Session Plus" }).first();
      await root.waitFor({ timeout: 55_000 });
      await toggleWsdirOpen(root, frame, "Session Plus");
      await waitForFileRow(frame, "[data-av-file-tree]", "readme.md", 55_000);
      await tree.locator("[data-av-file]").filter({ hasText: "readme.md" }).first().click();

      const mobileViewer = frame.locator('[data-av-dock-mobile-section="resource"]')
        .locator('[data-av-module="workspace.file-viewer/v1"]');
      await mobileViewer.locator("[data-av-file-markdown]").waitFor({ timeout: 55_000 });
      const compactChrome = await mobileViewer.locator("[data-av-document-bar]").evaluate((bar) => {
        const visible = Array.from(bar.children).filter((child) => getComputedStyle(child).display !== "none");
        const centers = visible.map((child) => {
          const box = child.getBoundingClientRect();
          return Math.round(box.top + box.height / 2);
        });
        return {
          rows: new Set(centers).size,
          metadata: getComputedStyle(bar.querySelector("[data-av-document-meta]")!).display,
          digest: getComputedStyle(bar.parentElement!.querySelector("[data-av-document-digest]")!).display,
        };
      });
      expect(compactChrome).toEqual({ rows: 1, metadata: "none", digest: "none" });
      await mobileViewer.getByRole("button", { name: "编辑", exact: true }).click();

      await frame.waitForSelector('[data-av-dock-mobile-section="resource"] [data-av-text-surface=editable]', { timeout: 55_000 });
      const content = frame.locator('[data-av-dock-mobile-section="resource"] [data-av-text-surface=editable] .cm-content');
      await content.click();
      await page.keyboard.type("手机端未保存草稿");
      await expect.poll(() => content.innerText()).toContain("手机端未保存草稿");
      const phoneBar = frame.locator("[data-av-dock-mobile-bar]");
      const selectSection = async (name: string, section: string) => {
        const button = phoneBar.getByRole("tab", { name });
        expect(await button.isEnabled()).toBe(true);
        const hit = await button.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return {
            matches: target === node || node.contains(target),
            button: [box.left, box.top, box.width, box.height],
            target: target ? `${target.tagName}.${(target as HTMLElement).className}` : null,
          };
        });
        expect(hit.matches, JSON.stringify(hit)).toBe(true);
        await button.click();
        await frame.waitForSelector(`[data-av-dock-mobile-section="${section}"]`, { timeout: 55_000 });
      };
      await selectSection("会话", "main");
      await selectSection("导航", "navigation");
      await selectSection("文件", "resource");
      // The section attribute changes before CodeMirror remeasures its visible
      // viewport. Verify the rendered draft after that redraw, just as we did
      // before leaving, rather than sampling an empty virtual viewport once.
      await expect.poll(() => content.innerText()).toContain("手机端未保存草稿");
      expect(await frame.getByRole("button", { name: /返回会话/ }).count()).toBe(0);
    } finally {
      await page.setViewportSize(desktop);
    }
  });

  it("keeps mixed-EOL line numbers aligned after inserting a row", async () => {
    // Keep this visual regression independently runnable. The complete file's
    // first case normally crosses publisher trust for later cases, whereas a
    // focused `-t` run starts from a fresh store.
    await page.goto(`${panelOrigin}/sessions-plus`);
    if (await page.locator("[data-testid=trust-app]").count()) {
      await page.click("[data-testid=trust-app]");
      await page.waitForFunction(() => document.body.dataset.spState === "ready", null, { timeout: 55_000 });
    }
    const frame = await openReady();
    const tree = frame.locator("[data-av-file-tree]");
    const root = tree.locator("[data-av-file-directory]").filter({ hasText: "Session Plus" }).first();
    await root.waitFor({ timeout: 55_000 });
    await toggleWsdirOpen(root, frame, "Session Plus");
    await waitForFileRow(frame, "[data-av-file-tree]", "readme.md", 55_000);
    await tree.locator("[data-av-file]").filter({ hasText: "readme.md" }).first().click();

    const viewer = frame.locator('[data-av-module="workspace.file-viewer/v1"]')
      .filter({ hasText: "第一行来自假设备" })
      .first();
    await viewer.locator("[data-av-file-markdown]").waitFor({ timeout: 55_000 });
    await viewer.getByRole("button", { name: "编辑", exact: true }).click();
    const firstEditor = frame.locator('[data-av-module="workspace.editor/v1"]').first();
    await firstEditor.locator(".cm-content").waitFor({ timeout: 55_000 });

    // The reported surface is the derived editor docked beside the standing
    // one, so reproduce that layout instead of only exercising the first slot.
    const docs = tree.locator("[data-av-file-directory]").filter({ hasText: "docs" }).first();
    await toggleWsdirOpen(docs, frame, "docs");
    await waitForFileRow(frame, "[data-av-file-tree]", "notes.md", 55_000);
    await tree.locator("[data-av-file]").filter({ hasText: "notes.md" }).first().click();
    const notesViewer = frame.locator('[data-av-module="workspace.file-viewer/v1"]')
      .filter({ hasText: "第二个文件" })
      .first();
    await notesViewer.locator("[data-av-file-markdown]").waitFor({ timeout: 55_000 });
    await notesViewer.getByRole("button", { name: "编辑", exact: true }).click();
    const selectedEditor = frame.locator('[data-av-module="workspace.editor/v1"]')
      .filter({ hasText: "第二个文件" })
      .first();
    const editorDocument = selectedEditor.locator("xpath=ancestor::*[@data-av-dock-document][1]");
    const editorPanelId = await editorDocument.getAttribute("data-av-dock-document");
    expect(editorPanelId).toMatch(/^panel-/);
    const editor = frame.locator(`[data-av-dock-document="${editorPanelId}"]`);
    const content = editor.locator(".cm-content");
    await content.waitFor({ timeout: 55_000 });

    // CodeMirror virtualizes off-screen lines. Move the viewport to the tail
    // so the reported area around line 74 is materialized before selecting it.
    await content.click();
    await page.keyboard.press("Control+End");
    const wrappedLine = content.locator(".cm-line").filter({ hasText: "line-74-" }).first();
    await wrappedLine.waitFor({ timeout: 55_000 });
    await wrappedLine.click({ position: { x: 2, y: 2 } });
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");

    const readGeometry = () => editor.evaluate((surface) => {
      const gutter = Array.from(surface.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement"))
        .filter((element) => getComputedStyle(element).visibility !== "hidden" && element.textContent);
      const lines = Array.from(surface.querySelectorAll<HTMLElement>(".cm-content > .cm-line"));
      return {
        numbers: gutter.map((element) => Number(element.textContent)),
        topDeltas: gutter.map((element, index) => {
          const line = lines[index];
          return line ? Math.abs(element.getBoundingClientRect().top - line.getBoundingClientRect().top) : null;
        }),
        overlaps: gutter.slice(1).map((element, index) => (
          element.getBoundingClientRect().top < gutter[index]!.getBoundingClientRect().bottom - 0.5
        )),
      };
    });
    const geometryIsAligned = (geometry: Awaited<ReturnType<typeof readGeometry>>) => (
      geometry.numbers.length > 2
      && geometry.numbers.every((number, index, all) => index === 0 || number === all[index - 1]! + 1)
      && geometry.topDeltas.every((delta) => delta !== null && delta < 1)
      && !geometry.overlaps.includes(true)
    );
    // CodeMirror updates the document and its line-number gutter in separate
    // view-observer passes. Under the gate's concurrent Chromium load, Enter
    // can therefore leave one animation-frame snapshot with the content on
    // the new line set and the gutter on the previous one. Wait for the same
    // final geometry this test asserts instead of accepting that half-update.
    await expect.poll(async () => geometryIsAligned(await readGeometry()), { timeout: 55_000 }).toBe(true);

    const geometry = await readGeometry();
    expect(geometry.numbers.length).toBeGreaterThan(2);
    const detail = JSON.stringify(geometry);
    expect(
      geometry.numbers.every((number, index, all) => index === 0 || number === all[index - 1]! + 1),
      detail,
    ).toBe(true);
    expect(geometry.topDeltas.every((delta) => delta !== null && delta < 1), detail).toBe(true);
    expect(geometry.overlaps, detail).not.toContain(true);
  });

  it("opens a chat file link on a phone and shows the file's content", async () => {
    const desktop = page.viewportSize() ?? { width: 1280, height: 720 };
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      const frame = await openReady();
      await frame.waitForSelector('[data-av-dock-workspace][data-av-narrow="1"]', { timeout: 55_000 });
      await frame.locator("[data-av-dock-mobile-bar]").getByRole("tab", { name: "会话" }).click();
      const link = frame.locator("[data-av-chat-transcript] a").filter({ hasText: "notes.md" }).first();
      await link.waitFor({ timeout: 55_000 });
      await link.click();
      await frame.waitForSelector('[data-av-dock-mobile-section="resource"]', { timeout: 55_000 });
      const linkedViewer = frame.locator('[data-av-dock-mobile-section="resource"]')
        .locator('[data-av-module="workspace.file-viewer/v1"]')
        .filter({ hasText: "第二个文件" });
      await linkedViewer.locator("[data-av-file-markdown]").waitFor({ timeout: 55_000 });
      const linkedImage = linkedViewer.locator("img[data-av-markdown-image]");
      await linkedImage.waitFor({ timeout: 55_000 });
      expect(await linkedImage.getAttribute("src")).toMatch(/^blob:/);
      expect(await linkedImage.getAttribute("alt")).toBe("聊天链接图片");
      const locate = linkedViewer.getByRole("button", { name: "在文件索引中定位此文件" });
      const locateBox = await locate.boundingBox();
      expect(locateBox!.width).toBeGreaterThanOrEqual(44);
      const documentsBeforeReveal = await frame.locator("[data-av-dock-document]").count();
      await locate.click();
      await frame.waitForSelector('[data-av-dock-mobile-section="navigation"]');
      const revealedFile = frame.locator("[data-av-file]").filter({ hasText: "notes.md" }).first();
      await expect.poll(() => revealedFile.evaluate((node) => node === document.activeElement)).toBe(true);
      expect(await revealedFile.locator('xpath=ancestor::*[@role="treeitem"][1]').getAttribute("aria-selected")).toBe("true");
      await expect.poll(() => revealedFile.evaluate((node) => {
        const row = node.getBoundingClientRect();
        const scroller = node.closest("[data-av-file-tree-rows]")!;
        const index = scroller.getBoundingClientRect();
        return {
          visible: row.top >= index.top - 1 && row.bottom <= index.bottom + 1,
          rowTop: row.top, rowBottom: row.bottom, indexTop: index.top, indexBottom: index.bottom,
          scrollTop: scroller.scrollTop, clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight,
        };
      })).toMatchObject({ visible: true });
      await revealedFile.click();
      await frame.waitForSelector('[data-av-dock-mobile-section="resource"]');
      expect(await frame.locator("[data-av-dock-document]").count()).toBe(documentsBeforeReveal);
      await linkedViewer.getByRole("button", { name: "编辑" }).click();
      await frame.waitForFunction(
        () => document.querySelector("[data-av-text-surface=editable] .cm-content")?.textContent?.includes("第二个文件"),
        null,
        { timeout: 55_000 },
      );

      // ── The half no `textContent` assertion can reach (ticket #253) ───────
      //
      // Every other check in this suite reads text out of the DOM, which is
      // true whether or not a single one of CodeMirror's own rules was applied.
      // The reported failure was exactly that gap: the file HAD loaded, and the
      // published document's `style-src 'sha256-…'` refused the stylesheet
      // `style-mod` builds while the editor initialises. Unstyled, `.cm-scroller`
      // is a block, the gutter stops being a column beside the text, and a
      // phone shows a stack of line numbers with the content below the fold.
      const layout = await frame.evaluate(() => {
        const scroller = document.querySelector("[data-av-text-surface=editable] .cm-scroller");
        const content = document.querySelector("[data-av-text-surface=editable] .cm-content");
        const gutters = document.querySelector("[data-av-text-surface=editable] .cm-gutters");
        if (!scroller || !content || !gutters) return null;
        const c = content.getBoundingClientRect();
        const g = gutters.getBoundingClientRect();
        return {
          display: getComputedStyle(scroller).display,
          contentLeft: c.left,
          contentTop: c.top,
          contentWidth: c.width,
          gutterRight: g.right,
          gutterTop: g.top,
        };
      });
      expect(layout).not.toBeNull();
      expect(layout!.display).toBe("flex");
      // Beside, not below — the two facts a reader is actually looking at.
      expect(layout!.contentLeft).toBeGreaterThanOrEqual(layout!.gutterRight - 1);
      expect(Math.abs(layout!.contentTop - layout!.gutterTop)).toBeLessThan(2);
      expect(layout!.contentWidth).toBeGreaterThan(0);
    } finally {
      await page.setViewportSize(desktop);
    }
  });
  it("starts Codex or Claude directly from the owner's compact directory action", async () => {
    const frame = await openReady();
    // 120s, not 55s: same reason as the roster test above — the workspace
    // refresh chain has more tail than the projection/App-root wait, and 90s
    // (pipeline 49244) then 120s (pipeline 49246) both lost to CPU contention.
    // The 49246 shape was fixed by lowering CI parallelism (see .gitlab-ci.yml),
    // not by another timeout hike; if this fires again under maxWorkers=4,
    // `waitForNewDirectory` prints a chain snapshot naming which hop stalled.
    await waitForNewDirectory(frame, "~/projects/session-plus", 120_000);
    const plus = frame.locator('[data-new-directory="~/projects/session-plus"]').first();
    await plus.click();
    await frame.selectOption("[data-av-new-session-control=source]", "codex");
    // Ticket #191: the model field is a picker now, so the name that reaches
    // the Runner is one the form offered rather than one somebody remembered.
    await frame.selectOption("[data-av-new-session-control=model]", "gpt-5.6-sol");
    await frame.selectOption("[data-av-new-session-control=effort]", "xhigh");
    await frame.fill("[data-av-new-session-control=prompt]", "检查并修复这个目录");
    await frame.click("[data-av-new-session-action=start]");

    await expect.poll(() => runnerFrames.find((row) =>
      row.operation === "start_session" && row.args.prompt === "检查并修复这个目录"), { timeout: 55_000 })
      .toBeTruthy();
    expect(await page.locator("[data-testid=approval-count]").textContent()).toBe("0");
    const sent = runnerFrames.find((row) =>
      row.operation === "start_session" && row.args.prompt === "检查并修复这个目录")!;
    expect(sent.args).toMatchObject({
      source: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      directory: "~/projects/session-plus",
    });
    expect(sent.args).not.toHaveProperty("workspace_id");
    expect(sent.args).not.toHaveProperty("workspace_display");
    await page.click("[data-testid=approval-activity-toggle]");
    await page.locator("[data-testid=agentic-activity-card]").filter({ hasText: "start_session" }).first()
      .waitFor({ timeout: 55_000 });
  });

  it("starts in a directory nothing has enumerated, from the global entry", async () => {
    // The whole point of the change, measured where only a browser can measure
    // it: the form is reachable and usable without a workspace registry, a
    // roster row, or any background pass having happened, and the typed path is
    // the one sent to the owner's Runner.
    const frame = await openReady();
    await showNavigatorView(frame, "sessions");
    await frame.click("[data-av-session-action=new-anywhere]");
    await frame.fill("[data-av-new-session-control=device]", "laptop");
    await frame.fill("[data-av-new-session-control=directory]", "/srv/never-enumerated");
    await frame.fill("[data-av-new-session-control=prompt]", "在这个新目录里开始");
    await frame.click("[data-av-new-session-action=start]");

    await expect.poll(() => runnerFrames.find((row) =>
      row.operation === "start_session" && row.args.prompt === "在这个新目录里开始"), { timeout: 55_000 })
      .toBeTruthy();
    const sent = runnerFrames.find((row) =>
      row.operation === "start_session" && row.args.prompt === "在这个新目录里开始")!;
    expect(sent.args.directory).toBe("/srv/never-enumerated");
    expect(sent.args).not.toHaveProperty("workspace_label");
    expect(await page.locator("[data-testid=approval-count]").textContent()).toBe("0");
  });

  it("keeps the new-session workflow usable after switching to phone navigation", async () => {
    const desktop = page.viewportSize() ?? { width: 1280, height: 720 };
    try {
      const frame = await openReady();
      await showNavigatorView(frame, "sessions");
      await frame.click("[data-av-session-action=new-anywhere]");
      const form = frame.locator("[data-av-new-session]:visible");
      await form.waitFor({ timeout: 55_000 });
      await form.locator("[data-av-new-session-control=device]").fill("laptop");
      await form.locator("[data-av-new-session-control=directory]").fill("~/projects/session-plus");
      await form.locator("[data-av-new-session-control=prompt]").fill("从手机导航启动这条会话");
      expect(await form.locator("[data-av-new-session-action=start]").isEnabled()).toBe(true);

      await page.setViewportSize({ width: 390, height: 844 });
      await frame.waitForSelector('[data-av-dock-workspace][data-av-narrow="1"]', { timeout: 55_000 });
      const mobileBar = frame.locator("[data-av-dock-mobile-bar]");
      await mobileBar.getByRole("tab", { name: "导航" }).click();
      await form.waitFor({ state: "hidden", timeout: 55_000 });
      await mobileBar.getByRole("tab", { name: "会话" }).click();
      await form.waitFor({ state: "visible", timeout: 55_000 });
      expect(await mobileBar.getByRole("tab", { name: "会话" }).getAttribute("aria-selected")).toBe("true");
      expect(await form.locator("[data-av-new-session-control=directory]").inputValue())
        .toBe("~/projects/session-plus");
      expect(await form.locator("[data-av-new-session-control=prompt]").inputValue())
        .toBe("从手机导航启动这条会话");
      const start = form.locator("[data-av-new-session-action=start]");
      expect(await start.isEnabled()).toBe(true);
      await captureAppleScreenshot(page, "session-plus-new-agent-phone-draft");
      await start.click();
      await expect.poll(() => runnerFrames.find((row) =>
        row.operation === "start_session" && row.args.prompt === "从手机导航启动这条会话"), {
        timeout: 55_000,
      }).toBeTruthy();
    } finally {
      await page.setViewportSize(desktop);
    }
  });

  it("uploads from the desktop button and the phone settings card, then references each path", async () => {
    const desktop = page.viewportSize() ?? { width: 1280, height: 720 };
    try {
      const desktopFrame = await openReady();
      const desktopUpload = desktopFrame.locator("[data-av-session-action=upload]:visible");
      await desktopUpload.waitFor({ timeout: 55_000 });
      expect(await desktopUpload.evaluate((button) => Boolean(button.closest("[data-av-session-composer-actions]"))))
        .toBe(true);
      const desktopChooser = page.waitForEvent("filechooser");
      await desktopUpload.click();
      await (await desktopChooser).setFiles({
        name: "desktop-notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("desktop"),
      });
      await desktopFrame.getByText("desktop-notes.txt").waitFor({ timeout: 55_000 });
      await desktopFrame.locator("[data-av-session-composer]:visible").fill("读取桌面附件");
      await desktopFrame.locator("[data-av-session-action=send]:visible").click();
      await expect.poll(() => runnerFrames.find((row) =>
        row.operation === "append_session"
        && String(row.args.prompt).includes("读取桌面附件")
        && String(row.args.prompt).includes("/tmp/octopus-session-browser/desktop-notes.txt")), {
        timeout: 55_000,
      }).toBeTruthy();

      await page.setViewportSize({ width: 390, height: 844 });
      const phoneFrame = await openReady();
      await phoneFrame.locator("[data-av-dock-mobile-bar]").getByRole("tab", { name: "会话" }).click();
      expect(await phoneFrame.locator("[data-av-session-action=upload]:visible").count()).toBe(0);
      const settings = phoneFrame.locator("[data-av-session-options]:visible");
      await settings.locator("summary").click();
      const phoneUpload = phoneFrame.locator("[data-av-session-action=upload]:visible");
      await phoneUpload.waitFor({ timeout: 55_000 });
      expect(await phoneUpload.evaluate((button) => Boolean(button.closest("[data-av-session-options-card]")))).toBe(true);
      const phoneChooser = page.waitForEvent("filechooser");
      await phoneUpload.click();
      await (await phoneChooser).setFiles({
        name: "phone-photo.jpg",
        mimeType: "image/jpeg",
        buffer: Buffer.from("phone"),
      });
      await phoneFrame.getByText("phone-photo.jpg").waitFor({ timeout: 55_000 });
      await phoneFrame.locator("[data-av-session-composer]:visible").fill("读取手机照片");
      await phoneFrame.locator("[data-av-session-action=send]:visible").click();
      await expect.poll(() => runnerFrames.find((row) =>
        row.operation === "append_session"
        && String(row.args.prompt).includes("读取手机照片")
        && String(row.args.prompt).includes("/tmp/octopus-session-browser/phone-photo.jpg")), {
        timeout: 55_000,
      }).toBeTruthy();
      expect(await page.locator("[data-testid=approval-count]").textContent()).toBe("0");
    } finally {
      await page.setViewportSize(desktop);
    }
  });

  it("submits directly and keeps activity in the compact trusted panel on a phone", async () => {
    const desktop = page.viewportSize() ?? { width: 1280, height: 720 };
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      const frame = await openReady();
      // Phone layout opens on navigation. Select the chat layer explicitly;
      // Dockview also keeps a hidden desktop renderer mounted.
      const phoneBar = frame.locator("[data-av-dock-mobile-bar]");
      await phoneBar.getByRole("tab", { name: "会话" }).click();
      const composer = frame.locator("[data-av-session-composer]:not([disabled]):visible");
      const sendPrompt = frame.locator("[data-av-session-action=send]:visible");
      await composer.waitFor({ timeout: 55_000 });
      await composer.fill("请继续完成这个实现");
      expect(await sendPrompt.isEnabled()).toBe(true);
      await sendPrompt.click();

      await expect.poll(() => runnerFrames.find((row) =>
        row.operation === "append_session" && row.args.prompt === "请继续完成这个实现"), { timeout: 55_000 })
        .toBeTruthy();
      // Runner receipt precedes the Host's proposal reply. Under the landing
      // gate's concurrent load that gap is observable, while trusted activity
      // is published only with the reply. The controller clears the composer
      // after that same successful reply, so wait on the producer-side seam
      // before opening the trusted operation history.
      await expect.poll(() => composer.inputValue(), { timeout: 55_000 }).toBe("");
      expect(await frame.locator('[data-av-dock-flow="bottom"]').count()).toBe(0);
      // Device terminals now open as resource-keyed primary documents rather
      // than owning a fourth standing phone layer.
      expect(await phoneBar.getByRole("tab").allInnerTexts()).toEqual(["导航", "会话", "文件"]);
      // And the refresh the phone never had: one control in the App frame, so
      // it is reachable from the chat layer where the rail is not on screen.
      expect(await phoneBar.locator("[data-av-session-action=refresh]").count()).toBe(1);
      expect(await page.locator("[data-testid=approval-count]").textContent()).toBe("0");
      // Ticket #438 moved operation history into the trusted Session+ info
      // menu. Exercise that user-visible route rather than the old approval
      // drawer, which now contains only approval-plane activity.
      await page.locator('summary[aria-label="会话信息"]').click();
      const historySummary = page.locator("summary").filter({ hasText: "历史动作" }).first();
      await historySummary.click();
      await historySummary.locator("..").getByText("append_session", { exact: true }).first()
        .waitFor({ timeout: 55_000 });
    } finally {
      await page.setViewportSize(desktop);
    }
  });

  it("opens the owner's own terminal without an approval card and reuses its lease (O1)", async () => {
    const frame = await openReady();
    const approvalsBefore = Number(await page.locator("[data-testid=approval-count]").textContent());

    // The owner opening a shell on their own machine asks nobody (O1); a
    // share guest doing the same still meets a card (bundle.test.ts).
    await frame.getByRole("button", { name: "打开 laptop 的远端终端" }).click();
    await expect.poll(() => runnerFrames.some((row) =>
      row.operation === "workspace_terminal" && row.args.action === "open"), { timeout: 55_000 }).toBe(true);
    expect(Number(await page.locator("[data-testid=approval-count]").textContent())).toBe(approvalsBefore);

    const terminalModule = frame.locator('[data-av-module="session.remote-terminal/v1"]');
    const terminalDocument = terminalModule.locator("xpath=ancestor::*[@data-av-dock-document][1]");
    const terminalPanelId = await terminalDocument.getAttribute("data-av-dock-document");
    expect(terminalPanelId).toBeTruthy();
    await frame.locator(`[data-av-dock-tab="${terminalPanelId}"]`).click();
    await terminalModule.getByText("快速通道已开启").waitFor({ timeout: 55_000 });

    const terminalInput = terminalModule.getByLabel("终端输入");
    await terminalInput.fill("printf terminal-ok");
    await terminalInput.press("Enter");
    await expect.poll(async () => ({
      actions: runnerFrames
        .filter((row) => row.operation === "workspace_terminal")
        .map((row) => String(row.args.action ?? "")),
      note: await frame.locator("[data-av-remote-terminal-error]:visible").textContent().catch(() => ""),
      approvals: Number(await page.locator("[data-testid=approval-count]").textContent()),
    }), { timeout: 55_000 }).toMatchObject({
      actions: expect.arrayContaining(["input"]),
      approvals: approvalsBefore,
    });
    await frame.locator("[data-av-remote-terminal-screen]").filter({ hasText: "terminal-ok" })
      .waitFor({ timeout: 55_000 });
    expect(Number(await page.locator("[data-testid=approval-count]").textContent())).toBe(approvalsBefore);

    await frame.getByRole("button", { name: "结束终端" }).click();
    await frame.getByRole("button", { name: /打开终端|重试打开/ }).waitFor({ timeout: 55_000 });
    expect(runnerFrames.some((row) =>
      row.operation === "workspace_terminal" && row.args.action === "close")).toBe(true);
    expect(Number(await page.locator("[data-testid=approval-count]").textContent())).toBe(approvalsBefore);
  });

  it("keeps the session cookie HttpOnly and out of App markup and asset URLs", async () => {
    await openReady();
    const cookies = await page.context().cookies(panelOrigin);
    const session = cookies.find((cookie) => cookie.name === "octopus_sess");
    expect(session?.httpOnly).toBe(true);
    expect(session?.domain).toBe("localhost");
    expect(await page.evaluate(() => document.cookie)).not.toContain(session!.value);
    const html = await page.locator("[data-session-plus-app]").evaluate((node) => node.outerHTML);
    for (const cookie of cookies) {
      expect(html).not.toContain(cookie.value);
      for (const path of appAssetRequests) expect(path).not.toContain(cookie.value);
    }
    expect(await page.locator("#octopus-app-instance").count()).toBe(0);
    expect(page.url()).toBe(`${panelOrigin}/sessions-plus`);
  });

  it("mounts the App and shell under the same React root", async () => {
    await openReady();
    const roots = await page.evaluate(() => {
      // React's DOM fiber is inspected only by this acceptance test. Walking
      // to HostRoot distinguishes one tree from two roots sharing a document.
      type Fiber = { return: Fiber | null; stateNode: unknown };
      const rootOf = (element: Element | null): unknown => {
        if (!element) return null;
        const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
        if (!key) return null;
        let fiber = (element as unknown as Record<string, Fiber>)[key];
        while (fiber.return) fiber = fiber.return;
        return fiber.stateNode;
      };
      const shell = rootOf(document.querySelector('[data-testid="session-plus-workspace"]'));
      const app = rootOf(document.querySelector("[data-session-plus-app]"));
      return { shell: Boolean(shell), app: Boolean(app), shared: shell === app };
    });
    expect(roots).toEqual({ shell: true, app: true, shared: true });
    expect(page.frames()).toEqual([page.mainFrame()]);
    expect(await page.locator('a.tab[href="/sessions-plus"]').getAttribute("href")).toBe("/sessions-plus");
  });

  it("permits same-origin reads and blocks external connections under the shell CSP", async () => {
    await openReady();
    const before = externalHits.length;
    const verdict = await page.evaluate(async (external: string) => {
      const overview = await fetch("/api/overview", { credentials: "same-origin" });
      const attempt = async (fn: () => Promise<unknown>): Promise<boolean> => {
        try { await fn(); return false; } catch { return true; }
      };
      return {
        sameOrigin: overview.status,
        fetchBlocked: await attempt(() => fetch(external + "/fetch")),
        xhrBlocked: await attempt(() => new Promise((resolve, reject) => {
          const request = new XMLHttpRequest();
          request.onload = resolve; request.onerror = reject;
          request.open("GET", external + "/xhr"); request.send();
        })),
        websocketBlocked: await attempt(() => new Promise((resolve, reject) => {
          const socket = new WebSocket(external.replace("http:", "ws:") + "/ws");
          socket.onopen = () => { socket.close(); resolve(undefined); };
          socket.onerror = reject;
        })),
        eventSourceBlocked: await attempt(() => new Promise((resolve, reject) => {
          const source = new EventSource(external + "/events");
          source.onopen = () => { source.close(); resolve(undefined); };
          source.onerror = (error) => { source.close(); reject(error); };
        })),
      };
    }, externalOrigin);
    expect(verdict).toEqual({ sameOrigin: 200, fetchBlocked: true, xhrBlocked: true, websocketBlocked: true, eventSourceBlocked: true });
    expect(externalHits.length).toBe(before);
  });

  it("hands the App a public projection without credentials or instance authority", async () => {
    await openReady();
    const projection = await page.evaluate(() => {
      const boot = JSON.parse(document.getElementById("octopus-bootstrap")!.textContent!);
      return boot.pageProps.projection as unknown;
    });
    expect(projection).toBeTruthy();
    const text = JSON.stringify(projection);
    // Boot contains durable App state; transcript data arrives through the
    // subsequent typed read. Wait for that real render independently.
    await expect.poll(() => page.locator("[data-session-plus-app]").textContent(),
      { timeout: 15_000 }).toContain("答复 260");
    const secrets = (await page.context().cookies(panelOrigin)).map((cookie) => cookie.value);
    expect(activeInstance).not.toBe("");
    secrets.push(activeInstance);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(await page.locator("#octopus-app-instance").count()).toBe(0);
  });

  it("persists the declared pin action without reflecting identity", async () => {
    const frame = await openReady();
    const acceptedBefore = Number(await page.getAttribute("body", "data-sp-accepted"));
    // Durable presentation recovery may correctly leave the navigation group
    // active. Select the semantic chat tab before opening its floating card so
    // Dockview raises that renderer above the always-mounted rail overlay.
    await frame.locator('[data-av-dock-tab="chat"]').click();
    const chat = frame.locator('[data-av-dock-document="chat"]:not([hidden])');
    // Session actions live behind the same settings disclosure a user opens.
    // Do not rely on an earlier test having left that disclosure expanded.
    await chat.locator('summary[aria-label="会话设置"]').click();
    const chatBox = await chat.boundingBox();
    const optionsBox = await chat.locator("[data-av-session-options-card]").boundingBox();
    expect(chatBox, "the active chat Dock surface").toBeTruthy();
    expect(optionsBox, "the open session settings card").toBeTruthy();
    expect(optionsBox!.x).toBeGreaterThanOrEqual(chatBox!.x - 1);
    expect(optionsBox!.x + optionsBox!.width)
      .toBeLessThanOrEqual(chatBox!.x + chatBox!.width + 1);
    await chat.locator("[data-av-session-action=pin]").click();
    await page.waitForFunction(
      (before: number) => Number(document.body.dataset.spAccepted ?? "0") > before,
      acceptedBefore,
      { timeout: 55_000 },
    );
    const answer = JSON.parse((await page.getAttribute("body", "data-sp-answer"))!) as Record<string, unknown>;
    expect(answer).toEqual({ ok: true, action: "pin_session" });
    const text = JSON.stringify(answer);
    for (const forbidden of ["alice", "owner", "credential", "instance", "scope"]) expect(text).not.toContain(forbidden);
    await page.click("[data-testid=approval-activity-toggle]");
    const activity = page.locator("[data-testid=agentic-activity-card]").filter({ hasText: "pin_session" }).first();
    await activity.waitFor({ timeout: 55_000 });
    expect(await activity.innerText()).toContain("已接受");
    const dialog = await openFixtureSessionDialog(frame);
    await dialog.locator("[data-av-session-row] [data-av-session-pinned]").waitFor();
    const cookies = await page.context().cookies(panelOrigin);
    for (const c of cookies) expect(await activity.innerText()).not.toContain(c.value);

    // App state is outside the browser and the runtime process: a fresh tab
    // instance projects the immutable event history and keeps the pin.
    await page.reload();
    const reopened = await openReady();
    const reopenedDialog = await openFixtureSessionDialog(reopened);
    expect(await reopenedDialog.locator("[data-av-session-row] [data-av-session-pinned]").count()).toBeGreaterThan(0);
  });

  it("refuses undeclared actions and binds forged authority to the authenticated owner", async () => {
    await openReady();
    const before = runnerFrames.length;
    const refused = await postAction({
      action: "delete_everything", params: {},
      owner: "root", app: "foreign", scope: "../../etc", instance: "forged", approved: true,
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ ok: false, code: "unknown_action" });
    for (const forged of ["root", "foreign", "../../etc", "forged"]) expect(JSON.stringify(refused.body)).not.toContain(forged);
    expect(runnerFrames.slice(before).some((row) => row.operation === "delete_everything")).toBe(false);
    const accepted = await postAction({ action: "refresh_sessions", params: { limit: "200", source: "all" }, owner: "root", approved: true });
    expect(accepted.status).toBe(200);
    expect(accepted.body.ok).toBe(true);
    expect(runnerFrames.slice(before).every((row) => row.owner === "alice")).toBe(true);
    expect(JSON.stringify(accepted.body)).not.toContain('"owner":"root"');
  });

  it("refuses missing CSRF, forged instances and a closed tab's binding", async () => {
    await openReady();
    const current = activeInstance;
    const payload = { action: "refresh_sessions", params: { limit: "200", source: "all" } };
    const noCsrf = await postAction(payload, { csrf: false });
    expect(noCsrf.status).toBe(403);
    const forged = await postAction(payload, { instance: "forged" });
    expect(forged.status).toBe(404);
    expect(forged.body.code).toBe("invalid_instance");
    // Navigating closes the previous instance through the real pagehide path.
    await openReady();
    expect(activeInstance).not.toBe(current);
    await expect.poll(async () => (await postAction(payload, { instance: current })).status,
      { timeout: 10_000 }).toBe(404);
  });

  it("reconstructs the App runtime while preserving trusted chrome and the composer draft", async () => {
    const frame = await openReady();
    await frame.locator('[data-av-dock-tab="chat"]').click();
    const composer = frame.locator("[data-av-session-composer]");
    await composer.fill("重建保留原会话草稿");
    const oldRoot = await frame.locator("[data-session-plus-app]").elementHandle();
    const generation = Number(await page.getAttribute("body", "data-sp-generation"));
    await page.evaluate(() => ((window as unknown as { __alive: number }).__alive = 42));
    await page.click("[data-testid=reconstruct-agent-view]");
    // The click leaves the pointer resting on ♻. When the rebuild is slow, its
    // hover tooltip opens over the chat tab and swallows the next click.
    await page.mouse.move(0, 0);
    await page.waitForFunction(
      (was: number) => document.body.dataset.spState === "ready" && Number(document.body.dataset.spGeneration) > was,
      generation, { timeout: 55_000 },
    );
    await frame.locator("[data-session-plus-app]").waitFor();
    expect(await oldRoot!.evaluate((node) => node.isConnected)).toBe(false);
    await frame.locator('[data-av-dock-tab="chat"]').click();
    expect(await composer.inputValue()).toBe("重建保留原会话草稿");
    expect(await page.evaluate(() => (window as unknown as { __alive?: number }).__alive)).toBe(42);
    expect(await page.getAttribute('a.tab[href="/sessions-plus"]', "href")).toBe("/sessions-plus");
    expect(page.frames()).toEqual([page.mainFrame()]);
  });

  it("keeps release CSS out of shell elements, other Apps and other release scopes", async () => {
    await openReady();
    const scoped = await page.evaluate(async () => {
      const surface = document.querySelector<HTMLElement>("[data-testid=session-plus-workspace] > [data-app-surface]")!;
      const root = surface.querySelector<HTMLElement>("[data-session-plus-app]")!;
      const styles = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
        .filter((link) => link.href.includes("/ui/apps/"));
      const holder = document.createElement("div");
      holder.style.cssText = "position:fixed;visibility:hidden;left:-10000px;top:0;width:500px";
      const scopes = ["", "foreign-app--0000000000000000", surface.dataset.appId + "--0000000000000000"];
      const sentinels = scopes.map((scope) => {
        const wrap = document.createElement("div");
        if (scope) wrap.dataset.appSurface = scope;
        const node = document.createElement("div");
        node.className = root.className;
        node.dataset.sessionPlusApp = "";
        const button = document.createElement("button");
        button.className = root.querySelector("button")?.className ?? "";
        button.textContent = "scope sentinel";
        node.appendChild(button); wrap.appendChild(node); holder.appendChild(wrap);
        return button;
      });
      document.body.appendChild(holder);
      const snapshot = (node: Element): string => {
        const computed = getComputedStyle(node);
        return Array.from(computed).map((key) => `${key}:${computed.getPropertyValue(key)}`).join(";");
      };
      try {
        styles.forEach((link) => { link.disabled = true; });
        const before = sentinels.map(snapshot);
        const appBefore = snapshot(root);
        styles.forEach((link) => { link.disabled = false; });
        return { count: styles.length, before, after: sentinels.map(snapshot), appChanged: appBefore !== snapshot(root) };
      } finally {
        styles.forEach((link) => { link.disabled = false; }); holder.remove();
      }
    });
    expect(scoped.count).toBeGreaterThan(0);
    expect(scoped.after).toEqual(scoped.before);
    expect(scoped.appChanged, "the tested styles really affect the active App").toBe(true);
  });

  it("serves only declared browser assets without exposing runtime source", async () => {
    await openReady();
    const base = `${panelOrigin}/ui/apps/${releases.active()!.prepared.identity.packageDigest}/`;
    for (const name of ["runtime.js", "app.ts", "package.json", "agent-view.js.map", "projection-secret"]) {
      const response = await page.request.get(base + name);
      expect(response.status(), name).toBe(404);
      expect(await response.text(), name).not.toContain("需求 61");
    }
    expect(await page.locator("[data-session-plus-app]").count()).toBe(1);
    expect(await page.locator("[data-testid=reconstruct-agent-view]").isEnabled()).toBe(true);
  });

  it("refuses unknown releases and nested paths without changing the running App", async () => {
    await openReady();
    const digest = releases.active()!.prepared.identity.packageDigest;
    for (const path of [
      `/ui/apps/${"0".repeat(64)}/agent-view.js`,
      `/ui/apps/${digest}/nested/agent-view.js`,
      `/ui/apps/${digest}/%2e%2e/package.json`,
      `/ui/apps/${digest}/agent-view.entry.json/projection-secret`,
    ]) {
      const response = await page.request.get(panelOrigin + path);
      expect(response.status(), path).toBe(404);
    }
    expect(await page.locator("[data-session-plus-app]").count()).toBe(1);
    expect(await page.locator('a.tab[href="/sessions-plus"]').getAttribute("href")).toBe("/sessions-plus");
  });

  it("shares the shell theme without remounting the App or disturbing its draft (ticket #45)", async () => {
    // One document and one React tree: appearance belongs on the App surface.
    // A theme flip must not create a second runtime or any session operation.
    const frame = await openReady();
    // The shell persists a person's last theme. Establish the baseline through
    // the real picker instead of coupling this test to profile history.
    const preferences = page.getByTestId("status-and-preferences");
    if (!(await preferences.evaluate((node) => node.hasAttribute("open")))) {
      await preferences.locator("summary").click();
    }
    await page.selectOption('select[aria-label="主题"]', "classic");
    await frame.waitForFunction(
      () => document.querySelector<HTMLElement>("[data-testid=session-plus-workspace] > [data-app-surface]")?.dataset.avTheme === "classic",
      null,
      { timeout: 5_000 },
    );
    await frame.waitForSelector("[data-av-session-composer]:not([disabled])", { timeout: 55_000 });
    await frame.fill("[data-av-session-composer]", "本轮外观切换不应清空这段草稿");
    await frame.evaluate(() => {
      const composer = document.getElementById("composer") as HTMLTextAreaElement;
      composer.focus();
      composer.setSelectionRange(6, 6);
    });

    async function appIdentity(): Promise<string> {
      // Attaching a data attribute is a stable way to prove the element is
      // literally the same DOM node: if the frame were rebuilt, the new
      // element would not carry the tag and this assertion would fail.
      return await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>("[data-session-plus-app]");
        if (!el) throw new Error("no App root");
        if (!el.dataset.themeSyncMark) el.dataset.themeSyncMark = `mark-${Math.random().toString(36).slice(2)}`;
        return el.dataset.themeSyncMark;
      });
    }

    const markBefore = await appIdentity();
    const genBefore = await page.evaluate(() => document.body.dataset.spGeneration ?? "");
    const portsBefore = await page.evaluate(() => document.body.dataset.spPorts ?? "");
    const acceptedBefore = await page.evaluate(() => document.body.dataset.spAccepted ?? "");
    const refusedBefore = await page.evaluate(() => document.body.dataset.spRefused ?? "");
    const runnerBefore = runnerFrames.length;

    async function selectTheme(theme: string): Promise<void> {
      // Drive the real picker and observe the App's scoped appearance id.
      await page.selectOption('select[aria-label="主题"]', theme);
      await frame.waitForFunction(
        (expected: string) => document.querySelector<HTMLElement>("[data-testid=session-plus-workspace] > [data-app-surface]")?.dataset.avTheme === expected,
        theme,
        { timeout: 5_000 },
      );
    }

    expect(await frame.evaluate(() => document.documentElement.dataset.avTheme)).toBeUndefined();
    await selectTheme("aurora");
    await selectTheme("ink");
    await selectTheme("apple");
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("apple");
    await selectTheme("classic");
    // A system-scheme transition is local CSS state and preserves the draft.
    await page.emulateMedia({ colorScheme: "dark" });
    await selectTheme("deepseek");
    await selectTheme("apple");
    await selectTheme("classic");
    await page.emulateMedia({ colorScheme: "light" });
    await selectTheme("apple");

    // The actual App DOM node and runtime generation survive every theme flip.
    expect(await appIdentity()).toBe(markBefore);
    expect(await page.evaluate(() => document.body.dataset.spGeneration ?? "")).toBe(genBefore);
    expect(await page.evaluate(() => document.body.dataset.spPorts ?? "")).toBe(portsBefore);
    expect(await page.evaluate(() => document.body.dataset.spAccepted ?? "")).toBe(acceptedBefore);
    expect(await page.evaluate(() => document.body.dataset.spRefused ?? "")).toBe(refusedBefore);

    expect(runnerFrames.length, "appearance has no Runner side effects").toBe(runnerBefore);
    expect(await page.evaluate(() => document.documentElement.dataset.avTheme)).toBeUndefined();

    // Composer draft, focus and selection survived every appearance change.
    // A remount or a projection overwrite would silently discard any of the
    // three, and each is what a person notices immediately.
    expect(await frame.evaluate(() => ({
      active: document.activeElement?.id ?? "",
      value: (document.getElementById("composer") as HTMLTextAreaElement).value,
      selection: (document.getElementById("composer") as HTMLTextAreaElement).selectionStart,
    }))).toEqual({
      active: "composer",
      value: "本轮外观切换不应清空这段草稿",
      selection: 6,
    });

    // Fresh contexts also verify the persisted profile on a second device.
    async function verifyFreshScheme(scheme: "light" | "dark"): Promise<void> {
      const context = await browser.newContext({ colorScheme: scheme });
      try {
        await idleDeploymentObserver(context);
        const visual = await context.newPage();
        await visual.goto(`${panelOrigin}/login`);
        await visual.fill('input[type="password"]', token);
        await visual.click('button[type="submit"]');
        await visual.waitForURL(`${panelOrigin}/sessions-plus`, { timeout: 30_000 });
        await visual.waitForFunction(
          () => document.body.dataset.spState === "ready",
          null,
          { timeout: 55_000 },
        );
        expect(await visual.locator("html").getAttribute("data-theme"), `${scheme} shell theme`).toBe("apple");
        const visualFrame = visual.mainFrame();
        expect(visual.frames(), `${scheme} same-tree App`).toEqual([visualFrame]);
        await visualFrame!.waitForSelector("[data-session-plus-app]", { timeout: 55_000 });
        await visualFrame!.waitForFunction(
          (dark: boolean) => window.matchMedia("(prefers-color-scheme: dark)").matches === dark,
          scheme === "dark",
          { timeout: 5_000 },
        );
        const appearance = await visualFrame!.evaluate(() => {
          const surface = document.querySelector<HTMLElement>("[data-testid=session-plus-workspace] > [data-app-surface]")!;
          const body = getComputedStyle(surface);
          const group = surface.querySelector<HTMLElement>(".dv-groupview");
          return {
            theme: surface.dataset.avTheme,
            canvas: body.backgroundColor,
            foreground: body.color,
            surface: group ? getComputedStyle(group).backgroundColor : "missing",
          };
        });
        expect(appearance).toEqual(scheme === "dark" ? {
          theme: "apple",
          canvas: "rgb(11, 11, 13)",
          foreground: "rgb(245, 245, 247)",
          surface: "rgb(28, 28, 30)",
        } : {
          theme: "apple",
          canvas: "rgb(245, 245, 247)",
          foreground: "rgb(29, 29, 31)",
          surface: "rgb(255, 255, 255)",
        });
        await captureAppleScreenshot(visual, `session-plus-${scheme}`);
      } finally {
        await context.close();
      }
    }

    await verifyFreshScheme("dark");
    await verifyFreshScheme("light");
  });

  it("keeps the all-sessions dialog inside the App scope with usable desktop and phone geometry", async () => {
    const frame = await openReady();
    const desktop = page.viewportSize()!;
    try {
      for (const viewport of [desktop, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        if (viewport.width < 600) {
          await frame.locator("[data-av-dock-mobile-bar]").getByRole("tab", { name: "导航" }).click();
        }
        await showNavigatorView(frame, "sessions");
        const browse = frame.getByRole("button", { name: "全部会话", exact: true });
        await browse.click();
        const dialog = frame.getByRole("dialog", { name: "浏览全部会话", exact: true });
        await dialog.waitFor();
        // Ant zooms the dialog in from scale(0.2) (520px reads as 104px on the
        // first frame); geometry is about the settled dialog, not a motion frame.
        await expect.poll(() => dialog.evaluate((node) => /\bant-zoom\b/.test(node.className)), { timeout: 5_000 }).toBe(false);
        const measured = await dialog.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const surface = node.closest<HTMLElement>("[data-app-surface]");
          return { width: box.width, left: box.left, right: box.right,
            scope: surface?.dataset.appSurface, theme: surface?.dataset.avTheme,
            token: getComputedStyle(node).getPropertyValue("--av-canvas").trim(),
            scrollOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        });
        expect(measured.scope).toMatch(/^session-plus--[0-9a-f]{16}$/);
        expect(measured.theme).toBe("apple");
        expect(measured.token).not.toBe("");
        expect(measured.width).toBeGreaterThan(Math.min(280, viewport.width - 32));
        expect(measured.left).toBeGreaterThanOrEqual(0);
        expect(measured.right).toBeLessThanOrEqual(viewport.width + 1);
        if (measured.scrollOverflow > 1) console.error("[session-plus phone overflow]", JSON.stringify(await page.evaluate(() =>
          Array.from(document.querySelectorAll("body *")).map((node) => {
            const r = node.getBoundingClientRect();
            return { tag: node.tagName, classes: node.getAttribute("class"), left: r.left, right: r.right, width: r.width, detailsOpen: node.closest("details")?.open };
          }).filter((row) => row.width > 0 && (row.left < -1 || row.right > innerWidth + 1)).slice(0, 15))));
        expect(measured.scrollOverflow).toBeLessThanOrEqual(1);
        await expect.poll(() => dialog.locator("[data-av-session-row]").count(), { timeout: 15_000 }).toBeGreaterThan(0);
        await dialog.locator("button.ant-modal-close").click();
        await expect.poll(() => dialog.count()).toBe(0);
      }
    } finally { await page.setViewportSize(desktop); }
  });

  it("keeps the authenticated Dashboard unframeable from an external page", async () => {
    const other = await page.context().newPage();
    try {
      await other.goto(externalOrigin);
      const response = other.waitForResponse((row) => row.url() === `${panelOrigin}/sessions-plus`);
      await other.evaluate((origin: string) => {
        const frame = document.createElement("iframe");
        frame.src = origin + "/sessions-plus";
        document.body.appendChild(frame);
      }, panelOrigin);
      const framed = await response;
      expect(framed.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
      await expect.poll(async () => {
        const child = other.frames().find((frame) => frame !== other.mainFrame());
        return child ? child.evaluate(() => Boolean(document.querySelector("[data-session-plus-app]"))).catch(() => false) : false;
      }).toBe(false);
    } finally { await other.close(); }
  });


  /** Drag actual Dock tabs into edge drop zones; no private Dock API or state injection. */
  async function splitLiveTab(frame: Frame, sourceId: string, targetId: string, edge: "right" | "bottom"): Promise<void> {
    const targetTab = frame.locator(`[data-av-dock-tab="${targetId}"]`);
    await targetTab.click();
    const target = targetTab
      .locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' dv-groupview ')][1]");
    const source = frame.locator(`[data-av-dock-tab="${sourceId}"]`)
      .locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' dv-tab ')][1]");
    await source.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`Dock split target ${targetId} is not visible`);
    const start = await source.boundingBox();
    if (!start) throw new Error(`Dock drag source ${sourceId} is not visible`);
    const x = edge === "right" ? box.x + box.width - 8 : box.x + box.width / 2;
    const y = edge === "right" ? box.y + box.height / 2 : box.y + box.height - 8;
    // Dockview's content overlay is a sibling of its group, so its legitimate
    // hit target differs from the group used to measure the drop rectangle.
    // Send the user's pointer gesture; never call private Dock/React APIs.
    await source.hover();
    await page.mouse.down();
    try {
      await page.mouse.move(start.x + start.width / 2 + 12, start.y + start.height / 2, { steps: 3 });
      await page.mouse.move(x, y, { steps: 12 });
      await page.mouse.move(x, y);
    } finally { await page.mouse.up(); }
    await expect.poll(() => frame.locator(`[data-av-dock-document="${sourceId}"]`).isVisible()).toBe(true);
    await expect.poll(() => frame.locator(`[data-av-dock-document="${targetId}"]`).isVisible()).toBe(true);
  }

  /** Balance real sashes so every window in this workload is simultaneously usable. */
  async function balanceLiveSplit(frame: Frame, upperId: string, lowerId: string, edge: "bottom" | "right" = "bottom"): Promise<void> {
    const group = (id: string) => frame.locator(`[data-av-dock-tab="${id}"]`)
      .locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' dv-groupview ')][1]");
    const upper = (await group(upperId).boundingBox())!;
    const lower = (await group(lowerId).boundingBox())!;
    const horizontal = edge === "bottom";
    const x = lower.x + lower.width / 2;
    const y = lower.y + lower.height / 2;
    const handle = await frame.locator(".dv-sash:not(.dv-disabled)").evaluateAll((nodes, point) =>
      nodes.map(node => node.getBoundingClientRect())
        .filter(box => point.horizontal
          ? box.width > 100 && box.height < 20 && box.left < point.x && box.right > point.x
          : box.height > 100 && box.width < 20 && box.top < point.y && box.bottom > point.y)
        .map(box => point.horizontal ? { x: point.x, y: box.top + box.height / 2 } : { x: box.left + box.width / 2, y: point.y })
        .sort((a, b) => Math.abs((point.horizontal ? a.y : a.x) - point.boundary) - Math.abs((point.horizontal ? b.y : b.x) - point.boundary))[0],
    { x, y, horizontal, boundary: horizontal ? lower.y : lower.x });
    if (!handle || Math.abs((horizontal ? handle.y - lower.y : handle.x - lower.x)) > 24) throw new Error("Live split sash is unavailable: " + JSON.stringify({
      upper, lower, handle, sashes: await frame.locator(".dv-sash").evaluateAll(nodes => nodes.map(node => ({
        classes: node.className, box: node.getBoundingClientRect().toJSON(),
      }))),
    }));
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    try { await page.mouse.move(
      horizontal ? handle.x : (upper.x + lower.x + lower.width) / 2,
      horizontal ? (upper.y + lower.y + lower.height) / 2 : handle.y,
      { steps: 12 },
    ); }
    finally { await page.mouse.up(); }
    await expect.poll(async () => Math.min(
      (await group(upperId).boundingBox())?.[horizontal ? "height" : "width"] ?? 0,
      (await group(lowerId).boundingBox())?.[horizontal ? "height" : "width"] ?? 0,
    )).toBeGreaterThan(300);
  }

  async function followLiveTail(transcript: Locator, token: string): Promise<void> {
    // A visible transcript must also receive pointer input after Dock splits.
    // Bounding boxes alone miss a composer overflowing on top of the messages.
    await transcript.scrollIntoViewIfNeeded();
    await expect.poll(() => transcript.evaluate(node => {
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      const panel = node.closest("[data-av-dock-document]")!;
      const geometry = [node, panel, panel.parentElement!, panel.parentElement!.parentElement!, ...Array.from(panel.querySelectorAll(".command-pane, .composer, .composer-entry, .composer-input-shell, textarea"))]
        .map(element => {
          const rect = element.getBoundingClientRect(); const css = getComputedStyle(element);
          return { role: element.className, top: rect.top, bottom: rect.bottom, height: rect.height,
            minHeight: css.minHeight, font: css.font, flex: css.flex, overflow: css.overflow };
        });
      return hit && node.contains(hit) ? "" : JSON.stringify({ viewport: innerHeight, hit: hit?.className, geometry });
    }), { timeout: 2_000 }).toBe("");
    await transcript.hover();
    await page.mouse.wheel(0, 1_000_000);
    // Wheel scrolling is asynchronous and removes the latest button once
    // the tail is reached. Wait for the tail instead of racing a second click.
    await expect.poll(() => transcript.textContent(), { timeout: 15_000 }).toContain(token);
  }

  it("recovers foreground session and file windows with their split geometry after reload and reopening", async () => {
    const ids = ["recovery-a", "recovery-b", "recovery-c"];
    const titles = ["布局恢复 A", "布局恢复 B", "布局恢复 C"];
    for (const [index, id] of ids.entries()) liveSessionRows.set(id, {
      title: titles[index]!, sequence: 1, text: id, epoch: id,
    });
    const geometry = async (target: Page) => target.evaluate(() => {
      const documents = Array.from(document.querySelectorAll<HTMLElement>("[data-av-dock-document]")).filter((node) => node.checkVisibility({ visibilityProperty: true }));
      return documents.map((node) => {
        const id = node.dataset.avDockDocument;
        const tab = Array.from(document.querySelectorAll<HTMLElement>("[data-av-dock-tab]")).find((row) => row.dataset.avDockTab === id);
        const box = node.getBoundingClientRect();
        return { title: tab?.textContent?.trim() ?? "", x: box.x, y: box.y, width: box.width, height: box.height };
      }).sort((a, b) => a.title.localeCompare(b.title));
    });
    try {
      await clearRecovery();
      const frame = await openReady();
      const nav = frame.locator('[data-av-dock-flow="navigation"]');
      await nav.waitFor();
      expect((await nav.boundingBox())!.width).toBeLessThan(400);
      const panels: string[] = [];
      await showNavigatorView(frame, "sessions");
      for (const title of titles) {
        const toggle = frame.getByRole("button", { name: /最近会话/ });
        if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
        await frame.getByRole("region", { name: "最近会话", exact: true }).locator("[data-av-session-row]").filter({ hasText: title }).click();
        const transcript = frame.locator("[data-av-chat-transcript]:visible").filter({ hasText: title }).first();
        await transcript.waitFor();
        panels.push((await transcript.locator("xpath=ancestor::*[@data-av-dock-document][1]").getAttribute("data-av-dock-document"))!);
      }
      await splitLiveTab(frame, panels[1]!, panels[0]!, "right");
      await splitLiveTab(frame, panels[2]!, panels[0]!, "bottom");
      await showNavigatorView(frame, "files");
      const tree = frame.locator("[data-av-file-tree]:visible").first();
      const root = tree.locator("[data-av-file-directory]").filter({ hasText: "Session Plus" }).first();
      await toggleWsdirOpen(root, frame, "Session Plus");
      await tree.locator("[data-av-file]").filter({ hasText: "readme.md" }).first().click();
      await frame.locator("[data-av-file-markdown] h1").waitFor();
      // The file replaces B as the front tab of the existing right group.
      await expect.poll(async () => (await geometry(page)).length).toBe(3);
      const file = frame.locator('[data-av-dock-document]:visible').filter({ has: frame.locator("[data-av-file-markdown] h1") });
      const box = (await file.boundingBox())!;
      const sash = await leftEdgeSash(frame.locator(".dv-sash"), box.x);
      const handle = (await sash.boundingBox())!;
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x - 65, handle.y + handle.height / 2, { steps: 10 });
      await page.mouse.up();
      const before = await geometry(page);
      expect(before.some((row) => row.title.includes("布局恢复 B"))).toBe(false);
      expect(before.every((row) => row.width > 150 && row.height > 100)).toBe(true);
      await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
        .filter((key) => key.startsWith("octopus-session-plus-recovery-v1:"))
        .some((key) => JSON.parse(localStorage.getItem(key)!).documents?.length === 3))).toBe(true);
      await openReady();
      await page.locator("[data-av-file-markdown] h1").waitFor();
      await expect.poll(async () => (await geometry(page)).map((row) => row.title)).toEqual(before.map((row) => row.title));
      const after = await geometry(page);
      for (const [index, row] of after.entries()) {
        for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(row[key] - before[index]![key]), JSON.stringify({ before, after })).toBeLessThan(8);
      }
      expect(await page.locator("[data-av-dock-tab]").filter({ hasText: "布局恢复 B" }).count()).toBe(0);
      // A fresh tab has an empty sessionStorage but shares the account's last layout.
      const reopened = await page.context().newPage();
      try {
        await reopened.goto(`${panelOrigin}/sessions-plus`);
        await reopened.locator("[data-av-file-markdown] h1").waitFor();
        await expect.poll(async () => (await geometry(reopened)).map((row) => row.title)).toEqual(before.map((row) => row.title));
        await reopened.setViewportSize({ width: 1000, height: 800 });
        await reopened.locator('[data-av-dock-flow="navigation"]').waitFor();
        await expect.poll(async () => (await geometry(reopened)).every((row) => row.width > 120 && row.height > 100)).toBe(true);
        expect((await reopened.locator('[data-av-dock-flow="navigation"]').boundingBox())!.width).toBeLessThan(400);
      } finally { await reopened.close(); }
    } finally {
      for (const id of ids) liveSessionRows.delete(id);
      await page.goto(`${panelOrigin}/`);
      await clearRecovery();
    }
  });

  /** Four independent resources, each really paged beyond the initial tail. */
  async function openLoadedLiveWorkspace(): Promise<{
    frame: Frame; transcripts: Locator[]; panels: string[]; sourceIds: string[];
  }> {
    const epoch = ++liveFixtureEpoch;
    const sourceIds = Array.from({ length: 4 }, (_, index) => `browser-live-${epoch}-${index}`);
    for (const [index, id] of sourceIds.entries()) {
      liveSessionRows.set(id, {
        title: `实时窗口 ${epoch} / ${index + 1}`, sequence: 1,
        text: `live-${epoch}-${index}-initial`, epoch: `browser-live-${epoch}-${index}`,
      });
    }
    const frame = await openReady();
    // A prior scenario may have saved a wide rail. Arrange this workload with
    // the same visible sash gesture a person uses, keeping all chats readable.
    const navigation = frame.locator('[data-av-dock-flow="navigation"]:visible').first();
    const navBox = await navigation.boundingBox();
    if (!navBox) throw new Error("Live workspace navigation is not visible");
    const sash = await leftEdgeSash(frame.locator(".dv-sash"), navBox.x + navBox.width);
    const sashBox = await sash.boundingBox();
    if (!sashBox) throw new Error("Live workspace navigation sash is not visible");
    const sashX = sashBox.x + sashBox.width / 2; const sashY = sashBox.y + sashBox.height / 2;
    await sash.hover();
    await page.mouse.down();
    try { await page.mouse.move(sashX + 320 - navBox.width, sashY, { steps: 16 }); }
    finally { await page.mouse.up(); }
    await expect.poll(async () => (await navigation.boundingBox())?.width ?? 0).toBeLessThan(340);
    const transcripts: Locator[] = [];
    const panels: string[] = [];
    await showNavigatorView(frame, "sessions");
    for (const id of sourceIds) {
      const row = liveSessionRows.get(id)!;
      const toggle = frame.getByRole("button", { name: /最近会话/ });
      if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
      await frame.getByRole("region", { name: "最近会话", exact: true })
        .locator("[data-av-session-row]").filter({ hasText: row.title }).click();
      const initial = frame.locator("[data-av-chat-transcript]:visible").filter({ hasText: row.title }).first();
      await expect.poll(() => initial.textContent(), { timeout: 15_000 }).toContain(row.text);
      const panelId = await initial.locator("xpath=ancestor::*[@data-av-dock-document][1]").getAttribute("data-av-dock-document");
      if (!panelId) throw new Error(`live resource ${id} has no Dock document`);
      // Keep resource identity in the locator when virtual rows leave the DOM.
      const transcript = frame.locator(`[data-av-dock-document="${panelId}"] [data-av-chat-transcript]`);
      panels.push(panelId); transcripts.push(transcript);
      for (let attempt = 0; attempt < 30; attempt++) {
        const previous = await readTranscriptWorkload(transcript);
        if (previous.loadedMessages >= 600) break;
        await readOlderPage(page, transcript, previous.loadedMessages);
      }
      const loaded = await readTranscriptWorkload(transcript);
      expect(loaded.totalMessages).toBe(1_200);
      expect(loaded.loadedMessages).toBeGreaterThanOrEqual(600);
      await followLiveTail(transcript, row.text);
    }
    expect(new Set(panels).size).toBe(4);
    await splitLiveTab(frame, panels[1]!, panels[0]!, "right");
    await splitLiveTab(frame, panels[2]!, panels[0]!, "bottom");
    await splitLiveTab(frame, panels[3]!, panels[1]!, "bottom");
    // An edge drop can initially leave a very short row. Its transcript must
    // remain scrollable without painting over the composer before balancing.
    await followLiveTail(transcripts[3]!, liveSessionRows.get(sourceIds[3]!)!.text);
    expect(await transcripts[3]!.evaluate(node => {
      const command = node.closest("[data-av-dock-document]")!.querySelector(".command-pane")!;
      return node.getBoundingClientRect().bottom - command.getBoundingClientRect().top;
    })).toBeLessThanOrEqual(1);
    await balanceLiveSplit(frame, panels[0]!, panels[2]!);
    await balanceLiveSplit(frame, panels[1]!, panels[3]!);
    for (const [index, transcript] of transcripts.entries()) {
      await followLiveTail(transcript, liveSessionRows.get(sourceIds[index]!)!.text);
      const workload = await readTranscriptWorkload(transcript);
      expect(workload.visible).toBe(true);
      expect(workload.box.width).toBeGreaterThan(300);
    }
    return { frame, transcripts, panels, sourceIds };
  }

  async function closeLivePanels(frame: Frame, panels: readonly string[]): Promise<void> {
    for (const panel of panels) {
      const tab = frame.locator(`[data-av-dock-tab="${panel}"]`);
      await tab.click();
      await tab.locator(".dv-default-tab-action").click();
      await expect.poll(() => frame.locator(`[data-av-dock-document="${panel}"]`).count()).toBe(0);
    }
  }

  function livePublisher(sourceIds: readonly string[], expected: (index: number, step: number) => string) {
    return async (step: number): Promise<void> => {
      for (const [index, id] of sourceIds.entries()) {
        const row = liveSessionRows.get(id)!;
        row.sequence++; row.text = expected(index, step);
      }
      if (!sessionChangeListener) throw new Error("live source subscription is absent");
      sessionChangeListener("alice", "laptop");
    };
  }

  function assertLiveReads(before: number, sourceIds: readonly string[]): void {
    const actions = runnerFrames.slice(before);
    for (const id of sourceIds) {
      expect(actions.some((row) => row.operation === "read_session"
        && (row.args.id ?? row.args.session_id) === id), id).toBe(true);
    }
    expect(actions.filter((row) => row.operation === "append_session")).toEqual([]);
  }

  it("keeps typing intact in four visible live windows with over 600 of 1200 messages loaded each", async () => {
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: 1920, height: 1080 });
    try {
      const { frame, transcripts, panels, sourceIds } = await openLoadedLiveWorkspace();
      const composer = frame.locator(`[data-av-dock-document="${panels[3]}"] [data-av-session-composer]`);
      const expected = (index: number, step: number) => `${sourceIds[index]}-typing-step-${step}`;
      const before = runnerFrames.length;
      const evidence = await exerciseFourLiveWindows({ page, composer, transcripts, expected,
        publish: livePublisher(sourceIds, expected),
      });
      for (const row of [...evidence.workloadBefore, ...evidence.workloadAfter]) {
        expect(row.totalMessages).toBe(1_200);
        expect(row.loadedMessages).toBeGreaterThanOrEqual(600);
        expect(row.visible).toBe(true);
        expect(row.mountedRows).toBeGreaterThan(0);
        expect(row.mountedRows).toBeLessThan(row.loadedMessages);
      }
      assertLiveReads(before, sourceIds);
      console.info("[session-plus four loaded live windows]", JSON.stringify({
        measurement: {
          unit: "milliseconds",
          inputToFrameMs: "DOM input event handler to next requestAnimationFrame callback; excludes event delivery delay",
          frameGapsMs: "intervals between requestAnimationFrame callbacks during typing and convergence waits",
          convergenceMs: "round start before source publish plus concurrent sequential typing, through all four tail checks; includes typing and polling, not isolated source latency",
        },
        viewport: page.viewportSize(), ...evidence,
      }));
      await closeLivePanels(frame, panels);
    } finally { liveSessionRows.clear(); await page.setViewportSize(viewport); }
  });

  it("resizes four loaded visible chats and a twenty-page PDF while all four sources advance", async () => {
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: 1920, height: 1080 });
    includeStressPdf = true;
    const workers = observePdfWorkers(page);
    try {
      const { frame, transcripts, panels, sourceIds } = await openLoadedLiveWorkspace();
      await showNavigatorView(frame, "files");
      const tree = frame.locator("[data-av-file-tree]:visible").first();
      const root = tree.locator("[data-av-file-directory]").filter({ hasText: "Session Plus" }).first();
      if (await root.locator('[data-av-file-chevron][data-open="1"]').count() === 0) await root.click();
      await tree.locator("[data-av-file]").filter({ hasText: "stress.pdf" }).first().click();
      const pdf = frame.locator("[data-av-pdf]:visible").first();
      await expect.poll(() => pdf.locator('[data-av-pdf-page][data-painted="1"]').count(),
        { timeout: 30_000 }).toBeGreaterThan(0);
      // Opening a file can reuse an existing tab group. Explicitly arrange the
      // five visible windows through the same tab gesture used by a person.
      const pdfPanel = await pdf.locator("xpath=ancestor::*[@data-av-dock-document][1]").getAttribute("data-av-dock-document");
      if (!pdfPanel) throw new Error("PDF has no Dock document");
      await splitLiveTab(frame, pdfPanel, panels[3]!, "right");
      await balanceLiveSplit(frame, panels[3]!, pdfPanel, "right");
      const expected = (index: number, step: number) => `${sourceIds[index]}-pdf-resize-step-${step}`;
      const before = runnerFrames.length;
      const evidence = await exerciseLoadedWorkspaceResize({ page, transcripts, pdf,
        sashes: frame.locator(".dv-sash"), workers, expected, publish: livePublisher(sourceIds, expected),
      }).catch(async error => {
        await captureAppleScreenshot(page, "session-plus-loaded-pdf-resize-failed");
        throw error;
      });
      await captureAppleScreenshot(page, "session-plus-loaded-pdf-resize");
      assertLiveReads(before, sourceIds);
      console.info("[session-plus four loaded chats and twenty-page PDF]", JSON.stringify({
        measurement: {
          unit: "milliseconds",
          frameGapsMs: "intervals between requestAnimationFrame callbacks across both drag gestures, repaint and convergence waits",
          convergenceMs: "gesture start through paced mouse movement, settled PDF repaint and all four final tail checks; includes drag and polling, not isolated source latency",
        },
        ...evidence,
      }));
      const viewer = pdf.locator("xpath=ancestor::*[@data-av-module='workspace.file-viewer/v1'][1]");
      await viewer.locator("[data-av-document-bar]").getByRole("button", { name: "关闭", exact: true }).click();
      await expect.poll(() => pdf.count()).toBe(0);
      await expect.poll(() => workers.closed(), { timeout: 10_000 }).toBe(workers.created());
      expect(workers.warnings()).toEqual([]);
      console.info("[session-plus PDF workers after close]", JSON.stringify({ created: workers.created(), closed: workers.closed() }));
      await closeLivePanels(frame, panels);
    } finally {
      workers.dispose(); includeStressPdf = false; liveSessionRows.clear();
      await page.setViewportSize(viewport);
    }
  });

});
