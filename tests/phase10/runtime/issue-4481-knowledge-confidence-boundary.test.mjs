import assert from 'node:assert/strict';
import test from 'node:test';

import { KnowledgeDB } from '../../../js/knowledge/index.js';
import { fingerprintFunction } from '../../../js/fingerprint/index.js';

const fixture = {
  architecture: 'arm64',
  address: 0x1000n,
  size: 1,
  bytes: new Uint8Array([0]),
  name: 'candidate',
};

function freshDb() {
  return new KnowledgeDB({ indexedDB: null, memory: new Map(), negativeMemory: new Map() });
}

test('#4481 remember accepts only primitive finite confidence numbers', async () => {
  const db = freshDb();
  for (const confidence of [0, 0.5, 1, -0.5, 1.5]) {
    const record = await db.remember({ ...fixture, id: `valid-${String(confidence)}`, confidence });
    assert.equal(record.confidence, Math.max(0, Math.min(1, confidence)));
  }

  for (const confidence of [['1'], true, '1', { value: 1 }, NaN, Infinity, -Infinity]) {
    await assert.rejects(
      () => db.remember({ ...fixture, id: `invalid-${String(confidence)}`, confidence }),
      /knowledge-confidence-must-be-finite-number/,
    );
  }
});

test('#4481 malformed stored confidence cannot gain matching or propagation authority', async () => {
  const fingerprint = fingerprintFunction(fixture);
  const db = new KnowledgeDB({
    indexedDB: null,
    memory: new Map([['malformed', {
      id: 'malformed',
      identityKey: fingerprint.semanticHash,
      fingerprint,
      names: ['candidate'],
      roles: [],
      types: [],
      comments: [],
      semanticLabels: [],
      fieldInterpretations: [],
      sourceBinaryHash: 'unknown',
      confidence: ['1'],
      confirmation: 'high-confidence-inferred',
      updatedAt: Date.now(),
    }]]),
    negativeMemory: new Map(),
  });

  const matches = await db.findMatches(fixture, { threshold: 0 });
  assert.equal(matches.length, 1);
  assert.ok(matches[0].confidence < 0.55, 'malformed confidence must use the same weak floor as zero confidence');
  assert.equal((await db.reidentify(fixture)).matched, false);
  assert.equal((await db.propagate(fixture)).propagated, false);
});
