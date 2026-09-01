import assert from 'node:assert/strict';
import { ProposalStore } from '../js/ai/proposals.js';

const evidenceStore = { has: (id) => id === 'ev_valid' };

for (const evidenceIds of [{ 0: 'ev_valid' }, 'ev_valid', true]) {
  const store = new ProposalStore({ evidenceStore });
  assert.throws(
    () => store.create({ kind: 'rename', evidenceIds }),
    (error) => error?.type === 'invalid_tool_call'
      && /requires deterministic evidence/i.test(error.message)
      && !(error instanceof TypeError),
    `non-array evidenceIds must fail through the deterministic-evidence validation path: ${JSON.stringify(evidenceIds)}`,
  );
}

const store = new ProposalStore({ evidenceStore });
const proposal = store.create({
  kind: 'rename',
  evidenceIds: ['ev_valid', 'ev_valid', 'missing'],
  before: 'old',
  after: 'new',
});
assert.deepEqual(proposal.evidenceIds, ['ev_valid'], 'valid arrays retain existing stringify/dedupe/filter semantics');

console.log('issue-3314 proposal evidence array: PASS');
