import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PermissionStudioExplainStep,
  PermissionStudioPermit,
  PermissionStudioProjection,
} from "../contract.js";
import { renderPage } from "../test-utils.js";
import { PermissionStudio } from "./PermissionStudio.js";

const STEPS: PermissionStudioExplainStep[] = [
  {
    stage: "authority",
    title: "Authority",
    detail: "服务端链路 1：Alice authority 是唯一裁决者",
  },
  {
    stage: "domain_audience",
    title: "Domain / Audience",
    detail: "服务端链路 2：留在 Alice personal domain",
  },
  {
    stage: "permit_ceiling",
    title: "Permit / Install ceiling",
    detail: "服务端链路 3：直接许可没有超过安装上限",
  },
  {
    stage: "enforcement",
    title: "Enforcement",
    detail: "服务端链路 4：执行入口会重新检查 Gate",
  },
];

function permit(patch: Partial<PermissionStudioPermit>): PermissionStudioPermit {
  return {
    id: "permit:report:expense:read",
    resourceId: "resource:report",
    holderId: "holder:expense-app",
    operation: "read",
    operationLabel: "读取",
    mode: "ask",
    verdict: "服务器原文：每次读取前向 Alice 询问",
    editable: true,
    explanation: {
      verdict: "服务器 EXPLAIN 原文：ASK，不做浏览器推导",
      summary: "服务端摘要原文",
      steps: STEPS,
    },
    ...patch,
  };
}

const PROJECTION: PermissionStudioProjection = {
  version: 2,
  username: "alice",
  revision: "projection-r7",
  coverage: { complete: true, notices: [] },
  domains: [
    {
      id: "domain:personal",
      title: "Alice personal domain",
      kind: "personal",
      authorityLabel: "Alice authority",
      historyPolicy: "not_applicable",
    },
    {
      id: "domain:work",
      title: "ACME team domain",
      kind: "organization",
      authorityLabel: "ACME mandatory authority",
      historyPolicy: "since_join",
    },
  ],
  resources: [
    {
      id: "resource:report",
      uri: "file://octopus/alice/reports/42",
      title: "report/42",
      kind: "document",
      domainId: "domain:personal",
      authorityLabel: "Alice authority",
      sensitivity: "sensitive",
      sourceSystem: "workspace-files",
      enforcement: "enforced",
    },
    {
      id: "resource:payroll",
      uri: "file://finance/acme/payroll",
      title: "payroll directory",
      kind: "directory",
      domainId: "domain:work",
      authorityLabel: "ACME mandatory authority",
      sensitivity: "credential",
      sourceSystem: "finance",
      enforcement: "compatibility",
    },
  ],
  aliases: [
    {
      uri: "file://octopus/alice/current-report",
      targetUri: "file://octopus/alice/reports/42",
    },
  ],
  holders: [
    { id: "holder:alice", title: "Alice", kind: "user" },
    { id: "holder:expense-app", title: "Expense Helper", kind: "app" },
  ],
  permits: [
    permit({}),
    permit({
      id: "permit:report:alice:read",
      holderId: "holder:alice",
      mode: "allow",
      verdict: "服务器原文：Alice 可读取",
    }),
    permit({
      id: "permit:payroll:expense:pay",
      resourceId: "resource:payroll",
      operation: "pay",
      operationLabel: "付款",
      mode: "ask",
      verdict: "服务器原文：组织付款必须询问",
      editable: false,
      readonlyReason: "ACME authority 只允许组织 steward 修改",
      compatibility: true,
      explanation: {
        verdict: "服务器 EXPLAIN 原文：组织 ASK",
        steps: STEPS,
      },
    }),
  ],
  policies: [
    {
      id: "policy:acme:manager-pay",
      title: "Manager payment rule",
      resourceId: "resource:payroll",
      authorityLabel: "ACME mandatory authority",
      effect: "allow",
      mandatory: false,
      subjectSelector: "user；bob",
      operationSelector: "pay",
      condition: "事实 manager = true",
      verdict: "服务器原文：尚未求值，需要真实调用事实",
      enforcement: "intent-only",
      explanation: {
        verdict: "服务器原文：条件规则尚未求值",
        steps: STEPS,
      },
    },
  ],
  emptyCell: {
    label: "服务端空值：没有投影许可",
    explanation: "服务端说明：不存在可显示的许可",
  },
  appDefaults: {
    title: "下一次新 App 的默认草稿",
    description: "服务端投影的安装草稿默认值",
    permits: [
      permit({
        id: "default:observe",
        resourceId: "studio:app-defaults:alice",
        holderId: "studio:app-default",
        operation: "observe",
        operationLabel: "观察",
        mode: "allow",
        verdict: "默认允许观察",
      }),
      permit({
        id: "default:read",
        resourceId: "studio:app-defaults:alice",
        holderId: "studio:app-default",
        operation: "read",
        operationLabel: "读取",
        mode: "allow",
        verdict: "默认允许读取",
      }),
      permit({
        id: "default:modify",
        resourceId: "studio:app-defaults:alice",
        holderId: "studio:app-default",
        operation: "modify",
        operationLabel: "修改",
        mode: "ask",
        verdict: "默认询问修改",
      }),
      permit({
        id: "default:execute",
        resourceId: "studio:app-defaults:alice",
        holderId: "studio:app-default",
        operation: "execute",
        operationLabel: "执行",
        mode: "ask",
        verdict: "默认询问执行",
      }),
    ],
  },
};

