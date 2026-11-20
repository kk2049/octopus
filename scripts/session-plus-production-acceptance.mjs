#!/usr/bin/env node

/**
 * Read-only production acceptance for the Sessions+ cold-open path.
 *
 * The script deliberately records only structural timings and counters. It
 * never reads page text, session data, console messages, response bodies,
 * screenshots, traces, or credentials from the page.
 */

import { lstat, readFile } from "node:fs/promises";
import process from "node:process";
import { chromium } from "playwright";

const DEFAULT_PAGES = 18;
const DEFAULT_TIMEOUT_MS = 55_000;
const POLL_MS = 100;

export function parseArgs(argv) {
  const values = new Map();
  let trustCurrentRelease = false;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--help") return { help: true };
    if (name === "--trust-current-release") {
      if (trustCurrentRelease) throw new Error(`duplicate argument: ${name}`);
      trustCurrentRelease = true;
      continue;
    }
    if (!name.startsWith("--") || index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new Error(`invalid argument: ${name}`);
    }
    if (values.has(name)) throw new Error(`duplicate argument: ${name}`);
    values.set(name, argv[++index]);
  }

  const origin = values.get("--origin");
  const tokenFile = values.get("--token-file");
  const storageState = values.get("--storage-state");
  const expectedFrameHost = values.get("--expect-frame-host") ?? null;
  const pages = integerArg(values.get("--pages") ?? String(DEFAULT_PAGES), "--pages", 1, 50);
  const timeoutMs = integerArg(
    values.get("--timeout-ms") ?? String(DEFAULT_TIMEOUT_MS),
    "--timeout-ms",
    1_000,
    300_000,
  );

  const known = new Set([
    "--origin",
    "--token-file",
    "--storage-state",
    "--expect-frame-host",
    "--pages",
    "--timeout-ms",
  ]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`unknown argument: ${name}`);
  }
  if (!origin) throw new Error("--origin is required");
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.protocol !== "https:" || parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash) {
    throw new Error("--origin must be an HTTPS origin without a path, query, or fragment");
  }
  if (Boolean(tokenFile) === Boolean(storageState)) {
    throw new Error("provide exactly one of --token-file or --storage-state");
  }
  if (expectedFrameHost && !/^[a-z0-9.-]+$/i.test(expectedFrameHost)) {
    throw new Error("--expect-frame-host is not a hostname or host label");
  }
  return {
    help: false,
    origin: parsedOrigin.origin,
    tokenFile,
    storageState,
    expectedFrameHost: expectedFrameHost?.toLowerCase() ?? null,
    trustCurrentRelease,
    pages,
    timeoutMs,
  };
}

function integerArg(raw, name, minimum, maximum) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

async function assertPrivateCredential(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("credential must be a regular file");
  if ((metadata.mode & 0o077) !== 0) throw new Error("credential must not be accessible by group or others");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("credential must be owned by the current user");
  }
}

async function readPrivateToken(path) {
  await assertPrivateCredential(path);
  const token = (await readFile(path, "utf8")).trim();
  if (!token.startsWith("dt_") || token.length > 4096) {
    throw new Error("token credential is not a personal dt_ key");
  }
  return token;
}

function elapsedMs(startedAt) {
  return Math.round(performance.now() - startedAt);
}

