import { act, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AttachmentStrip, attachmentSize, useAttachments, type AttachmentDraft } from "./Attachments.js";
import { filesFromClipboard, releaseAttachment, uploadAttachment, type Attachment } from "../lib/attachments.js";

vi.mock("../lib/attachments.js", async (original) => ({
  ...await original<typeof import("../lib/attachments.js")>(),
  filesFromClipboard: vi.fn(), releaseAttachment: vi.fn(), uploadAttachment: vi.fn(),
}));
vi.mock("../i18n/react.js", () => ({
  useMessages: () => ({ t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key) }),
}));

const stored: Attachment = { id: "image-1", label: "screen.png", path: "/service/staged/screen.png", bytes: 8,
  mediaType: "image/png", previewUrl: "blob:preview" };
const paste = { clipboardData: {}, preventDefault: vi.fn() } as unknown as React.ClipboardEvent;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(filesFromClipboard).mockReturnValue([new File(["image"], "screen.png", { type: "image/png" })]);
});

it("waits for pending uploads before composing the sent body, including refs before the next render", async () => {
  const upload = deferred<Attachment>();
  vi.mocked(uploadAttachment).mockReturnValue(upload.promise);
  const view = renderHook(() => useAttachments("ticket-1"));
  await act(async () => { view.result.current.onPaste(paste); });
  let ready = false;
  const pending = view.result.current.ready().then(() => { ready = true; });
  expect(ready).toBe(false);
  expect(view.result.current.compose("see screenshot")).toBe("see screenshot");
  await act(async () => { upload.resolve(stored); await pending; });
  expect(view.result.current.compose("see screenshot")).toContain(stored.path);
  expect(uploadAttachment).toHaveBeenCalledOnce();
  act(() => view.result.current.remove(stored.id));
  expect(view.result.current.compose("text only")).toBe("text only");
});

it("drops a late upload and rejects the old send when the selected ticket changes", async () => {
  const upload = deferred<Attachment>();
  vi.mocked(uploadAttachment).mockReturnValue(upload.promise);
  const view = renderHook(({ scope }) => useAttachments(scope), { initialProps: { scope: "ticket-1" } });
  await act(async () => { view.result.current.onPaste(paste); });
  const refused = expect(view.result.current.ready()).rejects.toThrow("草稿已变化");
  view.rerender({ scope: "ticket-2" });
  await act(async () => { upload.resolve(stored); await refused; });
  expect(view.result.current.items).toEqual([]);
  expect(view.result.current.compose("ticket 2")).toBe("ticket 2");
  expect(vi.mocked(releaseAttachment).mock.calls.map(([item]) => item)).toContainEqual(stored);
});

it.each(["clear", "unmount"] as const)("ignores and releases a late attachment after %s", async (action) => {
  const upload = deferred<Attachment>();
  vi.mocked(uploadAttachment).mockReturnValue(upload.promise);
  const view = renderHook(() => useAttachments("ticket-1"));
  await act(async () => { view.result.current.onPaste(paste); });
  const refused = expect(view.result.current.ready()).rejects.toThrow("草稿已变化");
  act(() => { if (action === "clear") view.result.current.clear(); else view.unmount(); });
  await act(async () => { upload.resolve(stored); await refused; });
  expect(view.result.current.items).toEqual([]);
  expect(vi.mocked(releaseAttachment).mock.calls.map(([item]) => item)).toContainEqual(stored);
});

it("keeps upload failure visible and blocks send until the failed draft is explicitly cleared", async () => {
  vi.mocked(uploadAttachment).mockRejectedValue(new Error("upload refused"));
  const view = renderHook(() => useAttachments("ticket-1"));
  await act(async () => { view.result.current.onPaste(paste); });
  await expect(view.result.current.ready()).rejects.toThrow("upload refused");
  expect(view.result.current.failure).toBe("upload refused");
  expect(uploadAttachment).toHaveBeenCalledOnce();
  act(() => view.result.current.clear());
  await expect(view.result.current.ready()).resolves.toBeUndefined();
});


