/**
 * The `workspace-files/v1` provider, as the catalog installs it.
 *
 * It is a composition and nothing else: an authority the DEPLOYMENT opened, the
 * existing Runner adapter, and the existing `WorkspaceFilesService`. No
 * permission model, no path handling and no stream state machine is written
 * here — each of those already has exactly one implementation, and this file's
 * whole job is to hold them in the right order and to translate the five wire
 * actions into port calls.
 *
 * The one decision that is deliberately NOT here is "may this scope read
 * anything, and unsupervised?". It arrives as `openGrant`, a callback the
 * composition root supplies, because that question belongs to the consent flow
 * and a provider that answered it would be a second permission model out of the
 * consent flow's reach.
 *
 * ── The order a scope is torn down in ──────────────────────────────────────
 *
 *   1. refs stop resolving and the port refuses      (`service.closeScope`, sync)
 *   2. every stream of this scope is cancelled       (the same call, async)
 *   3. the scope's authority is released             (after 2)
 *
 * Written the other way round — grant first — a cancellation that threw would
 * leave refs that still resolve, and the ports holding them would have been
 * derived from an authority that is already gone. This way the first step alone
 * is enough: from the moment `close()` is entered, nothing new can start.
 *
 * ── What crosses the boundary ─────────────────────────────────────────────
 *
 * Only what `workspace-files/v1` and `resource-stream/v1` declare. A chunk's
 * `bytes` is MEASURED here rather than taken from anywhere, because the consumer
 * re-measures it and compares — two independent measurements of one string is
 * how a transport-level edit becomes a `protocol` termination instead of a
 * silently short file.
 */

import {
  RESOURCE_STREAM_CONTRACT,
  type ResourceStreamRead,
  type ResourceStreamResponseFrame,
} from "@claude-bot/resource-stream-contract";
import { decodeWireParams } from "@claude-bot/typed-port-kit";
import {
  RESOURCE_ACTIONS,
  RESOURCE_OPEN_MEDIA_ACTION,
  RESOURCE_DOWNLOAD_FILE_ACTION,
  RESOURCE_RESOLVE_PATH_ACTION,
  RESOURCE_RESOLVE_FILE_LINK_ACTION,
  WORKSPACE_FILES_CONTRACT,
  WORKSPACE_FILES_CONTRACT_V2,
  WORKSPACE_FILES_CONTRACT_V3,
  WORKSPACE_FILES_CONTRACT_V4,
  WORKSPACE_FILES_DECLARATION,
  WORKSPACE_FILES_LIMITS,
  RESOURCE_PAGE_PARAM,
  WORKSPACE_MEDIA_LIMITS,
  WORKSPACE_FILES_PROPOSAL_ACTIONS,
  WORKSPACE_FILES_PROPOSAL_ACTIONS_V2,
  WORKSPACE_FILES_PROPOSAL_ACTIONS_V3,
  WORKSPACE_FILES_PROPOSAL_ACTIONS_V4,
  readWorkspaceTextChunk,
  readWorkspaceMediaChunk,
  utf8ByteLength,
  base64ByteLength,
} from "@claude-bot/workspace-files-contract";
import type { WorkspaceDirectoryKeys } from "../workspace-files/directory-key.js";
import { RunnerWorkspaceFilesBackend } from "../workspace-files/runner-backend.js";
import type { WorkspaceFilesScopePort, WorkspaceFilesService } from "../workspace-files/service.js";
import type { WorkspaceBinding, WorkspaceFilesAuthority, OwnerFileSessionTarget } from "../workspace-files/types.js";
import { resourceRefusal, type ResourceAnswer, type ResourceProviderDefinition, type ResourceProviderContext } from "./types.js";

/**
 * One scope's authority, as the deployment decided it.
 *
 * `close()` releases whatever the deployment took out to build it — in
 * production a capability Context. The provider calls it LAST, after the refs
 * and the streams are gone; see the teardown order above.
 */
