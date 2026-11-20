/** Process-local resources for one split-placement managed provider turn. */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentProvider } from "./agent-runtime.js";
import type {
  ManagedRecoveryRemoteHandle,
  ManagedRecoveryScope,
} from "./agent-control-plane.js";
import type { CodexExecRelayCoordinator } from "./codex-exec-relay.js";
import { ScopedMcpProxy } from "./scoped-mcp-proxy.js";
import type { DevelopmentMcpManager } from "./development-mcp.js";

export async function openManagedRemoteExecution(input: {
  provider: AgentProvider;
  cwd: string;
  scope: ManagedRecoveryScope;
  codexExecRelay?: CodexExecRelayCoordinator;
  developmentMcp?: DevelopmentMcpManager;
  gatewaySite?: string;
}): Promise<ManagedRecoveryRemoteHandle> {
  if (input.scope.expiresAt <= Date.now()) throw new Error("split session 执行凭证已过期");
  const proxy = new ScopedMcpProxy(
    new URL(input.scope.endpoint),
    input.scope.token,
    { revokeOnClose: false },
  );
  let releaseDevelopment: (() => void) | undefined;
  let developmentMcpUrl: string | undefined;
  let environment: Awaited<ReturnType<CodexExecRelayCoordinator["open"]>> | null = null;
  try {
    if (input.scope.development) {
      if (!input.developmentMcp || input.scope.development.expiresAt <= Date.now()) throw new Error("开发恢复凭证不可用");
      developmentMcpUrl = await input.developmentMcp.renew(input.gatewaySite, input.scope.development);
      releaseDevelopment = input.developmentMcp.retain(input.gatewaySite, input.scope.development.developmentId);
    }
    const remoteMcpUrl = await proxy.start();
    if (input.provider === "omp") {
      await fs.writeFile(
        path.join(input.cwd, ".mcp.json"),
        JSON.stringify({ mcpServers: { octopus_execution: { url: remoteMcpUrl },
          ...(developmentMcpUrl ? { octopus_devpipe: { url: developmentMcpUrl } } : {}) } }, null, 2),
        { encoding: "utf8", mode: 0o600 },
      );
    }
    if (input.provider === "codex") {
      if (!input.codexExecRelay) throw new Error("Codex split session 需要 exec-server relay");
      environment = await input.codexExecRelay.open({
        executionDevice: input.scope.executionDevice,
        workspaceId: input.scope.workspaceId,
        executionToken: input.scope.token,
        operationId: input.scope.operationId,
      });
    }
    return {
      remoteMcpUrl,
      ...(developmentMcpUrl ? { developmentMcpUrl } : {}),
      ...(environment
        ? {
            codexEnvironment: {
              environmentId: environment.environmentId,
              endpoint: environment.endpoint,
            },
          }
        : {}),
      close: async () => {
        releaseDevelopment?.();
        await Promise.allSettled([
          proxy.close(),
          environment?.close() ?? Promise.resolve(),
        ]);
      },
    };
  } catch (error) {
    releaseDevelopment?.();
    await Promise.allSettled([
      proxy.close(),
      environment?.close() ?? Promise.resolve(),
    ]);
    throw error;
  }
}
