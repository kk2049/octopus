/** Project-scoped composition of the same session controller used by Sessions+. */
import type { RuntimeJson } from '@claude-bot/app-runtime';
import { canonicalJson } from '@claude-bot/app-state';
import type { SessionPlusInstanceBinding } from '../app-core/instance.js';
import { resourceId } from '../sessionhub/core.js';
import type { AppAuthorityBundles } from '../session-resource/bundle.js';
import type { SessionResourcePort, SessionResourceSubscription } from '../session-resource/types.js';
import { isResearchSessionContract } from '../session-resource/research-contract.js';
import { mergeTranscriptTail, runtimeJson } from '../session-resource/projection.js';
import { SESSION_PLUS_OPERATION_ACTIONS, sessionOperationReceipt, type SessionPlusOperationBinding, type SessionPlusOperationAction, type SessionPlusOperationView } from '../session-resource/app-operation-binding.js';
import type { SessionPlusInteractionBinding } from '../session-resource/app-interaction-binding.js';
import type { DeclaredResourcePlane } from './resource-plane.js';

type Dispatch = Parameters<DeclaredResourcePlane['dispatch']>[0];
interface Locator { resource: string; device: string; provider: 'codex' | 'claude' | 'omp'; sessionId: string }
interface SessionState {
  owner: string;
  key: string;
  confirmed: Map<string, Locator>;
  transcripts: Record<string, RuntimeJson>;
  watches: Map<string, SessionResourceSubscription>;
  requests: Map<string, symbol>;
  operations: SessionPlusOperationView[];
  unsubscribe(): void;
}
const object = (value: unknown): Record<string, RuntimeJson> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, RuntimeJson> : {};
const denied = (message: string) => ({ ok: false as const, message });

export class ResearchSessionPlane implements DeclaredResourcePlane {
  private readonly states = new Map<string, SessionState>();
  constructor(private readonly deps: {
    authority: AppAuthorityBundles;
    resources: SessionResourcePort;
    operations: SessionPlusOperationBinding;
    interactions: SessionPlusInteractionBinding;
    devices(owner: string): readonly string[];
  }) {}

  private eligible(binding: SessionPlusInstanceBinding, projection = binding.projection): boolean {
    const root = object(projection);
    return isResearchSessionContract(binding.stableAppId, this.deps.authority.profile.publisher, binding.contractDigest)
      && binding.actorKind === 'user' && root.viewer_role === 'owner' && object(root.project).archived !== true;
  }
  private key(projection: RuntimeJson): string {
    const root = object(projection);
    const visible = Object.entries(object(root.sources)).filter(([, row]) => object(row).kind === 'session' && !object(row).hidden).map(([key]) => key).sort();
    return canonicalJson({ locations: root.source_locations ?? null, visible });
  }
  project(binding: SessionPlusInstanceBinding, durable: RuntimeJson): RuntimeJson {
    const state = this.states.get(binding.id);
    if (state && (!this.eligible(binding, durable) || state.key !== this.key(durable))) this.close(binding.id, 'project_binding_changed');
    const live = this.states.get(binding.id);
    // These fields are exclusively trusted, per-viewer, ephemeral output.
    return { ...object(durable), sessionResources: live ? {
      sessions: [...live.confirmed].map(([key, locator]) => ({ resourceId: key, sessionId: locator.sessionId, deviceId: locator.device, deviceLabel: locator.device, cliKind: locator.provider })),
      transcript: live.transcripts,
    } : { sessions: [], transcript: {} }, operations: live ? runtimeJson(live.operations) : [] };
  }

  private locator(binding: SessionPlusInstanceBinding, sourceKey: string): Locator | null {
    if (!this.eligible(binding)) return null;
    const root = object(binding.projection), source = object(object(root.sources)[sourceKey]);
    if (source.kind !== 'session' || source.hidden === true) return null;
    const map = object(object(object(root.source_locations).sessions)[sourceKey]);
    if (typeof map.device !== 'string' || !this.deps.devices(binding.owner).includes(map.device)
      || !['codex', 'claude', 'omp'].includes(String(map.provider)) || typeof map.session_id !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(map.session_id)) return null;
    const provider = map.provider as Locator['provider'];
    return { resource: resourceId({ owner: binding.owner, device: map.device, cliKind: provider, sessionId: map.session_id }), device: map.device, provider, sessionId: map.session_id };
  }

  private open(input: Dispatch): SessionState {
    const previous = this.states.get(input.binding.id);
    if (previous && previous.key === this.key(input.binding.projection)) return previous;
    if (previous) this.close(input.binding.id, 'project_binding_changed');
    this.deps.authority.open(input.binding.owner, input.binding.id, input.binding.packageDigest, 'user');
    const state: SessionState = { owner: input.binding.owner, key: this.key(input.binding.projection), confirmed: new Map(), transcripts: {}, watches: new Map(), requests: new Map(), operations: [], unsubscribe() {} };
    this.states.set(input.binding.id, state);
    state.unsubscribe = this.deps.operations.subscribe(state.owner, operation => {
      if (!input.current() || this.states.get(input.binding.id) !== state) return;
      const alias = [...state.confirmed].find(([, locator]) => locator.resource === operation.resourceId)?.[0];
      if (!alias) return;
      this.recordOperation(input, state, alias, operation);
    });
    return state;
  }

