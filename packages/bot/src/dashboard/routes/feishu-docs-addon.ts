/**
 * Isolated bearer/CORS surface. Dashboard cookies and administrator tokens confer nothing here.
 *
 * Two surfaces share the prefix. The card's (`METHODS`) answers only the
 * published widget origins, with CORS for exactly those, and a `fda_` login;
 * a card reader may look at a share card, take a key or end one without
 * signing in (`OPEN`), the card's capability in the body being the
 * authority. The claim link's (`CLAIM`) is the two calls the Dashboard's
 * claim page (`/doc-key`) makes: same-origin only, with no CORS at all.
 */
import { Readable } from 'node:stream';
import { FILE_META_HEADER, PROMPT_MAX_BYTES } from '@claude-bot/feishu-docs-addon/protocol';
import type { FeishuDocsAddonService } from '../../feishu/docs-addon.js';
import { DocsAddonError, type DocsAddonIdentity } from '../../feishu/docs-addon-auth.js';
import { mimeOf } from '../../feishu/docs-files.js';
import { bodyOf, panelUrl, replyJson, type PanelRequest, type PanelReply } from '../http.js';

export const DOCS_ADDON_PATH = '/api/feishu/docs-addon/';
/**
 * The largest body a card sends is one session prompt (a message, or a new
 * agent's task with the document's text): PROMPT_MAX_BYTES of text, which JSON
 * escaping (newlines, quotes) can at most double in practice, plus the other
 * fields. Authentication runs in onRequest, before any body is read.
 */
