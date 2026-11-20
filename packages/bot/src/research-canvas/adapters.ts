import type {
  Json,
  ResearchEvent,
  ResearchSubscription,
  ResourceBinding,
} from "@claude-bot/research-canvas-contract";
import type { Store } from "../store/store.js";
import { AgentLoop } from "../managed-execution/loop.js";
import { filterEvent } from "../managed-execution/event-filter.js";
import type { FeishuChatTransport } from "../feishu/chat-transport.js";
import type { ResearchResourceAdapters, ResourceChoice } from "./resources.js";
import { text } from "./validation.js";
import type { ResearchNative } from "./native.js";
import type { ResearchMossRunner, SourceProgress, SourceTranscription } from "./moss.js";
import { ResearchSourceSummarizer } from "./source-summary.js";
import type { DiscussionSegment } from "@claude-bot/research-canvas-contract";

export interface ResearchModelConfig {
  baseUrl: string;
  apiKey: string;
  models: readonly string[];
  defaultModel: string;
  filterModel: string;
  transcriptionModel?: string;
  fetchImpl?: typeof fetch;
}
/** Deployment credentials remain here. Nodes retain only a reviewed resource ID. */
export class ResearchAdapters implements ResearchResourceAdapters {
  constructor(
    private readonly store: Pick<Store, "getUser" | "getIdentitiesByUser">,
    private readonly config: ResearchModelConfig,
    private readonly feishu?: FeishuChatTransport,
    readonly native?: ResearchNative,
    private readonly moss?: ResearchMossRunner,
  ) {}
  async list(owner: string): Promise<ResourceChoice[]> {
    if (!this.store.getUser(owner)) return [];
    return [
      ...(this.config.apiKey && this.config.baseUrl
        ? [
            {
              id: "platform-model",
              kind: "agent" as const,
              title: "平台共享模型资源",
              config: {
                model: this.config.defaultModel,
                models: [...this.config.models],
              },
            },
          ]
        : []),
      ...((await this.native?.list(owner)) ?? []),
    ];
  }
  async validate(
    owner: string,
    kind: ResourceBinding["kind"],
    resource: string,
    config: Record<string, Json>,
  ): Promise<void> {
    if (!this.store.getUser(owner)) throw new Error("资源归属账号已失效");
    if (kind === "session" && this.native)
      return this.native.validate(owner, resource, config);
    if (kind === "group") {
      const openId = this.store
        .getIdentitiesByUser(owner)
        .find(
          (row) =>
            row.provider === "feishu" && row.external_id.startsWith("ou_"),
        )?.external_id;
      if (!openId || !this.feishu)
        throw new Error("请先连接飞书账号，并将机器人加入群聊");
      await this.feishu.assertMember(resource, openId);
      return;
    }
    if (
      kind !== "agent" ||
      resource !== "platform-model" ||
      !this.config.apiKey ||
      !this.config.baseUrl
    )
      throw new Error("运行资源不可用");
    if (Object.keys(config).some((key) => !["model", "effort"].includes(key)))
      throw new Error("资源配置包含未知字段");
    const model = text(config.model, "模型", 160);
    if (this.config.models.length && !this.config.models.includes(model))
      throw new Error("所选模型不在平台允许列表");
    if (
      config.effort !== undefined &&
      !["minimal", "low", "medium", "high", "max"].includes(
        String(config.effort),
      )
    )
      throw new Error("推理强度无效");
  }
  async open(
    binding: ResourceBinding,
  ): Promise<{ loop: AgentLoop; model: string; effort?: string }> {
    await this.validate(
      binding.owner,
      binding.kind,
      binding.resource,
      binding.config,
    );
    return {
      loop: new AgentLoop({
        ...this.config,
        requestTimeoutMs: 300_000,
        label: "Research v2",
      }),
      model: String(binding.config.model),
      ...(binding.config.effort
        ? { effort: String(binding.config.effort) }
        : {}),
    };
  }
  async filter(
    binding: ResourceBinding,
    subscription: ResearchSubscription,
    event: ResearchEvent,
    signal: AbortSignal,
  ): Promise<{ wake: boolean; reason: string }> {
    if (!this.config.filterModel) throw new Error("未配置小模型筛选资源");
    if (binding.kind !== "session")
      await this.validate(
        binding.owner,
        binding.kind,
        binding.resource,
        binding.config,
      );
    return filterEvent(this.config, {
      model: this.config.filterModel,
      prompt:
        subscription.filter.instruction ||
        "判断当前群消息是否需要科研 Agent 回应。闲聊和无关消息不回应。",
      context: event.payload,
      signal,
    });
  }
  async read(binding: ResourceBinding, cursor?: string): Promise<unknown> {
    await this.validate(
      binding.owner,
      binding.kind,
      binding.resource,
      binding.config,
    );
    if (binding.kind === "group" && this.feishu)
      return this.feishu.history(binding.resource, cursor, 16000);
    throw new Error("此资源由对应的会话窗口读取");
  }
  async send(
    binding: ResourceBinding,
    message: string,
    request: string,
    current?: () => void,
  ): Promise<string> {
    await this.validate(
      binding.owner,
      binding.kind,
      binding.resource,
      binding.config,
    );
    if (binding.kind !== "group" || !this.feishu)
      throw new Error("飞书群资源不可用");
    current?.();
    return this.feishu.send(binding.resource, message, request.slice(-50));
  }
  async transcribe(binding: ResourceBinding, file: { path: string; name: string; mime: string }, signal: AbortSignal, progress?: SourceProgress, current?: () => void): Promise<SourceTranscription> {
    if (!this.store.getUser(binding.owner) || !this.moss) throw new Error("未配置本人可用的 4090 MOSS 带讲话人转写资源");
    return this.moss.transcribe(binding, file, signal, progress, current);
  }
  async summarize(binding: ResourceBinding, input: { source: string; title: string; segments: DiscussionSegment[] }, signal: AbortSignal) {
    if (!this.store.getUser(binding.owner)) throw new Error("讨论来源归属账号已失效");
    return new ResearchSourceSummarizer(this.config).summarize(binding, input, signal);
  }
  async createGroup(owner: string, input: { title: string; agenda: string; request: string }): Promise<string> {
    if (!this.store.getUser(owner)) throw new Error("资源归属账号已失效");
    const openId = this.store.getIdentitiesByUser(owner).find(row => row.provider === "feishu" && row.external_id.startsWith("ou_"))?.external_id;
    if (!openId || !this.feishu) throw new Error("请先连接飞书账号");
    return this.feishu.create({ requestId: input.request.slice(-50), topic: input.title, agenda: input.agenda,
      ownerOpenId: openId, members: [{ openId, username: owner }] });
  }
}
