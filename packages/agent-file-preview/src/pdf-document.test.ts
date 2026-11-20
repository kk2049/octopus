import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  getDocument: vi.fn(), create: vi.fn(), destroy: vi.fn(), workerDestroy: vi.fn(),
}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: mock.getDocument, PDFWorker: { create: mock.create },
}));
import { openPdfDocument } from "./pdf-document.js";

class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  terminate = vi.fn();
  constructor(readonly url: URL, readonly options: WorkerOptions) {
    super(); FakeWorker.instances.push(this);
  }
}
beforeEach(() => {
  vi.clearAllMocks();
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
  mock.create.mockReturnValue({ destroy: mock.workerDestroy });
  mock.destroy.mockResolvedValue(undefined);
  mock.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 2 }), destroy: mock.destroy });
});
afterEach(() => vi.unstubAllGlobals());

describe("PDF worker ownership", () => {
  it("uses a module worker and copied bytes, then releases both layers exactly once", async () => {
    const data = new Uint8Array([1, 2, 3]);
    const handle = openPdfDocument(data, vi.fn());
    await expect(handle.promise).resolves.toMatchObject({ numPages: 2 });
    const port = FakeWorker.instances[0]!;
    expect(port.url.pathname).toContain("/pdf-worker");
    expect(port.options).toMatchObject({ type: "module" });
    expect(mock.create).toHaveBeenCalledWith({ port });
    const args = mock.getDocument.mock.calls[0]![0];
    expect(args.data).toEqual(data);
    expect(args.data).not.toBe(data);
    expect(args).toMatchObject({ useWasm: false, useWorkerFetch: false });
    handle.close(); handle.close();
    expect(mock.destroy).toHaveBeenCalledOnce();
    expect(mock.workerDestroy).toHaveBeenCalledOnce();
    expect(port.terminate).toHaveBeenCalledOnce();
  });

  it("contains startup errors and stops the worker without a main-thread fallback", () => {
    const refused = vi.fn();
    const handle = openPdfDocument(new Uint8Array([1]), refused);
    const port = FakeWorker.instances[0]!;
    port.dispatchEvent(new Event("error"));
    expect(refused).toHaveBeenCalledOnce();
    expect(port.terminate).toHaveBeenCalledOnce();
    port.dispatchEvent(new Event("error"));
    handle.close();
    expect(refused).toHaveBeenCalledOnce();
  });

  it("releases a worker when document construction fails synchronously", () => {
    mock.getDocument.mockImplementationOnce(() => { throw new Error("invalid"); });
    expect(() => openPdfDocument(new Uint8Array([1]), vi.fn())).toThrow("invalid");
    expect(mock.workerDestroy).toHaveBeenCalledOnce();
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("releases a worker after asynchronous document refusal", async () => {
    mock.getDocument.mockReturnValueOnce({ promise: Promise.reject(new Error("broken")), destroy: mock.destroy });
    const handle = openPdfDocument(new Uint8Array([1]), vi.fn());
    await expect(handle.promise).rejects.toThrow("broken");
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });
});
