import assert from 'node:assert/strict';
import { stableDigest } from '../../../js/core/identity/index.js';
import { semanticIrDigestFor } from '../../../js/analysis/alias/regions-v2-core.js';
import { semanticIrDigestFor as publicSemanticIrDigestFor } from '../../../js/analysis/alias/regions-v2.js';

// 1. Re-exported function is identical
assert.equal(semanticIrDigestFor, publicSemanticIrDigestFor, 'regions-v2 must re-export the exact core memoized function');

// 2. Exact match with stableDigest on plain and complex objects
const sampleIrA = Object.freeze({
  contractVersion: '1.0.0',
  functionId: 'fn_test_a',
  nodes: [{ id: 'node_1', kind: 'load' }],
  values: [{ id: 'val_1', kind: 'scalar' }],
});

const sampleIrB = Object.freeze({
  contractVersion: '1.0.0',
  functionId: 'fn_test_b',
  nodes: [{ id: 'node_2', kind: 'store' }],
  values: [{ id: 'val_2', kind: 'scalar' }],
});

const digestA1 = semanticIrDigestFor(sampleIrA);
const digestA2 = semanticIrDigestFor(sampleIrA);
const expectedA = stableDigest(sampleIrA);

assert.equal(digestA1, expectedA, 'semanticIrDigestFor must match stableDigest bit-for-bit');
assert.equal(digestA2, digestA1, 'subsequent calls must return the identical digest');

const digestB = semanticIrDigestFor(sampleIrB);
const expectedB = stableDigest(sampleIrB);
assert.equal(digestB, expectedB, 'distinct IR objects must produce distinct digests matching stableDigest');
assert.notEqual(digestA1, digestB, 'different IR objects must not collide');

// 3. Fallback for primitives and null
assert.equal(semanticIrDigestFor(null), stableDigest(null));
assert.equal(semanticIrDigestFor('test-string'), stableDigest('test-string'));
assert.equal(semanticIrDigestFor(12345), stableDigest(12345));

console.log('semantic-ir-digest-memo.test.mjs: PASS');
