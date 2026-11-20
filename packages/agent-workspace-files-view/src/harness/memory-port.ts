/**
 * A second real implementation of `workspace-files/v1`, backed by a fixture.
 *
 * It exists for the same reason the sessions harness does: a claim that these
 * modules depend on a PORT and not on a transport is only checkable if there is
 * a second thing that satisfies the port. This one has no network, no
 * message channel and no trusted side at all — it answers out of an object graph.
 *
 * ── Why it is a harness entry rather than a test helper ─────────────────────
 *
 * Because tests are not the only consumer that needs it: a storybook, a demo App
 * or a second read-only product would all wire it the same way. It is exported
 * from `./harness` rather than from the package root so a production bundle
 * cannot pick it up by reaching for the obvious import.
 *
 * The fixture speaks the CONTRACT's shapes, and every answer this port returns
 * is what a consumer would get from the real one — including `other` entries
 * with no ref, and a `too_large` refusal, because those are exactly the branches
 * a component is most likely to get wrong.
 */

import { createResourceStream } from "@claude-bot/resource-stream-contract";
import {
  WORKSPACE_FILES_CONTRACT,
  WORKSPACE_FILES_LIMITS,
  WORKSPACE_TEXT_CHUNK_PAYLOAD,
  WORKSPACE_TEXT_MEDIA_TYPE,
  compareWorkspaceListPositions,
  readWorkspaceListCursor,
  utf8ByteLength,
  workspaceFilesRefusal,
  type WorkspaceFilesDirectory,
  type WorkspaceFilesPort,
  type WorkspaceFilesRefusalCode,
  type WorkspaceFilesReply,
  type WorkspaceFilesRoots,
  type WorkspaceTextChunk,
  type WorkspaceTextDocument,
  type WorkspaceTextOpen,
} from "@claude-bot/workspace-files-contract";

export interface MemoryWorkspaceFixture {
  roots: WorkspaceFilesRoots;
  /** Directory ref → listing. A ref that is not here answers `unknown_ref`. */
  directories: Readonly<Record<string, WorkspaceFilesDirectory>>;
  /** File ref → header plus the whole text. Chunked on the way out. */
  files: Readonly<Record<string, { document: WorkspaceTextDocument; text: string }>>;
  /** Refs whose read is refused, and how. Checked before `files`. */
  refusals?: Readonly<Record<string, { code: WorkspaceFilesRefusalCode; message: string }>>;
  /** Bytes per chunk, so a test can force a multi-pull read. */
  chunkBytes?: number;
  /**
   * Entries per listing page and roots per roots page, as the contract's
   * windows (`maxEntries` / `maxRoots`) unless narrowed. A listing or roots
   * list that fits one page is answered exactly as written in the fixture.
   */
  pageEntries?: number;
  pageRoots?: number;
}

export interface MemoryWorkspaceFilesPort {
  port: WorkspaceFilesPort;
  /** Every call this port has served, for asserting single-flight and laziness. */
  readonly calls: ReadonlyArray<{ method: string; ref?: string; after?: string }>;
  /** Streams opened and not yet closed. Must be zero once a panel unmounts. */
  readonly openStreams: number;
}

export function createMemoryWorkspaceFilesPort(
  fixture: MemoryWorkspaceFixture,
): MemoryWorkspaceFilesPort {
  const calls: Array<{ method: string; ref?: string; after?: string }> = [];
  let open = 0;
  const chunkBytes = fixture.chunkBytes ?? WORKSPACE_FILES_LIMITS.textChunkBytes;
  const pageEntries = fixture.pageEntries ?? WORKSPACE_FILES_LIMITS.maxEntries;
  const pageRoots = fixture.pageRoots ?? WORKSPACE_FILES_LIMITS.maxRoots;

  const port: WorkspaceFilesPort = {
    contract: WORKSPACE_FILES_CONTRACT,

    async refreshRoots(after?: string): Promise<WorkspaceFilesReply<WorkspaceFilesRoots>> {
      calls.push({ method: "refreshRoots", ...(after !== undefined ? { after } : {}) });
      const all = fixture.roots.roots;
      if (after === undefined && all.length <= pageRoots) return { ok: true, value: fixture.roots };
      const from = after === undefined ? 0 : all.findIndex((root) => root.ref === after) + 1;
      if (after !== undefined && from === 0) return workspaceFilesRefusal("unknown_ref", "这个引用不属于当前视图。");
      const rest = all.slice(from);
      return { ok: true, value: { roots: rest.slice(0, pageRoots), truncated: rest.length > pageRoots } };
    },

    async listDirectory(ref: string, after?: string): Promise<WorkspaceFilesReply<WorkspaceFilesDirectory>> {
      calls.push({ method: "listDirectory", ref, ...(after !== undefined ? { after } : {}) });
      const refusal = ownValue(fixture.refusals, ref);
      if (refusal) return workspaceFilesRefusal(refusal.code, refusal.message);
      const listing = ownValue(fixture.directories, ref);
      if (!listing) return workspaceFilesRefusal("unknown_ref", "这个引用不属于当前视图。");
      if (after === undefined && listing.entries.length <= pageEntries) return { ok: true, value: listing };
      // Paged exactly as the contract states: the total order, then the
      // entries strictly after the cursor.
      const position = after === undefined ? null : readWorkspaceListCursor(after);
      if (after !== undefined && !position) return workspaceFilesRefusal("invalid_request", "这次翻页给出的目录位置无效。");
      const rest = [...listing.entries]
        .sort(compareWorkspaceListPositions)
        .filter((entry) => !position || compareWorkspaceListPositions(entry, position) > 0);
      return {
        ok: true,
        value: { ...listing, entries: rest.slice(0, pageEntries), truncated: rest.length > pageEntries },
      };
    },

    async openText(ref: string): Promise<WorkspaceFilesReply<WorkspaceTextOpen>> {
      calls.push({ method: "openText", ref });
      const refusal = ownValue(fixture.refusals, ref);
      if (refusal) return workspaceFilesRefusal(refusal.code, refusal.message);
      const file = ownValue(fixture.files, ref);
      if (!file) return workspaceFilesRefusal("unknown_ref", "这个引用不属于当前视图。");
      // Cut on UTF-16 units rather than bytes: this is a fixture, and the point
      // is to produce more than one chunk, not to reproduce the device's
      // boundary arithmetic (which the contract package tests already pin).
      const windows: string[] = [];
      for (let at = 0; at < file.text.length; at += Math.max(1, chunkBytes)) {
        windows.push(file.text.slice(at, at + Math.max(1, chunkBytes)));
      }
      let index = 0;
      open += 1;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        open -= 1;
      };
      const stream = createResourceStream<WorkspaceTextChunk>(
        {
          metadata: {
            payload: WORKSPACE_TEXT_CHUNK_PAYLOAD,
            mediaType: WORKSPACE_TEXT_MEDIA_TYPE,
            totalBytes: file.document.sizeBytes,
            digest: file.document.digest,
          },
          async pull() {
            if (index >= windows.length) return { kind: "end" as const };
            const text = windows[index++]!;
            return { kind: "chunk" as const, value: { text }, bytes: utf8ByteLength(text) };
          },
          close: release,
        },
        {
          maxChunkBytes: WORKSPACE_FILES_LIMITS.textChunkBytes,
          maxStreamBytes: WORKSPACE_FILES_LIMITS.maxTextBytes,
        },
      );
      return { ok: true, value: { document: file.document, stream } };
    },
  };

  return {
    port,
    calls,
    get openStreams() {
      return open;
    },
  };
}

function ownValue<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