export interface WorkspaceFilesScopeGrant {
  authority: WorkspaceFilesAuthority;
  /** Owner-local absolute-path reads survived the exact permission contract. */
  ownerFiles?: boolean;
  /** Independent owner-local CAS write survived the exact contract/grant intersection. */
  ownerFilesWritable?: boolean;
  /**
   * Whether this scope's capability actually carries the write operation.
   *
   * Supplied by whoever derived the grant, because that is the only place the
   * rights are known. It is a PROJECTION of the grant, never a second decision:
   * `true` grants nothing (the Gate is still asked), and `false` only turns a
   * write into `read_only` — a sentence about the composition — instead of a
   * kernel `denied`, without spending a frame or making an approval card for an
   * edit that could not be applied.
   */
  writable: boolean;
  /**
   * The capability Context this scope is holding, for trusted-side diagnostics
   * and for tests that need to assert two scopes are not the SAME authority.
   *
   * It never crosses the boundary: the provider is trusted code, and nothing on
   * `WorkspaceFilesPort` — or in any projection — mentions a Context.
   */
  readonly contextId: string;
  close(): void;
}

/** Per-scope state. Held by the catalog, never looked inside by it. */
interface WorkspaceFilesScopeState {
  port: WorkspaceFilesScopePort;
  grant: WorkspaceFilesScopeGrant;
}

export interface WorkspaceFilesProviderOptions {
  ownerFileTarget?: (owner: string, sessionRef: string) => OwnerFileSessionTarget | null;
  /** The ref vault, stream broker and projection layer. One per process. */
  service: WorkspaceFilesService;
  /**
   * Open this scope's authority, or return null when it holds none.
   *
   * Supplied by the composition root rather than decided here, and it is the
   * ONLY place "may this instance read files, and unsupervised?" is answered.
   * A provider that decided it would be a second permission model — and it
   * would be one the consent flow cannot see, which is how "read" quietly
   * becomes "read without asking".
   *
   * It receives the scope's full trusted identity, including the exact
   * `permissionContractDigest` this instance was opened under. Resolving the
   * grant against THAT contract rather than against whichever release is active
   * right now is what keeps an already-open instance inside the ask its owner
   * agreed to.
   *
   * Null also covers "this deployment has no backend at all": a host with no
   * Runner still installs a provider that satisfies the contract exactly and
   * refuses every scope, so the App's other surfaces keep working and the file
   * panel says so.
   */
  openGrant: (context: ResourceProviderContext) => WorkspaceFilesScopeGrant | null;
}

export interface WorkspaceFilesProviderV2Options extends WorkspaceFilesProviderOptions {
  /**
   * The process's ONE directory-key minter.
   *
   * Shared with the sessions projection rather than constructed here, because
   * the entire value of the key is that the two projections produce the same
   * one. A second minter would be a second secret and would fail silently: no
   * error, just an absence of joins.
   */
  directoryKeys: WorkspaceDirectoryKeys;
}

/**
 * Build the provider definition this deployment installs.
 *
 * It is a function rather than a value because everything it composes is
 * per-process state that the composition root owns.
 */
export function workspaceFilesProvider(
  options: WorkspaceFilesProviderOptions,
): ResourceProviderDefinition<WorkspaceFilesScopeState> {
  return buildWorkspaceFilesProvider(WORKSPACE_FILES_CONTRACT, options, null);
}

/**
 * The same provider, answering as `workspace-files/v2`.
 *
 * Two registrations of one implementation rather than one registration serving
 * both: the catalog resolves a binding to EXACTLY ONE contract id, and which
 * version a release speaks is a property of the plan it shipped. A provider that
 * decided per call would be deciding it from something the View said.
 *
 * Registering both is what makes the two versions coexist. They share the
 * service — and therefore one ref vault and one stream broker — which is safe
 * because a scope key already includes the binding name, so a v1 ref cannot
 * resolve inside a v2 scope any more than one App's ref can resolve inside
 * another's.
 */
