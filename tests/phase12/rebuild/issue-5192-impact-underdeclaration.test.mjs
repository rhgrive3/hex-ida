import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { createFormatSafeRebuildTransaction, inspectFormatSafeImage } from '../../../js/rebuild/format-safe.js';
import { createRebuildTransaction } from '../../../js/rebuild/transaction-v2.js';

const genericInput = (overrides = {}) => ({
  binaryId: 'binary:issue-5192',
  sourceHash: `bytes:${'0'.repeat(32)}`,
  format: 'elf',
  architecture: 'x86_64',
  loaderVersion: 'loader:test',
  operations: [{ id: 'same-size', offset: 16, before: [1, 2, 3, 4], after: [9, 8, 7, 6], provenance: { source: 'caller' } }],
  impact: { layoutMoving: false, relocations: false, branchRanges: false, unwind: false, importsExports: false, signature: false },
  ...overrides,
});

const sensitiveValidators = ['relocations', 'branch-ranges', 'unwind', 'imports-exports', 'signature-consequence'];

test('#5192 generic same-size patches cannot under-declare sensitive impact', () => {
  const transaction = createRebuildTransaction(genericInput());
  assert.equal(transaction.impact.layoutMoving, false, 'same-size generic edit need not claim layout motion');
  for (const field of ['relocations', 'branchRanges', 'unwind', 'importsExports', 'signature']) {
    assert.equal(transaction.impact[field], true, `${field} stays conservative without a range proof`);
  }
  for (const validator of sensitiveValidators) {
    assert.equal(transaction.requiredValidators.includes(validator), true, `${validator} must be required`);
  }
});

test('#5192 format-safe-looking state without adapter provenance does not bypass fallback', () => {
  const transaction = createRebuildTransaction(genericInput({
    expectedOriginalState: {
      sourceHash: `bytes:${'0'.repeat(32)}`,
      formatSafe: { schema: 'hex-format-safe-rebuild/v1', kind: 'pe-timestamp' },
    },
    additionalValidators: ['format-invariants'],
  }));
  for (const validator of sensitiveValidators) {
    assert.equal(transaction.requiredValidators.includes(validator), true, `${validator} remains required for unproven provenance`);
  }
});

test('#5192 the format-safe adapter retains its narrow proven impact', () => {
  const source = new Uint8Array(fs.readFileSync(new URL('./fixtures/vertical-microsoft-x86.exe', import.meta.url)));
  const image = inspectFormatSafeImage(source);
  const currentTimestamp = new DataView(source.buffer, source.byteOffset + image.target.offset, 4).getUint32(0, true);
  const timestamp = currentTimestamp === 0xffffffff ? 0xfffffffe : currentTimestamp + 1;
  const transaction = createFormatSafeRebuildTransaction({
    binaryId: 'binary:issue-5192:format-safe',
    source,
    format: 'pe',
    architecture: 'x86',
    loaderVersion: 'loader:test',
    mutation: { kind: 'pe-timestamp', timestamp },
  });
  assert.equal(transaction.impact.layoutMoving, false);
  for (const field of ['relocations', 'branchRanges', 'unwind', 'importsExports', 'signature']) {
    assert.equal(transaction.impact[field], false, `${field} remains narrow for the format-safe proof path`);
  }
  for (const validator of sensitiveValidators) {
    assert.equal(transaction.requiredValidators.includes(validator), false, `${validator} is not spuriously required`);
  }
  assert.equal(transaction.requiredValidators.includes('format-invariants'), true);
});