interface StubOptions {
  explain?: { status?: number; body: unknown };
  apply?: { status?: number; body: unknown };
}

function stubStudio(options: StubOptions = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let projectionReads = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("/api/permissions/studio?")) {
      projectionReads += 1;
      return new Response(JSON.stringify(PROJECTION), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/permissions/studio/explain") {
      const answer = options.explain ?? {
        body: {
          proposal_id: "opaque-proposal-7",
          verdict: "服务器预演原文：ALLOW",
          summary: "该提案仍需 APPLY",
          steps: STEPS,
        },
      };
      return new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/permissions/studio/apply") {
      const answer = options.apply ?? {
        body: { status: "applied", message: "服务器确认：规则已应用" },
      };
      return new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: `no stub for ${url}` }), { status: 404 });
  }) as typeof fetch;
  return { calls, projectionReads: () => projectionReads };
}

async function selectResource(title: string) {
  const user = userEvent.setup();
  const browser = await screen.findByTestId("permission-resource-browser");
  await user.clear(within(browser).getByRole("textbox", { name: "搜索资源或 URL" }));
  await user.type(within(browser).getByRole("textbox", { name: "搜索资源或 URL" }), title);
  await user.click(within(browser).getByRole("button", { name: new RegExp(title) }));
  return browser;
}

async function openEditablePermit() {
  const user = userEvent.setup();
  const browser = await selectResource("report/42");
  await user.click(within(browser).getByRole("button", { name: /report\/42 \/ Expense Helper \/ 读取/ }));
  return screen.findByRole("dialog");
}

