import assert from 'node:assert/strict';
import {
  createRebuildTransaction,
  evaluateF6RebuildDenominator,
  materializeRebuildTransaction,
  validateRebuildTransaction,
} from '../js/rebuild/transaction-v2.js';
import { stableDigest } from '../js/core/identity/index.js';

// Issue #5180: transaction-v2 `loader-reparse` treated a bare `{ ok: true }`
// answer as a passed reparse proof because every identity field was compared
// only when present. A hard F6 unit must fail closed when the result does not
// bind format / architecture / loader identity / output hash to the exact
// transaction it claims to have reparsed.

const source = Uint8Array.of(1, 2, 3, 4);
const digest = (bytes) => `bytes:${stableDigest(Array.from(bytes))}`;

const transaction = createRebuildTransaction({
  binaryId: 'binary:elf:issue-5180',
  sourceHash: digest(source),
  format: 'elf',
  architecture: 'x86_64',
  loaderVersion: 'loader:elf:issue-5180',
  operations: [{ id: 'replace', offset: 1, before: [2], after: [9], provenance: { source: 'test' } }],
  impact: {},
  requireIndependentOracle: false,
});
const materialized = await materializeRebuildTransaction(transaction, source, { maxOutputBytes: 1024 });
assert.equal(materialized.status, 'materialized');
assert.ok(transaction.requiredValidators.includes('loader-reparse'));

function loaderAnswer(overrides = {}, omit = []) {
  const base = {
    ok: true,
    status: 'passed',
    format: transaction.format,
    architecture: transaction.architecture,
    loaderVersion: transaction.loaderVersion,
    outputHash: materialized.outputHash,
    ...overrides,
  };
  for (const key of omit) delete base[key];
  return base;
}

async function loaderResult(answer) {
  const validation = await validateRebuildTransaction(transaction, materialized, {
    original: source,
    loaderReparse: async () => answer,
    validators: {},
  });
  return { validation, loader: validation.validators.find((item) => item.validator === 'loader-reparse') };
}

// 1. bare `{ ok: true }` must fail closed.
for (const [label, answer] of [
  ['bare-ok', { ok: true }],
  ['bare-ok-status-passed', { ok: true, status: 'passed' }],
]) {
  const { validation, loader } = await loaderResult(answer);
  assert.notEqual(loader.status, 'passed', `${label} must not pass loader-reparse`);
  assert.equal(loader.status, 'failed', `${label} must fail loader-reparse`);
  assert.equal(validation.status, 'invalid', `${label} must invalidate the transaction`);
}

// 2. every identity field is individually required.
const requiredFieldReasons = [
  ['format', 'validator-format-identity-required'],
  ['architecture', 'validator-architecture-identity-required'],
  ['loaderVersion', 'validator-loader-identity-required'],
  ['outputHash', 'validator-output-identity-required'],
];
for (const [field, reason] of requiredFieldReasons) {
  const { validation, loader } = await loaderResult(loaderAnswer({}, [field]));
  assert.equal(loader.status, 'failed', `missing ${field} must fail loader-reparse`);
  assert.equal(loader.reason, reason, `missing ${field} must report ${reason}`);
  assert.equal(validation.status, 'invalid', `missing ${field} must invalidate the transaction`);
}

// 3. stale / mismatched identity must fail even when present.
const mismatchReasons = [
  ['stale outputHash', { outputHash: digest(Uint8Array.of(9, 9, 9, 9)) }, 'validator-output-identity-mismatch'],
  ['wrong format', { format: 'pe' }, 'validator-format-mismatch'],
  ['wrong architecture', { architecture: 'arm64' }, 'validator-architecture-mismatch'],
  ['wrong loader', { loaderVersion: 'loader:elf:stale' }, 'validator-loader-identity-mismatch'],
];
for (const [label, overrides, reason] of mismatchReasons) {
  const { validation, loader } = await loaderResult(loaderAnswer(overrides));
  assert.equal(loader.status, 'failed', `${label} must fail loader-reparse`);
  assert.equal(loader.reason, reason, `${label} must report ${reason}`);
  assert.equal(validation.status, 'invalid', `${label} must invalidate the transaction`);
}

// 4. full correct identity with explicit success is the only passing shape.
const complete = await loaderResult(loaderAnswer());
assert.equal(complete.loader.status, 'passed', 'complete identity must pass loader-reparse');
assert.equal(complete.validation.status, 'valid', 'complete identity must keep the transaction valid');

// 5. the F6 `loader-reparse` unit must stay blocking on an identity-incomplete
// result and only close on a fully bound one.
const incompleteF6 = evaluateF6RebuildDenominator({ transaction, validation: (await loaderResult({ ok: true })).validation, publication: null, proof: {} });
assert.equal(incompleteF6.cells['loader-reparse'].status, 'blocking', 'F6 loader-reparse must block on a bare ok result');
assert.equal(incompleteF6.cells['loader-reparse'].reason, 'f6-loader-reparse-unproven');
const completeF6 = evaluateF6RebuildDenominator({ transaction, validation: complete.validation, publication: null, proof: {} });
assert.equal(completeF6.cells['loader-reparse'].status, 'closed', 'F6 loader-reparse closes only on bound reparse proof');

console.log('issue-5180 transaction-v2 loader-reparse identity binding is required: ok');
