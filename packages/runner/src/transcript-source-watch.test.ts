import { afterEach, describe, expect, it, vi } from "vitest";
import { watchTranscriptSource } from "./transcript-source-watch.js";

describe("subscribed native source observation", () => {
  afterEach(() => vi.useRealTimers());

  it("checks only the subscribed source, emits changed metadata, re-resolves identity and stops on release", async () => {
    vi.useFakeTimers();
    let file = "/trusted/account-a/session.jsonl";
    let version = "inode:1";
    const resolvePath = vi.fn(async () => file);
    const fingerprint = vi.fn(async () => version);
    const changed = vi.fn();
    const checked = vi.fn();
    const close = watchTranscriptSource({ resolvePath, fingerprint, onChanged: changed, onChecked: checked });
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(checked).toHaveBeenCalledTimes(1);
    version = "inode:2";
    await vi.advanceTimersByTimeAsync(1_500);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(resolvePath).toHaveBeenCalledTimes(1);
    file = "/trusted/account-b/session.jsonl";
    await vi.advanceTimersByTimeAsync(7_500);
    expect(fingerprint).toHaveBeenLastCalledWith(file);
    expect(changed).toHaveBeenCalledTimes(3);
    close();
    const calls = fingerprint.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fingerprint).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not notify or resurrect a timer after close during source resolution", async () => {
    vi.useFakeTimers();
    let resolve!: (file: string) => void;
    const pending = new Promise<string>((yes) => { resolve = yes; });
    const changed = vi.fn();
    const fingerprint = vi.fn(async () => "version");
    const close = watchTranscriptSource({ resolvePath: () => pending, fingerprint, onChanged: changed });
    close();
    resolve("/trusted/session.jsonl");
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).not.toHaveBeenCalled();
    expect(fingerprint).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
