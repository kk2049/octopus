/**
 * The MCP Streamable-HTTP endpoint, as a minimal stateless JSON-RPC handler.
 *
 * ── Why hand-rolled rather than the SDK's server transport ──────────────────
 *
 * `@modelcontextprotocol/sdk`'s Streamable HTTP transport is a stateful object
 * per MCP session: it owns the raw socket, manages `Mcp-Session-Id` issuance,
 * SSE resumption streams and a DELETE lifecycle. Mounting it inside this panel
 * would mean handing raw sockets out of Fastify BEFORE the panel's identity
 * gate, CSRF stance and route/Cedar table — the exact machinery this endpoint
 * must sit behind. What the spec actually requires of a stateless server is
 * small: answer a POSTed request with one `application/json` JSON-RPC
 * response, accept notifications with 202, and refuse GET (405) when no
 * server-push stream is offered. That subset is implemented here, purely, so a
 * test can drive it as a value function.
 *
 * Batching is not accepted: JSON-RPC batching was removed in protocol
 * 2025-06-18, and the panel's body parser already refuses non-object bodies.
 *
 * ── What this file decides, and what it does not ────────────────────────────
 *
 * It decides protocol shape only. WHO is calling was decided by the panel's
 * identity gate (an `mcp_` bearer resolved to an owner); WHAT the caller may
 * do is decided per call by `McpSurface` against the permission projections.
 * Nothing in a JSON-RPC message can name an owner.
 */

import type { McpSurface, McpPrincipal, McpToolOutcome } from "./service.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { CAPABILITY_LIMITS, jsonObject } from "@claude-bot/runner/capability-protocol";

/** Newest first. `initialize` echoes the client's version when we know it. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const MCP_SERVER_INFO = { name: "octopus", version: "1.0.0" } as const;

export interface McpHttpAnswer {
  status: number;
  /** Absent = an empty body (202 for notifications). */
  body?: unknown;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcError(id: unknown, code: number, message: string): McpHttpAnswer {
  // Per the streamable-http spec an error RESPONSE still travels as HTTP 200;
  // non-2xx is reserved for transport-level refusals the gate already sent.
  return { status: 200, body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): McpHttpAnswer {
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}

const MCP_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** A renderable image: an allowed type and canonical, non-empty base64. */
function validImage(item: { mimeType: string; data: string }): boolean {
  return MCP_IMAGE_TYPES.includes(item.mimeType)
    && item.data.length > 0 && item.data.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(item.data)
    && Buffer.from(item.data, "base64").toString("base64") === item.data;
}

/** Bounded, human-first rendering of one tool outcome as MCP content. */
function toolContent(out: McpToolOutcome, name: string): unknown {
  if (!out.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: `${out.code}: ${out.message}` }],
    };
  }
  // Images the surface lifted out of an authorized, successful result (the
  // lark-cli operations): JSON text plus image blocks, never base64 in text.
  if (out.images?.length) {
    if (!out.images.every(validImage)) {
      return { isError: true, content: [{ type: "text",
        text: "invalid_result_image: the result cannot be rendered; the call may have completed, do not replay automatically." }] };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(out.result, null, 2) },
        ...out.images.map(item => ({ type: "image", mimeType: item.mimeType, data: item.data }))],
      structuredContent: out.result,
    };
  }
  // Only the already-authorized, identity-checked Runner invocation can carry
  // provider images. Do not make arbitrary JSON from other tools executable
  // MCP content, nor dump base64 into a language-model text block.
  if (name === "runner_capability_call" && jsonObject(out.result)
    && out.result.status === "succeeded" && jsonObject(out.result.result)
    && Array.isArray(out.result.result.content)
    && out.result.result.content.some(item => jsonObject(item) && item.type === "image")) {
    const invalid = () => ({ isError: true, content: [{ type: "text",
      text: "invalid_provider_image: Runner result cannot be rendered; input may have completed, do not replay automatically." }] });
    if (Buffer.byteLength(JSON.stringify(out.result.result)) > CAPABILITY_LIMITS.resultBytes) return invalid();
    const parsed = CallToolResultSchema.safeParse(out.result.result);
    if (!parsed.success) return invalid();
    const images = parsed.data.content.filter(item => item.type === "image");
    if (!images.every(validImage)) return invalid();
    const metadata = { ...out.result, result: { ...out.result.result,
      content: parsed.data.content.map(item => item.type === "image"
        ? { type: "image", mimeType: item.mimeType, bytes: Buffer.from(item.data, "base64").length, data_omitted: true }
        : item) } };
    return {
      ...(parsed.data.isError ? { isError: true } : {}),
      content: [{ type: "text", text: JSON.stringify(metadata, null, 2) },
        ...images.map(item => ({ type: "image", mimeType: item.mimeType, data: item.data }))],
      structuredContent: metadata,
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(out.result, null, 2) }],
    structuredContent: out.result,
  };
}

