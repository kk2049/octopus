/**
 * The real Runner adapter: `workspace-files/v1` as Runner operations.
 *
 * Four operations. `list_session_workspaces` already existed on the account's
 * table, so the read half added exactly `list_workspace_entries` and
 * `read_workspace_text`; the write half (2026-08-07) adds
 * `replace_workspace_text` and nothing else.
 *
 * ── Why every field of every answer is re-validated ────────────────────────
 *
 * The other end of these calls is a laptop. It is the owner's own laptop, and
 * the capability layer guarantees which account's laptop — but it is still a
 * program on somebody's machine answering over a socket, and this process is
 * about to mint refs from what it says. So the shape is checked field by field,
 * and two checks are worth calling out because they are not just shape:
 *
 *  · **A child's relative path must be the parent's path plus its name.** A
 *    device that answered `{name: "a.ts", relative_path: "../../.ssh/id_rsa"}`
 *    would otherwise get a ref minted for it. The Runner refuses that path on
 *    the way back in, so this is defence in depth — but it is the cheap kind,
 *    and it fails at mint time rather than at read time.
 *  · **A text window must account for itself.** `bytes` has to equal the UTF-8
 *    length of `text`, start where we asked, and not exceed what we asked for.
 *    A window that reports zero bytes and not-EOF would make a consumer pull
 *    forever, so it is refused rather than retried.
 *  · **A mutation must describe the swap we asked for.** The echoed
 *    `previous_digest` has to equal the precondition we sent and `size` has to
 *    equal the UTF-8 length of the text we sent, because a receipt is about to
 *    be shown to a person as "saved" — and a receipt for a different version, or
 *    for a different number of bytes, is a receipt for something else.
 *
 * ── What is deliberately not forwarded ─────────────────────────────────────
 *
 * The `reason` string from a failed Gate call. It is written for an operator's
 * log, not for a person looking at a file browser, and it is the one field on
 * this path that has no bound on what it might contain.
 */

import { argsTooLarge } from "@claude-bot/capability-kernel";
import path from "node:path";
import { workspaceRelativePathProblem } from "@claude-bot/runner/workspace-files";
import {
  WORKSPACE_FILES_LIMITS,
  WORKSPACE_MEDIA_LIMITS,
  base64ByteLength,
  type WorkspaceFilesRefusalCode,
} from "@claude-bot/workspace-files-contract";
import { isResourceDigest } from "@claude-bot/resource-stream-contract";
import {
  backendRefusal,
  type BackendEntry,
  type BackendBinaryWindow,
  type BackendListing,
  type BackendMutation,
  type BackendResult,
  type BackendRoot,
  type BackendStagedText,
  type BackendTextStage,
  type BackendTextWindow,
  type RunnerCallOutcome,
  type WorkspaceBinding,
  type WorkspaceFilesAuthority,
  type WorkspaceFilesBackend,
  type OwnerFileSessionTarget,
  type BackendResolvedOwnerFile,
} from "./types.js";
import {
  readWorkspaceDirectorySnapshot,
} from "./directory-index.js";

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * The device's refusal vocabulary, mapped onto the contract's.
 *
 * A closed table rather than a pass-through: the device is on the far side of a
 * socket, and a code this build does not know must become "unavailable" rather
 * than a string the UI renders as if it meant something.
 */
const DEVICE_REFUSALS: Record<string, WorkspaceFilesRefusalCode> = {
  not_found: "not_found",
  not_a_directory: "not_a_directory",
  not_a_file: "not_a_file",
  not_text: "not_text",
  too_large: "too_large",
  outside_workspace: "outside_workspace",
  denied: "denied",
  digest_mismatch: "digest_mismatch",
  // A staged upload that was swept, consumed or never begun. Nothing written.
  upload_expired: "unavailable",
};

/**
 * An older Runner ignores `after` and answers page one again. Updated Runners
 * echo the cursor they honoured, so an answer without the echo is refused with
 * the reason rather than shown as the next page.
 */
