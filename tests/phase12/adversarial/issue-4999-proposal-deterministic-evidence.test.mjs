import assert from 'node:assert/strict';
import { EvidenceStore } from '../../../js/ai/evidence.js';
import { ProposalStore } from '../../../js/ai/proposals.js';

function proposalInput(evidenceIds, suffix = 'x') {
  return {
    kind: 'rename',
    target: { address: '0x1000' },
    before: 'sub_1000',
    after: `verified_name_${suffix}`,
    evidenceIds,
  };
}

function assertEvidenceRejected(store, evidenceIds, message) {
  assert.throws(
    () => store.create(proposalInput(evidenceIds, message.replace(/\W+/g, '_'))),
    (error) => error?.type === 'invalid_tool_call' && /deterministic evidence/i.test(error.message),
    message,
  );
}

const evidenceStore = new EvidenceStore();
const supported = evidenceStore.add({
  id: 'ev-supported', kind: 'candidate-source', status: 'supported',
  sourceTool: 'model-output', functionAddress: '0x1000', title: 'model-only suggestion',
});
const unknown = evidenceStore.add({
  id: 'ev-unknown', kind: 'candidate-source', status: 'unknown',
  sourceTool: 'model-output', functionAddress: '0x1000', title: 'unverified observation',
});
assert.equal(supported.status, 'supported');
assert.equal(unknown.status, 'unknown');

// Direct callers cannot self-assert deterministic authority by requesting the
// verified status through the ordinary EvidenceStore.add() boundary.
const forgedVerified = evidenceStore.add({
  id: 'ev-forged-verified', kind: 'candidate-source', status: 'verified',
  sourceTool: 'model-output', functionAddress: '0x1000', title: 'forged verifier claim',
});
assert.equal(forgedVerified.status, 'supported', 'ordinary add() must downgrade a forged verified status');

// #4999: merely existing evidence must not authorize a proposal.
assertEvidenceRejected(new ProposalStore({ evidenceStore }), ['ev-supported'], 'supported-only evidence must be rejected');
assertEvidenceRejected(new ProposalStore({ evidenceStore }), ['ev-unknown'], 'unknown-only evidence must be rejected');
assertEvidenceRejected(new ProposalStore({ evidenceStore }), ['missing-evidence'], 'missing-only evidence must remain rejected');
assertEvidenceRejected(new ProposalStore({ evidenceStore }), ['ev-forged-verified'], 'forged verified evidence must remain rejected');

// ProposalStore also accepts minimal injected authority adapters used by
// focused callers/tests. Their has() predicate is itself the trusted contract;
// the product EvidenceStore takes the record/status path above.
const authorityAdapter = { has: (id) => id === 'adapter-verified' };
const adapterProposal = new ProposalStore({ evidenceStore: authorityAdapter })
  .create(proposalInput(['adapter-verified'], 'adapter'));
assert.deepEqual(adapterProposal.evidenceIds, ['adapter-verified']);

// Evidence IDs are identity fields. Structured inputs must not be string-coerced
// into a verified ID (or execute attacker-controlled coercion hooks).
let coercionCalls = 0;
const hostileEvidenceId = {
  toString() { coercionCalls += 1; return 'ev-supported'; },
  [Symbol.toPrimitive]() { coercionCalls += 1; return 'ev-supported'; },
};
assertEvidenceRejected(new ProposalStore({ evidenceStore }), [hostileEvidenceId], 'structured evidence IDs must fail closed');
assert.equal(coercionCalls, 0, 'structured evidence IDs must not execute coercion hooks');

// Exercise the first-party deterministic verifier authority. A caller cannot mint
// `verified` through add(), but ingest(..., { verifier:true }) may do so only when
// the deterministic tool result itself carries an explicit verified verdict.
const verifiedRows = evidenceStore.ingest('verify_field_update', {
  result: {
    verified: true,
    evidence: ['planner-proof-1'],
    verifiedEvidenceIds: ['planner-proof-1'],
    functionAddress: '0x1000',
    kind: 'field-update-verification',
  },
}, { verifier: true });
const verified = verifiedRows.find((row) => row.status === 'verified');
assert.ok(verified, 'deterministic verifier path must produce verified evidence');

const verifiedStore = new ProposalStore({ evidenceStore });
const accepted = verifiedStore.create(proposalInput([verified.id], 'verified'));
assert.deepEqual(accepted.evidenceIds, [verified.id], 'verified evidence must authorize proposal creation');

// Mixed policy is fail-closed at the proposal trust boundary: non-verified IDs
// are not promoted into the proposal merely because at least one verified proof
// exists. The proposal keeps only deterministically verified evidence IDs.
const mixedStore = new ProposalStore({ evidenceStore });
const mixed = mixedStore.create(proposalInput(['ev-supported', verified.id, 'ev-unknown', verified.id], 'mixed'));
assert.deepEqual(mixed.evidenceIds, [verified.id], 'mixed proposals must retain only deterministic verified evidence');

console.log('issue-4999 proposal deterministic evidence regression: PASS');