  private recordOperation(input: Dispatch, state: SessionState, alias: string, operation: SessionPlusOperationView): void {
    // A fork is not silently rebound as the original project agent.
    const { newResourceId: _newResource, ...rest } = operation;
    const projected = { ...rest, resourceId: alias };
    state.operations = [projected, ...state.operations.filter(row => row.id !== operation.id)].slice(0, 100);
    input.operation(runtimeJson(projected));
  }

  private inner(binding: SessionPlusInstanceBinding, state: SessionState): SessionPlusInstanceBinding {
    const transcripts: Record<string, RuntimeJson> = {};
    for (const [alias, locator] of state.confirmed) if (state.transcripts[alias]) transcripts[locator.resource] = state.transcripts[alias]!;
    return { ...binding, projection: { transcript: transcripts, sessions: [] } };
  }

  async dispatch(input: Dispatch) {
    const binding = input.current(), alias = input.params.resource ?? '';
    if (!binding || !input.principal.session || binding.owner !== input.principal.owner) return denied('真实会话操作需要当前本人的网页登录。');
    const locator = this.locator(binding, alias);
    if (!locator) return denied('此历史未连接到本人的 Runner 会话，或项目已归档。请维护项目会话映射。');
    const allowed = input.action === 'open_session' || input.action === 'attach_file' || input.action === 'respond_agent_interaction'
      || SESSION_PLUS_OPERATION_ACTIONS.includes(input.action as SessionPlusOperationAction) && !['start_session', 'fallback_session'].includes(input.action);
    if (!allowed) return denied('此项目没有声明这个会话操作。');
    let state: SessionState;
    try { state = this.open({ ...input, binding }); } catch { return denied('请在权限中心授权自动科研项目台读取、继续会话及上传文件。'); }
    const current = () => {
      const live = input.current();
      return live && this.states.get(binding.id) === state && state.key === this.key(live.projection) && this.locator(live, alias)?.resource === locator.resource ? live : null;
    };
    const params = { ...input.params, resource: locator.resource };
    if (input.action === 'open_session') {
      const request = Symbol(); state.requests.set(alias, request);
      const answer = await this.deps.resources.execute(binding.id, input.action, params, this.inner(binding, state).projection, { isCurrent: () => Boolean(current()) && state.requests.get(alias) === request });
      if (!current() || state.requests.get(alias) !== request) return denied('来源映射或项目连接已变化，请重新读取。');
      if (!answer.ok) return denied(answer.message);
      state.confirmed.set(alias, locator);
      state.transcripts[alias] = object(answer.patch.transcript)[locator.resource] ?? answer.result;
      // Bound the page's transcript watches; instance teardown closes every remaining watch.
      for (const key of Object.keys(state.transcripts).slice(0, -4)) if (key !== alias) {
        delete state.transcripts[key]; state.watches.get(key)?.close(); state.watches.delete(key);
      }
      if (!state.watches.has(alias) && this.deps.resources.watchTranscript) {
        const watch = this.deps.resources.watchTranscript(binding.id, locator.resource, event => {
          if (!current()) { state.watches.get(alias)?.close(); state.watches.delete(alias); return; }
          if (event.type === 'data') state.transcripts[alias] = runtimeJson(mergeTranscriptTail(state.transcripts[alias], event.data));
          else if (event.type === 'error') {
            if (event.terminal) { state.confirmed.delete(alias); state.watches.get(alias)?.close(); state.watches.delete(alias); }
            else state.transcripts[alias] = { ...object(state.transcripts[alias]), liveState: 'reconnecting' };
          }
          input.publish();
        });
        if (watch.ok) state.watches.set(alias, watch.subscription);
      }
      input.publish();
      return { ok: true as const, result: answer.result };
    }
    if (!state.confirmed.has(alias)) return denied('请先成功读取这条真实会话，再发送或上传。');
    if (input.action === 'attach_file') {
      const answer = await this.deps.resources.execute(binding.id, input.action, params, this.inner(binding, state).projection);
      if (!current()) return denied('项目连接或会话映射已变化。');
      return answer.ok ? { ok: true as const, result: answer.result } : denied(answer.message);
    }
    if (input.action === 'respond_agent_interaction') {
      const answer = await this.deps.interactions.submit(this.inner(binding, state), input.principal, params);
      if (!current()) return denied('项目连接或会话映射已变化。');
      if (!answer.ok) return denied(answer.error);
      state.transcripts[alias] = object(object(answer.projection).transcript)[locator.resource] ?? state.transcripts[alias]!;
      input.publish(); return { ok: true as const, result: answer.result };
    }
    const answer = await this.deps.operations.submit(this.inner(binding, state), input.principal, input.action as SessionPlusOperationAction, params);
    if (!current()) return denied('项目连接或会话映射已变化；请查看运行记录，不要自动重发。');
    if (!answer.ok) return denied(answer.error);
    this.recordOperation(input, state, alias, answer.operation);
    return { ok: true as const, result: runtimeJson(sessionOperationReceipt(answer.operation)) };
  }

  close(instanceId: string, reason: string): void {
    const state = this.states.get(instanceId);
    if (!state) return;
    this.states.delete(instanceId);
    state.unsubscribe();
    for (const watch of state.watches.values()) watch.close();
    this.deps.operations.endContexts(state.owner, this.deps.authority.contextIds(instanceId), reason);
    this.deps.authority.destroy(instanceId);
  }
}
