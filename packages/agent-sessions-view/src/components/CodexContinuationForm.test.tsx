import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodexContinuationForm } from "./CodexContinuationForm.js";

afterEach(cleanup);
const revision = "12345678-1234-1234-1234-123456789abc";
const reply = (prompt: string | null, rev = "0") => ({ ok: true, message: "", result: {
  protocol: "codex-continuation/v1", prompt, effectivePrompt: prompt ?? "继续执行", revision: rev,
} });

it("reads only on demand, saves exact text, and resets via the last confirmed revision", async () => {
  const read = vi.fn(async () => reply(null));
  const save = vi.fn(async (prompt: string | null) => reply(prompt, revision));
  render(<CodexContinuationForm read={read} save={save} />);
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("读取续接设置"));
  const input = await screen.findByLabelText("Codex 自动续接消息");
  fireEvent.change(input, { target: { value: "Please continue.\nKeep using English." } });
  fireEvent.click(screen.getByText("保存续接消息"));
  await waitFor(() => expect(save).toHaveBeenCalledWith("Please continue.\nKeep using English.", "0"));
  await screen.findByText(/下一次自动续接/);
  fireEvent.click(screen.getByText("恢复默认续接消息"));
  await waitFor(() => expect(save).toHaveBeenLastCalledWith(null, revision));
  await waitFor(() => expect(input).toHaveValue("继续执行"));
});

it("keeps the draft after offline failure and never automatically repeats a save", async () => {
  const save = vi.fn(async () => { throw new Error("offline"); });
  render(<CodexContinuationForm read={async () => reply(null)} save={save} />);
  fireEvent.click(screen.getByText("读取续接设置"));
  const input = await screen.findByLabelText("Codex 自动续接消息");
  fireEvent.change(input, { target: { value: "繼續執行" } });
  fireEvent.click(screen.getByText("保存续接消息"));
  await screen.findByText(/可能是设备离线/);
  expect(input).toHaveValue("繼續執行"); expect(save).toHaveBeenCalledTimes(1);
});

it("refuses an old Runner transcript response instead of displaying a false saved state", async () => {
  render(<CodexContinuationForm read={async () => ({ ok: true, message: "", result: { messages: [] } })} save={vi.fn()} />);
  fireEvent.click(screen.getByText("读取续接设置"));
  await screen.findByText(/未确认设置/);
  expect(screen.queryByLabelText("Codex 自动续接消息")).toBeNull();
});