const PAGING_IGNORED = "设备上的 Runner 版本较旧，不支持分页列目录；升级 Runner 后即可看到全部条目。";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

/**
 * One Gate outcome, turned into the backend's own result vocabulary.
 *
 * `verb` is what a person reads. It is a parameter because "这次读取需要批准" on a
 * save is a sentence that would make somebody approve the wrong thing — and an
 * approval card for a write is exactly the moment the wording matters.
 */
function fromOutcome<T>(
  outcome: RunnerCallOutcome,
  onSuccess: (result: unknown) => BackendResult<T>,
  verb = "读取",
  subject = "这个工作区",
): BackendResult<T> {
  switch (outcome.status) {
    case "succeeded":
      return onSuccess(outcome.result);
    case "approval_required":
      return backendRefusal("approval_required", `这次${verb}需要设备主人先在可信审批栏确认。`);
    case "denied":
      return backendRefusal("denied", `当前授权不允许${verb}${subject}。`);
    default:
      return backendRefusal("unavailable", `设备暂时无法${verb}${subject}。`);
  }
}

/** Answers that are `{status:"refused", code}` rather than a payload. */
function deviceRefusal<T>(row: Record<string, unknown>): BackendResult<T> | null {
  if (row.status !== "refused") return null;
  const code = DEVICE_REFUSALS[String(row.code ?? "")] ?? "unavailable";
  return backendRefusal(code, refusalText(code));
}

function refusalText(code: WorkspaceFilesRefusalCode): string {
  switch (code) {
    case "not_found":
      return "这个文件或目录已经不在了。";
    case "not_a_directory":
      return "这不是一个目录。";
    case "not_a_file":
      return "这不是一个普通文件。";
    case "not_text":
      return "这个文件不是 UTF-8 文本，本视图不打开它。";
    case "too_large":
      // Reads have no size cap since 2026-10-20; only a Runner bundle from
      // before that still refuses a large file, so say what fixes it.
      return "设备上的 Runner 版本较旧，仍对大文件设有读取上限；升级 Runner 后即可完整读取。";
    case "outside_workspace":
      return "这个路径指向了工作区之外。";
    case "denied":
      return "设备拒绝了这次操作。";
    case "digest_mismatch":
      return "这个文件已经不是你编辑时的那个版本了，没有写入任何内容。请重新打开后再改一次。";
    default:
      return "设备暂时无法完成这次操作。";
  }
}

export class RunnerWorkspaceFilesBackend implements WorkspaceFilesBackend {
  constructor(
    private readonly authority: WorkspaceFilesAuthority,
    private readonly options: { ownerFiles?: boolean } = {},
  ) {}

  async resolveOwnerFile(target: OwnerFileSessionTarget, href: string): Promise<BackendResult<BackendResolvedOwnerFile>> {
    if (!this.options.ownerFiles) return backendRefusal("denied", "当前访问不允许读取本人文件。");
    const device = (await this.authority.devices()).find((row) => row.device === target.device);
    if (!device) return backendRefusal("denied", "会话所属设备不在当前授权内。");
    const binding: WorkspaceBinding = { device: device.device, deviceLabel: device.label,
      workspaceId: "", workspaceLabel: "/", ownerRoot: true };
    const outcome = await this.authority.call(device.device, "access_owner_files", {
      device: device.device, mode: "resolve", path: href,
      ...(target.workspaceId ? { workspace_id: target.workspaceId } : { source: target.source, id: target.id }),
    });
    const answer = fromOutcome(outcome, (result) => this.ownerStat(result));
    return answer.ok ? { ok: true, value: { binding, entry: answer.value } } : answer;
  }

  async statOwnerFile(binding: WorkspaceBinding, absolutePath: string): Promise<BackendResult<BackendEntry>> {
    if (!this.options.ownerFiles || !binding.ownerRoot) return backendRefusal("denied", "当前访问不允许读取本人文件。");
    const outcome = await this.authority.call(binding.device, "access_owner_files", {
      device: binding.device, mode: "stat", absolute_path: absolutePath,
    });
    return fromOutcome(outcome, (result) => this.ownerStat(result, absolutePath));
  }

