import assert from 'node:assert/strict';
import test from 'node:test';
import { stableDigest } from '../../js/core/identity/index.js';
import { createRebuildTransaction } from '../../js/rebuild/transaction-v2.js';

const sourceHash = `bytes:${stableDigest([1, 2, 3, 4])}`;

function validParams(overrides = {}) {
  return {
    binaryId: 'bin:test:1',
    sourceHash,
    format: 'elf',
    architecture: 'x86_64',
    loaderVersion: '1.0.0',
    operations: [
      {
        offset: '0',
        before: [0x90],
        after: [0xcc],
      },
    ],
    ...overrides,
  };
}

test('issue #5540: createRebuildTransaction rejects non-array impact.sections at construction', () => {
  // Valid array should succeed
  const txValid = createRebuildTransaction(validParams({
    impact: { sections: [] },
  }));
  assert.ok(txValid);
  assert.deepEqual(txValid.impact.sections, []);

  // Non-array object should throw TypeError
  assert.throws(
    () => createRebuildTransaction(validParams({ impact: { sections: { text: true } } })),
    TypeError,
  );

  // String should throw TypeError
  assert.throws(
    () => createRebuildTransaction(validParams({ impact: { sections: 'text' } })),
    TypeError,
  );
});
