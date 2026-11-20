/**
 * User management types.
 */

export interface User {
  username: string;
  uid: number;
  homeDir: string;
  workspaceDir: string;
  claudeSessionsDir: string;
  oauthDir: string;
  ragDocsDir: string;
  /**
   * Centralized memory on the BOT host: notes that must outlive any single
   * machine ("what lives where", "what we did last week"), so a laptop going
   * offline does not amnesia the assistant. Private per user; reachable only
   * through the machines plugin's jailed memory_* tools and the
   * `user-memory-v1` capability plane.
   */
  memoryDir: string;
  /**
   * User-level skills (`<home>/.claude/skills/<name>/`, `SKILL.md` as the
   * main file). Claude Code sessions running under this HOME discover them
   * natively; the `user-skills-v1` capability plane is the consented,
   * revocable registry door over the same directory.
   */
  skillsDir: string;
  createdAt: Date;
}

export interface UserIdentity {
  provider: string;
  externalId: string;
  label?: string;
}

export interface FeishuOAuthToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
  /**
   * The scope string this grant carries, space-separated, as reported by
   * Feishu (falling back to what was requested at authorisation).
   *
   * Recorded so the Feishu gateway can check an operation's declared scopes
   * BEFORE calling as the user (SEC-03). Optional because tokens issued before
   * this existed have none — and "no record" is treated as "cannot prove",
   * which fails closed and is fixed by running `/auth` again.
   */
  scope?: string;
}

export interface UserManager {
  /** Resolve user by external identity (feishu open_id or CLI token) */
  resolve(provider: string, externalId: string): User | undefined;

  /** Register a new user (create directories + persist) */
  register(username: string, identity: UserIdentity): Promise<User>;

  /** Add an identity binding for an existing user */
  addIdentity(username: string, identity: UserIdentity): Promise<void>;

  /** Remove one owner-scoped binding and its in-memory resolution entry. */
  removeIdentity(username: string, provider: string, externalId: string): boolean;

  /** Get user by username */
  get(username: string): User | undefined;

  /** List all users */
  list(): User[];

  /** Get user's Feishu OAuth token */
  getFeishuToken(username: string): FeishuOAuthToken | undefined;

  /** Save user's Feishu OAuth token */
  saveFeishuToken(username: string, token: FeishuOAuthToken): Promise<void>;

  /** Restore state from database */
  restore(): Promise<void>;
}