  private ownerStat(result: unknown, expected?: string): BackendResult<BackendEntry> {
    const row = record(result);
    if (!row) return backendRefusal("unavailable", "设备返回了无效文件信息。");
    const refusal = deviceRefusal<BackendEntry>(row);
    if (refusal) return refusal;
    const absolute = boundedString(row.absolute_path, 4096);
    if (row.status !== "ok" || row.mode !== "stat" || !absolute || !path.posix.isAbsolute(absolute)
      || path.posix.normalize(absolute) !== absolute || (expected !== undefined && absolute !== expected)
      || (row.kind !== "file" && row.kind !== "directory") || !Number.isSafeInteger(row.size) || Number(row.size) < 0) {
      return backendRefusal("unavailable", "设备返回了无效文件信息。");
    }
    return { ok: true, value: { name: path.posix.basename(absolute), kind: row.kind,
      relativePath: absolute, sizeBytes: Number(row.size) } };
  }

  /**
   * Enumerate every registered workspace on every device this scope may reach.
   *
   * A device that refuses or fails is skipped rather than failing the whole
   * roster: one laptop being asleep is not a reason to hide another's projects.
   * If EVERY device refused, the first refusal is returned, because "no roots"
   * and "you were not allowed to see the roots" are different answers.
   */
  async listRoots(): Promise<BackendResult<readonly BackendRoot[]>> {
    const devices = await this.authority.devices();
    if (devices.length === 0) return { ok: true, value: [] };

    const roots: BackendRoot[] = [];
    let firstRefusal: BackendResult<readonly BackendRoot[]> | null = null;
    for (const device of devices) {
      const outcome = await this.authority.call(device.device, "list_session_workspaces", {
        device: device.device,
      });
      const parsed = fromOutcome<readonly BackendRoot[]>(outcome, (result) => {
        const snapshot = readWorkspaceDirectorySnapshot(result, device.device);
        if (!snapshot) return backendRefusal("unavailable", "设备返回了无法识别的工作区列表。");
        return {
          ok: true,
          value: snapshot.roots.map((root) => ({
            binding: {
              device: device.device,
              deviceLabel: device.label,
              workspaceId: root.workspaceId,
              workspaceLabel: root.label,
            },
          })),
        };
      });
      if (parsed.ok) roots.push(...parsed.value);
      else firstRefusal ??= parsed;
      if (this.options.ownerFiles) {
        roots.push({
          binding: {
            device: device.device,
            deviceLabel: device.label,
            workspaceId: "",
            workspaceLabel: "/",
            ownerRoot: true,
          },
        });
      }
    }
    if (roots.length === 0 && firstRefusal) return firstRefusal;
    return { ok: true, value: roots };
  }

  async listEntries(
    binding: WorkspaceBinding,
    relativePath: string,
    limit: number,
    after?: string,
  ): Promise<BackendResult<BackendListing>> {
    if (binding.ownerRoot) return this.listOwnerEntries(binding, relativePath, limit, after);
    const outcome = await this.authority.call(binding.device, "list_workspace_entries", {
      device: binding.device,
      workspace_id: binding.workspaceId,
      relative_path: relativePath,
      limit,
      ...(after !== undefined ? { after } : {}),
    });
    return fromOutcome<BackendListing>(outcome, (result) => {
      const row = record(result);
      if (!row) return backendRefusal("unavailable", "设备返回了无法识别的目录列表。");
      const refused = deviceRefusal<BackendListing>(row);
      if (refused) return refused;
      if (row.status !== "ok" || !Array.isArray(row.entries) || typeof row.truncated !== "boolean") {
        return backendRefusal("unavailable", "设备返回了无法识别的目录列表。");
      }
      if (row.relative_path !== relativePath || row.workspace_id !== binding.workspaceId) {
        return backendRefusal("unavailable", "设备回答的不是被请求的那个目录。");
      }
      if (after !== undefined && row.after !== after) return backendRefusal("too_large", PAGING_IGNORED);
      if (row.entries.length > WORKSPACE_FILES_LIMITS.maxEntries) {
        return backendRefusal("unavailable", "设备返回的条目数超过了上限。");
      }
      const entries: BackendEntry[] = [];
      for (const raw of row.entries) {
        const entry = this.readEntry(raw, relativePath);
        if (!entry) return backendRefusal("unavailable", "设备返回了无法识别的目录条目。");
        entries.push(entry);
      }
      return { ok: true, value: { entries, truncated: row.truncated } };
    });
  }

