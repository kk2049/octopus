import type { CapabilityService, OperationSpec } from '@claude-bot/capability-kernel';
import { AccountAuthority, SlotGrant } from '../runner/account-authority.js';
import type { DiscussionService } from './service.js';

const S = (maxLength: number, required = false) => ({ type: 'string' as const, maxLength, required });
export const DISCUSSION_OPERATIONS: Record<string, OperationSpec> = {
  discussion_start: { title: '创建议题飞书群并托管秘书', effect: 'execute', args: { request_id: S(128, true), topic: S(200, true), agenda: S(8000), participants: S(1000, true), settings: S(20000) } },
  discussion_list: { title: '列出参与的会议', effect: 'read', args: {} },
  discussion_read: { title: '读取会议历史与 Agent 活动', effect: 'read', args: { discussion_id: S(128, true), after: { type: 'number', min: 0, max: Number.MAX_SAFE_INTEGER, integer: true } } },
  discussion_append: { title: '向会议秘书追加消息', effect: 'execute', args: { discussion_id: S(128, true), request_id: S(128, true), text: S(16000, true) } },
  discussion_configure: { title: '调整会议模型与运行状态', effect: 'modify', args: { discussion_id: S(128, true), revision: { type: 'number', min: 1, max: Number.MAX_SAFE_INTEGER, integer: true, required: true }, settings: S(20000), status: { type: 'string', enum: ['active', 'paused', 'closed'] } } },
};
export const DISCUSSION_OPERATION_IDS = Object.keys(DISCUSSION_OPERATIONS);
const SLOT = 'discussions';

export class DiscussionCapabilities {
  private readonly authority: AccountAuthority<{ owner: string }>;
  constructor(private readonly kernel: CapabilityService, readonly discussions: DiscussionService, userExists: (owner: string) => boolean) {
    this.authority = new AccountAuthority({
      service: kernel, slot: SLOT, objectPrefix: 'discussions-v1', kind: 'discussion-service', operations: DISCUSSION_OPERATIONS,
      bindingFor: owner => discussions.enabled && userExists(owner) ? { owner } : null,
      // Standing automation is an explicit per-operation grant. Human browser
      // calls are derived separately; no MCP caller can assert that identity.
      rootAutoAllow: () => DISCUSSION_OPERATION_IDS,
      policy: input => {
        const a = input.approval;
        if (a && a.objectId === input.object.id && a.operation === input.operation && a.argsHash === input.argsHash && a.contextId === input.context.id && a.slot === input.slot && a.approver === input.object.metadata.owner) return { kind: 'allow' };
        return input.terms.autoAllow.includes(input.operation) ? { kind: 'allow' } : {
        kind: 'approval_required', summary: {
          title: input.spec.title ?? input.operation, target: `${input.object.metadata.owner}/会议`,
          details: [String(input.args.topic ?? input.args.discussion_id ?? '会议列表'), `参会者：${input.args.participants ?? '既有成员'}`, '创建会议会授权秘书持续读取本群消息、按需在本群发言；召集人可暂停或结束。', `参数指纹：${input.argsHash.slice(0, 16)}`],
          allowedApprover: String(input.object.metadata.owner),
        },
        };
      },
      adapter: async (binding, operation, args) => this.execute(binding.owner, operation, args),
    });
  }
  accountOperations(owner: string): string[] {
    return this.discussions.enabled ? DISCUSSION_OPERATION_IDS.filter(op => this.discussions.canConvene(owner) || ['discussion_list', 'discussion_read', 'discussion_append'].includes(op)) : [];
  }
  open(owner: string, rights: readonly string[], autoAllow: readonly string[]): SlotGrant | null {
    const allowed = this.accountOperations(owner);
    const grant = this.authority.derive({ username: owner, purpose: '会议秘书', kind: 'agent-run', rights: rights.filter(op => allowed.includes(op)), autoAllow: autoAllow.filter(op => allowed.includes(op)) });
    return grant ? new SlotGrant(this.kernel, grant.contextId, SLOT, '会议秘书', owner, grant.borrowed) : null;
  }
  private async execute(owner: string, operation: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
    switch (operation) {
      case 'discussion_start': return this.discussions.start(owner, args as unknown as Parameters<DiscussionService['start']>[1]);
      case 'discussion_list': return { discussions: this.discussions.list(owner) };
      case 'discussion_read': return this.discussions.read(owner, String(args.discussion_id), args.after === undefined ? undefined : Number(args.after));
      case 'discussion_append': return this.discussions.append(owner, String(args.discussion_id), String(args.text), String(args.request_id));
      case 'discussion_configure': return this.discussions.configure(owner, String(args.discussion_id), Number(args.revision), args.settings as string | undefined, args.status as string | undefined);
      default: throw new Error('未知会议操作');
    }
  }
  revoke(owner: string): void { this.authority.revokeAccount(owner); }
}
