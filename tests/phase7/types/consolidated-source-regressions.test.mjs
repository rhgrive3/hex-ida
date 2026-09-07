import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHardConstraint,
  createSoftEvidence,
  createTypeClaim,
} from '../../../js/analysis/types/constraints.js';
import { condenseTypeGraph } from '../../../js/analysis/types/scc.js';

const validClaim = Object.freeze({
  layer: 'machine',
  entityId: 'v0',
  descriptor: Object.freeze({ widthBits: 64, class: 'integer' }),
});

test('#3467 type constraint enum fields reject structured values instead of String-coercing them', () => {
  assert.throws(
    () => createTypeClaim({ ...validClaim, layer: ['machine'] }),
    TypeError,
  );

  assert.throws(
    () => createHardConstraint({
      kind: ['access-width'],
      origin: 'binary-evidence',
      claim: validClaim,
    }),
    TypeError,
  );
  assert.throws(
    () => createHardConstraint({
      kind: 'access-width',
      origin: ['binary-evidence'],
      claim: validClaim,
    }),
    TypeError,
  );

  assert.throws(
    () => createSoftEvidence({
      kind: ['use-shape'],
      origin: 'heuristic',
      claim: validClaim,
    }),
    TypeError,
  );
  assert.throws(
    () => createSoftEvidence({
      kind: 'use-shape',
      origin: ['heuristic'],
      claim: validClaim,
    }),
    TypeError,
  );
});

test('#3470 dependency enumeration failure marks SCC condensation truncated', () => {
  let calls = 0;
  const result = condenseTypeGraph(['A'], () => {
    calls += 1;
    if (calls === 1) throw new Error('enumeration failed');
    return [];
  });

  assert.equal(result.cancelled, false);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.components, [['A']]);
  assert.equal(result.isRecursiveMap.get('A'), false);
});

test('#3470 self-edge dependency failure marks SCC condensation truncated', () => {
  let calls = 0;
  const result = condenseTypeGraph(['A'], () => {
    calls += 1;
    if (calls === 1) return [];
    throw new Error('self-edge probe failed');
  });

  assert.equal(calls, 2);
  assert.equal(result.cancelled, false);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.components, [['A']]);
  assert.equal(result.isRecursiveMap.get('A'), false);
});