export function workspaceFilesProviderV2(
  options: WorkspaceFilesProviderV2Options,
): ResourceProviderDefinition<WorkspaceFilesScopeState> {
  return buildWorkspaceFilesProvider(WORKSPACE_FILES_CONTRACT_V2, options, options.directoryKeys);
}

export function workspaceFilesProviderV3(
  options: WorkspaceFilesProviderV2Options,
): ResourceProviderDefinition<WorkspaceFilesScopeState> {
  return buildWorkspaceFilesProvider(WORKSPACE_FILES_CONTRACT_V3, options, options.directoryKeys);
}

export function workspaceFilesProviderV4(
  options: WorkspaceFilesProviderV2Options,
): ResourceProviderDefinition<WorkspaceFilesScopeState> {
  return buildWorkspaceFilesProvider(WORKSPACE_FILES_CONTRACT_V4, options, options.directoryKeys);
}

function buildWorkspaceFilesProvider(
  contract: string,
  options: WorkspaceFilesProviderOptions,
  directoryKeys: WorkspaceDirectoryKeys | null,
): ResourceProviderDefinition<WorkspaceFilesScopeState> {
  return {
    contract,
    actions: contract === WORKSPACE_FILES_CONTRACT_V4
      ? WORKSPACE_FILES_PROPOSAL_ACTIONS_V4
      : contract === WORKSPACE_FILES_CONTRACT_V3
        ? WORKSPACE_FILES_PROPOSAL_ACTIONS_V3
        : contract === WORKSPACE_FILES_CONTRACT_V2
          ? WORKSPACE_FILES_PROPOSAL_ACTIONS_V2
          : WORKSPACE_FILES_PROPOSAL_ACTIONS,

    open(context: ResourceProviderContext): WorkspaceFilesScopeState | null {
      // Null is the fail-closed answer: no grant, no device, no backend, or a
      // permission contract this build does not implement. The catalog turns it
      // into `no_authority`.
      const grant = options.openGrant(context);
      if (!grant) return null;
      const port = options.service.open({
        scope: context.scope,
        owner: context.owner,
        backend: new RunnerWorkspaceFilesBackend(grant.authority, { ownerFiles: grant.ownerFiles === true }),
        writable: grant.writable,
        ownerFilesWritable: grant.ownerFilesWritable,
        ...(grant.ownerFiles && options.ownerFileTarget
          ? { ownerFileTarget: (ref: string) => options.ownerFileTarget!(context.owner, ref) } : {}),
        contract,
        // Bound to this scope's identity ONCE, at open, exactly like every other
        // decision on this path. The service is handed a function, not the
        // owner/publisher/app it closes over — so nothing downstream of here can
        // mint a key for somebody else by passing different arguments.
        ...(directoryKeys
          ? {
            directoryKey: (binding: WorkspaceBinding, relativePath: string) => binding.ownerRoot
              ? null
              : directoryKeys.mint({
                  owner: context.owner,
                  publisher: context.publisher,
                  app: context.app,
                  device: binding.device,
                  workspaceId: binding.workspaceId,
                  relativePath,
                }),
          }
          : {}),
      });
      return { port, grant };
    },

    async dispatch(
      state: WorkspaceFilesScopeState,
      action: string,
      params: Readonly<Record<string, string>>,
    ): Promise<ResourceAnswer> {
      switch (action) {
        case RESOURCE_RESOLVE_FILE_LINK_ACTION: {
          const out = await state.port.resolveFileLink({ href: String(params.href ?? ""),
            ...(params.session !== undefined ? { sessionRef: params.session } : {}),
            ...(params.ref !== undefined ? { fileRef: params.ref } : {}) });
          return out.ok ? { ok: true, result: out.value } : resourceRefusal(out.code, out.message);
        }
        case RESOURCE_ACTIONS.refreshRoots: {
          // `after` continues a paged answer; absent is page one, exactly the
          // proposal every installed bundle sends.
          const out = await state.port.refreshRoots(params[RESOURCE_PAGE_PARAM]);
          return out.ok ? { ok: true, result: out.value } : resourceRefusal(out.code, out.message);
        }
        case RESOURCE_ACTIONS.listDirectory: {
          const out = await state.port.listDirectory(String(params.ref ?? ""), params[RESOURCE_PAGE_PARAM]);
          return out.ok ? { ok: true, result: out.value } : resourceRefusal(out.code, out.message);
        }
        case RESOURCE_RESOLVE_PATH_ACTION: {
          // Split is total: an empty or malformed `path` becomes labels the
          // port's own validator refuses with zero backend calls.
          const out = await state.port.resolvePath(
            String(params.ref ?? ""),
            String(params.path ?? "").split("/"),
          );
          return out.ok ? { ok: true, result: out.value } : resourceRefusal(out.code, out.message);
        }
        case RESOURCE_ACTIONS.openText: {
          const out = await state.port.openTextForTransport(String(params.ref ?? ""));
          if (!out.ok) return resourceRefusal(out.code, out.message);
          const open: ResourceStreamResponseFrame = {
            contract: RESOURCE_STREAM_CONTRACT,
            kind: "open",
            handle: out.value.handle,
            metadata: out.value.stream.metadata,
          };
          return { ok: true, result: { document: out.value.document, stream: open } };
        }
        case RESOURCE_OPEN_MEDIA_ACTION: {
          const out = await state.port.openMediaForTransport(String(params.ref ?? ""));
          if (!out.ok) return resourceRefusal(out.code, out.message);
          const open: ResourceStreamResponseFrame = {
            contract: RESOURCE_STREAM_CONTRACT,
            kind: "open",
            handle: out.value.handle,
            metadata: out.value.stream.metadata,
          };
          return { ok: true, result: { document: out.value.document, stream: open } };
        }
        case RESOURCE_DOWNLOAD_FILE_ACTION: {
          const out = await state.port.openDownloadForTransport(String(params.ref ?? ""));
          if (!out.ok) return resourceRefusal(out.code, out.message);
          const open: ResourceStreamResponseFrame = {
            contract: RESOURCE_STREAM_CONTRACT,
            kind: "open",
            handle: out.value.handle,
            metadata: out.value.stream.metadata,
          };
          return { ok: true, result: { document: out.value.document, stream: open } };
        }
        case RESOURCE_ACTIONS.replaceText: {
          // The one action on this provider that changes something. Its
          // parameters arrive as the same flat strings every other action's do,
          // and every one of them is bounded by the port before it can become a
          // proposal on a laptop.
          //
          // A MISSING `text` is refused rather than defaulted, and that is not
          // pedantry: `""` is a perfectly legal edit (empty the file), so
          // `params.text ?? ""` would turn a dropped parameter into a request to
          // erase somebody's file.
          if (params.stage !== undefined) return await dispatchStagedText(state.port, params);
          if (typeof params.text !== "string") {
            return resourceRefusal("invalid_request", "这次改写没有给出新的文件内容。");
          }
          const out = await state.port.replaceText(String(params.ref ?? ""), {
            expectedDigest: String(params.expected_digest ?? ""),
            text: params.text,
          });
          return out.ok ? { ok: true, result: out.value } : resourceRefusal(out.code, out.message);
        }
        case RESOURCE_ACTIONS.streamPull: {
          const handle = String(params.handle ?? "");
          const seq = Number(params.seq);
          if (!Number.isInteger(seq) || seq < 0) {
            return resourceRefusal("invalid_request", "这次读取没有给出合法的分块序号。");
          }
          const read = await state.port.pullStream(handle, seq);
          return { ok: true, result: streamFrame(handle, read) };
        }
        case RESOURCE_ACTIONS.streamClose: {
          const closed = await state.port.closeStream(String(params.handle ?? ""));
          return { ok: true, result: { closed } };
        }
        default:
          // Unreachable: the catalog checks the closed action set before it gets
          // here. Kept because "unreachable" and "silently does something else"
          // are one edit apart in a switch.
          return resourceRefusal("invalid_request", "这个资源不支持被请求的动作。");
      }
    },

    close(state: WorkspaceFilesScopeState, context: ResourceProviderContext): Promise<void> {
      // Step 1 and 2. `closeScope` drops the refs synchronously, so the port has
      // already stopped answering when this returns.
      return options.service
        .closeScope(context.scope)
        .then(() => {
          // Step 3, and only after the streams are released: a Context destroyed
          // first would make an in-flight cancellation's own reads fail for the
          // wrong reason.
          state.grant.close();
        })
        .catch(() => {
          state.grant.close();
        });
    },
  };
}

