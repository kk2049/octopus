import type { ResearchRecord, ResearchBranch, ResearchState } from '../app/research-model.js';
export type RecordView = ResearchRecord & {
    understood_by_me: boolean;
    my_judgment: string;
    approvals: number;
    superseded: boolean;
    needs_recheck: boolean;
};
export type BranchView = ResearchBranch & {
    transitions: string[];
    review_stale: boolean;
    created_by?: string;
    created_at?: string;
};
export interface ResearchView extends Omit<ResearchState, 'seen' | 'records' | 'branches'> {
    records: RecordView[];
    branches: BranchView[];
    seen_through: number;
    changes: string[];
    controls: {
        can_write: boolean;
        can_attest: boolean;
        can_mark_seen: boolean;
    };
    indexes: {
        kinds: string[];
        authors: string[];
        tags: string[];
    };
}
export const kindNames: Record<string, string> = { request: '要求 / 问题', hypothesis: '假设', plan: '方案', experiment: '实验', dataset: '数据', artifact: '产物', claim: '结论', decision: '判断', delivery: '交付', briefing: '教学 / 汇报', note: '研究笔记' };
export const stateNames: Record<string, string> = { proposed: '待推进', active: '推进中', blocked: '受阻', paused: '暂停', review: '待人验收', changes_requested: '需要修改', merged: '已合入', abandoned: '已放弃' };
export const originNames: Record<string, string> = { user_direct: '用户直接要求', human_authored: '真人原文 · 不代表批准', infer: 'Agent infer', imported: '历史导入 · 待核实' };
export const judgmentNames: Record<string, string> = { understood: '已理解', approve: '明确批准', reject: '拒绝', disagree: '不同意', withdraw: '撤回批准' };
export function newResearchId(prefix: string) { return `${prefix}-${crypto.randomUUID()}`; }
