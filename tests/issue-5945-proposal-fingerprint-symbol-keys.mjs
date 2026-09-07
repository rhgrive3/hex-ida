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

const arraySymbol = Symbol('array-revision-sensitive');
const arrayBefore = [];
arrayBefore[arraySymbol] = 'before';
assert.throws(
  () => proposals.create({
    kind: 'comment', target: '0x1001',
    before: arrayBefore, after: [],
    evidenceIds: [verified.id],
  }),
  (error) => error.type === 'tool_failed' && /symbol-keyed own properties/.test(error.message),
  'arrays with symbol-keyed own properties must fail closed before canonical array handling',
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

const arrayApplyKey = Symbol('array-current-state');
const arrayProposal = proposals.create({ kind: 'comment', target: '0x1002', before: [], after: ['after'], evidenceIds: [verified.id] });
const arrayApproval = proposals.approve(arrayProposal.id).approvalToken;
const arrayCurrentState = [];
arrayCurrentState[arrayApplyKey] = 'changed';
await assert.rejects(
  () => proposals.apply(arrayProposal.id, {
    approvalToken: arrayApproval,
    currentState: arrayCurrentState,
    apply: async () => { throw new Error('must not run'); },
  }),
  (error) => error.type === 'tool_failed' && /symbol-keyed own properties/.test(error.message),
  'array currentState with symbol-keyed properties must fail closed',
);
assert.equal(proposals.get(arrayProposal.id).status, 'failed', 'fingerprint failure must leave applying state');
assert.ok(proposals.audit.some((event) => event.type === 'proposal-failed' && event.proposalId === arrayProposal.id),
  'fingerprint failure must emit proposal-failed audit evidence');

let bindingState = {};
const bindingStore = new ProposalStore({ evidenceStore: evidence, binding: () => bindingState });
const bindingProposal = bindingStore.create({
  kind: 'comment', target: '0x1003', before: { name: 'target' }, after: { name: 'after' },
  evidenceIds: [verified.id],
});
const bindingApproval = bindingStore.approve(bindingProposal.id).approvalToken;
const bindingSymbol = Symbol('binding-current-state');
bindingState = { [bindingSymbol]: 'changed' };
await assert.rejects(
  () => bindingStore.apply(bindingProposal.id, {
    approvalToken: bindingApproval,
    currentState: { name: 'target' },
    apply: async () => { throw new Error('must not run'); },
  }),
  (error) => error.type === 'tool_failed' && /symbol-keyed own properties/.test(error.message),
  'binding fingerprint failures must fail the proposal closed',
);
assert.equal(bindingStore.get(bindingProposal.id).status, 'failed',
  'binding fingerprint failure must not leave the proposal applying');
assert.ok(bindingStore.audit.some((event) => event.type === 'proposal-failed' && event.proposalId === bindingProposal.id),
  'binding fingerprint failure must emit proposal-failed audit evidence');

// Plain string-keyed states keep working end to end.
const stable = proposals.create({ kind: 'comment', target: '0x2000', before: plainBefore, after: { name: 'after' }, evidenceIds: [verified.id] });
const stableToken = proposals.approve(stable.id).approvalToken;
let stableApplied = false;
await proposals.apply(stable.id, { approvalToken: stableToken, currentState: { name: 'target' }, apply: async () => { stableApplied = true; } });
assert.equal(stableApplied, true, 'plain string-keyed states still apply');

console.log('issue-5945 proposal fingerprint symbol-key regression: PASS');