/**
 * One step of a staged replacement, decoded through the contract's own
 * declaration — the same bounds the View encoded against — and handed to the
 * port method for that step. Each reaches the device as one call of the same
 * write operation.
 */
async function dispatchStagedText(
  port: WorkspaceFilesScopePort,
  params: Readonly<Record<string, string>>,
): Promise<ResourceAnswer> {
  const { binding: _binding, ...fields } = params;
  const decoded = decodeWireParams(WORKSPACE_FILES_DECLARATION.byAction.replace_text, fields);
  if (!decoded.ok) return resourceRefusal("invalid_request", "这次分段保存的参数无效。");
  const value = decoded.value as {
    ref: string;
    stage: "begin" | "append" | "commit";
    expected_digest?: string;
    upload?: string;
    offset?: number;
    size?: number;
    text?: string;
  };
  const out = value.stage === "begin"
    ? await port.beginTextUpload(value.ref, { expectedDigest: value.expected_digest ?? "" })
    : value.stage === "append"
      ? await port.appendTextUpload(value.ref, {
          upload: value.upload ?? "",
          offset: value.offset ?? -1,
          // Refused rather than defaulted, for the reason the one-call path
          // states: an absent body is not an empty one.
          text: value.text as string,
        })
      : await port.commitTextUpload(value.ref, {
          upload: value.upload ?? "",
          expectedDigest: value.expected_digest ?? "",
          sizeBytes: value.size ?? -1,
        });
  return out.ok ? { ok: true, result: out.value } : resourceRefusal(out.code, out.message);
}

