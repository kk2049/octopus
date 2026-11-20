import type { AddonLogin, AgentApi, AgentOperation, BoardReply, CardFrameReply, DocShareAction, DocShareRevealRequest, DocShareRights, DocShareSelfRequest, DocShareSelfServe, FileMeta, FileReply, LaunchForm, LaunchOptions, LaunchStatus, MessageOrigin, OlderRows, PlacedCard, SessionChoice, ShareResult, SpeakersInfo, WorkspaceInfo } from './protocol';
import {
  AgentApiError, FILE_META_HEADER, readAssistantList, readAssistantPinned, readAssistantSettings, readAssistantStarted, readAssistantStatus, readAssistantTargets, readAssistantView,
  readDocShareActionReply, readDocShareInviteReply, readDocSharePanel, readDocShareRevealReply, readDocShareSelfReply,
} from './protocol';

/**
 * Signing in cannot work for this reader: the host has no Feishu login to give
 * (its one-time code rejects), or the bridge refuses the code (401) or the
 * reader's tenant (403). A network failure or a cancelled login is not that.
 */
const cannotSignIn = (error: unknown) => !(error instanceof AgentApiError) || error.status === 401 || error.status === 403;

/**
 * Bridge client. The login token lives only in this frame's memory and is sent
 * as a bearer header, never a cookie or URL. When the bridge says the login
 * ended (401) the client fetches a fresh one-time Feishu code and repeats the
 * call once: the bridge decides 401 before running a handler, and `send`/`stop`
 * carry a durable request id, so the repeat can never start a second turn.
 *
 * A share card's reader may also call without a login (`share-panel`,
 * `share-self`, and a terminate): signed in when they can be, else without a
 * bearer — decided once, so a reader who cannot sign in is not asked again on
 * every read. Everything else, the owner's share controls and every document
 * assistant call included, needs the login.
 */
export class BridgeApi implements AgentApi {
  private token = '';
  private generation = 0;
  private connecting: Promise<AddonLogin> | null = null;
  /** Signing in proved impossible here: calls that allow it go without a bearer from now on. */
  private anonymous = false;

  constructor(
    private readonly origin: string,
    private readonly loginCode: () => Promise<string>,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    if (!origin || new URL(origin).origin !== origin || new URL(origin).protocol !== 'https:') throw new Error('尚未配置 Octopus 连接地址');
  }

