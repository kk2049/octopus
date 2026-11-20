/** Pure research contracts. Identity is evidence supplied by the trusted coordinator. */
export const RECORD_KINDS = ['request', 'hypothesis', 'plan', 'experiment', 'dataset', 'artifact', 'claim', 'decision', 'delivery', 'briefing', 'note'] as const;
export type RecordKind = typeof RECORD_KINDS[number];
export type WorkStatus = 'proposed' | 'active' | 'blocked' | 'paused' | 'review' | 'changes_requested' | 'merged' | 'abandoned';
export const TRANSITIONS: Record<WorkStatus, WorkStatus[]> = {
    proposed: ['active', 'paused', 'abandoned'], active: ['blocked', 'paused', 'abandoned'],
    blocked: ['active', 'paused', 'abandoned'], paused: ['active', 'abandoned'],
    review: ['changes_requested', 'abandoned'], changes_requested: ['active', 'paused', 'abandoned'],
    merged: [], abandoned: [],
};
export interface Stamp {
    at: string;
    by: string;
    seq: number;
}
export interface ResearchLink {
    relation: 'derived_from' | 'supports' | 'contradicts' | 'supersedes' | 'uses' | 'produces' | 'requested_by';
    target: string;
}
export interface ResearchRecord extends Stamp {
    id: string;
    kind: RecordKind;
    title: string;
    body: string;
    parents: string[];
    links: ResearchLink[];
    origin_by?: string;
    title_inferred?: boolean;
    documents?: Array<{
        key: string;
        seq: number;
        title: string;
    }>;
    source: string;
    source_level: 'user_direct' | 'human_authored' | 'infer' | 'imported';
    critical: boolean;
    tags: string[];
}
export interface ResearchBranch extends Stamp {
    id: string;
    title: string;
    purpose: string;
    base: string;
    head: string;
    status: WorkStatus;
    delivery: string;
    review_main: string;
    reason: string;
}
export interface ResearchAttestation extends Stamp {
    target: string;
    kind: 'understood' | 'approve' | 'reject' | 'disagree' | 'withdraw';
    response: string;
    main: string;
}
export interface ResearchConfirmation extends Stamp {
    id: string;
    target: string;
    question: string;
}
export interface ResearchState {
    main: string;
    records: ResearchRecord[];
    branches: ResearchBranch[];
    attestations: ResearchAttestation[];
    confirmations: ResearchConfirmation[];
    seen: Record<string, number>;
    revision: number;
}
export function emptyResearch(): ResearchState {
    return { main: '', records: [], branches: [], attestations: [], confirmations: [], seen: {}, revision: 0 };
}
export function latestAttestation(state: ResearchState, target: string, by: string, kinds: string[]): ResearchAttestation | undefined {
    return [...state.attestations].reverse().find(row => row.target === target && row.by === by && kinds.includes(row.kind));
}
export function approvals(state: ResearchState, target: string, main?: string): ResearchAttestation[] {
    const people = [...new Set(state.attestations.filter(row => row.target === target).map(row => row.by))];
    return people.flatMap(by => {
        const last = latestAttestation(state, target, by, ['approve', 'reject', 'disagree', 'withdraw']);
        return last?.kind === 'approve' && (main === undefined || last.main === main) ? [last] : [];
    });
}
export function descendants(state: ResearchState, target: string): string[] {
    const found = new Set([target]);
    for (const record of state.records)
        if (record.parents.some(id => found.has(id)) || record.links.some(link => found.has(link.target)))
            found.add(record.id);
    return [...found].filter(id => id !== target);
}
/** SES exposes language intrinsics, without Node Buffer or TextEncoder.
 * Count UTF-8 without allocating a percent-encoded copy of the entire state.
 * Reserve space for one history page, action input and viewer-only fields. */
export function assertProjectCapacity(state: unknown): void {
    const json = JSON.stringify(state ?? {});
    let bytes = 0;
    for (let index = 0; index < json.length && bytes <= 900000; index++) {
        const code = json.charCodeAt(index);
        if (code < 0x80) bytes++;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; index++; }
        else bytes += 3;
    }
    if (bytes > 900000) throw new Error('项目索引容量已满；历史仍可分页读取，扩容后继续新增资料');
}
