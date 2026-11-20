import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardUiProvider } from "../ui-kit/UiProvider.js";
import { DocKeyPage } from "./DocKeyPage.js";

const SECRET = `dsi_${"A".repeat(43)}`;
const CONNECT = {
  claude: 'claude mcp add --transport http --scope user octopus-doc-0a1b2c https://octopus.example/api/mcp --header "Authorization: Bearer mcp_0123"',
  codex: "printf '\\n[mcp_servers.octopus-doc-0a1b2c]\\nurl = \"https://octopus.example/api/mcp\"\\nhttp_headers = { Authorization = \"Bearer mcp_0123\" }\\n' >> ~/.codex/config.toml",
  endpoint: "https://octopus.example/api/mcp",
  token: "mcp_0123",
};

/** The docs add-on's two claim calls, answered as given; every request is recorded. */
function claimApi(info: [number, unknown], claim: [number, unknown] = [200, { share: { label: "外校老师", rights: "write" }, connect: CONNECT }]) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const [status, body] = url.endsWith("/invite-info") ? info : url.endsWith("/invite-claim") ? claim : [404, { error: "not found" }];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

/** Mounted as `main.tsx` mounts the app: StrictMode at the root, so effects run twice as in development. */
function open(hash = `#i=${SECRET}`) {
  window.history.replaceState(null, "", `/doc-key${hash}`);
  return render(<StrictMode><DashboardUiProvider><DocKeyPage /></DashboardUiProvider></StrictMode>);
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false, media, onchange: null,
    addEventListener(): void {}, removeEventListener(): void {}, addListener(): void {}, removeListener(): void {}, dispatchEvent: () => false,
  }));
});
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

describe("the claim page of a document's access keys", () => {
  it("takes the secret from the fragment once, out of the address bar, and sends it in request bodies only", async () => {
    const calls = claimApi([200, { doc_title: "论文初稿", self_serve: "write" }]);
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    open();
    expect(await screen.findByText("文档：《论文初稿》")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/doc-key");
    expect(window.location.hash).toBe("");
    fireEvent.change(screen.getByLabelText("名字"), { target: { value: "  外校   老师 " } });
    fireEvent.click(screen.getByRole("button", { name: "领取密钥" }));
    expect(await screen.findByText("密钥只显示这一次，等同密码。")).toBeInTheDocument();
    expect(calls.map((call) => call.url)).toEqual(["/api/feishu/docs-addon/invite-info", "/api/feishu/docs-addon/invite-claim"]);
    expect(calls.map((call) => call.body)).toEqual([{ invite: SECRET }, { invite: SECRET, label: "外校 老师", rights: "write" }]);
    expect(screen.getByRole("status")).toHaveTextContent("已领取「外校老师」（读写）。");
    // Claude Code first; each way in is one line to copy.
    expect(screen.getByText(CONNECT.claude)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制命令" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CONNECT.claude));
    expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
    expect(await screen.findByText(CONNECT.codex)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "其他客户端" }));
    expect(await screen.findByText(CONNECT.endpoint)).toBeInTheDocument();
    expect(screen.getByText(`Authorization: Bearer ${CONNECT.token}`)).toBeInTheDocument();
    // The form is gone: one claim per page.
    expect(screen.queryByRole("button", { name: "领取密钥" })).toBeNull();
  });

  it("offers no more than the owner's ceiling, and says why", async () => {
    const calls = claimApi([200, { doc_title: "", self_serve: "read" }]);
    open();
    expect(await screen.findByText("文档：《飞书文档》")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^读写/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /^只读/ })).toBeChecked();
    expect(screen.getByText("文档所有者只开放了只读密钥")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("名字"), { target: { value: "读者" } });
    fireEvent.click(screen.getByRole("button", { name: "领取密钥" }));
    await screen.findByText("密钥只显示这一次，等同密码。");
    expect(calls[1].body).toEqual({ invite: SECRET, label: "读者", rights: "read" });
  });

  it("asks nothing for a link without its secret, and says what is wrong with one that is", async () => {
    const calls = claimApi([404, { error: "这个领取链接无效，或者文档所有者已经重置或停用了它；请向所有者要新的链接" }]);
    open("");
    expect(await screen.findByRole("status")).toHaveTextContent("链接不完整");
    open(`#i=dsi_short`);
    await waitFor(() => expect(screen.getAllByRole("status").every((node) => node.textContent?.includes("链接不完整"))).toBe(true));
    expect(calls).toEqual([]);
    open();
    expect(await screen.findByText(/这个领取链接无效/)).toBeInTheDocument();
    expect(screen.queryByLabelText("名字")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("shows no form when the owner turned self-service off", async () => {
    claimApi([200, { doc_title: "论文初稿", self_serve: "off" }]);
    open();
    expect(await screen.findByText("文档所有者现在没有开放自助领取，不能领取访问密钥")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "领取密钥" })).toBeNull();
  });

  it("keeps the form on a refused claim, with the server's own words, and asks for a name first", async () => {
    const calls = claimApi([200, { doc_title: "论文初稿", self_serve: "write" }], [429, { error: "这张卡片一小时内最多自助领取 10 个访问密钥，请稍后再试" }]);
    open();
    await screen.findByText("文档：《论文初稿》");
    fireEvent.click(screen.getByRole("button", { name: "领取密钥" }));
    expect(await screen.findByText("请先填一个名字")).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("名字"), { target: { value: "张老师" } });
    fireEvent.click(screen.getByRole("button", { name: "领取密钥" }));
    expect(await screen.findByText(/一小时内最多自助领取 10 个/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "领取密钥" })).toBeEnabled();
    expect(screen.queryByText("密钥只显示这一次，等同密码。")).toBeNull();
  });

  it("selects a line for copying by hand where the browser refuses the clipboard", async () => {
    claimApi([200, { doc_title: "论文初稿", self_serve: "write" }]);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    open();
    fireEvent.change(await screen.findByLabelText("名字"), { target: { value: "张老师" } });
    fireEvent.click(screen.getByRole("button", { name: "领取密钥" }));
    fireEvent.click(await screen.findByRole("button", { name: "复制命令" }));
    expect(await screen.findByRole("button", { name: "已选中，请手动复制" })).toBeInTheDocument();
    expect(window.getSelection()?.toString()).toBe(CONNECT.claude);
  });
});