/**
 * Handle one POSTed JSON-RPC message. The caller (the panel route) has already
 * authenticated the principal and parsed the body into an object.
 */
export async function handleMcpRpc(
  body: Record<string, unknown>,
  surface: Pick<McpSurface, "listTools" | "callTool">,
  principal: McpPrincipal,
): Promise<McpHttpAnswer> {
  const message = body as JsonRpcRequest;
  if (message.jsonrpc !== "2.0") {
    return rpcError(message.id, -32600, "需要 jsonrpc: \"2.0\" 的单条消息（不支持批量）。");
  }
  const method = typeof message.method === "string" ? message.method : "";
  const hasId = message.id !== undefined && message.id !== null;

  // A response or a notification (`notifications/initialized` and friends):
  // acknowledged, nothing to answer.
  if (!hasId || !method) return { status: 202 };

  const params = (message.params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
        ? asked
        : MCP_PROTOCOL_VERSIONS[0];
      return rpcResult(message.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions: principal.policy?.ticketDevelopment
          ? "本票本轮的开发工具；目标由服务端固定。轮次结束后凭据失效，结果未知时查询原调用，不要重复提交。"
          : principal.policy?.feishuDocShare
          ? "这个连接只能访问文档所有者共享给你的那一篇飞书文档，身份是 Octopus 飞书应用。先用 feishu_shared_doc_read 或 "
          + "feishu_shared_doc_outline 了解内容和块 ID，再写入或修改。所有者可以随时暂停或终止共享；被拒绝时说明原因，不要反复重试。"
          : principal.policy?.sessionExecution?.permissionProfile === "read_only"
          ? "这是一个飞书文档助手的连接，只有两样东西：所有者登记的一个项目工作区，只读（list_session_workspaces → list_workspace_entries → "
          + "read_workspace_text）；以及一篇飞书文档（feishu_shared_doc_*，身份是 Octopus 飞书应用，可写与否由所有者决定）。没有命令、"
          + "写文件或任何别的工具。所有者或发起人可以随时暂停或结束这个助手；被拒绝时说明原因，不要反复重试。"
          : "octopus 后端的原子接口。tools/list 只列出当前令牌的所有者此刻实际有效的操作；"
          + "授权在 dashboard 的 /permissions 页管理。modify 类工具会走逐次批准：收到 approval_required 时，"
          + "请所有者在网页「待批准」里点头。",
      });
    }
    case "ping":
      return rpcResult(message.id, {});
    case "tools/list":
      return rpcResult(message.id, { tools: surface.listTools(principal) });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (!name) return rpcError(message.id, -32602, "params.name 缺失。");
      const out = await surface.callTool(principal, name, params.arguments);
      if (!out.ok && out.code === "unknown_tool") return rpcError(message.id, -32602, out.message);
      return rpcResult(message.id, toolContent(out, name));
    }
    case "prompts/list":
      return rpcResult(message.id, { prompts: [] });
    case "resources/list":
      return rpcResult(message.id, { resources: [] });
    default:
      return rpcError(message.id, -32601, `方法 ${method} 不存在。`);
  }
}
