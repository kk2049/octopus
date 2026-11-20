import { describe, expect, it } from "vitest";
import { filePathOf, findFilePaths, linkifyFilePaths } from "./file-mentions.js";

describe("filePathOf", () => {
  it("accepts the four anchored forms", () => {
    expect(filePathOf("/home/u/a.ts")).toBe("/home/u/a.ts");
    expect(filePathOf("~/lht/octopus/AGENTS.md")).toBe("~/lht/octopus/AGENTS.md");
    expect(filePathOf("./src/main.tsx")).toBe("./src/main.tsx");
    expect(filePathOf("../shared/util.js")).toBe("../shared/util.js");
  });

  it("accepts a workspace-relative path and normalises separators", () => {
    expect(filePathOf("packages/agent-sessions-view/src/modules.tsx"))
      .toBe("packages/agent-sessions-view/src/modules.tsx");
    expect(filePathOf("packages\\bot\\src\\index.ts")).toBe("packages/bot/src/index.ts");
  });

  it("drops the line/column suffix agents append", () => {
    expect(filePathOf("src/a.ts:120")).toBe("src/a.ts");
    expect(filePathOf("src/a.ts:120:4")).toBe("src/a.ts");
  });

  it("refuses directories, versions and elisions", () => {
    expect(filePathOf("/home/ubuntu/lht/octopus")).toBe("");
    expect(filePathOf("packages/agent-view-react")).toBe("");
    expect(filePathOf("v4.0")).toBe("");
    expect(filePathOf("1.5.2")).toBe("");
    expect(filePathOf("~/lht/…/a.ts")).toBe("");
  });

  /**
   * Ticket #201. Every one of these is a path that exists on this fleet and
   * that the ASCII-only run alphabet cut in half at the first CJK character.
   */
  it("accepts a non-ASCII file name, in every anchored form", () => {
    expect(filePathOf("/home/ubuntu/lht/oh-my-pi-\u6280\u672f\u62a5\u544a.md"))
      .toBe("/home/ubuntu/lht/oh-my-pi-\u6280\u672f\u62a5\u544a.md");
    expect(filePathOf("~/\u6587\u6863/\u8bbe\u8ba1.md")).toBe("~/\u6587\u6863/\u8bbe\u8ba1.md");
    expect(filePathOf("doc/deliveries/\u4ea4\u4ed8.md")).toBe("doc/deliveries/\u4ea4\u4ed8.md");
    expect(filePathOf("\u6280\u672f\u62a5\u544a.md")).toBe("\u6280\u672f\u62a5\u544a.md");
    expect(filePathOf("caf\u00e9/r\u00e9sum\u00e9.txt")).toBe("caf\u00e9/r\u00e9sum\u00e9.txt");
  });

  it("still refuses a non-ASCII name with no ASCII extension", () => {
    expect(filePathOf("\u6280\u672f\u62a5\u544a.\u4e2d\u6587")).toBe("");
    expect(filePathOf("~/lht/\u9879\u76ee")).toBe("");
  });

  it("refuses a URL whose scheme was split off, and a bare hostname path", () => {
    expect(filePathOf("//example.com/a.ts")).toBe("");
    expect(filePathOf("example.com/a.ts")).toBe("");
    expect(filePathOf("www.example.org/x/y.json")).toBe("");
  });

  it("accepts a bare name only for a known extension, never for prose", () => {
    expect(filePathOf("package.json")).toBe("package.json");
    expect(filePathOf("AGENTS.md")).toBe("AGENTS.md");
    expect(filePathOf("Node.js")).toBe("");
    expect(filePathOf("Vue.js")).toBe("");
    expect(filePathOf("something.unknownext")).toBe("");
    // A stem the prose list names is still a path once it has path context.
    expect(filePathOf("docs/node.js")).toBe("docs/node.js");
  });

  it("refuses anything carrying a character a path may not have", () => {
    expect(filePathOf("a b/c.ts")).toBe("");
    expect(filePathOf("说明/文件？.md")).toBe("");
    expect(filePathOf("")).toBe("");
  });
});

