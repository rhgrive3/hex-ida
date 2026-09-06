import test from 'node:test';
import assert from 'node:assert/strict';

import { ProposalStore } from '../js/ai/proposals.js';

function storeWithEv1() {
  return new ProposalStore({ evidenceStore: new Map([['ev1', { id: 'ev1' }]]) });
}

function validInput(overrides = {}) {
  return {
    kind: 'rename',
    target: '0x1000',
    before: 'sub_1000',
    after: 'addCoins',
    evidenceIds: ['ev1'],
    ...overrides,
  };
}

test('#6089 valid array evidenceIds still creates a proposal', () => {
  const store = storeWithEv1();
  const record = store.create(validInput());
  assert.deepEqual(record.evidenceIds, ['ev1']);
  assert.equal(record.status, 'pending');
});

test('#6089 null and undefined evidenceIds keep the empty/unspecified semantics', () => {
  const store = storeWithEv1();
  for (const evidenceIds of [null, undefined]) {
    assert.throws(
      () => store.create(validInput({ evidenceIds })),
      (error) => error?.type === 'invalid_tool_call' && /deterministic evidence/i.test(error.message),
      'unspecified evidenceIds must reach the deterministic-evidence gate',
    );
  }
});

test('#6089 non-array evidenceIds stays inside the invalid_tool_call domain boundary', () => {
  const store = storeWithEv1();
  const badValues = ['ev1', { 0: 'ev1' }, { map: () => ['ev1'] }, true, 1, 0n];
  for (const evidenceIds of badValues) {
    let threw = null;
    try {
      store.create(validInput({ evidenceIds }));
    } catch (error) {
      threw = error;
    }
    assert.ok(threw, `evidenceIds ${String(evidenceIds)} must be rejected`);
    assert.equal(threw.name, 'AIError', 'must be a domain AIError, never a native TypeError');
    assert.equal(threw.type, 'invalid_tool_call');
    assert.match(threw.message, /deterministic evidence|evidenceIds must be an array/i);
    assert.equal(threw instanceof TypeError, false);
  }
});

test('#6089 array of unknown evidence ids still hits the deterministic-evidence gate', () => {
  const store = storeWithEv1();
  assert.throws(
    () => store.create(validInput({ evidenceIds: ['nope'] })),
    (error) => error?.type === 'invalid_tool_call' && /deterministic evidence/i.test(error.message),
  );
});

test('#6089 duplicate evidence ids keep dedupe and unknown-id filtering', () => {
  const store = new ProposalStore({
    evidenceStore: new Map([
      ['ev1', { id: 'ev1' }],
      ['ev2', { id: 'ev2' }],
      ['1', { id: '1' }],
    ]),
  });
  const record = store.create(validInput({ evidenceIds: ['ev1', 'ev1', 'ev2', 'unknown'] }));
  assert.deepEqual(record.evidenceIds, ['ev1', 'ev2']);
});
