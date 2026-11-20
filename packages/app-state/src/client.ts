import { ChildRpcClient, type ChildRpcLaunch } from "@claude-bot/child-rpc";
import { AppStateService } from "./service.js";
import type {
  AppStateHealth,
  CommitRequest,
  CommitResult,
  JsonValue,
  ReadCommitsResult,
  ReadResult,
  ResolveStreamRequest,
  SnapshotResult,
  StateClient,
  StreamHead,
} from "./types.js";

export class InProcessStateClient implements StateClient {
  constructor(readonly service: AppStateService) {}
  async resolveStream(request: ResolveStreamRequest): Promise<StreamHead> { return this.service.resolveStream(request); }
  async commit(request: CommitRequest): Promise<CommitResult> { return this.service.commit(request); }
  async readSince(streamId: string, after: number, limit: number): Promise<ReadResult> {
    return this.service.readSince(streamId, after, limit);
  }
  async readCommits(streamId: string, after: number, limit: number): Promise<ReadCommitsResult> {
    return this.service.readCommits(streamId, after, limit);
  }
  async putSnapshot(streamId: string, revision: number, projectionDigest: string, view: JsonValue): Promise<void> {
    this.service.putSnapshot(streamId, revision, projectionDigest, view);
  }
  async snapshot(streamId: string, projectionDigest: string): Promise<SnapshotResult | null> {
    return this.service.snapshot(streamId, projectionDigest);
  }
  async health(): Promise<AppStateHealth> { return this.service.health(); }
  async stop(): Promise<void> { this.service.close(); }
}

export interface StateProcessClientOptions extends Omit<ChildRpcLaunch, "args"> {
  stateDir: string;
}

export class StateProcessClient implements StateClient {
  readonly rpc: ChildRpcClient;
  constructor(options: StateProcessClientOptions) {
    this.rpc = new ChildRpcClient({ ...options, args: [options.stateDir] });
  }
  async start(): Promise<void> { await this.rpc.start(); }
  async stop(): Promise<void> { await this.rpc.stop(); }
  async resolveStream(request: ResolveStreamRequest): Promise<StreamHead> {
    return await this.rpc.request("resolveStream", request) as StreamHead;
  }
  async commit(request: CommitRequest): Promise<CommitResult> {
    return await this.rpc.request("commit", request) as CommitResult;
  }
  async readSince(streamId: string, after: number, limit: number): Promise<ReadResult> {
    return await this.rpc.request("readSince", { streamId, after, limit }) as ReadResult;
  }
  async readCommits(streamId: string, after: number, limit: number): Promise<ReadCommitsResult> {
    return await this.rpc.request("readCommits", { streamId, after, limit }) as ReadCommitsResult;
  }
  async putSnapshot(streamId: string, revision: number, projectionDigest: string, view: JsonValue): Promise<void> {
    await this.rpc.request("putSnapshot", { streamId, revision, projectionDigest, view });
  }
  async snapshot(streamId: string, projectionDigest: string): Promise<SnapshotResult | null> {
    return await this.rpc.request("snapshot", { streamId, projectionDigest }) as SnapshotResult | null;
  }
  async health(): Promise<AppStateHealth> { return await this.rpc.request("health", null) as AppStateHealth; }
}