  async readText(
    binding: WorkspaceBinding,
    relativePath: string,
    offset: number,
    maxBytes: number,
  ): Promise<BackendResult<BackendTextWindow>> {
    if (binding.ownerRoot) return this.readOwnerText(binding, relativePath, offset, maxBytes);
    const outcome = await this.authority.call(binding.device, "read_workspace_text", {
      device: binding.device,
      workspace_id: binding.workspaceId,
      relative_path: relativePath,
      offset,
      max_bytes: maxBytes,
    });
    return fromOutcome<BackendTextWindow>(outcome, (result) => {
      const row = record(result);
      if (!row) return backendRefusal("unavailable", "设备返回了无法识别的文件内容。");
      const refused = deviceRefusal<BackendTextWindow>(row);
      if (refused) return refused;
      if (row.status !== "ok" || row.encoding !== "utf-8" || typeof row.text !== "string") {
        return backendRefusal("unavailable", "设备返回了无法识别的文件内容。");
      }
      if (row.relative_path !== relativePath || row.workspace_id !== binding.workspaceId) {
        return backendRefusal("unavailable", "设备回答的不是被请求的那个文件。");
      }
      if (!isResourceDigest(row.digest)) return backendRefusal("unavailable", "设备没有给出可识别的内容摘要。");

      const size = row.size;
      const at = row.offset;
      const bytes = row.bytes;
      const eof = row.eof;
      if (
        !Number.isInteger(size)
        || !Number.isInteger(at)
        || !Number.isInteger(bytes)
        || typeof eof !== "boolean"
        || (size as number) < 0
        || (size as number) > WORKSPACE_FILES_LIMITS.maxTextBytes
        || at !== offset
        || (bytes as number) < 0
        // A window may overshoot `max_bytes` by up to three bytes, and only for
        // the reason the device documents: one character wider than the window.
        || (bytes as number) > maxBytes + 3
        || (at as number) + (bytes as number) > (size as number)
        || eof !== ((at as number) + (bytes as number) === (size as number))
      ) {
        return backendRefusal("unavailable", "设备返回的文件窗口自相矛盾。");
      }
      if (Buffer.byteLength(row.text, "utf8") !== bytes) {
        return backendRefusal("unavailable", "设备返回的文件窗口长度与内容不符。");
      }
      if (bytes === 0 && !eof) return backendRefusal("unavailable", "设备返回了一个不会前进的空窗口。");
      if (typeof row.modified_at !== "string" || !ISO_INSTANT.test(row.modified_at)) {
        return backendRefusal("unavailable", "设备返回了无法识别的修改时间。");
      }
      return {
        ok: true,
        value: {
          sizeBytes: size as number,
          digest: row.digest,
          modifiedAt: row.modified_at,
          offset: at as number,
          bytes: bytes as number,
          eof,
          text: row.text,
        },
      };
    });
  }

  readBinary(
    binding: WorkspaceBinding,
    relativePath: string,
    offset: number,
    maxBytes: number,
  ): Promise<BackendResult<BackendBinaryWindow>> {
    return this.readBinaryOperation("read_workspace_binary", binding, relativePath, offset, maxBytes);
  }

  downloadBinary(
    binding: WorkspaceBinding,
    relativePath: string,
    offset: number,
    maxBytes: number,
  ): Promise<BackendResult<BackendBinaryWindow>> {
    return this.readBinaryOperation("download_workspace_file", binding, relativePath, offset, maxBytes);
  }

