/**
 * The API client's rules, each pinned to the failure it prevents.
 *
 * These are the rules that were previously spread across a `fetch` monkey patch
 * in the document head and a dozen call sites. Every one of them has a concrete
 * history: the CSRF cookie name went stale and turned every mutation into a 403;
 * an empty body from a restarting proxy surfaced as "Unexpected end of JSON
 * input"; a helpful retry on a capability-bearing GET would ask a person to
 * approve the same read twice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyLanguage } from "../i18n/language.js";
import {
  ApiError,
  api,
  csrfSecret,
  errorText,
  query,
  request,
  resetSessionExpiredForTests,
  sessionExpired,
  subscribeSessionExpired,
} from "./api.js";

beforeEach(() => {
  resetSessionExpiredForTests();
});
afterEach(() => applyLanguage("zh-CN"));

it("localizes client response errors and keeps the server's response text intact", async () => {
  applyLanguage("en");
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response("", { status: 503 }));
  await expect(api("/api/overview")).rejects.toThrow("HTTP 503 · Empty response");
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response("原始输出：保存", { status: 502 }));
  await expect(api("/api/overview")).rejects.toThrow("HTTP 502 · Response is not JSON: 原始输出：保存");
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(jsonResponse({ error: "保存" }, 403));
  await expect(api("/api/overview")).rejects.toThrow("保存");
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(jsonResponse({}, 401));
  await expect(api("/api/overview")).rejects.toThrow("Your session has expired. Sign in again.");
  applyLanguage("ja-JP");
  await expect(api("/api/overview")).rejects.toThrow("セッションの有効期限が切れました。");
  expect(globalThis.fetch).toHaveBeenCalledTimes(4);
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function lastCall(): [RequestInfo | URL, RequestInit | undefined] {
  const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  return mock.mock.calls.at(-1) as [RequestInfo | URL, RequestInit | undefined];
}

function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers ?? {});
}

describe("the CSRF header", () => {
  beforeEach(() => {
    document.cookie = "octopus_csrf=s3cr3t; path=/";
  });

  it("is attached to unsafe same-origin requests", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ ok: true }));
    await api("/api/settings", { method: "POST", json: { a: 1 } });
    expect(headersOf(lastCall()[1]).get("x-csrf-token")).toBe("s3cr3t");
  });

  it("is NOT attached to safe methods — the server does not ask for one", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ ok: true }));
    await api("/api/overview");
    expect(headersOf(lastCall()[1]).has("x-csrf-token")).toBe(false);
  });

  it("never leaves this origin, because the request never does", async () => {
    await expect(api("https://evil.example/collect", { method: "POST" })).rejects.toMatchObject({
      code: "cross_origin",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("reads the name the DEPLOYMENT issued, in the server's preference order", () => {
    // The https panel issues `__Host-octopus_csrf` and the plain-http one
    // issues `octopus_csrf`. Both spellings come from the server, in the order
    // the server chose; a page that looked for the retired one would find
    // nothing, send no header, and 403 every mutation. (jsdom serves over http,
    // so the prefixed name cannot actually be set here — what is under test is
    // that the list is consulted in order and that an absent first candidate
    // falls through rather than returning "".)
    document.cookie = "octopus_csrf_next=newer; path=/";
    expect(csrfSecret(["octopus_csrf_next", "octopus_csrf"])).toBe("newer");
    expect(csrfSecret(["__Host-octopus_csrf", "octopus_csrf"])).toBe("s3cr3t");
    expect(csrfSecret(["nothing-here"])).toBe("");
  });

  it("does not overwrite a header the caller set itself", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ ok: true }));
    await api("/api/settings", {
      method: "POST",
      json: {},
      headers: { "x-csrf-token": "explicit" },
    });
    expect(headersOf(lastCall()[1]).get("x-csrf-token")).toBe("explicit");
  });
});

describe("answers that are not JSON", () => {
  it("turns an empty body into words a person can act on", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("", { status: 502 }));
    await expect(api("/api/tickets")).rejects.toThrow(/响应为空/);
  });

  it("says so when the body is not JSON at all", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("<html>oops", { status: 500 }));
    await expect(api("/api/tickets")).rejects.toThrow(/不是 JSON/);
  });

  it("passes the server's own refusal sentence through", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({ error: "append 仅限本人操作 — 请用自己的 /dashboard 链接登录" }, 403),
    );
    await expect(api("/api/sessions/append", { method: "POST", json: {} })).rejects.toThrow(
      "append 仅限本人操作 — 请用自己的 /dashboard 链接登录",
    );
  });

  it("hands back statuses the caller declared as answers rather than failures", async () => {
    // 202 (accepted, still running) and 409 (somebody holds the lease) are what
    // the session-append route says with, not failures to be thrown away.
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({ operation_id: "op-1", operation: { id: "op-1" } }, 202),
    );
    const out = await api<{ operation_id: string }>("/api/sessions/append", {
      method: "POST",
      json: {},
      expect: [202, 409],
    });
    expect(out.operation_id).toBe("op-1");
  });
});

describe("what the client never does on its own", () => {
  it("makes exactly one request — there is no retry at this layer", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ error: "nope" }, 500));
    await expect(api("/api/session?id=x")).rejects.toBeInstanceOf(ApiError);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("stores nothing anywhere a later page could read it", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ ok: true }));
    await api("/api/settings", { method: "POST", json: { secret: "value" } });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("sends cookies only same-origin, explicitly", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({}));
    await request("/api/overview");
    expect(lastCall()[1]?.credentials).toBe("same-origin");
  });

  it("stops every request path after one 401 and publishes expiry once", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionExpired(listener);
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ error: "expired" }, 401));

    // `request()` is used by streaming endpoints, so it must publish expiry
    // itself rather than relying on the JSON-only `api()` wrapper.
    await expect(request("/api/session-plus/stream")).rejects.toMatchObject({
      status: 401,
      code: "unauthenticated",
    });
    await expect(api("/api/tickets")).rejects.toMatchObject({ status: 401 });

    expect(sessionExpired()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("leaves a rejected login exchange to the login form", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ error: "令牌无效" }, 401));
    const res = await request("/login", { method: "POST", json: { token: "bad" } });
    expect(res.status).toBe(401);
    expect(sessionExpired()).toBe(false);
  });
});

describe("query()", () => {
  it("drops empty values instead of sending `?x=`", () => {
    expect(query({ username: "alice", device: "", limit: 400, source: undefined })).toBe(
      "?username=alice&limit=400",
    );
  });

  it("is empty when there is nothing to say", () => {
    expect(query({ a: "", b: undefined })).toBe("");
  });
});

describe("errorText()", () => {
  it("prefers the server's wording", () => {
    expect(errorText(new ApiError("没有开发系统权限", 403))).toBe("没有开发系统权限");
    expect(errorText("plain")).toBe("plain");
  });
});