export const DOCS_ADDON_BODY_LIMIT = 2 * PROMPT_MAX_BYTES + 256 * 1024;
/** Card and claim-link capabilities travel only in POST bodies, never in URLs that proxies and logs keep. */
const METHODS: Record<string, string> = {
  login: 'POST', logout: 'POST',
  sessions: 'GET', share: 'POST', unshare: 'POST',
  view: 'POST', older: 'POST', message: 'POST', read: 'POST', send: 'POST', stop: 'POST', operation: 'GET',
  'launch-options': 'GET', launch: 'POST', 'launch-status': 'GET',
  workspace: 'POST', 'workspace-grant': 'POST', file: 'POST',
  board: 'POST', unboard: 'POST',
  snapshot: 'POST', fork: 'POST', speakers: 'POST', 'speakers-set': 'POST',
  'share-panel': 'POST', 'share-action': 'POST', 'share-reveal': 'POST', 'share-self': 'POST', 'share-settings': 'POST', 'share-invite': 'POST',
  // Document assistants: a signed-in reader's own agent, so a bearer always (never `OPEN`).
  'assistant-targets': 'POST', 'assistant-configure': 'POST', 'assistant-list': 'POST', 'assistant-start': 'POST',
  'assistant-status': 'POST', 'assistant-end': 'POST', 'assistant-pin': 'POST',
};
/** Card ops a reader may call with no bearer at all; a bearer that is there must still be valid. */
const OPEN: ReadonlySet<string> = new Set(['share-panel', 'share-action', 'share-self']);
/** The calls of the claim link's page. */
const CLAIM: Record<string, string> = { 'invite-info': 'POST', 'invite-claim': 'POST' };
function token(req: PanelRequest): string { return req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : ''; }
/** No Authorization header at all: a reader by the card alone. */
const anonymous = (op: string, req: PanelRequest) => OPEN.has(op) && req.headers.authorization === undefined;
function refusal(reply: PanelReply, error: unknown): void {
  replyJson(reply, error instanceof DocsAddonError ? error.status : 502, { error: error instanceof DocsAddonError ? error.message : '连接服务暂不可用，请稍后重试' });
}
/** Called in onRequest before Fastify touches the body. */
export function feishuDocsAddonPreGate(service: FeishuDocsAddonService | null, req: PanelRequest, reply: PanelReply): boolean {
  const op = panelUrl(req).pathname.slice(DOCS_ADDON_PATH.length);
  if (service && Object.hasOwn(CLAIM, op)) return claimGate(op, req, reply);
  if (!service || !Object.hasOwn(METHODS, op)) { replyJson(reply, 404, { error: 'not found' }); return false; }
  const origin = req.headers.origin ?? '';
  if (!service.auth.allowsOrigin(origin)) { replyJson(reply, 403, { error: '此卡片来源未获授权' }); return false; }
  reply.header('access-control-allow-origin', origin).header('vary', 'Origin').header('cache-control', 'no-store')
    .header('access-control-expose-headers', FILE_META_HEADER);
  const method = METHODS[op];
  if (req.method === 'OPTIONS') {
    const headers = String(req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map((h) => h.trim()).filter(Boolean);
    if (req.headers['access-control-request-method'] !== method || headers.some((h) => h !== 'authorization' && h !== 'content-type')) {
      replyJson(reply, 403, { error: 'preflight refused' }); return false;
    }
    // A polling card would otherwise pay one preflight per frame.
    reply.header('access-control-allow-methods', method).header('access-control-allow-headers', 'Authorization, Content-Type').header('access-control-max-age', '7200');
    void reply.code(204).send(); return false;
  }
  if (req.method !== method) { replyJson(reply, 405, { error: 'method not allowed' }); return false; }
  if (op !== 'login' && !anonymous(op, req)) {
    try { service.auth.authenticate(token(req), origin); }
    catch (error) { refusal(reply, error); return false; }
  }
  return true;
}
/**
 * The claim link's calls. They must come from the claim page this origin
 * serves: an `Origin` that is this very host over https, as the browser
 * states it. No CORS header is ever sent, so no other site's script may read
 * an answer; and every answer is no-store, as a claim's holds a token.
 */
function claimGate(op: string, req: PanelRequest, reply: PanelReply): boolean {
  void reply.header('cache-control', 'no-store');
  if (req.method !== CLAIM[op]) { replyJson(reply, 405, { error: 'method not allowed' }); return false; }
  const host = req.headers.host;
  if (!host || req.headers.origin !== `https://${host}`) { replyJson(reply, 403, { error: '只接受领取页本身发出的请求' }); return false; }
  return true;
}
export async function handleFeishuDocsAddon(service: FeishuDocsAddonService, req: PanelRequest, reply: PanelReply): Promise<void> {
  try {
    const url = panelUrl(req);
    const op = url.pathname.slice(DOCS_ADDON_PATH.length);
    const body = bodyOf(req);
    const text = (key: string) => typeof body[key] === 'string' ? body[key] as string : '';
    switch (op) {
      // The claim link: its secret, in the body, is the authority (`claimGate` let only the claim page's own calls through).
      case 'invite-info': replyJson(reply, 200, await service.inviteInfo(text('invite'))); return;
      // The answer holds the new key's token, once: it is not logged, and the reply is no-store.
      case 'invite-claim': replyJson(reply, 200, await service.inviteClaim(text('invite'), text('label'), text('rights'))); return;
      case 'login': replyJson(reply, 200, await service.auth.login(text('code'), req.headers.origin!)); return;
    }
    if (anonymous(op, req)) { replyJson(reply, 200, await cardReader(service, op, null, text)); return; }
    const identity = service.auth.authenticate(token(req), req.headers.origin!);
    switch (op) {
      case 'share-panel': case 'share-action': case 'share-self': replyJson(reply, 200, await cardReader(service, op, identity, text)); return;
      case 'logout': service.auth.logout(identity); replyJson(reply, 200, { ok: true }); return;
      case 'sessions': replyJson(reply, 200, await service.sessions(identity)); return;
      case 'share': replyJson(reply, 200, service.share(identity, { resourceId: text('resourceId'), title: text('title'), from: text('from'), docTitle: text('docTitle') })); return;
      case 'unshare': replyJson(reply, 200, service.unshare(identity, { share: text('share'), resourceId: text('resourceId') })); return;
      case 'view': replyJson(reply, 200, await service.view(identity, text('share'), text('since'), typeof body.after === 'number' ? body.after : -1)); return;
      case 'older': replyJson(reply, 200, await service.older(identity, text('share'), typeof body.before === 'number' ? body.before : -1)); return;
      case 'message': replyJson(reply, 200, await service.message(identity, text('share'), typeof body.i === 'number' ? body.i : -1)); return;
      case 'read': replyJson(reply, 200, service.markRead(identity, text('share'), text('at'))); return;
      case 'send': replyJson(reply, 202, await service.send(identity, text('share'), text('prompt'), text('requestId'), { doc: text('doc'), title: text('docTitle') })); return;
      case 'stop': replyJson(reply, 202, await service.stop(identity, text('share'), text('requestId'))); return;
      case 'operation': replyJson(reply, 200, service.operation(identity, url.searchParams.get('id') ?? '')); return;
      case 'launch-options': replyJson(reply, 200, await service.launchOptions(identity)); return;
      case 'launch': replyJson(reply, 202, await service.launch(identity, {
        device: text('device'), directory: text('directory'), provider: text('provider'), model: text('model'), effort: text('effort'),
        task: text('task'), title: text('title'), doc: text('doc'), docTitle: text('docTitle'), docText: text('docText'),
        ...(typeof body.docBytes === 'number' ? { docBytes: body.docBytes } : {}), requestId: text('requestId'),
      })); return;
      case 'launch-status': replyJson(reply, 200, await service.launchStatus(identity, url.searchParams.get('id') ?? '')); return;
      case 'workspace': replyJson(reply, 200, await service.workspace(identity, text('share'))); return;
      case 'workspace-grant': replyJson(reply, 200, await service.grantWorkspace(identity, text('share'), text('workspace'),
        Array.isArray(body.members) ? body.members.filter((m): m is string => typeof m === 'string').slice(0, 64) : [])); return;
      case 'snapshot': replyJson(reply, 200, await service.snapshot(identity, text('share'), text('doc'))); return;
      case 'fork': replyJson(reply, 200, await service.fork(identity, text('share'), text('prompt'), text('requestId'), { doc: text('doc'), title: text('docTitle') })); return;
      case 'speakers': replyJson(reply, 200, service.speakers(identity, text('share'))); return;
      case 'speakers-set': replyJson(reply, 200, service.setSpeakers(identity, text('share'),
        Array.isArray(body.members) ? body.members.filter((m): m is string => typeof m === 'string').slice(0, 64) : [])); return;
      // The answer holds a share's command, once: it is not logged, and the reply is no-store like every add-on reply.
      case 'share-reveal': replyJson(reply, 200, await service.shareReveal(identity, text('anchor'), text('share_id'))); return;
      case 'share-settings': replyJson(reply, 200, await service.shareSettings(identity, text('anchor'), text('self_serve'), text('host_token') || undefined)); return;
      // A new claim link's secret is in this answer only.
      case 'share-invite': replyJson(reply, 200, service.shareInvite(identity, text('anchor'), text('op'))); return;
      // Document assistants. The guest is the login's Feishu identity, never a body field; a task is never logged.
      case 'assistant-targets': replyJson(reply, 200, await service.assistantTargets(identity)); return;
      case 'assistant-configure': replyJson(reply, 200, await service.assistantConfigure(identity, text('anchor'), {
        // JSON null turns the card's assistants off; anything that is not 'read' or 'write' is refused.
        rights: body.rights === null ? null : text('rights'),
        ...(text('device') ? { device: text('device') } : {}), ...(text('workspace_id') ? { workspaceId: text('workspace_id') } : {}),
      })); return;
      case 'assistant-list': replyJson(reply, 200, service.assistantList(identity, text('anchor'))); return;
      case 'assistant-start': replyJson(reply, 202, await service.assistantStart(identity, text('anchor'), text('host_token'), text('task'), text('request_id'), text('name'))); return;
      case 'assistant-status': replyJson(reply, 200, await service.assistantStatus(identity, text('id'))); return;
      case 'assistant-end': replyJson(reply, 200, service.assistantEnd(identity, text('id'))); return;
      case 'assistant-pin': replyJson(reply, 200, await service.assistantPin(identity, text('id'))); return;
      case 'board': replyJson(reply, 200, service.readBoard(identity, text('board'), text('since'))); return;
      case 'unboard': replyJson(reply, 200, service.unboard(identity, text('board'))); return;
      case 'file': {
        const content = await service.file(identity, text('share'), text('path'), text('after') || undefined);
        if (content.kind === 'dir') {
          // `next` continues the listing: the card sends it back as `after`.
          replyJson(reply, 200, { kind: 'dir', workspace: content.workspace.label, path: content.path, entries: content.entries,
            truncated: content.truncated, ...(content.next ? { next: content.next } : {}) });
          return;
        }
        const mime = mimeOf(content.name);
        const meta = { kind: 'file', workspace: content.workspace.label, path: content.path, name: content.name, size: content.size, modifiedAt: content.modifiedAt, mime };
        // Bytes are never rendered by the browser as a document: the card fetches them into a Blob.
        // They stream window by window; a failure midway aborts the response, so a
        // short body never passes for the declared length.
        void reply.code(200).header(FILE_META_HEADER, Buffer.from(JSON.stringify(meta)).toString('base64url'))
          .header('content-disposition', 'attachment').header('x-content-type-options', 'nosniff')
          .header('content-length', String(content.size))
          .type('application/octet-stream').send(Readable.from(content.chunks));
        return;
      }
      default: replyJson(reply, 404, { error: 'not found' });
    }
  } catch (error) { refusal(reply, error); }
}
/** The card ops open to any reader holding the card (`OPEN`); `reader` is null for one who did not sign in. */
function cardReader(service: FeishuDocsAddonService, op: string, reader: DocsAddonIdentity | null, text: (key: string) => string): Promise<unknown> {
  switch (op) {
    case 'share-panel': return service.sharePanel(reader, text('anchor'), text('host_token') || undefined);
    case 'share-action': return service.shareAction(reader, text('anchor'), text('share_id'), text('action'), text('host_token') || undefined);
    // The answer holds the new key's token, once: it is not logged, and the reply is no-store.
    case 'share-self': return service.shareSelf(reader, text('anchor'), text('host_token'), text('label'), text('rights'));
    default: throw new DocsAddonError(404, 'not found');
  }
}
