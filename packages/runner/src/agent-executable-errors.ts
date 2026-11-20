/** Closed, path-free diagnostics shared by inventory and local execution adapters. */
export const AGENT_DIAGNOSTIC_CODES = [
  "command_unavailable", "unsafe_permissions", "invalid_path", "not_executable",
  "interpreter_unavailable", "unsupported_interpreter", "invalid_bindings",
  "binding_unavailable", "selection_unavailable", "multiple_installations",
  "selection_write_failed", "executable_changed", "execution_only", "probe_failed",
  "permission_denied", "probe_timeout",
] as const;
export type AgentDiagnosticCode = typeof AGENT_DIAGNOSTIC_CODES[number];
export function agentDiagnosticCode(value: unknown): AgentDiagnosticCode | undefined {
  return typeof value === "string" && (AGENT_DIAGNOSTIC_CODES as readonly string[]).includes(value)
    ? value as AgentDiagnosticCode : undefined;
}
export interface AgentLocalDiagnostic {
  stage: "entry" | "target" | "interpreter" | "registry";
  path: string;
  rule: string;
  uid?: number;
  gid?: number;
  mode?: string;
}
export class AgentExecutableError extends Error {
  readonly code: string;
  constructor(readonly diagnosticCode: AgentDiagnosticCode, readonly detail?: AgentLocalDiagnostic) {
    super(diagnosticCode);
    this.code = diagnosticCode === "command_unavailable" ? "ENOENT" : "AGENT_EXECUTABLE_UNAVAILABLE";
  }
}
export function executableDiagnostic(error: unknown): AgentDiagnosticCode {
  if (error instanceof AgentExecutableError) return error.diagnosticCode;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "command_unavailable";
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  if ((error as { killed?: boolean } | undefined)?.killed) return "probe_timeout";
  return agentDiagnosticCode(error instanceof Error ? error.message : undefined) ?? "probe_failed";
}
