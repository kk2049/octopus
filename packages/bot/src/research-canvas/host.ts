import { join } from "node:path";
import type { CapabilityService } from "@claude-bot/capability-kernel";
import {
  RESEARCH_APP,
  RESEARCH_PUBLISHER,
  type ResourceBinding,
} from "@claude-bot/research-canvas-contract";
import type { Store } from "../store/store.js";
import type { PermissionService } from "../permissions/service.js";
import type { ManagedExecutionSupervisor } from "../managed-execution/supervisor.js";
import type { FeishuOAuthCommandMessage } from "../feishu/oauth-commands.js";
import type { FeishuChatTransport } from "../feishu/chat-transport.js";
import { IntentGrantResolver } from "../session-resource/intent-resolver.js";
import { ResearchGraph } from "./graph.js";
import { ResearchCapabilities } from "./capability.js";
import { ResearchAdapters, type ResearchModelConfig } from "./adapters.js";
import { ResearchResources } from "./resources.js";
import { ResearchCollaboration } from "./collaboration.js";
import { ResearchAutomation } from "./automation.js";
import { ResearchCanvasPlane, RESEARCH_DISCOVERY_TOOLS } from "./plane.js";
import type { ResearchNative } from "./native.js";
import type { RunnerCapabilities } from "../runner/capability.js";
import { ResearchMossRunner, type MossRunnerConfig } from "./moss.js";
import type { MeetingTranscriptionCapabilities } from "../meeting-transcription/capability.js";
import { RESEARCH_MEETING_OPERATIONS } from "./contract.js";
import { ResearchMeetingFlow } from "./meeting-flow.js";
import { ResearchWorkflows } from "./workflows.js";
import { ResearchDiscussionSources } from "./discussion-sources.js";
import { ResearchDiscussions } from "./discussions.js";
import { ResearchEvidenceService } from "./evidence.js";
import { createResearchDocumentWatch } from "./documents-watch.js";
import { ResearchDocuments, type CloudDocumentProvider } from "./documents.js";

export interface ResearchCanvasOptions {
  native?: ResearchNative;
  runner?: RunnerCapabilities;
  meetingTranscription?: MeetingTranscriptionCapabilities;
  moss?: MossRunnerConfig;
  cloudDocuments?: CloudDocumentProvider;
  root: string;
  model: ResearchModelConfig;
  feishu?: FeishuChatTransport;
  subscribeGroups?(
    receive: (message: FeishuOAuthCommandMessage) => void,
  ): () => void;
}
export function createResearchCanvasHost(
  store: Store,
  kernel: CapabilityService,
  permissions: PermissionService,
  supervisor: ManagedExecutionSupervisor,
  options: ResearchCanvasOptions,
) {
  let plane: ResearchCanvasPlane | undefined;
  const changed = (project: string) => plane?.changed(project);
  const graph = new ResearchGraph(store, options.root, undefined, changed),
    grants = new IntentGrantResolver(
      permissions,
      Date.now,
      new Map([[RESEARCH_APP, RESEARCH_PUBLISHER]]),
    );
  const capabilities = new ResearchCapabilities(kernel, graph, grants);
  const allowed = (context: Parameters<ResearchCapabilities["allowed"]>[0], operation: string) =>
    capabilities.allowed(context, operation) && (operation !== "transcribe_audio" || RESEARCH_MEETING_OPERATIONS.every(name => capabilities.allowed(context, name)));
  const moss = options.meetingTranscription && options.moss ? new ResearchMossRunner(options.meetingTranscription, options.moss) : undefined,
    adapters = new ResearchAdapters(
      store,
      options.model,
      options.feishu,
      options.native,
      moss,
    );
  let automation: ResearchAutomation | undefined;
  options.native?.attach(graph, capabilities, changed);
  const resources = new ResearchResources(
    graph,
    join(options.root, "resources"),
    adapters,
    (event) => automation?.emit(event),
    changed,
    (context, binding, operation) => allowed({project: context.project, actor: {kind: 'human', owner: binding.owner}}, operation),
  );
  const collaboration = new ResearchCollaboration(
    graph,
    join(options.root, "documents"),
    changed,
  );
  automation = new ResearchAutomation(
    graph,
    resources,
    supervisor,
    {
      authorized: (context, operation = "run_agent") => allowed(context, operation),
      open: (binding) => adapters.open(binding),
      filter: (binding, subscription, event, signal) =>
        adapters.filter(binding, subscription, event, signal),
      tools: RESEARCH_DISCOVERY_TOOLS,
      invoke: (context, name, args) => plane!.invokeTool(context, name, args),
    },
    changed,
    Date.now,
    options.native,
  );
  const workflows = new ResearchWorkflows(graph, automation, resources, changed);
  const sources = new ResearchDiscussionSources(graph, resources, changed,
    (context, input) => workflows.prepareCandidates(context, input),
    allowed);
  const meeting = new ResearchMeetingFlow(graph, resources, sources, automation, allowed,
    owner => moss?.readiness(owner) ?? { available: false, status: "尚未配置会议转写 Runner", backend: "MOSS-Transcribe-Diarize" }, options.native);
  const discussions = new ResearchDiscussions(graph, resources, sources, changed,
    (context, operation) => capabilities.allowed(context, operation));
  const evidence = new ResearchEvidenceService(graph, changed);
  const documents = new ResearchDocuments(graph, options.cloudDocuments, {
    read: (context, node) => plane!.readPaperLocal(context, node),
    write: (context, node, value, expected, request, current) => plane!.writePaperLocal(context, node, value, expected, request, current),
  }, (context, operation) => capabilities.allowed(context, operation), changed);
  plane = new ResearchCanvasPlane(
    graph,
    collaboration,
    resources,
    automation,
    capabilities,
    options.native,
    { workflows, sources, discussions, evidence, documents, meeting },
  );
  const documentWatch = createResearchDocumentWatch(graph, documents, workflows, changed);
  const detach = options.subscribeGroups?.((message) => {
    if (!message.messageId || message.senderType !== "user") return;
    // Registry enumeration is trusted event routing, never a caller-selected chat.
    for (const project of graph.repo.projects())
      for (const binding of graph.records<ResourceBinding>(
        project,
        "bindings",
      )) {
        if (
          binding.kind !== "group" ||
          binding.archived ||
          binding.resource !== message.chatId
        )
          continue;
        discussions.event(project, binding.node);
        automation!.emit({
          id: `feishu:${message.messageId}`,
          project,
          source: binding.node,
          type: "group.message",
          version: 1,
          at: new Date().toISOString(),
          trigger: `feishu:${message.openId}`,
          root: `feishu:${message.messageId}`,
          chain: [],
          payload: {
            sender: message.openId,
            senderType: message.senderType,
            text: message.text,
            mentions: message.mentions ?? [],
          },
        });
      }
  });
  return {
    plane,
    capabilities,
    native: options.native,
    tools: RESEARCH_DISCOVERY_TOOLS.map((tool) => ({
      name: `research_${tool.name}`,
      description: tool.description,
      inputSchema: tool.parameters,
    })),
    close: () => {
      detach?.();
      documentWatch.close();
      discussions.close();
      meeting.close();
      sources.close();
      workflows.close();
      automation?.close();
      collaboration.close();
      graph.close();
      options.native?.close();
    },
  };
}
