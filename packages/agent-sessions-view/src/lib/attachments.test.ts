/**
 * The prompt is the only channel an agent reads.
 *
 * So the assertion that matters is not that the upload happened — it is that
 * the message carries the paths, and that a chip taken off the draft is a path
 * the agent is never told about.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_CHAT_ATTACHMENTS,
  base64Of,
  imagesFromItems,
  isAttachableImage,
  promptWithAttachments,
} from "./attachments.js";

function file(type: string): File {
  return new File([new Uint8Array([1, 2, 3])], "shot.png", { type });
}

const one = { id: "a1", label: "shot.png", path: "/tmp/octopus-session-a/x.png", bytes: 2048 };
const two = { id: "a2", label: "second.png", path: "/tmp/octopus-session-b/y.png", bytes: 1024 };

describe("imagesFromItems", () => {
  it("takes the images and leaves a text paste alone", () => {
    expect(imagesFromItems([{ kind: "string", getAsFile: () => null }])).toEqual([]);
    expect(imagesFromItems([{ kind: "file", getAsFile: () => file("image/png") }])).toHaveLength(1);
    expect(imagesFromItems([{ kind: "file", getAsFile: () => file("application/pdf") }])).toEqual([]);
  });

  it("bounds one paste", () => {
    const many = Array.from({ length: 9 }, () => ({ kind: "file", getAsFile: () => file("image/png") }));
    expect(imagesFromItems(many)).toHaveLength(4);
  });

  it("numbers generic screenshots across batches and preserves named files", () => {
    const screenshot = new File(["pixels"], "image.png", { type: "image/png" });
    const named = new File(["pixels"], "diagram.png", { type: "image/png" });
    const items = [screenshot, named, screenshot].map((image) => ({ kind: "file", getAsFile: () => image }));
    const first = imagesFromItems(items);
    const next = imagesFromItems(items.slice(0, 1));
    expect(first[1]).toBe(named);
    const names = [first[0]!.name, first[2]!.name, next[0]!.name];
    for (const name of names) expect(name).toMatch(/^image-\d+\.png$/);
    const numbers = names.map((name) => Number(name.match(/\d+/)![0]));
    expect(numbers).toEqual([numbers[0], numbers[0]! + 1, numbers[0]! + 2]);
    expect(screenshot.name).toBe("image.png");
  });

  it.each([
    ["image/png", "", "png"],
    ["image/jpeg", "image.jpg", "jpg"],
    ["image/webp", "image.webp", "webp"],
    ["image/gif", "image.gif", "gif"],
  ])("preserves the bytes and metadata of a numbered %s screenshot", async (type, name, extension) => {
    const original = new File([new Uint8Array([0, 1, 250, 255])], name, { type, lastModified: 1234 });
    const [renamed] = imagesFromItems([{ kind: "file", getAsFile: () => original }]);
    expect(renamed!.name).toMatch(new RegExp(`^image-\\d+\\.${extension}$`));
    expect(renamed!.type).toBe(type);
    expect(renamed!.size).toBe(original.size);
    expect(renamed!.lastModified).toBe(original.lastModified);
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(renamed!);
    });
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([0, 1, 250, 255]));
  });

  it("states which types the trusted side accepts", () => {
    expect(isAttachableImage("image/webp")).toBe(true);
    expect(isAttachableImage("image/svg+xml")).toBe(false);
  });
});

describe("promptWithAttachments", () => {
  it("names every remaining attachment by absolute path", () => {
    const prompt = promptWithAttachments("这个按钮点不动", [one, two]);
    expect(prompt).toContain("这个按钮点不动");
    expect(prompt).toContain(one.path);
    expect(prompt).toContain(two.path);
    expect(prompt).toContain("附件 2 个文件");
  });

  it("is a legitimate message with a picture and no words", () => {
    const prompt = promptWithAttachments("   ", [one]);
    expect(prompt.startsWith("[附件 1 个文件")).toBe(true);
    expect(prompt).toContain(one.path);
  });

  it("adds nothing at all when the draft carries none", () => {
    expect(promptWithAttachments("  只有文字  ", [])).toBe("只有文字");
  });

  it("keeps the ceiling small enough that a composer is not an uploader", () => {
    expect(MAX_CHAT_ATTACHMENTS).toBeLessThanOrEqual(8);
  });
});

describe("base64Of", () => {
  it("round-trips without a data-URL prefix", () => {
    const bytes = new Uint8Array([0, 1, 250, 255]);
    expect(base64Of(bytes.buffer)).toBe(btoa(String.fromCharCode(0, 1, 250, 255)));
  });

  it("survives a payload larger than one argument spread", () => {
    const big = new Uint8Array(20_000).fill(65);
    expect(base64Of(big.buffer)).toBe(btoa("A".repeat(20_000)));
  });
});
