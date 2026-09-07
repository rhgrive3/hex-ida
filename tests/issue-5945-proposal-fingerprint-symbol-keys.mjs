// Regression for #5945: ProposalStore's stale-state fingerprint must treat
// symbol-keyed own properties as part of the value. A canonical text cannot
// distinguish two distinct symbols sharing a description, so symbol-keyed
// proposal state is refused explicitly (fail-closed) instead of silently
// omitted — a symbol-keyed change can never alias the approved revision.
import assert from 'node:assert/strict';
import { EvidenceStore } from '../js/ai/evidence.js';
import { ProposalStore } from '../js/ai/proposals.js';

const evidence = new EvidenceStore();
const verified = evidence.ingest('verify_field_update', { verified: true, evidence: ['ev1'], results: [{ id: 'write', kind: 'function', functionAddress: '0x1000', evidence: ['ev1'] }] }, { verifier: true })[0];

const hidden = Symbol('revision-sensitive');

// A symbol-keyed state is rejected explicitly at the create boundary.
const proposals = new ProposalStore({ evidenceStore: evidence });
assert.throws(
  () => proposals.create({
    kind: 'comment', target: '0x1000',
    before: { name: 'target', [hidden]: 'before' },
    after: { name: 'target', [hidden]: 'after' },
    evidenceIds: [verified.id],
  }),
  (error) => error.type === 'tool_failed' && /symbol-keyed own properties/.test(error.message),
  'symbol-keyed proposal state must be refused, not silently fingerprinted without it',
);

// An apply-time currentState carrying symbol keys cannot alias either.
const plainBefore = { name: 'target' };
const proposal = proposals.create({ kind: 'comment', target: '0x1000', before: plainBefore, after: { name: 'after' }, evidenceIds: [verified.id] });
const { approvalToken } = proposals.approve(proposal.id);
let applied = false;
await assert.rejects(
  () => proposals.apply(proposal.id, {
    approvalToken,
    currentState: { name: 'target', [hidden]: 'anything' },
    apply: async () => { applied = true; },
  }),
  (error) => error.type === 'tool_failed' && /symbol-keyed own properties/.test(error.message),
  'symbol-keyed currentState must fail closed instead of comparing aliased text',
);
assert.equal(applied, false, 'no mutation may run for an unfingerprintable state');

// Plain string-keyed states keep working end to end.
const stable = proposals.create({ kind: 'comment', target: '0x2000', before: plainBefore, after: { name: 'after' }, evidenceIds: [verified.id] });
const stableToken = proposals.approve(stable.id).approvalToken;
let stableApplied = false;
await proposals.apply(stable.id, { approvalToken: stableToken, currentState: { name: 'target' }, apply: async () => { stableApplied = true; } });
assert.equal(stableApplied, true, 'plain string-keyed states still apply');

console.log('issue-5945 proposal fingerprint symbol-key regression: PASS');