  private async raw<T>(path: string, data: unknown, token: string, timeout = 20_000): Promise<T> {
    const response = await this.fetcher(`${this.origin}/api/feishu/docs-addon/${path}`, {
      method: data === undefined ? 'GET' : 'POST', credentials: 'omit',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(timeout),
    }).catch(() => { throw new AgentApiError(0, '暂时连不上 Octopus，请检查网络'); });
    const meta = response.ok ? response.headers.get(FILE_META_HEADER) : null;
    if (meta) {
      // A file's bytes are the body; its description rides in one header.
      const info = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(meta.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))) as FileMeta;
      return { ...info, data: new Blob([await response.arrayBuffer()], { type: info.mime }) } as T;
    }
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    if (!response.ok) throw new AgentApiError(response.status, typeof body?.error === 'string' ? body.error.slice(0, 300) : `Octopus 返回错误（${response.status}）`);
    return body as T;
  }

  /** `optional`: the bridge also answers this call without a login, so a reader who cannot sign in makes it without a bearer. */
  private async request<T>(path: string, data?: unknown, timeout?: number, optional = false): Promise<T> {
    if (!this.token && !(optional && this.anonymous)) await this.signIn(optional);
    const token = this.token;
    try { return await this.raw<T>(path, data, token, timeout); }
    catch (error) {
      // Without a login there is none to renew: the bridge's 401 is its answer.
      if (!(error instanceof AgentApiError) || error.status !== 401 || !token) throw error;
      if (this.token === token) this.token = '';
      await this.signIn(optional);
      return this.raw<T>(path, data, this.token, timeout);
    }
  }
  private optional<T>(path: string, data: unknown): Promise<T> { return this.request<T>(path, data, undefined, true); }

  private async signIn(optional: boolean): Promise<void> {
    try { await this.login(); }
    catch (error) { if (!optional || !cannotSignIn(error)) throw error; this.anonymous = true; }
  }

  /** One login at a time; a login that finishes after `disconnect` is logged out again. */
  login(): Promise<AddonLogin> {
    if (this.connecting) return this.connecting;
    const generation = this.generation;
    this.connecting = (async () => {
      const value = await this.raw<AddonLogin>('login', { code: await this.loginCode() }, '');
      if (typeof value?.token !== 'string' || !value.token.startsWith('fda_')) throw new AgentApiError(502, '登录响应不完整');
      if (generation !== this.generation) {
        void this.raw('logout', {}, value.token).catch(() => {});
        throw new AgentApiError(0, '连接已取消');
      }
      this.token = value.token;
      this.anonymous = false;
      return value;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  sessions() { return this.request<{ sessions: SessionChoice[]; notice?: string }>('sessions'); }
  share(input: Parameters<AgentApi['share']>[0]) { return this.request<ShareResult>('share', input); }
  unshare(input: Parameters<AgentApi['unshare']>[0]) { return this.request<{ revoked: number }>('unshare', input); }
  view(share: string, since: string, after: number) { return this.request<CardFrameReply>('view', { share, since, after }); }
  older(share: string, before: number) { return this.request<OlderRows>('older', { share, before }, 45_000); }
  message(share: string, index: number) { return this.request<{ i: number; text: string }>('message', { share, i: index }, 45_000); }
  read(share: string, at: string) { return this.request<{ ok: true }>('read', { share, at }); }
  send(share: string, prompt: string, requestId: string, origin?: MessageOrigin) {
    return this.request<AgentOperation>('send', { share, prompt, requestId, ...(origin ? { doc: origin.doc, docTitle: origin.title } : {}) });
  }
  snapshot(share: string, doc: string) { return this.request<PlacedCard>('snapshot', { share, doc }); }
  fork(share: string, prompt: string, requestId: string, origin?: MessageOrigin) {
    return this.request<PlacedCard>('fork', { share, prompt, requestId, ...(origin ? { doc: origin.doc, docTitle: origin.title } : {}) });
  }
  speakers(share: string) { return this.request<SpeakersInfo>('speakers', { share }); }
  setSpeakers(share: string, members: string[]) { return this.request<SpeakersInfo>('speakers-set', { share, members }); }
  stop(share: string, requestId: string) { return this.request<AgentOperation>('stop', { share, requestId }); }
  operation(id: string) { return this.request<AgentOperation>(`operation?id=${encodeURIComponent(id)}`); }
  launchOptions() { return this.request<LaunchOptions>('launch-options'); }
  launch(form: LaunchForm) { return this.request<{ id: string }>('launch', form, 45_000); }
  launchStatus(id: string) { return this.request<LaunchStatus>(`launch-status?id=${encodeURIComponent(id)}`); }
  workspace(share: string) { return this.request<WorkspaceInfo>('workspace', { share }); }
  grantWorkspace(share: string, workspace: string, members: string[]) { return this.request<WorkspaceInfo>('workspace-grant', { share, workspace, members }); }
  file(share: string, path: string, after?: string) { return this.request<FileReply>('file', { share, path, ...(after ? { after } : {}) }, 60_000); }
  board(board: string, since: string) { return this.request<BoardReply>('board', { board, since }); }
  unboard(board: string) { return this.request<{ revoked: boolean }>('unboard', { board }); }
  sharePanel(anchor: string, hostToken?: string) {
    return this.optional<unknown>('share-panel', { anchor, ...(hostToken ? { host_token: hostToken } : {}) }).then(readDocSharePanel);
  }
  /** Any reader of the card may terminate a key; pausing and resuming are the owner's, signed in. */
  shareAction(anchor: string, shareId: string, action: DocShareAction, hostToken?: string) {
    const body = { anchor, share_id: shareId, action, ...(hostToken ? { host_token: hostToken } : {}) };
    return (action === 'terminate' ? this.optional<unknown>('share-action', body) : this.request<unknown>('share-action', body)).then(readDocShareActionReply);
  }
  /** The reply holds a token: it goes back to the caller and nowhere else. */
  shareReveal(anchor: string, shareId: string) {
    return this.request<unknown>('share-reveal', { anchor, share_id: shareId } satisfies DocShareRevealRequest).then(readDocShareRevealReply);
  }
  /** The reply holds the new key's token: it goes back to the caller and nowhere else. */
  shareSelf(anchor: string, hostToken: string, label: string, rights: DocShareRights) {
    return this.optional<unknown>('share-self', { anchor, host_token: hostToken, label, rights } satisfies DocShareSelfRequest).then(readDocShareSelfReply);
  }
  shareSettings(anchor: string, selfServe: DocShareSelfServe, hostToken?: string) {
    return this.request<unknown>('share-settings', { anchor, self_serve: selfServe, ...(hostToken ? { host_token: hostToken } : {}) }).then(readDocSharePanel);
  }
  /** A `create` reply holds the claim link: it goes back to the caller and nowhere else. */
  shareInvite(anchor: string, op: 'create' | 'revoke') {
    return this.request<unknown>('share-invite', { anchor, op }).then(readDocShareInviteReply);
  }
  assistantTargets() { return this.request<unknown>('assistant-targets', {}).then(readAssistantTargets); }
  /** `rights` null turns the card's assistants off (and ends every live one); otherwise the project is the device's workspace. */
  assistantConfigure(anchor: string, config: Parameters<AgentApi['assistantConfigure']>[1]) {
    const { rights, device, workspace_id } = config;
    return this.request<unknown>('assistant-configure', { anchor, rights, ...(device ? { device } : {}), ...(workspace_id ? { workspace_id } : {}) }).then(readAssistantSettings);
  }
  assistantList(anchor: string) { return this.request<unknown>('assistant-list', { anchor }).then(readAssistantList); }
  /** `requestId` is stable per task: a repeat joins the first start instead of starting a second assistant. */
  assistantStart(anchor: string, hostToken: string, task: string, requestId: string, name: string) {
    return this.request<unknown>('assistant-start', { anchor, host_token: hostToken, task, request_id: requestId, name }, 45_000).then(readAssistantStarted);
  }
  /** Once ready, the reply holds the assistant card's capability: it goes back to the caller and nowhere else. */
  assistantStatus(id: string) { return this.request<unknown>('assistant-status', { id }).then(readAssistantStatus); }
  assistantEnd(id: string) { return this.request<unknown>('assistant-end', { id }).then(readAssistantView); }
  assistantPin(id: string) { return this.request<unknown>('assistant-pin', { id }, 45_000).then(readAssistantPinned); }

  disconnect(): void {
    this.generation++;
    if (this.token) void this.raw('logout', {}, this.token).catch(() => {});
    this.token = '';
  }
}
