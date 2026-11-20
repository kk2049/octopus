/**
 * The MCP face, derived from the declaration. Pure data.
 *
 * ── What "derived" buys and why it is not cosmetic ─────────────────────────
 *
 * The convergence plan's decision 5 states it as a property: the contract is the
 * single source of truth, and the agent-facing surface is MECHANICALLY derived
 * from it — action to tool name, parameter schema to `inputSchema`, refusal code
 * to tool error. The alternative is what the repository has today. Its one
 * existing generator, `gatewayToolDescriptors` in
 * `packages/bot/src/feishu/catalog.ts`, emits `{ type }` per property and drops
 * `maxLength`, `min`, `max` and every description, because it was written by hand
 * against a declaration that carries all four. Nothing is wrong with the code;
 * the shape simply lets a bound exist in one place and be absent from the other,
 * and a model that cannot see a bound will exceed it and be refused for a reason
 * it was never shown.
 *
 * ── What this file deliberately is not ─────────────────────────────────────
 *
 * It has NO dependency on `@modelcontextprotocol/sdk`, and it never will. It
 * emits the same `{ name, description, inputSchema }` object literal the whole
 * repository already hand-writes — every `plugins/<name>/src/server.ts`,
 * `packages/bot/src/hq/mcp-tools.ts`, `packages/bot/src/devpipe/mcp-server.ts`.
 * Whoever mounts an MCP server hands these to it. Keeping the SDK out means a
 * contract package stays loadable in a browser bundle, in a release adapter, and
 * in a test, and the derivation stays testable as a value comparison.
 *
 * It also does not INVOKE anything. Decision 6 puts the authorisation for an
 * agent's intent at the point the intent enters trusted code, under the agent's
 * own identity; a bridge that mounts these tools is trusted code and is where
 * that happens. This file only says what the tools look like.
 *
 * ── The two-faces rule ─────────────────────────────────────────────────────
 *
 * The wire's eight-keys-by-512-characters budget does NOT constrain this face: a
 * bridge runs inside the trusted process and receives bounded structured JSON.
 * So a `json` field appears here as its declared nested schema, not as a string
 * containing JSON — which is the whole reason `wireProblems` is computed
 * separately rather than being a validation error.
 */

import type { ContractDeclaration, JsonSchemaFragment, PortActionDeclaration, PortField } from "./declaration.js";
import type { PortRefusal } from "./reply.js";

/**
 * A JSON Schema object, as MCP's `inputSchema`.
 *
 * `additionalProperties: false` on every derived schema. Only one place in this
 * repository sets it today (`devpipe/mcp-server.ts`), and its absence elsewhere
 * is how a model's invented extra argument reaches a handler that ignores it —
 * which reads to the model as "accepted".
 */
export interface McpInputSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonSchemaFragment>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: McpInputSchema;
}

export interface McpDerivationOptions {
  /**
   * Prefix for tool names. Defaults to the contract's first namespace segment,
   * so `notify/v1` yields `notify_send_text`.
   */
  readonly namePrefix?: string;
  /**
   * Append the closed refusal set to each description.
   *
   * On by default, because an agent that can enumerate the ways an action says
   * no can act on the difference — "approval_required" is a thing to wait for,
   * "bad_recipient" is a thing to fix. Off for a surface that has its own way of
   * publishing them.
   */
  readonly describeRefusals?: boolean;
  /** Restrict the derivation to these action ids, in this order. */
  readonly only?: readonly string[];
}

/**
 * MCP tool names in practice: letters, digits, underscore, hyphen.
 *
 * Checked rather than assumed, and a violation throws: a derivation that quietly
 * produced an unusable name would surface as a tool that never appears, which is
 * indistinguishable from one that was never registered.
 */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;