  private async readBinaryOperation(
    operation: "read_workspace_binary" | "download_workspace_file",
    binding: WorkspaceBinding,
    relativePath: string,
    offset: number,
    maxBytes: number,
  ): Promise<BackendResult<BackendBinaryWindow>> {
    const ownerMode = operation === "download_workspace_file" ? "download" : "binary";
    const owner = binding.ownerRoot;
    const outcome = await this.authority.call(binding.device, owner ? "access_owner_files" : operation, owner ? {
      device: binding.device,
      mode: ownerMode,
      absolute_path: relativePath,
      offset,
      max_bytes: maxBytes,
    } : {
      device: binding.device,
      workspace_id: binding.workspaceId,
      relative_path: relativePath,
      offset,
      max_bytes: maxBytes,
    });
    return fromOutcome<BackendBinaryWindow>(outcome, (result) => {
      const row = record(result);
      if (!row) return backendRefusal("unavailable", "设备返回了无法识别的媒体内容。");
      const refused = deviceRefusal<BackendBinaryWindow>(row);
      if (refused) return refused;
      if (row.status !== "ok" || row.encoding !== "base64" || typeof row.data !== "string") {
        return backendRefusal("unavailable", "设备返回了无法识别的媒体内容。");
      }
      if (owner
        ? row.absolute_path !== relativePath || row.mode !== ownerMode
        : row.relative_path !== relativePath || row.workspace_id !== binding.workspaceId) {
        return backendRefusal("unavailable", "设备回答的不是被请求的那个文件。");
      }
      if (!isResourceDigest(row.digest)) return backendRefusal("unavailable", "设备没有给出可识别的内容摘要。");
      const size = row.size;
      const at = row.offset;
      const bytes = row.bytes;
      const eof = row.eof;
      if (
        !Number.isInteger(size)
        || !Number.isInteger(at)
        || !Number.isInteger(bytes)
        || typeof eof !== "boolean"
        || (size as number) < 0
        || (size as number) > WORKSPACE_MEDIA_LIMITS.maxBytes
        || at !== offset
        || (bytes as number) < 0
        || (bytes as number) > maxBytes
        || (at as number) + (bytes as number) > (size as number)
        || eof !== ((at as number) + (bytes as number) === (size as number))
        || base64ByteLength(row.data) !== bytes
      ) {
        return backendRefusal("unavailable", "设备返回的媒体窗口自相矛盾。");
      }
      if (bytes === 0 && !eof) return backendRefusal("unavailable", "设备返回了一个不会前进的空窗口。");
      if (typeof row.modified_at !== "string" || !ISO_INSTANT.test(row.modified_at)) {
        return backendRefusal("unavailable", "设备返回了无法识别的修改时间。");
      }
      return {
        ok: true,
        value: {
          sizeBytes: size as number,
          digest: row.digest,
          modifiedAt: row.modified_at,
          offset: at as number,
          bytes: bytes as number,
          eof,
          data: row.data,
        },
      };
    }, "读取", owner ? "本人 Runner 文件" : "这个工作区");
  }

  /**
   * Replace one file's whole content in one call, if it still hashes to
   * `expectedDigest`. The receipt is held to `readMutation`'s four equalities.
   */
  async replaceText(
    binding: WorkspaceBinding,
    relativePath: string,
    expectedDigest: string,
    text: string,
  ): Promise<BackendResult<BackendMutation>> {
    const outcome = await this.callWrite(binding, relativePath, { expected_digest: expectedDigest, text });
    if (!("status" in outcome)) return outcome;
    return fromOutcome<BackendMutation>(
      outcome,
      (result) => this.readMutation(result, binding, relativePath, expectedDigest, Buffer.byteLength(text, "utf8")),
      "改写",
    );
  }

