/** A meeting owns its history and tools; it never owns a participant's account. */
export interface DiscussionProfile { model: string; effort: string; prompt: string }
export interface DiscussionSettings {
  filter: DiscussionProfile;
  secretary: DiscussionProfile;
  maxToolTurns: number;
  maxRepliesPerTurn: number;
}
export interface DiscussionsConfig {
  enabled?: boolean;
  /** Explicit deployment ceiling for conveners. Default: lht. */
  owners?: string[];
  filter?: Partial<DiscussionProfile>;
  secretary?: Partial<DiscussionProfile>;
  max_concurrent?: number;
}
export interface DiscussionMember { username: string; openId: string }
export interface Discussion {
  id: string;
  owner: string;
  requestId: string;
  fingerprint: string;
  topic: string;
  agenda: string;
  members: DiscussionMember[];
  chatId: string | null;
  status: 'creating' | 'active' | 'paused' | 'closed' | 'unknown';
  settings: DiscussionSettings;
  revision: number;
  consumedSeq: number;
  memory: string;
  activity: 'idle' | 'filtering' | 'thinking' | 'tool' | 'error';
  activityText: string;
  cardId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface DiscussionMessage {
  seq: number;
  discussion_id: string;
  external_id: string;
  sender: string;
  text: string;
  role: 'human' | 'assistant';
  triage: 'pending' | 'quiet' | 'wake';
  reason: string;
  created_at: string;
}
export interface DiscussionEvent {
  seq: number; discussion_id: string; agent: string; kind: string; text: string; created_at: string;
}
export interface DiscussionOutbox {
  id: string; discussion_id: string; text: string;
  status: 'pending' | 'sending' | 'sent' | 'unknown' | 'cancelled';
  message_id: string | null;
}
export interface DiscussionTransport {
  create(input: { requestId: string; topic: string; agenda: string; ownerOpenId: string; members: readonly DiscussionMember[] }): Promise<string>;
  send(chatId: string, text: string, requestId: string): Promise<string>;
  card(chatId: string, card: Record<string, unknown>, requestId: string, messageId: string | null): Promise<string>;
  /** Bot-visible history only, scoped by the service to this meeting. */
  history(chatId: string, pageToken?: string): Promise<unknown>;
}
