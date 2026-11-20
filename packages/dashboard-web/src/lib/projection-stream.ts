/**
 * The trusted host's half of the hosted App projection delta
 * (`../projection-delta.ts`): which header opts a stream into `view-patch`
 * frames, the frame this tab holds that the next patch applies to, and the
 * same frame as the base an act reply may be patched against.
 *
 * It only turns wire frames and replies back into the full projections they
 * would have carried; the page still hands every projection to the same host,
 * revision guard and App as before. A patch that does not fit the frame this
 * tab holds is never guessed at: the caller drops the connection and reconnects,
 * and the new stream opens with a full frame. After a few such resyncs the
 * page stops asking for patches, so even a persistent mismatch costs no more
 * than the full-frame stream it replaced.
 */

import {
  PROJECTION_BASE_HEADER,
  PROJECTION_DELTA_HEADER,
  PROJECTION_DELTA_VERSION,
  PROJECTION_PATCH_EVENT,
  PROJECTION_STREAM_PATTERN,
  applyProjectionPatch,
  readProjectionPatchFrame,
} from "../projection-delta.js";

export interface ProjectionFrame {
  projection: unknown;
  revision: number | undefined;
}

export interface ProjectionAct {
  /** Headers for this act request. */
  headers: Record<string, string>;
  /**
   * The reply as it would have arrived in full: a patched reply gets back its
   * `projection`, or none at all when it cannot be rebuilt exactly (the stream
   * then delivers that state, as for any reply without a projection).
   */
  rebuild(reply: Record<string, unknown>): Record<string, unknown>;
}

export interface ProjectionStream {
  /** Headers for the next stream request. */
  headers(): Record<string, string>;
  /**
   * The full projection carried by one stream event: a `view` frame, or a
   * `view-patch` rebuilt on the previous frame. `undefined` for every other
   * event; `null` for a patch that does not fit, after which the caller must
   * reconnect.
   */
  read(event: string, value: Record<string, unknown>): ProjectionFrame | null | undefined;
  /** Bind one act request to the frame this tab holds right now. */
  act(): ProjectionAct;
}

/** Resyncs after which a page keeps to full frames for the rest of its life. */
const RESYNC_LIMIT = 3;

export function createProjectionStream(): ProjectionStream {
  let base: { stream: string | null; revision: number; projection: unknown } | null = null;
  let resyncs = 0;
  const negotiating = (): boolean => resyncs < RESYNC_LIMIT;
  return {
    headers(): Record<string, string> {
      const headers: Record<string, string> = {};
      if (negotiating()) headers[PROJECTION_DELTA_HEADER] = PROJECTION_DELTA_VERSION;
      return headers;
    },
    read(event, value) {
      if (event === "view") {
        if (!Object.prototype.hasOwnProperty.call(value, "projection")) return undefined;
        const revision = typeof value.revision === "number" ? value.revision : undefined;
        const stream = typeof value.stream === "string" && PROJECTION_STREAM_PATTERN.test(value.stream) ? value.stream : null;
        base = revision === undefined ? null : { stream, revision, projection: value.projection };
        return { projection: value.projection, revision };
      }
      if (event !== PROJECTION_PATCH_EVENT) return undefined;
      const frame = readProjectionPatchFrame(value);
      const applied = frame && base && frame.base === base.revision ? applyProjectionPatch(base.projection, frame.patch) : null;
      if (!frame || !base || !applied?.ok) {
        base = null;
        resyncs += 1;
        return null;
      }
      base = { stream: base.stream, revision: frame.revision, projection: applied.value };
      return { projection: applied.value, revision: frame.revision };
    },
    act(): ProjectionAct {
      // Captured now: the reply is patched against the frame named here even
      // if the stream has moved on (or reconnected) by the time it arrives.
      const held = base?.stream && negotiating()
        ? { id: `${base.stream}.${base.revision}`, projection: base.projection }
        : null;
      return {
        headers: held ? { [PROJECTION_BASE_HEADER]: held.id } : {},
        rebuild(reply) {
          if (!Object.prototype.hasOwnProperty.call(reply, "projection_patch")) return reply;
          const { projection_base: id, projection_patch: patch, ...rest } = reply;
          const applied = held && id === held.id ? applyProjectionPatch(held.projection, patch) : null;
          if (applied?.ok) return { ...rest, projection: applied.value };
          resyncs += 1;
          return rest;
        },
      };
    },
  };
}