  /**
   * `begin` or `append` of a staged replacement. The answer must name the
   * upload we addressed and, for an append, account for exactly the window we
   * sent: the device's size is the offset the next window will claim.
   */
  async stageText(
    binding: WorkspaceBinding,
    relativePath: string,
    step: BackendTextStage,
  ): Promise<BackendResult<BackendStagedText>> {
    const outcome = await this.callWrite(binding, relativePath, step.stage === "begin"
      ? { stage: "begin", upload_id: step.uploadId, expected_digest: step.expectedDigest }
      : { stage: "append", upload_id: step.uploadId, offset: step.offset, text: step.text });
    if (!("status" in outcome)) return outcome;
    return fromOutcome<BackendStagedText>(outcome, (result) => {
      const row = record(result);
      if (!row) return backendRefusal("unavailable", "设备返回了无法识别的分段保存回执。");
      const refused = deviceRefusal<BackendStagedText>(row);
      if (refused) return refused;
      if (row.status !== "ok" || row.stage !== step.stage || row.upload_id !== step.uploadId) {
        return backendRefusal("unavailable", "设备返回了无法识别的分段保存回执。");
      }
      if (!this.answersFor(row, binding, relativePath)) {
        return backendRefusal("unavailable", "设备回答的不是被请求的那个文件。");
      }
      const size = row.size;
      const expected = step.stage === "begin" ? 0 : step.offset + Buffer.byteLength(step.text, "utf8");
      if (!Number.isSafeInteger(size) || size !== expected) {
        return backendRefusal("unavailable", "设备回执里的暂存长度与本次提交的内容不符。");
      }
      return { ok: true, value: { uploadId: step.uploadId, sizeBytes: size as number } };
    }, "改写");
  }

  /** Commit a staged replacement: a receipt held to the same four equalities. */
  async commitStagedText(
    binding: WorkspaceBinding,
    relativePath: string,
    uploadId: string,
    expectedDigest: string,
    sizeBytes: number,
  ): Promise<BackendResult<BackendMutation>> {
    const outcome = await this.callWrite(binding, relativePath, {
      stage: "commit",
      upload_id: uploadId,
      expected_digest: expectedDigest,
      size: sizeBytes,
    });
    if (!("status" in outcome)) return outcome;
    return fromOutcome<BackendMutation>(outcome, (result) => {
      const row = record(result);
      if (row && row.status === "ok" && (row.stage !== "commit" || row.upload_id !== uploadId)) {
        return backendRefusal("unavailable", "设备返回了无法识别的分段保存回执。");
      }
      return this.readMutation(result, binding, relativePath, expectedDigest, sizeBytes);
    }, "改写");
  }

  /**
   * One call of either write operation, addressed to the file a binding names.
   *
   * The Gate caps one call's ENCODED arguments, and a file body is the first
   * argument in this repository large enough to reach that cap. Asking the
   * kernel's own predicate — rather than restating its number — turns what
   * would be a denial ("arguments too large", which reads like a permission
   * problem) into this contract's own `too_large` with a sentence a person can
   * act on. It is the same function, so the two can never disagree. Callers cut
   * text into windows that fit (`workspaceTextWindows`), so this is a backstop.
   */
  private async callWrite(
    binding: WorkspaceBinding,
    relativePath: string,
    fields: Record<string, unknown>,
  ): Promise<RunnerCallOutcome | BackendResult<never>> {
    const owner = binding.ownerRoot === true;
    const args = {
      device: binding.device,
      ...(owner
        ? { absolute_path: relativePath }
        : { workspace_id: binding.workspaceId, relative_path: relativePath }),
      ...fields,
    };
    if (argsTooLarge(args)) {
      return backendRefusal(
        "too_large",
        "这次改写的内容编码后超过了单次调用的上限，设备没有收到任何请求。",
      );
    }
    return await this.authority.call(binding.device, owner ? "replace_owner_text" : "replace_workspace_text", args);
  }

  private answersFor(row: Record<string, unknown>, binding: WorkspaceBinding, relativePath: string): boolean {
    return binding.ownerRoot === true
      ? row.absolute_path === relativePath
      : row.relative_path === relativePath && row.workspace_id === binding.workspaceId;
  }

