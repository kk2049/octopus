/** The only credential file the recovery CLI may read, relative to its cwd. */
export const MCP_CONFIG_FILE = ".mcp-devpipe.json";

export interface PipelineMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Validate the short-lived pipeline MCP config without guessing malformed values. */
export function parsePipelineMcpConfig(value: unknown): Record<string, PipelineMcpServer> {
  const root = record(value, "MCP config");
  const servers = record(root.mcpServers, "MCP config mcpServers");
  const result: Record<string, PipelineMcpServer> = {};
  for (const [name, value] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`invalid MCP server name: ${name}`);
    const raw = record(value, `MCP server ${name}`);
    if (typeof raw.command !== "string" || !raw.command.trim()) {
      throw new Error(`MCP server ${name} requires a command`);
    }
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== "string"))) {
      throw new Error(`MCP server ${name} args must be strings`);
    }
    if (raw.env !== undefined && (!raw.env || typeof raw.env !== "object" || Array.isArray(raw.env))) {
      throw new Error(`MCP server ${name} env must be an object`);
    }
    const rawEnv = raw.env === undefined ? {} : record(raw.env, `MCP server ${name} env`);
    if (Object.values(rawEnv).some((entry) => typeof entry !== "string")) {
      throw new Error(`MCP server ${name} env values must be strings`);
    }
    result[name] = {
      command: raw.command,
      ...(raw.args ? { args: raw.args as string[] } : {}),
      ...(Object.keys(rawEnv).length ? { env: rawEnv as Record<string, string> } : {}),
    };
  }
  return result;
}
