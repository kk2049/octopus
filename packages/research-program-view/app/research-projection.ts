import { approvals, descendants, emptyResearch, latestAttestation, TRANSITIONS, type ResearchState, type ResearchRecord } from './research-model.js';
export function foldResearch(state: ResearchState, event: any): void {
    const data = event?.data;
    if (!data || typeof data !== 'object')
        return;
    const stamp = { at: String(event.at ?? ''), by: String(event.by ?? ''), seq: Number(event.seq ?? state.revision + 1) };
    state.revision = Math.max(state.revision, stamp.seq);
    const branch = state.branches.find(row => row.id === data.branch);
    if (event.type === 'research_recorded')
        state.records.push({ ...data, ...stamp });
    if (event.type === 'research_forked')
        state.branches.push({ ...data, ...stamp, created_by: stamp.by, created_at: stamp.at });
    if (event.type === 'research_advanced' && branch)
        Object.assign(branch, { head: data.head, reason: data.reason, ...stamp });
    if (event.type === 'research_transitioned' && branch)
        Object.assign(branch, { status: data.status, reason: data.reason, ...stamp });
    if (event.type === 'research_delivered' && branch) {
        state.records.push({ ...data.record, ...stamp });
        Object.assign(branch, { head: data.record.id, delivery: data.record.id, review_main: data.main, status: 'review', ...stamp });
    }
    if (event.type === 'research_merged' && branch) {
        state.records.push({ ...data.record, ...stamp });
        state.main = data.record.id;
        Object.assign(branch, { status: 'merged', ...stamp });
    }
    // Event stamps are authoritative. Importing text with role=user never reaches this path.
    if (event.type === 'research_attested' && stamp.by.startsWith('user:'))
        state.attestations.push({ ...data, ...stamp });
    if (event.type === 'research_confirmation_requested')
        state.confirmations.push({ ...data, ...stamp });
    if (event.type === 'research_seen' && stamp.by.startsWith('user:'))
        state.seen[stamp.by] = Math.max(state.seen[stamp.by] ?? 0, data.through);
}
export function presentResearch(input: ResearchState | undefined, viewer: {
    user?: string;
    kind?: string;
    agent?: string;
}, mutable: boolean) {
    const state = input ?? emptyResearch();
    const self = viewer.kind !== 'agent' && viewer.user ? `user:${viewer.user}` : '';
    const { seen, ...shared } = state;
    const superseded = new Set(state.records.flatMap(row => row.links.filter(l => l.relation === 'supersedes').map(l => l.target)));
    const withdrawn = state.records.filter(r => r.critical && state.attestations.some(a => a.target === r.id && a.kind === 'approve') && !approvals(state, r.id).length).map(r => r.id);
    const affected = new Set([...superseded, ...withdrawn].flatMap(id => [id, ...descendants(state, id)]));
    const approvalCount = (record: ResearchRecord) => approvals(state, record.id, record.kind === 'delivery' ? state.branches.find(b => b.delivery === record.id)?.review_main : undefined).length;
    return {
        ...shared,
        records: state.records.map(row => ({ ...row,
            understood_by_me: Boolean(self && latestAttestation(state, row.id, self, ['understood'])),
            my_judgment: self ? latestAttestation(state, row.id, self, ['approve', 'reject', 'disagree', 'withdraw'])?.kind ?? '' : '',
            approvals: approvalCount(row), superseded: superseded.has(row.id), needs_recheck: affected.has(row.id),
        })),
        branches: state.branches.map(row => ({ ...row, transitions: mutable ? TRANSITIONS[row.status] : [], review_stale: row.status === 'review' && row.review_main !== state.main })),
        seen_through: self ? seen[self] ?? 0 : 0,
        changes: state.records.filter(row => row.seq > (self ? seen[self] ?? 0 : 0)).map(row => row.id),
        controls: { can_write: mutable, can_attest: mutable && Boolean(self), can_mark_seen: Boolean(self) },
        indexes: {
            kinds: [...new Set(state.records.map(row => row.kind))],
            authors: [...new Set(state.records.flatMap(row => [row.by, ...(row.origin_by ? [row.origin_by] : [])]))],
            tags: [...new Set(state.records.flatMap(row => row.tags))],
        },
    };
}