  /**
   * A committed replacement, held to what this request asked for.
   *
   * The device is the authority on whether the precondition held; this method's
   * job is to make sure the answer it sends back is an answer to THIS request.
   * Four equalities do that, and each is a different way a receipt could be a
   * true statement about the wrong thing:
   *
   *   workspace_id + relative_path   the file we named
   *   previous_digest                the version we based the edit on
   *   size                           the bytes we sent, not somebody else's
   *   digest                         a well-formed digest of the new content
   *
   * The last one is not recomputed here — this process never holds what actually
   * landed on disk. It is the DEVICE's statement, and the fourth equality only
   * checks that it is a statement of the right shape. What makes it trustworthy
   * enough to show a person is that the same device just proved it could read
   * the precondition, and that the next `open_text` will refuse if the two ever
   * disagree.
   */
  private readMutation(
    result: unknown,
    binding: WorkspaceBinding,
    relativePath: string,
    expectedDigest: string,
    sizeBytes: number,
  ): BackendResult<BackendMutation> {
    const row = record(result);
    if (!row) return backendRefusal("unavailable", "设备返回了无法识别的写入回执。");
    const refused = deviceRefusal<BackendMutation>(row);
    if (refused) return refused;
    if (row.status !== "ok" || row.encoding !== "utf-8") {
      return backendRefusal("unavailable", "设备返回了无法识别的写入回执。");
    }
    if (!this.answersFor(row, binding, relativePath)) {
      return backendRefusal("unavailable", "设备回答的不是被请求的那个文件。");
    }
    if (row.previous_digest !== expectedDigest) {
      // A device that swapped a different version than the one this edit was
      // based on has done something nobody asked for. Reporting it as a
      // success would put "已保存" in front of a person for a write whose
      // precondition was somebody else's.
      return backendRefusal("unavailable", "设备回执里的原始版本与本次编辑的基准不一致。");
    }
    if (!isResourceDigest(row.digest)) {
      return backendRefusal("unavailable", "设备没有给出可识别的内容摘要。");
    }
    const size = row.size;
    if (!Number.isInteger(size) || (size as number) !== sizeBytes) {
      return backendRefusal("unavailable", "设备回执里的长度与本次提交的内容不符。");
    }
    if ((size as number) > WORKSPACE_FILES_LIMITS.maxTextBytes) {
      return backendRefusal("unavailable", "设备回执里的长度超过了本契约的上限。");
    }
    if (typeof row.modified_at !== "string" || !ISO_INSTANT.test(row.modified_at)) {
      return backendRefusal("unavailable", "设备返回了无法识别的修改时间。");
    }
    return {
      ok: true,
      value: {
        sizeBytes: size as number,
        digest: row.digest,
        previousDigest: expectedDigest,
        modifiedAt: row.modified_at,
      },
    };
  }

  private async listOwnerEntries(
    binding: WorkspaceBinding,
    absolutePath: string,
    limit: number,
    after?: string,
  ): Promise<BackendResult<BackendListing>> {
    const outcome = await this.authority.call(binding.device, "access_owner_files", {
      device: binding.device,
      mode: "list",
      absolute_path: absolutePath,
      limit,
      ...(after !== undefined ? { after } : {}),
    });
    return fromOutcome<BackendListing>(outcome, (result) => {
      const row = record(result);
      if (!row) return backendRefusal("unavailable", "设备返回了无法识别的目录列表。");
      const refused = deviceRefusal<BackendListing>(row);
      if (refused) return refused;
      if (
        row.status !== "ok"
        || row.mode !== "list"
        || row.absolute_path !== absolutePath
        || !Array.isArray(row.entries)
        || typeof row.truncated !== "boolean"
      ) {
        return backendRefusal("unavailable", "设备回答的不是被请求的那个目录。");
      }
      if (after !== undefined && row.after !== after) return backendRefusal("too_large", PAGING_IGNORED);
      if (row.entries.length > WORKSPACE_FILES_LIMITS.maxEntries) {
        return backendRefusal("unavailable", "设备返回的条目数超过了上限。");
      }
      const entries: BackendEntry[] = [];
      for (const raw of row.entries) {
        const entry = this.readEntry(raw, absolutePath, true);
        if (!entry) return backendRefusal("unavailable", "设备返回了无法识别的目录条目。");
        entries.push(entry);
      }
      return { ok: true, value: { entries, truncated: row.truncated } };
    }, "访问", "本人 Runner 文件");
  }

