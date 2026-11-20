export type RuntimeJson = string | number | boolean | null | RuntimeJson[] | { [key: string]: RuntimeJson };

export interface RuntimeEvent {
  type: string;
  data: RuntimeJson;
  at: string;
  by: string;
  seq?: number;
}

export interface InvokeRequest {
  backendCodeDigest: string;
  action: string;
  context: Record<string, RuntimeJson>;
  params: Record<string, RuntimeJson>;
}

export interface InvokeResult {
  events: RuntimeEvent[];
  result?: RuntimeJson;
}

export interface ProjectRequest {
  backendCodeDigest: string;
  events: readonly RuntimeEvent[];
  /**
   * Trusted canonical projection checkpoint. When present, Runtime calls the
   * release's explicit `projectIncremental(snapshot, events, context)` export.
   */
  snapshot?: RuntimeJson;
  /**
   * Optional trusted viewing context. It is supplied by the coordinator, never
   * by the View, and lets a shared App declassify a role-appropriate projection
   * without putting identity or ACL logic in the browser bundle.
   */
  context?: Record<string, RuntimeJson>;
}

export interface RuntimeHealth {
  ok: boolean;
  backendCodeDigest: string;
}

export interface AppRuntimeClient {
  invoke(request: InvokeRequest): Promise<InvokeResult>;
  project(request: ProjectRequest): Promise<RuntimeJson>;
  health(): Promise<RuntimeHealth>;
}
