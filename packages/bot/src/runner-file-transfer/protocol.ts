import { declareContract, mcpToolsOf, refusalVocabulary, type PortField } from "@claude-bot/typed-port-kit";
import type { ArgSpec, OperationSpec } from "@claude-bot/capability-kernel";
import { workspaceRelativePathProblem } from "@claude-bot/runner/workspace-files";

export const TRANSFER_OPERATION = "transfer_workspace_file";
const device = (description: string, optional = false): PortField => ({ type: "string", maxLength: 128, description, ...(optional ? { optional } : {}) });
const workspace: PortField = { type: "string", maxLength: 27, pattern: /^ws_[a-f0-9]{24}$/, description: "Exact registered workspace_id from target discovery." };
const file: PortField = { type: "string", maxLength: 4096, description: "POSIX relative file path inside the workspace. The parent directory must already exist." };
const transferId: PortField = { type: "string", maxLength: 36, pattern: /^[a-f0-9-]{36}$/, description: "Exact transfer_id returned by octopus_copy_file. Do not resubmit a copy after an uncertain result." };
const copyFields = {
  source_device: device("Exact source device from targets or local_target."),
  source_workspace_id: workspace,
  source_path: file,
  destination_device: device("Exact destination device. Omit to use the current local Runner.", true),
  destination_workspace_id: workspace,
  destination_path: file,
  expected_digest: { type: "string", optional: true, maxLength: 71, pattern: /^(absent|sha256:[a-f0-9]{64})$/,
    description: "Defaults to absent (create only). To replace, supply the existing destination file's SHA-256 as sha256:hex; a changed destination is refused." } satisfies PortField,
};
export const FILE_TRANSFER_REFUSALS = refusalVocabulary(
  ["invalid_input", "unavailable", "denied", "capacity", "approval_required"] as const,
  { fallback: "unavailable" },
);
export const FILE_TRANSFER_DECLARATION = declareContract({
  contract: "runner-file-transfer/v1",
  summary: "Copy binary files between owned registered Runner workspaces over Octopus.",
  refusals: FILE_TRANSFER_REFUSALS,
  actions: {
    copy_file: { operation: TRANSFER_OPERATION, params: copyFields,
      summary: "Start an asynchronous binary file copy through Octopus. No total file-size or transfer-duration limit; memory is bounded. Poll octopus_get_file_transfer until completed. Closing this MCP client does not cancel; origin Runner/Gateway disconnect or permission revocation stops the transfer. No automatic replay or resume after failure. Directories are not copied; archive them first." },
    get_file_transfer: { params: { transfer_id: transferId },
      summary: "Read copy progress, decimal byte counts and final SHA-256. Up to 256 recent receipts are retained for one hour after completion; Gateway restart loses in-memory receipts. approval_required means wait for approval of this transfer, not resubmit." },
    cancel_file_transfer: { params: { transfer_id: transferId },
      summary: "Cancel this origin Runner's copy and clean its staging file. If atomic commit was already dispatched, the destination outcome may be indeterminate; inspect it before retrying." },
  },
});
export const FILE_TRANSFER_MCP_TOOLS = mcpToolsOf(FILE_TRANSFER_DECLARATION, { namePrefix: "octopus" });
export const FILE_TRANSFER_MCP_NAMES = new Set(FILE_TRANSFER_MCP_TOOLS.map((tool) => tool.name));

/** The Gate schema and MCP face share one field declaration. */
export const FILE_TRANSFER_OPERATIONS: Record<string, OperationSpec> = {
  [TRANSFER_OPERATION]: {
    args: {
      ...Object.fromEntries(Object.entries(copyFields).map(([key, field]) => [key, toArgSpec(field)])),
      origin_device: toArgSpec(device("Trusted initiating Runner.")),
      transfer_id: toArgSpec(transferId),
    },
    effect: "modify", retrySafe: false, title: "在 Runner 工作区之间复制文件",
  },
};
function toArgSpec(field: PortField): ArgSpec {
  return { type: "string", required: !field.optional, maxLength: field.maxLength };
}

export function readFileTransferArgs(tool: string, args: Readonly<Record<string, unknown>>): Record<string, string> {
  const action = FILE_TRANSFER_DECLARATION.actions.find((candidate) => "octopus_" + candidate.action === tool);
  if (!action) throw new Error("unknown file transfer tool");
  if (Object.keys(args).some((key) => !Object.hasOwn(action.params, key))) throw new Error("unknown file transfer argument");
  const result: Record<string, string> = {};
  for (const [key, field] of Object.entries(action.params)) {
    const value = args[key];
    if (value === undefined && field.optional) continue;
    if (typeof value !== "string" || !value || value !== value.trim() || value.length > field.maxLength!
      || (field.pattern && !field.pattern.test(value))) throw new Error("invalid file transfer argument: " + key);
    if (key.endsWith("_path") && workspaceRelativePathProblem(value)) throw new Error("invalid workspace relative path");
    result[key] = value;
  }
  return result;
}
