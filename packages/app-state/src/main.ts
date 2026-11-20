import { serveChildRpc } from "@claude-bot/child-rpc";
import { AppStateService, AppStateError } from "./service.js";
import type { CommitRequest, JsonValue, ResolveStreamRequest } from "./types.js";

const stateDir = process.argv[2];
if (!stateDir) throw new Error("app-state requires a state directory argument");
const started = Date.now();
const phase = (phase: string) => process.stderr.write(`app-state-startup ${JSON.stringify({ phase, elapsedMs: Date.now() - started })}\n`);
phase("entry");
const service = new AppStateService(stateDir, { onStartupPhase: phase });

serveChildRpc({
  handle(method, params) {
    const row = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "resolveStream": return service.resolveStream(params as ResolveStreamRequest);
      case "commit": return service.commit(params as CommitRequest);
      case "readSince": return service.readSince(String(row.streamId ?? ""), Number(row.after), Number(row.limit));
      case "readCommits": return service.readCommits(String(row.streamId ?? ""), Number(row.after), Number(row.limit));
      case "putSnapshot":
        service.putSnapshot(String(row.streamId ?? ""), Number(row.revision), String(row.projectionDigest ?? ""), row.view as JsonValue);
        return null;
      case "snapshot": return service.snapshot(String(row.streamId ?? ""), String(row.projectionDigest ?? ""));
      case "health": return service.health();
      default: throw new AppStateError(`unknown state RPC method: ${method}`, "unknown_method");
    }
  },
  close: () => service.close(),
  // SQLite is synchronous. Serializing requests at the process edge avoids a
  // misleading concurrency setting while BEGIN IMMEDIATE remains the real
  // cross-process writer coordination.
  maxConcurrent: 1,
});
