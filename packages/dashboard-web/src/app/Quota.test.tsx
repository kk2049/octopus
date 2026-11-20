/**
 * The quota badges: `[provider logomark] [window] [remaining ring]` per card.
 *
 * The properties under test are the ones the design depends on: the `key`
 * prefix is the only provider discriminator (labels are free-form prose), the
 * window suffix must stay stable for the four known cards and degrade sanely
 * for future Codex slots, the mark must be the vendor's own asset rather than
 * a code-drawn approximation, and — the 2026-08-11 revision — the ring must
 * read as a fuel gauge: arc, number, tooltip and accessible name all report
 * what is LEFT, never what has been spent.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusManager, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { createQueryClient } from "../lib/query.js";
import {
  QuotaChips,
  RING_CIRCUMFERENCE,
  providerOf,
  remainingOf,
  ringDasharray,
  windowSuffix,
} from "./Quota.js";
import claudeMark from "../assets/claude.svg";
import openaiMark from "../assets/openai.svg";
// The same two files as text, so their markup can be parsed here.
import claudeSource from "../assets/claude.svg?raw";
import openaiSource from "../assets/openai.svg?raw";
// CSS Modules still take precedence over Vite's `?raw` transform. Resolve the
// source without Vite's `new URL(..., import.meta.url)` asset rewrite, which
// produces an HTTP URL in jsdom instead of a path Node can read.
const quotaCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "Quota.module.css"),
  "utf8",
);

const HOUR = 3_600_000;
afterEach(() => { vi.useRealTimers(); focusManager.setFocused(undefined); });

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function stubQuota(body: unknown): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

function renderChips() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <QuotaChips />
    </QueryClientProvider>,
  );
}

describe("provider discrimination by key prefix", () => {
  it("maps codex:* to OpenAI and everything else to Anthropic", () => {
    expect(providerOf("session")).toBe("anthropic");
    expect(providerOf("weekly_all")).toBe("anthropic");
    expect(providerOf("scoped:fable")).toBe("anthropic");
    expect(providerOf("codex:primary:300m")).toBe("openai");
    expect(providerOf("codex:secondary:10080m")).toBe("openai");
    expect(providerOf("codex:primary")).toBe("openai");
    // Unknown / missing keys stay on the host plan rather than crashing.
    expect(providerOf("")).toBe("anthropic");
  });
});

describe("window suffix mapping", () => {
  it("covers the four cards shipping today", () => {
    expect(windowSuffix("session", "5 小时")).toBe("5h");
    expect(windowSuffix("weekly_all", "一周")).toBe("1wk");
    expect(windowSuffix("scoped:fable", "Fable · 周")).toBe("fable");
    expect(windowSuffix("codex:primary:300m", "Codex · 5 小时")).toBe("5h");
    expect(windowSuffix("codex:account:2:10080m", "Codex · 一周")).toBe("1wk");
  });

  it("derives future codex slots from the window minutes in the key", () => {
    expect(windowSuffix("codex:secondary:10080m", "Codex · 一周")).toBe("1wk");
    expect(windowSuffix("codex:primary:1440m", "Codex · 一天")).toBe("1d");
    expect(windowSuffix("codex:primary:30m", "Codex · 30 分钟")).toBe("30m");
    expect(windowSuffix("codex:secondary:2880m", "Codex · 两天")).toBe("2d");
  });

  it("falls back to a compacted server label for unrecognised keys", () => {
    expect(windowSuffix("codex:primary", "Codex · 3 小时")).toBe("3h");
    expect(windowSuffix("codex:primary", "Codex · 一周")).toBe("1wk");
    expect(windowSuffix("something_new", "一天")).toBe("1d");
    expect(windowSuffix("something_new", "Mystery")).toBe("mystery");
  });
});

/**
 * A logomark is drawn with `<img>`, and a browser answers a malformed SVG with
 * a broken-image icon and no exception — so nothing else in this suite, and
 * nothing in the page smoke suite, can see it. This one caught a real defect
 * while the marks were being added: a provenance comment containing a double
 * hyphen, which is illegal in XML and blanked the whole mark.
 */
