import { describe, expect, it } from "vitest";
import { feishuDocumentLabel, readFeishuDocumentLink } from "./links.js";

describe("readFeishuDocumentLink", () => {
  it("accepts tenant Feishu and Lark document links and removes tracking identity", () => {
    expect(readFeishuDocumentLink("https://acme.feishu.cn/docx/Abc_def-123?from=chat#section"))
      .toEqual({ url: "https://acme.feishu.cn/docx/Abc_def-123", host: "acme.feishu.cn", kind: "docx", token: "Abc_def-123" });
    expect(readFeishuDocumentLink("https://team.larksuite.com/wiki/WikTok_88")?.kind).toBe("wiki");
  });

  it("refuses lookalike hosts, credentials, non-HTTPS, extra paths and unknown products", () => {
    for (const value of [
      "http://acme.feishu.cn/docx/Abcdef12",
      "https://feishu.cn.evil.test/docx/Abcdef12",
      "https://acme.feishu.cn:8443/docx/Abcdef12",
      "https://u:p@acme.feishu.cn/docx/Abcdef12",
      "https://acme.feishu.cn/docx/Abcdef12/more",
      "https://acme.feishu.cn/admin/Abcdef12",
    ]) expect(readFeishuDocumentLink(value), value).toBeNull();
  });

  it("uses authored text only as a bounded presentation label", () => {
    const link = readFeishuDocumentLink("https://acme.feishu.cn/base/Bascn123")!;
    expect(feishuDocumentLabel(link, "项目看板")).toBe("项目看板");
    expect(feishuDocumentLabel(link, "")).toContain("飞书多维表格");
  });
});