describe("findFilePaths", () => {
  it("pulls the paths out of a JSON tool input", () => {
    const input = '{"file_path":"/home/u/p/src/a.ts","old_string":"x","new":"src/b.tsx"}';
    expect(findFilePaths(input)).toEqual(["/home/u/p/src/a.ts", "src/b.tsx"]);
  });

  it("pulls the paths out of a patch header and a command transcript", () => {
    const output = "*** Update File: packages/bot/src/index.ts\n"
      + "grep -n foo packages/bot/src/index.ts docs/readme.md\n";
    expect(findFilePaths(output)).toEqual(["packages/bot/src/index.ts", "docs/readme.md"]);
  });

  it("deduplicates, keeps first-seen order and honours the cap", () => {
    const text = "a/one.ts b/two.ts a/one.ts c/three.ts";
    expect(findFilePaths(text)).toEqual(["a/one.ts", "b/two.ts", "c/three.ts"]);
    expect(findFilePaths(text, 2)).toEqual(["a/one.ts", "b/two.ts"]);
  });

  it("is empty for text that mentions no file", () => {
    expect(findFilePaths("已经在 v4.0 上跑通了，见 https://example.com/x")).toEqual([]);
    expect(findFilePaths(undefined)).toEqual([]);
  });
});

describe("linkifyFilePaths", () => {
  it("links a path written in prose", () => {
    expect(linkifyFilePaths("改动在 packages/bot/src/index.ts 里。"))
      .toBe("改动在 [packages/bot/src/index.ts](packages/bot/src/index.ts) 里。");
  });

  it("links an inline code span that is exactly one path", () => {
    expect(linkifyFilePaths("见 `src/a.ts` 与 `pnpm -r build`"))
      .toBe("见 [`src/a.ts`](src/a.ts) 与 `pnpm -r build`");
  });

  it("leaves fenced code blocks alone", () => {
    const source = ["前言 src/a.ts", "```sh", "cat src/b.ts", "```", "后记 src/c.ts"].join("\n");
    expect(linkifyFilePaths(source)).toBe([
      "前言 [src/a.ts](src/a.ts)",
      "```sh",
      "cat src/b.ts",
      "```",
      "后记 [src/c.ts](src/c.ts)",
    ].join("\n"));
  });

  it("links a CJK path out of CJK prose without swallowing the punctuation", () => {
    const source = "\u5df2\u5b8c\u6210\u3002\u62a5\u544a\u5728 /home/ubuntu/lht/oh-my-pi-\u6280\u672f\u62a5\u544a.md\uff081089 \u884c\uff09";
    expect(linkifyFilePaths(source)).toBe(
      "\u5df2\u5b8c\u6210\u3002\u62a5\u544a\u5728 [/home/ubuntu/lht/oh-my-pi-\u6280\u672f\u62a5\u544a.md](/home/ubuntu/lht/oh-my-pi-\u6280\u672f\u62a5\u544a.md)\uff081089 \u884c\uff09",
    );
  });

  it("finds a CJK path inside a tool call's recorded JSON", () => {
    const raw = '{"file_path":"/home/ubuntu/lht/oh-my-pi-\u6280\u672f\u62a5\u544a.md","content":"# Oh My Pi"}';
    expect(findFilePaths(raw)).toContain("/home/ubuntu/lht/oh-my-pi-\u6280\u672f\u62a5\u544a.md");
  });

  it("never rewrites an existing link or image", () => {
    expect(linkifyFilePaths("[看这里](src/a.ts) 和 ![图](docs/x.png)"))
      .toBe("[看这里](src/a.ts) 和 ![图](docs/x.png)");
  });

  it("leaves a real URL untouched", () => {
    const source = "见 https://example.com/a/b.ts 和 <https://x.dev/c.md>";
    expect(linkifyFilePaths(source)).toBe(source);
  });

  it("returns the same string when there is nothing to link", () => {
    expect(linkifyFilePaths("完全没有路径")).toBe("完全没有路径");
    expect(linkifyFilePaths("")).toBe("");
  });

  it("keeps a partially streamed line renderable", () => {
    // The typewriter hands this function prefixes of a growing block.
    expect(linkifyFilePaths("正在写 `src/a.t")).toBe("正在写 `src/a.t");
  });
});
