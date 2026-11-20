/** Native Sessions+ controller, restricted to a durable project resource binding. */
import type {
  Json,
  ResearchRun,
  ResourceBinding,
  MeetingOptions,
} from "@claude-bot/research-canvas-contract";
import {
  AGENT_PERMISSION_PROFILES,
  type AgentPermissionProfile,
  type TranscriptWindow,
} from "@claude-bot/agent-sessions-contract";
import type { RunnerCapabilities } from "../runner/capability.js";
import type { RunnerSessionProjectionService } from "../runner/session-projection.js";
import type { Store } from "../store/store.js";
import type { PermissionService } from "../permissions/service.js";
import type { SessionLeases } from "../sessionhub/lease.js";
import type {
  SessionOperationCoordinator,
  SessionOperationView,
} from "../sessionhub/operations.js";
import type { AgentInteractionCapabilities } from "../agent-interactions/capability.js";
import { RESPOND_AGENT_INTERACTION } from "../agent-interactions/capability.js";
import { AppAuthorityBundles } from "../session-resource/bundle.js";
import { SessionResourceService } from "../session-resource/service.js";
import type { SessionResourceSubscription } from "../session-resource/types.js";
import {
  SessionResourceOperationExecutor,
  type SessionResourceOperationInput,
} from "../session-resource/operation-executor.js";
import { IntentGrantResolver } from "../session-resource/intent-resolver.js";
import { decodeResourceId, resourceId } from "../sessionhub/core.js";
import type { WorkspaceFilesCapabilities } from "../workspace-files/capability.js";
import { readWorkspaceDirectorySnapshot } from "../workspace-files/directory-index.js";
import { ResearchNativeFiles } from "./native-files.js";
import { ensurePromptWindow } from "./rules.js";
import type { RunnerManagedCompletion } from "@claude-bot/runner/gateway-protocol";
import {
  RESEARCH_CANVAS_CONTRACT,
  RESEARCH_CANVAS_DIGEST,
  RESEARCH_NATIVE_OPERATIONS,
} from "./contract.js";
import type { ResearchGraph, ResearchContext } from "./graph.js";
import type { ResearchCapabilities } from "./capability.js";
import type { ResourceChoice } from "./resources.js";
import { digest, object, text } from "./validation.js";