  private async readOwnerText(
    binding: WorkspaceBinding,
    absolutePath: string,
    offset: number,
    maxBytes: number,
  ): Promise<BackendResult<BackendTextWindow>> {
    const outcome = await this.authority.call(binding.device, "access_owner_files", {
      device: binding.device,
      mode: "text",
      absolute_path: absolutePath,
      offset,
      max_bytes: maxBytes,
    });
    return fromOutcome<BackendTextWindow>(outcome, (result) => {
      const row = record(result);
      if (!row) return backendRefusal("unavailable", "设备返回了无法识别的文件内容。");
      const refused = deviceRefusal<BackendTextWindow>(row);
      if (refused) return refused;
      if (
        row.status !== "ok"
        || row.mode !== "text"
        || row.absolute_path !== absolutePath
        || row.encoding !== "utf-8"
        || typeof row.text !== "string"
      ) {
        return backendRefusal("unavailable", "设备回答的不是被请求的那个文件。");
      }
      if (!isResourceDigest(row.digest)) return backendRefusal("unavailable", "设备没有给出可识别的内容摘要。");
      const size = row.size;
      const at = row.offset;
      const bytes = row.bytes;
      const eof = row.eof;
      if (
        !Number.isInteger(size)
        || !Number.isInteger(at)
        || !Number.isInteger(bytes)
        || typeof eof !== "boolean"
        || (size as number) < 0
        || (size as number) > WORKSPACE_FILES_LIMITS.maxTextBytes
        || at !== offset
        || (bytes as number) < 0
        || (bytes as number) > maxBytes + 3
        || (at as number) + (bytes as number) > (size as number)
        || eof !== ((at as number) + (bytes as number) === (size as number))
        || Buffer.byteLength(row.text, "utf8") !== bytes
        || (bytes === 0 && !eof)
        || typeof row.modified_at !== "string"
        || !ISO_INSTANT.test(row.modified_at)
      ) {
        return backendRefusal("unavailable", "设备返回的文件窗口自相矛盾。");
      }
      return {
        ok: true,
        value: {
          sizeBytes: size as number,
          digest: row.digest,
          modifiedAt: row.modified_at,
          offset: at as number,
          bytes: bytes as number,
          eof,
          text: row.text,
        },
      };
    }, "读取", "本人 Runner 文件");
  }

  private readEntry(raw: unknown, parent: string, absolute = false): BackendEntry | null {
    const row = record(raw);
    if (!row) return null;
    const name = boundedString(row.name, WORKSPACE_FILES_LIMITS.maxLabelLength);
    const kind = row.kind;
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\u0000")) return null;
    if (kind !== "file" && kind !== "directory" && kind !== "other") return null;

    const entry: BackendEntry = { name, kind };
    if (kind !== "other") {
      const expected = absolute
        ? (parent === "/" ? `/${name}` : `${parent}/${name}`)
        : (parent === "" ? name : `${parent}/${name}`);
      if (absolute) {
        if (row.absolute_path !== expected || !expected.startsWith("/")) return null;
      } else if (row.relative_path !== expected || workspaceRelativePathProblem(expected) !== null) {
        return null;
      }
      entry.relativePath = expected;
    } else if (row.relative_path !== undefined || row.absolute_path !== undefined) {
      // A device that offered a way to address a symlink is a device this build
      // does not understand; it is not something to quietly drop the field from.
      return null;
    }
    if (row.size !== undefined) {
      if (!Number.isInteger(row.size) || (row.size as number) < 0) return null;
      entry.sizeBytes = row.size as number;
    }
    if (row.modified_at !== undefined) {
      if (typeof row.modified_at !== "string" || !ISO_INSTANT.test(row.modified_at)) return null;
      entry.modifiedAt = row.modified_at;
    }
    return entry;
  }
}
