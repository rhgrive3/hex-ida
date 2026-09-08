import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { decompileEntry, observeCorpus } from '../../../tools/validation/phase8/decompile-corpus.mjs';
import { structuringAccounting, aggregateCertainty, providerEvidence } from '../../../tools/validation/phase8/metrics.mjs';
import { resolveABIPlugin } from '../../../js/targets/abi/index.js';

const corpus = loadCorpus();
const entry = corpus.functions.filter(row => row.architectureId === 'riscv64')
  .sort((left, right) => left.bytes.length - right.bytes.length)[0];
assert.ok(entry, 'the frozen corpus must retain its real RISC-V lane');

test('all metric consumers preserve missing caller toolchain evidence instead of borrowing the frozen default', () => {
  const missing = { functions: [entry] };
  assert.match(observeCorpus({ corpus: missing })[0].failure, /phase8-measurement-compiler-abi/);
  const edges = structuringAccounting({ corpus: missing });
  assert.equal(edges.lostCfgEdgeCount, 1);
  assert.deepEqual(edges.functionsWithoutIr, [entry.id]);
  assert.equal(aggregateCertainty({ corpus: missing }).forcedTypeContradictionCount, 1);
  assert.equal(providerEvidence({ corpus: missing }).providerAuthorityFailureCount, 1);
});

test('frozen RISC-V compiler ABI reaches the production decompiler without restoring registry inference', () => {
  assert.equal(resolveABIPlugin({ architecture: 'riscv64', platform: 'linux' }).supported, false);
  const outcome = decompileEntry(entry, { toolchain: corpus.toolchain });
  assert.equal(outcome.failure, undefined, outcome.failure);
  assert.ok(outcome.result, 'real frozen RISC-V bytes must reach the product');
});

test('missing, conflicting, mismatched and unsupported compiler ABI evidence remains blocking', () => {
  const target = corpus.toolchain.targets.find(row => row.architectureId === 'riscv64');
  for (const targets of [
    [],
    [{ ...target, compilerArgs: ['-march=rv64im'] }],
    [{ ...target, compilerArgs: ['-mabi=lp64', '-mabi=lp64d'] }],
    [{ ...target, compilerArgs: ['-mabi=lp64q'] }],
    [{ ...target, compilerArgs: [['-mabi=lp64']] }],
    [{ ...target, target: 'riscv64-unknown-freebsd' }],
    [target, { ...target }],
  ]) {
    const outcome = decompileEntry(entry, { toolchain: { ...corpus.toolchain, targets } });
    assert.match(outcome.failure, /phase8-measurement-compiler-abi/);
    assert.equal(outcome.result, undefined);
  }
});
