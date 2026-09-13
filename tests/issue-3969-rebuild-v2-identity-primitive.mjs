// Regression for #3969: the v2 rebuild transaction is the L3 authority for an
// explicit byte rewrite, and every identity-bearing field was normalized with
// `String(value ?? '')`. JavaScript coercion makes `['content:deadbeef']`,
// `{toString(){return 'elf'}}` and a real `'elf'` indistinguishable, so a
// structured (non-string) input was minted into the canonical transactionId of
// a publishable rebuild proposal. Identity fields now require a primitive
// string and fail closed instead of aliasing an unrelated canonical identity.
import assert from 'node:assert/strict';
import { createRebuildTransaction } from '../js/rebuild/transaction-v2.js';

function input(overrides = {}) {
  return {
    binaryId: 'content:deadbeef',
    sourceHash: 'bytes:0123456789abcdef0123456789abcdef',
    format: 'elf',
    architecture: 'x86_64',
    loaderVersion: 'elf-loader@1',
    operations: [{
      id: 'op-1', offset: 0, before: [0], after: [1], provenance: { source: 'test' },
    }],
    ...overrides,
  };
}

// 1. The canonical string form is accepted and preserved verbatim.
{
  const transaction = createRebuildTransaction(input());
  assert.equal(transaction.binaryId, 'content:deadbeef');
  assert.equal(transaction.format, 'elf');
  assert.equal(transaction.architecture, 'x86_64');
  assert.equal(transaction.loaderVersion, 'elf-loader@1');
}

// 2. Structured values must never coerce into the same canonical identity.
const coercions = [
  ['binaryId', ['content:deadbeef']],
  ['binaryId', { toString() { return 'content:deadbeef'; } }],
  ['format', ['elf']],
  ['architecture', { toString() { return 'x86_64'; } }],
  ['loaderVersion', ['elf-loader@1']],
  ['sourceHash', { toString() { return 'bytes:0123456789abcdef0123456789abcdef'; } }],
  ['sourceHash', ['bytes:0123456789abcdef0123456789abcdef']],
];
for (const [field, value] of coercions) {
  assert.throws(
    () => createRebuildTransaction(input({ [field]: value })),
    (error) => error instanceof TypeError,
    `${field} must reject the structured value ${JSON.stringify(value)} (${typeof value})`,
  );
}

// 3. The same rule holds for an operation id, which also becomes transaction
//    identity through the canonical operation list.
assert.throws(
  () => createRebuildTransaction(input({ operations: [{ id: ['op-1'], offset: 0, before: [0], after: [1] }] })),
  (error) => error instanceof TypeError,
  'a structured operation id must not be coerced into the canonical operation identity',
);

console.log('issue #3969 rebuild-v2 identity primitive-type regression passed');