describe("Permission Studio", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the server verdict and ordered EXPLAIN words verbatim", async () => {
    stubStudio();
    renderPage(<PermissionStudio owner="alice" />);

    const dialog = await openEditablePermit();
    expect(within(dialog).getByText("服务器 EXPLAIN 原文：ASK，不做浏览器推导")).toBeInTheDocument();
    expect(within(dialog).getByText("服务端链路 1：Alice authority 是唯一裁决者")).toBeInTheDocument();
    expect(within(dialog).getByText("服务端链路 2：留在 Alice personal domain")).toBeInTheDocument();
    expect(within(dialog).getByText("服务端链路 3：直接许可没有超过安装上限")).toBeInTheDocument();
    expect(within(dialog).getByText("服务端链路 4：执行入口会重新检查 Gate")).toBeInTheDocument();
  });

  it("browses URL levels and follows aliases without making a new request", async () => {
    const user = userEvent.setup();
    const stub = stubStudio();
    renderPage(<PermissionStudio owner="alice" />);
    const browser = await screen.findByTestId("permission-resource-browser");
    await user.click(within(browser).getByRole("button", { name: /文件 · octopus/ }));
    await user.click(within(browser).getByRole("button", { name: "进入目录" }));
    await user.click(within(browser).getByRole("button", { name: /alice/ }));
    await user.click(within(browser).getByRole("button", { name: "进入目录" }));
    await user.click(within(browser).getByRole("button", { name: /current-report/ }));
    expect(within(browser).getByText("软链接目标")).toBeInTheDocument();
    await user.click(within(browser).getByRole("button", { name: "查看目标" }));
    expect(within(browser).getByText("服务器原文：Alice 可读取")).toBeInTheDocument();
    expect(within(browser).getByText("服务器原文：每次读取前向 Alice 询问")).toBeInTheDocument();
    expect(stub.calls).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "刷新投影" }));
    await waitFor(() => expect(stub.projectionReads()).toBe(2));
    expect(within(browser).getByText("服务器原文：Alice 可读取")).toBeInTheDocument();
  });

  it("keeps conditional policy separate from exact holder decisions", async () => {
    stubStudio();
    renderPage(<PermissionStudio owner="alice" />);
    const browser = await selectResource("payroll directory");
    await userEvent.setup().click(within(browser).getByText("条件与规则 · 1"));
    expect(within(browser).getByText("服务器原文：尚未求值，需要真实调用事实")).toBeInTheDocument();
    expect(within(browser).getByText(/待运行时求值/)).toBeInTheDocument();
    expect(within(browser).queryByText("Alice")).toBeNull();
  });

  it("previews first, applies only the opaque proposal, then reloads projection", async () => {
    const user = userEvent.setup();
    const stub = stubStudio();
    renderPage(<PermissionStudio owner="alice" />);
    const dialog = await openEditablePermit();

    await user.click(within(dialog).getByRole("radio", { name: "允许" }));
    await user.click(within(dialog).getByRole("button", { name: "预演并解释" }));
    expect(await within(dialog).findByText("服务器预演原文：ALLOW")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "应用此提案" }));

    await waitFor(() => expect(stub.projectionReads()).toBe(2));
    const explainCall = stub.calls.find((call) => call.url.endsWith("/studio/explain"));
    expect(JSON.parse(String(explainCall?.init?.body))).toEqual({
      username: "alice",
      resource_id: "resource:report",
      holder_id: "holder:expense-app",
      operation: "read",
      proposed_mode: "allow",
    });
    const applyCall = stub.calls.find((call) => call.url.endsWith("/studio/apply"));
    expect(JSON.parse(String(applyCall?.init?.body))).toEqual({
      username: "alice",
      proposal_id: "opaque-proposal-7",
    });
    expect(applyCall?.init?.body).not.toContain("resource:report");
    expect(await within(dialog).findByText("服务器确认：规则已应用")).toBeInTheDocument();
  });

  it("preserves the chosen draft when APPLY is refused", async () => {
    const user = userEvent.setup();
    stubStudio({
      apply: {
        status: 403,
        body: { error: "ACME mandatory authority 拒绝了这次放宽" },
      },
    });
    renderPage(<PermissionStudio owner="alice" />);
    const dialog = await openEditablePermit();

    const allow = within(dialog).getByRole("radio", { name: "允许" });
    await user.click(allow);
    await user.click(within(dialog).getByRole("button", { name: "预演并解释" }));
    await user.click(await within(dialog).findByRole("button", { name: "应用此提案" }));

    expect(await within(dialog).findByText(/ACME mandatory authority 拒绝了这次放宽/)).toBeInTheDocument();
    expect(allow).toBeChecked();
    expect(within(dialog).getByRole("button", { name: "应用此提案" })).toBeEnabled();
  });

  it("keeps compatibility decisions read-only when editable is false", async () => {
    const user = userEvent.setup();
    stubStudio();
    renderPage(<PermissionStudio owner="alice" />);
    const matrix = await selectResource("payroll directory");
    await user.click(
      within(matrix).getByRole("button", {
        name: /payroll directory \/ Expense Helper \/ 付款/,
      }),
    );
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByText("ACME authority 只允许组织 steward 修改")).toBeInTheDocument();
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "预演并解释" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "应用此提案" })).toBeNull();
  });
});
