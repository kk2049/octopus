import { AgentLoop, type RunLoopRequest } from '../app-agents/loop.js';
import { filterEvent } from '../managed-execution/event-filter.js';
import type { Discussion, DiscussionMessage } from './types.js';

export interface DiscussionModels {
  readonly enabled: boolean;
  filter(room: Discussion, message: DiscussionMessage, recent: readonly DiscussionMessage[], signal: AbortSignal): Promise<{ wake: boolean; reason: string }>;
  run(request: RunLoopRequest): ReturnType<AgentLoop['run']>;
}
export class DiscussionModelClient implements DiscussionModels {
  private readonly loop: AgentLoop;
  constructor(private readonly config: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }) {
    this.loop = new AgentLoop({ ...config, requestTimeoutMs: 120_000, label: 'Discussion secretary' });
  }
  get enabled(): boolean { return this.loop.configured; }
  run(request: RunLoopRequest) { return this.loop.run(request); }
  async filter(room: Discussion, message: DiscussionMessage, recent: readonly DiscussionMessage[], signal: AbortSignal) {
    return filterEvent(this.config, {
      model: room.settings.filter.model, effort: room.settings.filter.effort,
      prompt: room.settings.filter.prompt, signal,
      context: {topic: room.topic, agenda: room.agenda, recent: recent.slice(-8).map(row => ({sender: row.sender, text: row.text.slice(0, 2000)})), message: {sender: message.sender, text: message.text}},
    });
  }
}