function frameHostname(frame, panelHostname) {
  if (!frame.parentFrame()) return null;
  try {
    const url = new URL(frame.url());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === panelHostname) return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostMatches(actual, expected) {
  return actual === expected || actual.startsWith(`${expected}.`);
}

async function inspectPage(page, index, options) {
  const startedAt = performance.now();
  const deadline = startedAt + options.timeoutMs;
  const result = {
    page: index + 1,
    within_55s: false,
    outcome: "timeout",
    completed_ms: null,
    navigation_status: null,
    ready_ms: null,
    frame_ms: null,
    sess_ms: null,
    frame_hostname: null,
    final_panel_state: null,
    page_errors: 0,
    request_failures: 0,
    http_5xx: 0,
  };

  const onPageError = () => { result.page_errors += 1; };
  const onRequestFailed = () => { result.request_failures += 1; };
  const onResponse = (response) => {
    if (response.status() >= 500) result.http_5xx += 1;
  };
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);

  const navigation = page
    .goto(`${options.origin}/sessions-plus`, { waitUntil: "domcontentloaded", timeout: options.timeoutMs })
    .then((response) => { result.navigation_status = response?.status() ?? null; })
    .catch(() => {});

  while (performance.now() < deadline) {
    let panel = null;
    try {
      panel = await page.evaluate(() => ({
        state: document.body?.dataset.spState ?? null,
        trustGate: Boolean(document.querySelector("#trustApp")),
        login: location.pathname.startsWith("/login"),
      }));
    } catch {
      // Navigation may replace the execution context between samples.
    }

    if (panel) {
      result.final_panel_state = ["idle", "loading", "ready", "unavailable", "degraded"].includes(panel.state)
        ? panel.state
        : panel.state === null ? null : "unknown";
      if (panel.login) {
        result.outcome = "authentication_required";
        break;
      }
      if (panel.trustGate) {
        result.outcome = "publisher_trust_required";
        break;
      }
      if (panel.state === "ready" && result.ready_ms === null) result.ready_ms = elapsedMs(startedAt);
    }

    let appFrame = null;
    for (const frame of page.frames()) {
      const hostname = frameHostname(frame, options.panelHostname);
      if (!hostname) continue;
      appFrame = frame;
      if (result.frame_ms === null) result.frame_ms = elapsedMs(startedAt);
      result.frame_hostname ??= hostname;
      break;
    }
    if (appFrame && result.sess_ms === null) {
      try {
        if ((await appFrame.locator(".sess").count()) > 0) result.sess_ms = elapsedMs(startedAt);
      } catch {
        // A generation change can detach the old frame between samples.
      }
    }

    if (result.ready_ms !== null && result.frame_ms !== null && result.sess_ms !== null) {
      result.completed_ms = Math.max(result.ready_ms, result.frame_ms, result.sess_ms);
      result.within_55s = result.completed_ms <= DEFAULT_TIMEOUT_MS;
      result.outcome = "ready";
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  await navigation;
  if (result.outcome === "ready" && result.frame_hostname) {
    const digestAddressed = /^app-[0-9a-f]{20}(?:\.|$)/.test(result.frame_hostname);
    const expected = !options.expectedFrameHost
      || hostMatches(result.frame_hostname, options.expectedFrameHost);
    if (!digestAddressed) result.outcome = "invalid_frame_hostname";
    else if (!expected) result.outcome = "unexpected_frame_hostname";
  }
  if (result.outcome === "ready" && !result.within_55s) result.outcome = "deadline_exceeded";
  page.off("pageerror", onPageError);
  page.off("requestfailed", onRequestFailed);
  page.off("response", onResponse);
  return result;
}

export function summarize(results) {
  const hosts = [...new Set(results.map((result) => result.frame_hostname).filter(Boolean))].sort();
  const passed = results.every((result) => result.outcome === "ready" && result.within_55s) && hosts.length === 1;
  return {
    passed,
    pages: results.length,
    ready_within_55s: results.filter((result) => result.outcome === "ready" && result.within_55s).length,
    distinct_frame_hostnames: hosts,
    results,
  };
}

export function loginExchangeOptions(origin, token) {
  return {
    data: { token, next: "/" },
    headers: { origin },
    failOnStatusCode: false,
    maxRedirects: 0,
  };
}

export function trustExchangeOptions(origin, csrf) {
  return {
    data: { decision: "trust", follow_updates: true },
    headers: { origin, "x-csrf-token": csrf },
    failOnStatusCode: false,
  };
}

async function run(options) {
  const browser = await chromium.launch({ headless: true });
  let context;
  let trustHttpStatus = null;
  const pages = [];
  try {
    if (options.storageState) await assertPrivateCredential(options.storageState);
    context = await browser.newContext(options.storageState ? { storageState: options.storageState } : {});
    if (options.tokenFile) {
      let token = await readPrivateToken(options.tokenFile);
      const response = await context.request.post(
        `${options.origin}/login`,
        loginExchangeOptions(options.origin, token),
      );
      token = "";
      if (response.status() !== 303) throw new Error(`login exchange failed with HTTP ${response.status()}`);
    }
    if (options.trustCurrentRelease) {
      const cookies = await context.cookies(options.origin);
      const csrf = cookies.find((cookie) => cookie.name === "__Host-octopus_csrf")?.value;
      if (!csrf) throw new Error("trust current release failed: CSRF cookie is missing");
      const response = await context.request.post(
        `${options.origin}/api/session-plus/trust`,
        trustExchangeOptions(options.origin, csrf),
      );
      trustHttpStatus = response.status();
      if (trustHttpStatus < 200 || trustHttpStatus >= 300) {
        throw new Error(`trust current release failed with HTTP ${trustHttpStatus}`);
      }
    }

    for (let index = 0; index < options.pages; index += 1) pages.push(await context.newPage());
    const panelHostname = new URL(options.origin).hostname;
    const results = await Promise.all(
      pages.map((page, index) => inspectPage(page, index, { ...options, panelHostname })),
    );
    return { trust_http_status: trustHttpStatus, ...summarize(results) };
  } finally {
    await Promise.allSettled(pages.map((page) => page.close({ runBeforeUnload: true })));
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function usage() {
  return `Usage:
  node scripts/session-plus-production-acceptance.mjs \\
    --origin https://bot.example.com \\
    --token-file /path/to/private-dt-token \\
    [--pages 18] [--timeout-ms 55000] \\
    [--expect-frame-host app-0123456789abcdef0123] \\
    [--trust-current-release]

Use --storage-state /path/to/state.json instead of --token-file to reuse an
existing authenticated Playwright state. --trust-current-release explicitly
trusts the current release and follows its publisher updates. The harness never
grants capabilities and never records page content, console text, screenshots,
or traces. The acceptance SLO is always 55 seconds; --timeout-ms only controls
how long the harness observes an eventual result (the production gate uses the
default 55000, so observation and acceptance end together).`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const summary = await run(options);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.passed) process.exitCode = 1;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ passed: false, error: error instanceof Error ? error.message : "unknown error" }));
    process.exitCode = 1;
  });
}