interface Conversation {
  id: string;
  node: string;
  binding: number;
  session: string;
  operation: string | null;
}
interface Scope {
  context: ResearchContext;
  binding: ResourceBinding;
}
export class ResearchNative {
  readonly authority: AppAuthorityBundles;
  readonly resources: SessionResourceService;
  readonly executor: SessionResourceOperationExecutor;
  readonly files: ResearchNativeFiles;
  private graph?: ResearchGraph;
  private capabilities?: ResearchCapabilities;
  private readonly scopes = new Map<string, Scope>();
  private readonly watches = new Map<
    string,
    { watch: SessionResourceSubscription; fingerprint: string }
  >();
  private changed: (project: string) => void = () => {};
  /** Internal execution credentials select a current run without trusting a model-supplied project ID. */
  contextForExecution(scope: {
    owner: string;
    operationId: string;
    runtimeDevice: string;
    source?: string;
    sessionId?: string;
  }): ResearchContext | null {
    if (!this.graph) return null;
    const matches: ResearchRun[] = [];
    for (const project of this.graph.repo.projects())
      for (const run of this.graph.repo.runs(project, {
        active: true,
        limit: 1000,
      })) {
        if (
          run.status === "queued" ||
          run.binding.kind !== "session" ||
          run.binding.owner !== scope.owner ||
          run.binding.config.device !== scope.runtimeDevice
        )
          continue;
        const operation = this.graph.repo.get<{ operation: string }>(
          project,
          "native-runs",
          run.id,
        )?.operation;
        const launchMatches =
          operation === scope.operationId ||
          `op_${digest([scope.owner, "app:research-v2", run.id])}` ===
            scope.operationId;
        const session = this.session(
          { project, actor: { kind: "agent", owner: scope.owner } },
          run.binding,
          run.conversation,
        );
        const decoded = session ? decodeResourceId(session) : null;
        const sessionMatches =
          decoded &&
          decoded.sessionId === scope.sessionId &&
          decoded.cliKind === scope.source;
        if (!launchMatches && !sessionMatches) continue;
        const context: ResearchContext = {
          project,
          actor: {
            kind: "agent",
            owner: run.binding.owner,
            agent: run.node,
            run: run.id,
            model: run.model,
            trigger: run.trigger,
          },
        };
        if (this.valid({ context, binding: run.binding }, "run_agent"))
          matches.push(run);
      }
    if (matches.length !== 1) return null;
    const run = matches[0];
    return {
      project: run.project,
      actor: {
        kind: "agent",
        owner: run.binding.owner,
        agent: run.node,
        run: run.id,
        model: run.model,
        trigger: run.trigger,
      },
    };
  }
  private readonly detach: () => void;
  constructor(
    private readonly deps: {
      store: Store;
      permissions: PermissionService;
      runner: RunnerCapabilities;
      leases: SessionLeases;
      operations(): SessionOperationCoordinator;
      projection?: RunnerSessionProjectionService;
      interactions?: AgentInteractionCapabilities;
      workspaceFiles?: WorkspaceFilesCapabilities;
    },
  ) {
    const profile = { ...RESEARCH_CANVAS_CONTRACT };
    this.authority = new AppAuthorityBundles({
      runner: deps.runner,
      profile,
      grants: new IntentGrantResolver(
        deps.permissions,
        Date.now,
        new Map([[profile.app, profile.publisher]]),
      ),
      agentAutoAllow: RESEARCH_NATIVE_OPERATIONS,
    });
    this.resources = new SessionResourceService(
      this.authority,
      deps.permissions,
      undefined,
      undefined,
      null,
      null,
      Date.now,
      undefined,
      deps.projection ?? null,
      null,
      (owner, device, source, id) =>
        Boolean(
          deps.store.getSessionPlusSplitSession(owner, device, source, id),
        ),
      (owner, device, source, id) => {
        for (const scope of this.scopes.values()) {
          if (
            scope.binding.owner !== owner ||
            scope.binding.config.device !== device ||
            scope.binding.config.provider !== source ||
            !this.valid(scope, "run_agent")
          )
            continue;
          const session = this.session(
            scope.context,
            scope.binding,
            String(scope.binding.config.conversation),
          );
          if (session && decodeResourceId(session)?.sessionId === id)
            return {
              device,
              workspaceId: String(scope.binding.config.workspace),
            };
        }
        return null;
      },
    );
    this.executor = new SessionResourceOperationExecutor(
      this.authority,
      deps.permissions,
      deps.leases,
      Date.now,
      (principal, input) => {
        const scope = this.scopes.get(input.instanceId);
        if (
          !scope ||
          principal.username !== scope.context.actor.owner ||
          !this.valid(scope, "run_agent")
        )
          return false;
        const config = scope.binding.config;
        if (input.action === "start_session")
          return (
            input.source === config.provider &&
            input.target.kind === "workspace" &&
            input.target.workspace.device === config.device &&
            input.target.workspace.id === config.workspace &&
            input.runtimeDevice === undefined
          );
        const session = this.session(
          scope.context,
          scope.binding,
          String(config.conversation ?? `manual:${scope.binding.node}`),
        );
        return Boolean(
          session &&
            input.session.resourceId === session &&
            input.session.deviceId === config.device &&
            input.session.cliKind === config.provider,
        );
      },
    );
    this.files = new ResearchNativeFiles(
      deps.workspaceFiles,
      deps.permissions,
      (context, binding, operation = "read_project") => this.valid({ context, binding }, operation),
    );
    this.detach = deps.runner.onTargetSetChanged((event) =>
      this.revoke(event.username),
    );
  }
  attach(
    graph: ResearchGraph,
    capabilities: ResearchCapabilities,
    changed: (project: string) => void,
  ): void {
    this.graph = graph;
    this.capabilities = capabilities;
    this.changed = changed;
  }
  close(): void {
    this.detach();
    for (const row of this.watches.values()) row.watch.close();
    this.watches.clear();
    for (const key of this.scopes.keys()) this.authority.destroy(key);
    this.scopes.clear();
  }
  revoke(owner: string): void {
    for (const [key, scope] of this.scopes)
      if (
        scope.binding.owner === owner ||
        scope.context.actor.owner === owner
      ) {
        this.deps
          .operations()
          .endContexts(
            scope.binding.owner,
            this.authority.contextIds(key),
            "project_resource_revoked",
          );
        this.authority.destroy(key);
        this.scopes.delete(key);
      }
  }
  async list(owner: string): Promise<ResourceChoice[]> {
    const choices: ResourceChoice[] = [];
    const key = `rv2-roster:${digest(owner)}`;
    this.authority.open(owner, key, RESEARCH_CANVAS_DIGEST, "user");
    try {
      for (const device of this.deps.runner.listDevices(owner)) {
        const answer = await this.resources.execute(
          key,
          "refresh_workspaces",
          { device: device.device },
          {},
        );
        if (!answer.ok) continue;
        const snapshot = readWorkspaceDirectorySnapshot(
          answer.result,
          device.device,
        );
        for (const workspace of snapshot?.roots ?? [])
          choices.push({
            id: `runner:${device.device}:${workspace.workspaceId}`,
            kind: "session",
            title: `${device.device} · ${workspace.label}`,
            config: {
              device: device.device,
              workspace: workspace.workspaceId,
              label: workspace.label,
              directory: workspace.display ?? "",
              provider: "codex",
              model: "",
              effort: "",
            },
          });
      }
    } finally {
      this.authority.destroy(key);
    }
    return choices;
  }
  /** Public inventory choices only; paths and account credentials stay on the Runner. */
  async meetingSources(owner: string): Promise<MeetingOptions["sources"]> {
    const choices = await this.list(owner);
    const devices = this.deps.runner.listDevices(owner);
    return choices.flatMap(choice => {
      const device = devices.find(item => item.device === choice.config.device);
      if (!device?.online || !device.inventory?.agent_backends.some(backend => backend.kind === "codex" && backend.available)) return [];
      return [{ id: choice.id, title: choice.title,
        accounts: (device.inventory.ticket_options?.codex_accounts ?? []).map(account => ({ id: account.id, label: account.label })),
        models: [], efforts: ["low", "medium", "high", "xhigh", "max"] }];
    });
  }
  /** Dispatch preparers call this after Gate, with a trusted durable operation ID. */
  placementForOperation(
    owner: string,
    operationId: string,
  ): { device: string; workspace: string; run: string } | null {
    if (!this.graph) return null;
    for (const project of this.graph.repo.projects())
      for (const run of this.graph.repo.runs(project, {
        active: true,
        limit: 1000,
      })) {
        if (
          run.binding.kind !== "session" ||
          run.binding.owner !== owner ||
          run.status === "queued" ||
          `op_${digest([owner, "app:research-v2", run.id])}` !== operationId
        )
          continue;
        const context: ResearchContext = {
          project,
          actor: {
            kind: "agent",
            owner,
            agent: run.node,
            run: run.id,
            trigger: run.trigger,
          },
        };
        if (!this.valid({ context, binding: run.binding }, "run_agent"))
          throw new Error("科研执行资源已撤销");
        return {
          device: String(run.binding.config.device),
          workspace: String(run.binding.config.workspace),
          run: run.id,
        };
      }
    return null;
  }
  async validate(
    owner: string,
    resource: string,
    config: Record<string, Json>,
  ): Promise<void> {
    if (
      Object.keys(config).some(
        (key) =>
          ![
            "device",
            "provider",
            "session",
            "workspace",
            "label",
            "directory",
            "model",
            "effort",
            "account",
            "permissionProfile",
          ].includes(key),
      )
    )
      throw new Error("Runner 配置包含未知字段");
    const device = text(config.device, "Runner", 160),
      provider = text(config.provider, "CLI", 32);
    if (!["codex", "claude", "omp"].includes(provider))
      throw new Error("CLI 无效");
    nativePermissionProfile(config);
    const choices = await this.list(owner);
    const choice = choices.find(
      (row) =>
        row.id === resource &&
        row.config.device === device &&
        row.config.workspace === config.workspace,
    );
    if (!choice) throw new Error("请选择资源归属人已登记且授权的工作区");
    // Display data is canonicalized from the same trusted registry response.
    config.label = choice.config.label;
    config.directory = choice.config.directory;
    if (
      config.session &&
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(String(config.session))
    )
      throw new Error("会话 ID 无效");
    if (
      config.model &&
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(String(config.model))
    )
      throw new Error("模型无效");
    if (
      config.effort &&
      !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        String(config.effort),
      )
    )
      throw new Error("推理强度无效");
    if (
      config.account &&
      (provider !== "codex" ||
        !/^(?:@default|[A-Za-z0-9_-]{1,32})$/.test(String(config.account)))
    )
      throw new Error("模型账号无效");
    if (config.session) {
      const key = `rv2-validate:${digest([owner, resource, config])}`;
      this.authority.open(owner, key, RESEARCH_CANVAS_DIGEST, "user");
      try {
        const answer = await this.resources.execute(
          key,
          "open_session",
          {
            resource: this.resource(owner, config, String(config.session)),
            limit: "1",
          },
          {},
        );
        if (!answer.ok) throw new Error(answer.message);
      } finally {
        this.authority.destroy(key);
      }
    }
  }
  private resource(
    owner: string,
    config: ResourceBinding["config"],
    sessionId: string,
  ): string {
    return resourceId({
      owner,
      device: String(config.device),
      cliKind: config.provider as "codex" | "claude" | "omp",
      sessionId,
    });
  }
  private valid(scope: Scope, operation: string): boolean {
    try {
      if (!this.graph || !this.capabilities?.allowed(scope.context, operation))
        return false;
      this.graph.role({
        project: scope.context.project,
        actor: { kind: "human", owner: scope.binding.owner },
      });
      const current = this.graph.repo.get<ResourceBinding>(
        scope.context.project,
        "bindings",
        scope.binding.node,
      );
      return Boolean(
        current &&
          !current.archived &&
          current.version === scope.binding.version &&
          current.owner === scope.binding.owner &&
          Boolean(this.graph.resourceNode(scope.context.project, current.node)),
      );
    } catch {
      return false;
    }
  }
  private scope(
    context: ResearchContext,
    binding: ResourceBinding,
    conversation: string,
    operation: string,
  ): string {
    const scope = {
      context,
      binding: { ...binding, config: { ...binding.config, conversation } },
    };
    if (!this.valid(scope, operation)) throw new Error("项目资源授权已变化");
    const key = `rv2:${digest([context.project, binding.id, binding.version, conversation, context.actor.kind, context.actor.owner])}`;
    this.scopes.set(key, scope);
    if (!this.authority.get(key))
      this.authority.open(
        binding.owner,
        key,
        RESEARCH_CANVAS_DIGEST,
        context.actor.kind === "human" ? "user" : "agent",
      );
    return key;
  }
  private conversation(
    context: ResearchContext,
    binding: ResourceBinding,
    conversation: string,
  ): Conversation | null {
    const row = this.graph!.repo.get<Conversation>(
      context.project,
      "native",
      conversation,
    );
    return row?.binding === binding.version && row.node === binding.node
      ? row
      : null;
  }
  session(
    context: ResearchContext,
    binding: ResourceBinding,
    conversation: string,
  ): string | null {
    const row = this.conversation(context, binding, conversation);
    const id =
      row?.session ||
      (conversation === `manual:${binding.node}`
        ? String(binding.config.session ?? "")
        : "");
    return id ? this.resource(binding.owner, binding.config, id) : null;
  }
  async read(
    context: ResearchContext,
    binding: ResourceBinding,
    conversation: string,
    offset?: string,
  ): Promise<TranscriptWindow | null> {
    const key = this.scope(context, binding, conversation, "read_project"),
      resource = this.session(context, binding, conversation);
    if (!resource) return null;
    const answer = await this.resources.execute(
      key,
      "open_session",
      { resource, limit: "100", ...(offset ? { offset } : {}) },
      {},
    );
    if (!this.valid(this.scopes.get(key)!, "read_project"))
      throw new Error("读取期间项目授权变化");
    if (!answer.ok) throw new Error(answer.message);
    if (!offset && !this.watches.has(key)) {
      const watch = this.resources.watchTranscript(
        key,
        resource,
        (event) => {
          const row = this.watches.get(key);
          if (!row) return;
          if (
            !this.valid(this.scopes.get(key)!, "read_project") ||
            (event.type === "error" && event.terminal)
          ) {
            row.watch.close();
            this.watches.delete(key);
            return;
          }
          const fingerprint = digest(event);
          if (fingerprint !== row.fingerprint) {
            row.fingerprint = fingerprint;
            this.changed(context.project);
          }
        },
        100,
      );
      if (watch.ok) {
        this.watches.set(key, { watch: watch.subscription, fingerprint: "" });
        if (this.watches.size > 32) {
          const oldest = this.watches.keys().next().value!;
          this.watches.get(oldest)!.watch.close();
          this.watches.delete(oldest);
        }
      }
    }
    return answer.result as unknown as TranscriptWindow;
  }
  async submit(
    context: ResearchContext,
    run: ResearchRun,
  ): Promise<SessionOperationView> {
    const binding = run.binding,
      key = this.scope(context, binding, run.conversation, "run_agent");
    const existing = this.graph!.repo.get<{ id: string; operation: string }>(
      run.project,
      "native-runs",
      run.id,
    );
    if (existing) {
      const operation = this.deps
        .operations()
        .get(binding.owner, existing.operation);
      if (operation) return operation;
      throw new Error("会话执行回执不可用，不会重新发送");
    }
    const session = this.session(context, binding, run.conversation),
      config = binding.config;
    const prompt = `科研项目 ${run.project}；当前 Agent 节点 ${run.node}；运行 ${run.id}。优先调用 research_graph_read 获取图 YAML 快照，保留 snapshot，修改后用 research_graph_apply 提交并检查冲突回执。使用 research_ref_describe 发现独立资源的工具；正文直接写文件，坐标用 research_layout_read、research_layout_auto/move 单独调整。工具已绑定当前项目，不接受其他项目选择。可按项目权限直接编辑；移除图成员不停止资源或运行。\n\n${String(this.graph!.resourceNode(run.project, run.node).data.instructions ?? "")}\n\n${run.prompt}`;
    ensurePromptWindow(prompt, "任务、Agent 指令与上下文");
    const model = config.model ? String(config.model) : undefined,
      effort = config.effort ? String(config.effort) : undefined,
      permissionProfile = nativePermissionProfile(config);
    const decoded = session ? decodeResourceId(session)! : null;
    const input: SessionResourceOperationInput = decoded
      ? {
          instanceId: key,
          action: "append_session",
          prompt,
          model,
          effort,
          ...(permissionProfile ? { permissionProfile } : {}),
          session: {
            resourceId: session!,
            deviceId: decoded.device,
            cliKind: decoded.cliKind,
            sessionId: decoded.sessionId,
          },
        }
      : {
          instanceId: key,
          action: "start_session",
          source: config.provider as "codex" | "claude" | "omp",
          prompt,
          model,
          effort,
          ...(permissionProfile ? { permissionProfile } : {}),
          ...(config.account ? { codexAccount: String(config.account) } : {}),
          target: {
            kind: "workspace",
            workspace: {
              device: String(config.device),
              id: String(config.workspace),
              label: String(config.label ?? config.workspace),
              display: String(config.directory ?? ""),
            },
          },
        };
    const result = await this.deps
      .operations()
      .submit(
        "app:research-v2",
        {
          username: context.actor.owner,
          admin: false,
          session: false,
          credential: `research-v2:${context.project}:${context.actor.owner}`,
        },
        input,
        { requestId: run.id },
      );
    if (!result.ok) throw new Error(result.error);
    this.graph!.repo.put(
      run.project,
      "native-runs",
      run.id,
      { id: run.id, operation: result.operation.id },
      0,
      false,
    );
    return result.operation;
  }
  observe(run: ResearchRun, operation: SessionOperationView): void {
    const session =
      operation.input?.sessionId ||
      operation.newSessionId ||
      operation.sessionId;
    if (session)
      this.graph!.repo.put(
        run.project,
        "native",
        run.conversation,
        {
          id: run.conversation,
          node: run.node,
          binding: run.binding.version,
          session,
          operation: operation.id,
        } satisfies Conversation,
        null,
        false,
      );
  }
  completed(
    owner: string,
    device: string,
    completion: RunnerManagedCompletion,
  ): void {
    if (!this.graph) return;
    const key = digest([
      owner,
      device,
      completion.provider,
      completion.turn_id,
    ]);
    for (const project of this.graph.repo.projects()) {
      if (this.graph.repo.get(project, "native-completions", key)) continue;
      if (
        [...this.graph.records<ResourceBinding>(project, "bindings")].some(
          (binding) =>
            binding.kind === "session" &&
            binding.owner === owner &&
            binding.config.device === device,
        )
      ) {
        this.graph.repo.put(
          project,
          "native-completions",
          key,
          { id: key, ...completion },
          null,
          false,
        );
        this.changed(project);
      }
    }
  }
  completion(
    run: ResearchRun,
    operation: SessionOperationView,
  ): RunnerManagedCompletion | null {
    const turn = operation.input?.turnId;
    return turn
      ? this.graph!.repo.get(
          run.project,
          "native-completions",
          digest([
            run.binding.owner,
            run.binding.config.device,
            run.binding.config.provider,
            turn,
          ]),
        )
      : null;
  }
  async stop(
    context: ResearchContext,
    run: ResearchRun,
  ): Promise<SessionOperationView | null> {
    const key = this.scope(context, run.binding, run.conversation, "run_agent"),
      resource = this.session(context, run.binding, run.conversation);
    const decoded = resource ? decodeResourceId(resource) : null;
    if (!decoded) return null;
    const result = await this.deps
      .operations()
      .submit(
        "app:research-v2",
        {
          username: context.actor.owner,
          admin: false,
          session: false,
          credential: `research-v2:${context.project}:${context.actor.owner}`,
        },
        {
          instanceId: key,
          action: "interrupt_session",
          session: {
            resourceId: resource!,
            deviceId: decoded.device,
            cliKind: decoded.cliKind,
            sessionId: decoded.sessionId,
          },
        } satisfies SessionResourceOperationInput,
        { requestId: `stop:${run.id}` },
      );
    if (!result.ok) throw new Error(result.error);
    return result.operation;
  }
  async attachFile(
    context: ResearchContext,
    binding: ResourceBinding,
    params: Record<string, string>,
  ): Promise<unknown> {
    const conversation = `manual:${binding.node}`,
      key = this.scope(context, binding, conversation, "run_agent"),
      resource = this.session(context, binding, conversation);
    if (!resource) throw new Error("请先启动或绑定会话");
    const answer = await this.resources.execute(
      key,
      "attach_file",
      { ...params, resource },
      {},
    );
    if (!answer.ok) throw new Error(answer.message);
    if (!this.valid(this.scopes.get(key)!, "run_agent"))
      throw new Error("项目绑定已变化");
    return answer.result;
  }
  async respond(
    context: ResearchContext,
    binding: ResourceBinding,
    params: Record<string, string>,
  ): Promise<unknown> {
    if (context.actor.kind !== "human")
      throw new Error("Agent 请求须由项目成员回答");
    const conversation = params.conversation || `manual:${binding.node}`,
      key = this.scope(context, binding, conversation, "run_agent");
    const resource = this.session(context, binding, conversation),
      decoded = resource ? decodeResourceId(resource) : null;
    if (!decoded) throw new Error("会话尚未连接");
    const grant = this.deps.interactions?.openProjectHumanResponse(
      binding.owner,
      context.actor.owner,
      context.project,
      decoded.device,
      decoded.cliKind,
      decoded.sessionId,
    );
    if (!grant) throw new Error("Agent 交互资源不可用");
    try {
      if (!this.valid(this.scopes.get(key)!, "run_agent"))
        throw new Error("项目授权已变化");
      const result = await grant.request(RESPOND_AGENT_INTERACTION, {
        device: decoded.device,
        provider: decoded.cliKind,
        session_id: decoded.sessionId,
        interaction_id: params.interaction,
        response_json: params.response,
      });
      if (result.status !== "succeeded")
        throw new Error("Agent 回答未确认，请刷新当前请求");
      this.graph!.repo.put(
        context.project,
        "native-responses",
        digest([binding.node, params.interaction]),
        {
          id: params.interaction,
          node: binding.node,
          actor: this.graph!.provenance(context),
          response: object(JSON.parse(params.response)),
        },
        null,
        false,
      );
      return result.result;
    } finally {
      grant.close();
    }
  }
}

/** Selection belongs to the reviewed resource binding, never to an agent prompt. */
function nativePermissionProfile(
  config: ResourceBinding["config"],
): AgentPermissionProfile | undefined {
  const value = config.permissionProfile;
  if (value === undefined) return undefined;
  if (
    (value !== AGENT_PERMISSION_PROFILES.fullAccess &&
      value !== AGENT_PERMISSION_PROFILES.manual) ||
    (config.provider === "omp" && value === AGENT_PERMISSION_PROFILES.manual)
  )
    throw new Error("Agent 权限档位无效");
  return value;
}
