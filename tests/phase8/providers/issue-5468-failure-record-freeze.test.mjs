import assert from 'node:assert/strict';
import test from 'node:test';

import { createProvider, runProviderPass } from '../../../js/decompiler/phase8/providers.js';

function runWithFailingProvider() {
  const analysis = {
    get(key) {
      if (key === 'induction') return { loops: [] };
      if (key === 'aggregates') return { regions: [] };
      if (key === 'structuredRegions') return { edgesByConstruct: {}, regions: [] };
      return null;
    },
  };
  const published = [];
  const area = { stage: (key, value) => published.push({ key, value }) };
  const facts = runProviderPass(
    {
      analysis,
      providers: [createProvider({
        id: 'test.provider', version: '1', kinds: ['idiom'],
        refine() { throw new Error('original failure'); },
      })],
      opts: {},
    },
    { shouldAbort: () => false },
    area,
  );
  return { facts, staged: published[0].value };
}

test('#5468 provider failure records are published frozen', () => {
  const { staged } = runWithFailingProvider();
  const facts = staged;
  assert.equal(facts.completeness, 'partial');
  assert.equal(facts.failures.length, 1);
  assert.equal(facts.failures[0].providerId, 'test.provider');
  assert.equal(facts.failures[0].reason, 'original failure');
  assert.ok(Object.isFrozen(facts.failures), 'failures array must be frozen');
  assert.ok(Object.isFrozen(facts.failures[0]), 'each failure record must be frozen like hints are');
});

test('#5468 published failure evidence cannot be rewritten after publication', () => {
  const { staged: facts } = runWithFailingProvider();
  const record = facts.failures[0];
  assert.throws(() => { record.reason = 'forged'; }, TypeError);
  assert.throws(() => { record.providerId = 'forged.provider'; }, TypeError);
  assert.equal(record.reason, 'original failure');
  assert.equal(record.providerId, 'test.provider');
});