/** Derive the agent-facing tool descriptors for one contract. */
export function mcpToolsOf<C extends string, A extends string>(
  declaration: ContractDeclaration<C, A>,
  options: McpDerivationOptions = {},
): readonly McpToolDefinition[] {
  const prefix = options.namePrefix ?? defaultPrefix(declaration.contract);
  const describeRefusals = options.describeRefusals ?? true;
  const refusalLine = describeRefusals ? ` 可能的拒绝：${declaration.refusals.codes.join("、")}。` : "";

  const ids = options.only ?? declaration.actionIds;
  const tools: McpToolDefinition[] = [];
  for (const id of ids) {
    const action = Object.prototype.hasOwnProperty.call(declaration.byAction, id)
      ? declaration.byAction[id as A]
      : undefined;
    if (!action) throw new Error(`${declaration.contract} has no action ${JSON.stringify(id)}`);
    const name = `${prefix}_${action.action}`;
    if (!TOOL_NAME.test(name)) throw new Error(`derived tool name ${JSON.stringify(name)} is not a legal MCP name`);
    tools.push(
      Object.freeze({
        name,
        description: describeAction(declaration.contract, action) + refusalLine,
        inputSchema: inputSchemaOf(action),
      }),
    );
  }
  return Object.freeze(tools);
}

/**
 * The default namespace: the contract id up to its first `.` or `/`.
 *
 * `workspace-files/v1` becomes `workspace-files`, which is a legal tool-name
 * segment; `session.roster/v1` becomes `session`. Hyphens survive because MCP
 * names allow them.
 */
function defaultPrefix(contract: string): string {
  const head = contract.split("/")[0] ?? contract;
  return head.split(".")[0] ?? head;
}

/**
 * The sentence a model reads.
 *
 * The contract id is in it on purpose: an agent with two notification tools
 * mounted needs to know which service each one reaches, and the tool name alone
 * is a prefix somebody chose.
 */
function describeAction(contract: string, action: PortActionDeclaration): string {
  const operation = action.operation ? `（权限词元 ${action.operation}）` : "";
  return `${action.summary}${operation}[${contract}]`;
}

function inputSchemaOf(action: PortActionDeclaration): McpInputSchema {
  const properties: Record<string, JsonSchemaFragment> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(action.params)) {
    properties[name] = propertyOf(field);
    if (!field.optional) required.push(name);
  }
  const schema: {
    type: "object";
    properties: Readonly<Record<string, JsonSchemaFragment>>;
    required?: readonly string[];
    additionalProperties: false;
  } = {
    type: "object",
    properties: Object.freeze(properties),
    additionalProperties: false,
  };
  if (required.length > 0) schema.required = Object.freeze(required);
  return Object.freeze(schema);
}

/**
 * One field as JSON Schema.
 *
 * Every declared bound is carried. That is the whole point of deriving rather
 * than hand-writing: `maxLength`, `minimum`, `maximum`, `enum` and `pattern` are
 * exactly the facts a model needs in order not to be refused, and they are
 * exactly the facts the existing hand-written generator drops.
 */
function propertyOf(field: PortField): JsonSchemaFragment {
  switch (field.type) {
    case "string": {
      const out: Record<string, unknown> = { type: "string", description: field.description };
      if (field.enum !== undefined) out.enum = [...field.enum];
      if (field.maxLength !== undefined) out.maxLength = field.maxLength;
      // `source` rather than the RegExp: JSON Schema's `pattern` is a string, and
      // the declaration already guaranteed it is anchored and flagless so the
      // two engines read it the same way.
      if (field.pattern !== undefined) out.pattern = field.pattern.source;
      return Object.freeze(out);
    }
    case "integer": {
      const out: Record<string, unknown> = { type: "integer", description: field.description };
      if (field.minimum !== undefined) out.minimum = field.minimum;
      if (field.maximum !== undefined) out.maximum = field.maximum;
      return Object.freeze(out);
    }
    case "boolean":
      return Object.freeze({ type: "boolean", description: field.description });
    case "json": {
      // The nested schema the contract author wrote, with the description
      // layered on rather than replacing anything the author put there. No
      // `maxLength`: that bound is the WIRE's, and this face does not have it.
      const nested = field.schema ?? { type: "object" };
      return Object.freeze({ description: field.description, ...nested });
    }
  }
}

/**
 * One MCP `CallToolResult`-shaped error, from a refusal.
 *
 * Pure data, same as the tools. The code is in the text because it is the part
 * an agent can act on: the prose is written for a person and may be in any
 * language, but `approval_required` means the same thing every time.
 */
export function mcpErrorOf<C extends string>(refusal: PortRefusal<C>): {
  readonly isError: true;
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
} {
  return Object.freeze({
    isError: true as const,
    content: Object.freeze([Object.freeze({ type: "text" as const, text: `${refusal.code}: ${refusal.message}` })]),
  });
}