describe("the shipped logomark assets", () => {
  it.each([
    ["claude.svg", claudeSource],
    ["openai.svg", openaiSource],
  ])("%s parses as XML and is a 24×24 square", (_name, source) => {
    const doc = new DOMParser().parseFromString(source, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    const svg = doc.documentElement;
    expect(svg.tagName).toBe("svg");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    // Geometry, not a placeholder: the vendor artwork is a real path.
    expect(doc.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  it("keeps the OpenAI mark a single flat fill, because dark themes invert it", () => {
    const doc = new DOMParser().parseFromString(openaiSource, "image/svg+xml");
    // `currentColor` cannot work inside an <img>; a pinned near-black can, and
    // `filter: invert(1)` only lands on white if there is exactly one colour.
    expect(doc.documentElement.getAttribute("fill")).toMatch(/^#0[dD]0[dD]0[dD]$/);
    for (const painted of doc.querySelectorAll("[fill]")) {
      expect(painted.getAttribute("fill")).not.toBe("currentColor");
    }
  });
});

describe("remaining percent", () => {
  it("prefers the server's remainPercent and falls back to 100 - used", () => {
    expect(remainingOf({ usedPercent: 40, remainPercent: 60 })).toBe(60);
    expect(remainingOf({ usedPercent: 97 })).toBe(3);
    expect(remainingOf({ usedPercent: 0 })).toBe(100);
  });

  it("clamps rather than trusting an out-of-range payload", () => {
    expect(remainingOf({ remainPercent: 140 })).toBe(100);
    expect(remainingOf({ remainPercent: -8 })).toBe(0);
    expect(remainingOf({ usedPercent: 150 })).toBe(0);
  });
});

describe("the gauge ring arc", () => {
  it("is proportional to REMAINING percent of the circumference", () => {
    // A nearly untouched plan is a nearly complete ring, not an empty one.
    expect(ringDasharray(95)).toBe(
      `${(0.95 * RING_CIRCUMFERENCE).toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`,
    );
    expect(ringDasharray(60)).toBe(
      `${(0.6 * RING_CIRCUMFERENCE).toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`,
    );
    expect(ringDasharray(100)).toBe(
      `${RING_CIRCUMFERENCE.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`,
    );
  });

  it("clamps out-of-range values instead of drawing nonsense", () => {
    expect(ringDasharray(150)).toBe(ringDasharray(100));
    expect(ringDasharray(-5)).toBe(ringDasharray(0));
    expect(ringDasharray(Number.NaN)).toBe(ringDasharray(0));
  });
});

describe("the rendered strip", () => {
  beforeEach(() => {
    stubQuota({
      cards: [
        {
          key: "session",
          label: "5 小时",
          usedPercent: 40,
          remainPercent: 60,
          severity: "normal",
          resetsAt: isoIn(3 * HOUR),
        },
        {
          key: "weekly_all",
          label: "一周",
          usedPercent: 82,
          remainPercent: 18,
          severity: "warning",
          resetsAt: isoIn(3 * 24 * HOUR),
        },
        {
          key: "scoped:fable",
          label: "Fable · 周",
          usedPercent: 12,
          remainPercent: 88,
          severity: "normal",
        },
        {
          key: "codex:primary:300m",
          label: "Codex · 5 小时",
          usedPercent: 97,
          remainPercent: 3,
          severity: "critical",
          resetsAt: isoIn(HOUR / 2),
        },
      ],
    });
  });

  it("names each badge by what is LEFT, with the severity word spelled out", async () => {
    renderChips();
    expect(
      await screen.findByRole("img", { name: /^Anthropic 5h 额度:充足,剩余 60%,3 小时后重置$/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Anthropic 1wk 额度:偏紧,剩余 18%/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Anthropic fable 额度:充足,剩余 88%$/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^OpenAI 5h 额度:告急,剩余 3%,30 分钟后重置$/ })).toBeInTheDocument();
  });

  it("draws the vendors' own logomark assets, one per provider", async () => {
    renderChips();
    const anthropic = await screen.findByRole("img", { name: /^Anthropic 5h/ });
    const openai = screen.getByRole("img", { name: /^OpenAI 5h/ });
    // Hidden from the accessibility tree: the badge already carries the name.
    const mark = (badge: HTMLElement) => badge.querySelector("img[aria-hidden='true']");
    expect(mark(anthropic)?.getAttribute("src")).toBe(claudeMark);
    expect(mark(openai)?.getAttribute("src")).toBe(openaiMark);
    // Two distinct SVG assets — the import path is what pins each badge to its
    // vendor's file. (The URL itself is a hashed `/ui/a/…svg` in a real build
    // and an inlined `data:` URI under Vitest's default `assetsInlineLimit`,
    // so it is not something to assert a shape on.)
    expect(claudeMark).not.toBe(openaiMark);
    for (const url of [claudeMark, openaiMark]) {
      expect(url).toMatch(/(\.svg$|^data:image\/svg\+xml)/);
    }
    // The first version drew the marks inline; nothing hand-drawn survives.
    expect(anthropic.querySelector("svg path")).toBeNull();
  });

  it("contains no emoji anywhere — the mark and the ring replaced them", async () => {
    const { container } = renderChips();
    await screen.findByRole("img", { name: /OpenAI 5h/ });
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/[✅⚠️🔴]/u);
    expect(text).not.toMatch(/\p{Emoji_Presentation}|\uFE0F/u);
  });

  it("draws each ring arc with a dasharray proportional to remaining percent", async () => {
    renderChips();
    const badge = await screen.findByRole("img", { name: /^Anthropic 5h/ });
    const arc = badge.querySelector("circle[stroke-dasharray]");
    expect(arc?.getAttribute("stroke-dasharray")).toBe(ringDasharray(60));
    // A nearly full plan is nearly a full ring: 88 % left, not 12 % drawn.
    const fable = screen.getByRole("img", { name: /fable/ });
    expect(fable.querySelector("circle[stroke-dasharray]")?.getAttribute("stroke-dasharray")).toBe(
      ringDasharray(88),
    );
    // And the exhausted one is a sliver.
    const codex = screen.getByRole("img", { name: /^OpenAI 5h/ });
    expect(codex.querySelector("circle[stroke-dasharray]")?.getAttribute("stroke-dasharray")).toBe(
      ringDasharray(3),
    );
  });

  it("writes the bare remaining number in the ring middle and keeps the countdown", async () => {
    renderChips();
    const badge = await screen.findByRole("img", { name: /^Anthropic 5h/ });
    expect(badge.querySelector("text")?.textContent).toBe("60");
    expect(badge.textContent).toContain("↻3h");
    expect(screen.getByRole("img", { name: /^OpenAI 5h/ }).querySelector("text")?.textContent).toBe(
      "3",
    );
    // A card without resetsAt gets no countdown chip.
    const fable = screen.getByRole("img", { name: /fable/ });
    expect(fable.textContent).not.toContain("↻");
  });

  it("keeps the complete story in the tooltip: label, severity word, both percents, reset", async () => {
    renderChips();
    const badge = await screen.findByRole("img", { name: /^Anthropic 1wk/ });
    const title = badge.getAttribute("title") ?? "";
    expect(title).toContain("一周");
    expect(title).toContain("偏紧");
    expect(title).toContain("剩余 18%");
    expect(title).toContain("已用 82%");
    // Remaining leads, matching the ring the reader just looked at.
    expect(title.indexOf("剩余")).toBeLessThan(title.indexOf("已用"));
    expect(title).toContain("后重置");
    expect(title).toContain("重置时间");
  });

  it("still derives the ring from usedPercent when the server omits remainPercent", async () => {
    stubQuota({
      cards: [{ key: "session", label: "5 小时", usedPercent: 25, severity: "normal" }],
    });
    renderChips();
    const badge = await screen.findByRole("img", { name: /^Anthropic 5h/ });
    expect(badge.querySelector("text")?.textContent).toBe("75");
    expect(badge.querySelector("circle[stroke-dasharray]")?.getAttribute("stroke-dasharray")).toBe(
      ringDasharray(75),
    );
  });

  it("marks a cached value without adding visible text or changing the badge contents", async () => {
    stubQuota({
      cards: [
        {
          key: "session",
          label: "5 小时",
          usedPercent: 25,
          remainPercent: 75,
          severity: "normal",
          stale: true,
        },
      ],
    });
    renderChips();
    const badge = await screen.findByRole("img", { name: /^Anthropic 5h 额度:充足,剩余 75%,缓存值$/ });
    expect(badge).toHaveAttribute("title", expect.stringContaining("暂时显示缓存值"));
    expect(badge.className).toContain("stale");
    expect(badge.textContent).toBe("5h75");
  });

  it("groups both routed Codex accounts in one segmented panel", async () => {
    stubQuota({
      cards: [
        {
          key: "codex:account:1:10080m",
          label: "Codex · 一周",
          accountLabel: "ol*",
          usedPercent: 100,
          remainPercent: 0,
          severity: "critical",
          resetsAt: isoIn(36 * HOUR),
        },
        {
          key: "codex:account:2:10080m",
          label: "Codex · 一周",
          accountLabel: "li*",
          usedPercent: 6,
          remainPercent: 94,
          severity: "normal",
          resetsAt: isoIn(6 * 24 * HOUR),
        },
      ],
    });
    renderChips();

    const panel = await screen.findByRole("group", { name: "Codex 2 个账号额度" });
    expect(screen.getByRole("img", { name: /^Codex 账号 1 额度:告急,剩余 0%,/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Codex 账号 2 额度:充足,剩余 94%,/ })).toBeInTheDocument();
    expect(panel.textContent).toBe("0↻36h94↻6d");
    expect(panel.textContent).not.toMatch(/Codex|ol\*|li\*/);
    expect(panel.querySelectorAll("img[aria-hidden='true']")).toHaveLength(1);
  });

  it("wraps into two columns on mobile instead of overflowing the drawer (ticket #178)", () => {
    // jsdom does not evaluate media queries, and the layout under test IS the
    // media query, so the stylesheet is asserted as text — the same `?raw`
    // route the logomark checks above use.
    const mobileStart = quotaCss.indexOf("@media (max-width: 720px)");
    expect(mobileStart).toBeGreaterThan(-1);
    const mobile = quotaCss.slice(mobileStart);
    expect(mobile).toMatch(/\.chips\s*\{[^}]*display:\s*grid;/);
    expect(mobile).toMatch(/\.chips\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
    expect(mobile).toMatch(/\.codexPanel\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/);
    // The default strip stays a single nowrap line: the wide nav bar has the
    // room for it, and only the drawer needed the two-column treatment.
    const desktop = quotaCss.slice(0, mobileStart);
    expect(desktop).toMatch(/\.chips\s*\{[^}]*display:\s*inline-flex;/);
    expect(desktop).toMatch(/\.chips\s*\{[^}]*flex-wrap:\s*nowrap;/);
  });

  it("hides entirely on a quota error instead of alarming every page", async () => {
    stubQuota({ cards: [], error: "expired", message: "登录过期" });
    const { container } = renderChips();
    await vi.waitFor(() => {
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    });
    expect(container.firstChild).toBeNull();
  });
});

it("groups Runner registrations by machine, showing both windows and unknown quota without hiding accounts", async () => {
  stubQuota({ cards: [], codexHosts: [
    { key: "aws", device: "aws-local", label: "AWS", online: true, accounts: [
      { id: "@default", label: "codexb", emailLabel: "long-…@example.com", quota: { status: "available", fetchedAt: new Date().toISOString(), creditCount: 2, windows: [
        { remainingPercent: 73, windowMinutes: 300, resetsAt: isoIn(HOUR) },
        { remainingPercent: 19, windowMinutes: 10080, resetsAt: isoIn(24 * HOUR) },
      ] } }, { id: "a", label: "codexa", quota: { status: "unavailable", fetchedAt: new Date().toISOString(), windows: [] } },
    ] },
    { key: "ali", device: "aws-workbench", label: "aliyun", online: false, accounts: [{ id: "@default", label: "codex" }] },
  ] });
  renderChips();
  const aws = await screen.findByRole("group", { name: "AWS" });
  expect(aws).toHaveTextContent("codexa");
  expect(aws).toHaveTextContent("long-…@example.com");
  expect(aws).toHaveTextContent("充值卡 2");
  expect(aws.querySelectorAll("svg")).toHaveLength(2);
  expect(screen.getByRole("img", { name: /5h · 剩余 73%/ })).toHaveTextContent("↻1h");
  expect(screen.getByRole("img", { name: /1wk · 剩余 19%/ })).toHaveTextContent("↻24h");
  expect(aws).toHaveTextContent("额度未知");
  expect(aws).not.toHaveTextContent("reset");
  expect(screen.getByRole("group", { name: "aliyun" })).toHaveTextContent("Runner 离线");
});

it("shows the two active Codex accounts and Claude with independent resets, including Claude-only devices", async () => {
  const quota = { status: "available", fetchedAt: new Date().toISOString(), windows: [
    { remainingPercent: 91, windowMinutes: 300, resetsAt: isoIn(HOUR) },
    { remainingPercent: 63, windowMinutes: 10080, resetsAt: isoIn(3 * 24 * HOUR) },
  ] };
  stubQuota({ codexHosts: [{ key: "research", label: "Research", online: true,
    accounts: [{ id: "account_a", label: "codexa" }, { id: "account_c", label: "codexc" }],
    claudeAccounts: [{ id: "@default", label: "Claude", quota }],
  }, { key: "claude-only", label: "Claude only", online: false, accounts: [], claudeAccounts: [{ id: "@default", label: "Claude" }] }] });
  renderChips();
  const host = await screen.findByRole("group", { name: "Research" });
  expect(host).toHaveTextContent("codexa");
  expect(host).toHaveTextContent("codexc");
  expect(host).toHaveTextContent("Claude");
  expect(host).not.toHaveTextContent("codexb");
  expect(host).not.toHaveTextContent("充值卡");
  expect(screen.getByRole("img", { name: /5h · 剩余 91%/ })).toHaveTextContent("↻1h");
  expect(screen.getByRole("img", { name: /1wk · 剩余 63%/ }).getAttribute("title")).toContain("重置时间");
  expect(screen.getByRole("group", { name: /Claude only/ })).toHaveTextContent("额度未知");
});


it.each([
  [5 * 24 * HOUR, "5d"], [6 * HOUR, "6h"], [12 * 60_000, "12m"],
])("shows the earliest reset card expiry after its count (%s ms)", async (remaining, label) => {
  const creditExpiresAt = isoIn(remaining);
  stubQuota({ codexHosts: [{ key: "aws", label: "AWS", online: true, accounts: [{ id: "a", label: "codexa", quota: {
    status: "available", fetchedAt: new Date().toISOString(), creditCount: 3, creditExpiresAt,
    windows: [{ remainingPercent: 89, windowMinutes: 10080, resetsAt: isoIn(5 * 24 * HOUR) }],
  } }] }] });
  renderChips();
  const host = await screen.findByRole("group", { name: "AWS" });
  expect(host).toHaveTextContent(`充值卡 3 ⏳${label}`);
  const expiry = screen.getByLabelText(/^最早到期充值卡：/);
  expect(expiry).toHaveAttribute("title", expiry.getAttribute("aria-label"));
  expect(expiry.getAttribute("title")).toContain(String(new Date(creditExpiresAt).getFullYear()));
});

it.each([
  { creditCount: 2 }, { creditCount: 0, creditExpiresAt: "2030-01-01T00:00:00Z" },
  { creditCount: 2, creditExpiresAt: "invalid" }, {},
])("keeps legacy/missing credit expiry unobtrusive: %j", async (credits) => {
  stubQuota({ codexHosts: [{ key: "aws", label: "AWS", online: true, accounts: [{ id: "a", label: "codexa", quota: {
    status: "unavailable", fetchedAt: new Date().toISOString(), windows: [], ...credits,
  } }] }] });
  renderChips();
  const host = await screen.findByRole("group", { name: "AWS" });
  expect(host).not.toHaveTextContent("⏳");
  if (credits.creditCount !== undefined) expect(host).toHaveTextContent(`充值卡 ${credits.creditCount}`);
});

it("updates cached card expiry locally through expiration without changing the measured count", async () => {
  stubQuota({ codexHosts: [{ key: "aws", label: "AWS", online: false, accounts: [{ id: "a", label: "codexa", quota: {
    status: "available", fetchedAt: new Date().toISOString(), creditCount: 3, creditExpiresAt: isoIn(120_000),
    windows: [{ remainingPercent: 89, windowMinutes: 10080, resetsAt: isoIn(5 * 24 * HOUR) }],
  } }] }] });
  focusManager.setFocused(false); // Pause the existing inventory poll; the local countdown keeps ticking.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  const { unmount } = renderChips();
  const host = await screen.findByRole("group", { name: "AWS" });
  expect(host).toHaveTextContent("充值卡 3 ⏳2m");
  expect(host).toHaveTextContent("缓存值");
  const requests = vi.mocked(fetch).mock.calls.length;
  try {
    act(() => vi.advanceTimersByTime(60_000));
    expect(host).toHaveTextContent("充值卡 3 ⏳1m");
    act(() => vi.advanceTimersByTime(60_000));
    expect(host).toHaveTextContent("充值卡 3 ⏳已过期");
    expect(vi.mocked(fetch).mock.calls.length).toBe(requests);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
