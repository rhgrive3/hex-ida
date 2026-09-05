import assert from 'node:assert/strict';
import { ProposalStore } from '../js/ai/proposals.js';

const evidenceStore = { has: (id) => id === 'ev1' || id === '1' };

function create(store, overrides = {}) {
  return store.create({
    kind: 'comment',
    evidenceIds: ['ev1'],
    before: 'x',
    after: 'y',
    ...overrides,
  });
}

for (const id of [['proposal-A'], [], { toString() { return 'proposal-A'; } }, 1, true, null, undefined]) {
  const store = new ProposalStore({ evidenceStore });
  assert.throws(
    () => create(store, { id }),
    (error) => error?.type === 'invalid_tool_call' && /proposal id/i.test(error.message),
    'explicit proposal IDs must be non-empty strings',
  );
}

{
  const store = new ProposalStore({ evidenceStore });
  const generated = create(store);
  assert.match(generated.id, /^proposal_\d+$/, 'omitted ID still uses the existing generated-ID path');
}

{
  const store = new ProposalStore({ evidenceStore });
  const proposal = create(store, { id: 'proposal-A' });
  assert.equal(proposal.id, 'proposal-A');
  for (const alias of [['proposal-A'], { toString() { return 'proposal-A'; } }, 1, true, '', null, undefined]) {
    assert.equal(store.has(alias), false, 'lookup must not coerce proposal identity');
    assert.equal(store.get(alias), null, 'get must not coerce proposal identity');
    assert.throws(() => store.require(alias), (error) => error?.type === 'invalid_tool_call');
  }
  assert.equal(store.require('proposal-A').id, 'proposal-A');
}

for (const evidenceIds of [{ 0: 'ev1' }, 'ev1', true]) {
  const store = new ProposalStore({ evidenceStore });
  assert.throws(
    () => create(store, { evidenceIds }),
    (error) => error?.type === 'invalid_tool_call'
      && /requires deterministic evidence/i.test(error.message)
      && !(error instanceof TypeError),
    'non-array evidenceIds must use the deterministic-evidence validation path',
  );
}

for (const evidenceId of [['ev1'], { toString() { return 'ev1'; } }, 1, true]) {
  const store = new ProposalStore({ evidenceStore });
  assert.throws(
    () => create(store, { evidenceIds: [evidenceId] }),
    (error) => error?.type === 'invalid_tool_call' && /requires deterministic evidence/i.test(error.message),
    'non-string evidence IDs must not alias deterministic evidence',
  );
}

{
  const store = new ProposalStore({ evidenceStore });
  const proposal = create(store, { evidenceIds: ['ev1', 'ev1', 'missing'] });
  assert.deepEqual(proposal.evidenceIds, ['ev1'], 'valid string evidence IDs retain dedupe/filter semantics');
}

console.log('proposal identity boundaries: PASS');