it("owns screenshot acquisition before the file exists and discards it after closing the draft", async () => {
  const screenshot = deferred<readonly File[]>();
  const view = renderHook(({ scope }) => useAttachments(scope), { initialProps: { scope: "debug:open" } });
  let adding!: Promise<void>;
  act(() => { adding = view.result.current.addFiles(screenshot.promise); });
  const cancelled = expect(adding).rejects.toThrow("草稿已变化");
  const refused = expect(view.result.current.ready()).rejects.toThrow("草稿已变化");
  view.rerender({ scope: "debug:closed" });
  view.rerender({ scope: "debug:open" });
  await act(async () => {
    screenshot.resolve([new File(["image"], "screen.png", { type: "image/png" })]);
    await Promise.all([cancelled, refused]);
  });
  expect(uploadAttachment).not.toHaveBeenCalled();
  expect(view.result.current.items).toEqual([]);
  await expect(view.result.current.ready()).resolves.toBeUndefined();
});

it("consumes only the submitted chips and leaves later uploads or another draft intact", async () => {
  const next = { ...stored, id: "image-2", path: "/service/staged/next.png", previewUrl: "blob:next" };
  vi.mocked(uploadAttachment).mockResolvedValueOnce(stored).mockResolvedValueOnce(next);
  const view = renderHook(({ scope }) => useAttachments(scope), { initialProps: { scope: "ticket-1" } });
  await act(async () => { view.result.current.onPaste(paste); await view.result.current.ready(); });
  const complete = view.result.current.markSubmission();
  await act(async () => { view.result.current.onPaste(paste); await view.result.current.ready(); });
  act(complete);
  expect(view.result.current.items).toEqual([next]);
  expect(vi.mocked(releaseAttachment).mock.calls.map(([item]) => item)).toContainEqual(stored);
  expect(releaseAttachment).not.toHaveBeenCalledWith(next);
  const oldComplete = view.result.current.markSubmission();
  view.rerender({ scope: "ticket-2" });
  vi.mocked(uploadAttachment).mockResolvedValue(stored);
  await act(async () => { view.result.current.onPaste(paste); await view.result.current.ready(); });
  act(oldComplete);
  expect(view.result.current.items).toEqual([stored]);
});

it("reports chunk progress for the file being uploaded and hands the upload a draft-currency check", async () => {
  const upload = deferred<Attachment>();
  let progress!: (sent: number, total: number) => void;
  let current!: () => boolean;
  vi.mocked(uploadAttachment).mockImplementation((_file, options) => {
    progress = options!.onProgress!;
    current = options!.current!;
    return upload.promise;
  });
  const view = renderHook(({ scope }) => useAttachments(scope), { initialProps: { scope: "ticket-1" } });
  await act(async () => { view.result.current.onPaste(paste); });
  act(() => progress(512, 1024));
  expect(view.result.current.status).toBe('attachment.progress:{"name":"screen.png","percent":50}');
  expect(current()).toBe(true);
  view.rerender({ scope: "ticket-2" });
  expect(current()).toBe(false);
  await act(async () => { upload.resolve(stored); });
});

it("previews only raster images; any other file is a plain label with its size", () => {
  const draft = (items: Attachment[]): AttachmentDraft => ({
    items, status: "", failure: "", onPaste: vi.fn(), addFiles: vi.fn(), markSubmission: vi.fn(), remove: vi.fn(),
    compose: vi.fn(), ready: vi.fn(), clear: vi.fn(),
  } as unknown as AttachmentDraft);
  const html: Attachment = { id: "file-1", label: "page.html", path: "/service/page.html", bytes: 40 * 1024 * 1024,
    mediaType: "text/html", previewUrl: "" };
  render(<AttachmentStrip draft={draft([stored, html])} />);
  expect(screen.getByText("screen.png").closest("a")?.getAttribute("href")).toBe("blob:preview");
  expect(screen.getByText("page.html").closest("a")).toBeNull();
  expect(screen.getByText("40.0 MB")).toBeTruthy();
  expect(attachmentSize(8)).toBe("1 KB");
});
