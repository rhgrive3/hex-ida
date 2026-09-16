import assert from 'node:assert/strict';
import {
  createRebuildTransaction,
  evaluateF6RebuildDenominator,
  materializeRebuildTransaction,
  validateRebuildTransaction,
} from '../js/rebuild/transaction-v2.js';
import { stableDigest } from '../js/core/identity/index.js';

const source = Uint8Array.of(1, 2, 3, 4);
const digest = (bytes) => `bytes:${stableDigest(Array.from(bytes))}`;
const transaction = createRebuildTransaction({
  binaryId: 'binary:elf:issue-5180', sourceHash: digest(source), format: 'elf', architecture: 'x86_64',
  loaderVersion: 'loader:elf:issue-5180',
  operations: [{ id: 'replace', offset: 1, before: [2], after: [9], provenance: { source: 'test' } }],
  impact: {}, requireIndependentOracle: false,
});
const materialized = await materializeRebuildTransaction(transaction, source, { maxOutputBytes: 1024 });
assert.equal(materialized.status, 'materialized');
assert.ok(transaction.requiredValidators.includes('loader-reparse'));

function loaderAnswer(overrides = {}, omit = []) {
  const base = { ok: true, status: 'passed', format: transaction.format, architecture: transaction.architecture,
    loaderVersion: transaction.loaderVersion, outputHash: materialized.outputHash, ...overrides };
  for (const key of omit) delete base[key];
  return base;
}
async function loaderResult(answer) {
  const validation = await validateRebuildTransaction(transaction, materialized, {
    original: source, loaderReparse: async () => answer, validators: {},
  });
  return { validation, loader: validation.validators.find((item) => item.validator === 'loader-reparse') };
}
for (const [label, answer] of [['bare-ok', { ok: true }], ['bare-ok-status-passed', { ok: true, status: 'passed' }]]) {
  const { validation, loader } = await loaderResult(answer);
  assert.equal(loader.status, 'failed', `${label} must fail loader-reparse`);
  assert.equal(validation.status, 'invalid', `${label} must invalidate the transaction`);
}
for (const [field, reason] of [
  ['format', 'validator-format-identity-required'], ['architecture', 'validator-architecture-identity-required'],
  ['loaderVersion', 'validator-loader-identity-required'], ['outputHash', 'validator-output-identity-required'],
]) {
  const { validation, loader } = await loaderResult(loaderAnswer({}, [field]));
  assert.equal(loader.reason, reason, `missing ${field} must report ${reason}`);
  assert.equal(validation.status, 'invalid');
}
for (const [label, overrides, reason] of [
  ['stale outputHash', { outputHash: digest(Uint8Array.of(9, 9, 9, 9)) }, 'validator-output-identity-mismatch'],
  ['wrong format', { format: 'pe' }, 'validator-format-mismatch'],
  ['wrong architecture', { architecture: 'arm64' }, 'validator-architecture-mismatch'],
  ['wrong loader', { loaderVersion: 'loader:elf:stale' }, 'validator-loader-identity-mismatch'],
]) {
  const { validation, loader } = await loaderResult(loaderAnswer(overrides));
  assert.equal(loader.reason, reason, `${label} must report ${reason}`);
  assert.equal(validation.status, 'invalid');
}
const complete = await loaderResult(loaderAnswer());
assert.equal(complete.loader.status, 'passed');
assert.equal(complete.validation.status, 'valid');
const incompleteF6 = evaluateF6RebuildDenominator({ transaction, validation: (await loaderResult({ ok: true })).validation, publication: null, proof: {} });
assert.equal(incompleteF6.cells['loader-reparse'].status, 'blocking');
const completeF6 = evaluateF6RebuildDenominator({ transaction, validation: complete.validation, publication: null, proof: {} });
assert.equal(completeF6.cells['loader-reparse'].status, 'closed');
console.log('issue-5180 transaction-v2 loader-reparse identity binding is required: ok');