/**
 * One broker answer as a `resource-stream/v1` response frame.
 *
 * Text is measured from UTF-8. Media is parsed as strict base64 and its decoded
 * length is measured independently of the broker's byte claim.
 */
function streamFrame(handle: string, read: ResourceStreamRead<unknown>): ResourceStreamResponseFrame {
  if (read.kind === "end") {
    return { contract: RESOURCE_STREAM_CONTRACT, kind: "end", handle, chunks: read.chunks, bytes: read.bytes };
  }
  if (read.kind === "refused") {
    return { contract: RESOURCE_STREAM_CONTRACT, kind: "refused", handle, code: read.code, message: read.message };
  }
  const text = readWorkspaceTextChunk(read.value);
  let value: unknown;
  let bytes: number | null;
  let limit: number;
  if (text.ok) {
    value = text.value;
    bytes = utf8ByteLength(text.value.text);
    limit = WORKSPACE_FILES_LIMITS.textChunkBytes;
  } else {
    const media = readWorkspaceMediaChunk(read.value);
    if (!media.ok) {
      return {
        contract: RESOURCE_STREAM_CONTRACT,
        kind: "refused",
        handle,
        code: "protocol",
        message: "资源块没有通过内容契约校验。",
      };
    }
    value = media.value;
    bytes = base64ByteLength(media.value.data);
    limit = WORKSPACE_MEDIA_LIMITS.chunkBytes;
  }
  if (bytes === null || bytes > limit) {
    return {
      contract: RESOURCE_STREAM_CONTRACT,
      kind: "refused",
      handle,
      code: "too_large",
      message: "资源块超过了单块上限。",
    };
  }
  return {
    contract: RESOURCE_STREAM_CONTRACT,
    kind: "chunk",
    handle,
    seq: read.seq,
    bytes,
    value,
  };
}
