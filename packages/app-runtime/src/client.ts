import { ChildRpcClient, type ChildRpcLaunch } from "@claude-bot/child-rpc";
import { AppRuntimeService } from "./service.js";
import type {
  AppRuntimeClient,
  InvokeRequest,
  InvokeResult,
  ProjectRequest,
  RuntimeHealth,
  RuntimeJson,
} from "./types.js";

export class InProcessRuntimeClient implements AppRuntimeClient {
  constructor(readonly service: AppRuntimeService) {}
  async invoke(request: InvokeRequest): Promise<InvokeResult> { return await this.service.invoke(request); }
  async project(request: ProjectRequest): Promise<RuntimeJson> { return await this.service.project(request); }
  async health(): Promise<RuntimeHealth> { return await this.service.health(); }
  async stop(): Promise<void> { await this.service.stop(); }
}

export interface RuntimeProcessClientOptions extends Omit<ChildRpcLaunch, "args"> {
  appDir: string;
}

export class RuntimeProcessClient implements AppRuntimeClient {
  readonly rpc: ChildRpcClient;
  constructor(options: RuntimeProcessClientOptions) {
    this.rpc = new ChildRpcClient({ ...options, args: [options.appDir] });
  }
  async start(): Promise<void> { await this.rpc.start(); }
  async stop(): Promise<void> { await this.rpc.stop(); }
  async invoke(request: InvokeRequest): Promise<InvokeResult> {
    return await this.rpc.request("invoke", request) as InvokeResult;
  }
  async project(request: ProjectRequest): Promise<RuntimeJson> {
    return await this.rpc.request("project", request) as RuntimeJson;
  }
  async health(): Promise<RuntimeHealth> { return await this.rpc.request("health", null) as RuntimeHealth; }
}
