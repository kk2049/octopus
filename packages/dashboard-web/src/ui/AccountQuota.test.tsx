import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { quotaDeadline } from "@claude-bot/chat-ui-commons/quota";
import { AccountQuota } from "./AccountQuota.js";

const now = Date.parse("2026-09-16T12:00:00Z");
const quota = {
  status: "available" as const, fetchedAt: new Date(now).toISOString(),
  windows: [{ remainingPercent: 42, windowMinutes: 300, resetsAt: new Date(now + 120_000).toISOString() }],
};
afterEach(() => vi.useRealTimers());

it("counts down locally, keeps measured remaining quota at reset, and cleans up its timer", () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const { unmount } = render(<AccountQuota quota={quota} />);
  const gauge = screen.getByRole("img", { name: /5h · 剩余 42%/ });
  expect(gauge).toHaveTextContent("↻2m");
  expect(gauge.querySelector("circle[stroke-dasharray]")).toHaveAttribute("stroke-dasharray", "21.11 50.27");
  expect(gauge).toHaveAttribute("title", expect.stringContaining("重置时间"));
  act(() => vi.advanceTimersByTime(60_000));
  expect(gauge).toHaveTextContent("↻1m");
  act(() => vi.advanceTimersByTime(120_000));
  expect(gauge).toHaveTextContent("↻0m");
  expect(gauge).toHaveAccessibleName(expect.stringContaining("剩余 42%"));
  expect(screen.getByText("· 缓存值")).toBeVisible();
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("distinguishes zero, full, missing, unavailable and offline cached measurements", () => {
  const { rerender } = render(<AccountQuota />);
  expect(screen.getByText("额度未知")).toBeVisible();
  expect(screen.queryByRole("img")).toBeNull();
  rerender(<AccountQuota quota={{ ...quota, status: "unavailable" }} />);
  expect(screen.queryByRole("img")).toBeNull();
  rerender(<AccountQuota offline quota={{ ...quota, windows: [
    { ...quota.windows[0]!, remainingPercent: 0 },
    { ...quota.windows[0]!, remainingPercent: 100, windowMinutes: 10080 },
  ] }} />);
  expect(screen.getByRole("img", { name: /5h · 剩余 0%/ }).querySelector("circle[stroke-dasharray]")).toBeNull();
  expect(screen.getByRole("img", { name: /1wk · 剩余 100%/ }).querySelector("circle[stroke-dasharray]"))
    .toHaveAttribute("stroke-dasharray", "50.27 50.27");
  expect(screen.getByText("· 缓存值")).toBeVisible();
});

it("formats short deadlines including invalid and elapsed timestamps without inventing a reset", () => {
  expect(quotaDeadline("invalid", now)).toBe("?");
  expect(quotaDeadline(new Date(now - 1).toISOString(), now)).toBe("0m");
  expect(quotaDeadline(new Date(now + 1).toISOString(), now)).toBe("1m");
  expect(quotaDeadline(new Date(now + 3600_000).toISOString(), now)).toBe("1h");
  expect(quotaDeadline(new Date(now + 3 * 86400_000).toISOString(), now)).toBe("3d");
});
