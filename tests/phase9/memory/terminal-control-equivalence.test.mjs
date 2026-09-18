import assert from 'node:assert/strict';
import test from 'node:test';
import { queryMemoryEquivalence, isAdoptableMemoryEquivalence } from '../../../js/symbolic/query/memory-equivalence.js';
import { partialStoreFixture, machineIR, identity } from './main-fixtures.mjs';

function withTarget(ir, target = 0x1000n, bits = 64) {
  const ret = ir.instructions.find(inst => inst.op === 'ret');
  ret.returnTargetValue = typeof target === 'bigint'
    ? { id:'terminal-target', kind:'const', const:target, bits } : target;
  ret.extra = { ...ret.extra, returnControlTargetValueId:'source-target',
    returnControlTarget:{ schema:'semantic-return-control-target/v1', state:'resolved', valueId:'source-target' } };
  return ir;
}
const requestFor = (beforeIr, afterIr, overrides = {}) => ({ identity, beforeIr, afterIr,
  backendTier:'tiered', memory:{ addressBits:64 }, inputs:[], preconditions:[], timeoutMs:5000, ...overrides });
const arg = suffix => ({ id:`pc-${suffix}`, kind:'arg', bits:8 });

test('generic byte equivalence proves equal terminal PCs as an explicit versioned observable', async () => {
  const request = requestFor(withTarget(partialStoreFixture()), withTarget(partialStoreFixture()));
  const result = await queryMemoryEquivalence(request);
  assert.equal(result.verdict, 'proved', result.reason);
  assert.equal(result.eligible, true);
  assert.equal(result.scope.version, 3);
  assert.deepEqual(result.scope.effects, ['terminal-return','all-terminal-memory-bytes','terminal-control-target']);
  assert.equal(isAdoptableMemoryEquivalence(result, request), true);
});

test('equal bytes and ABI returns cannot conceal a different terminal PC', async () => {
  const result = await queryMemoryEquivalence(requestFor(withTarget(partialStoreFixture(), 0x1000n),
    withTarget(partialStoreFixture(), 0x2000n)));
  assert.equal(result.verdict, 'refuted', result.reason);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.firstDivergence, { kind:'return-target', before:0x1000n, after:0x2000n });
});

test('missing terminal control or a mismatched target width cannot authorize adoption', async () => {
  for (const [before, after] of [
    [withTarget(partialStoreFixture()), partialStoreFixture()],
    [partialStoreFixture(), withTarget(partialStoreFixture())],
    [withTarget(partialStoreFixture(), 16n, 32), withTarget(partialStoreFixture(), 16n, 64)],
  ]) {
    const result = await queryMemoryEquivalence(requestFor(before, after));
    assert.equal(result.eligible, false);
    assert.equal(result.verdict, 'unknown');
  }
});

test('target-only symbolic inputs require the same explicit input correspondence as ABI and memory inputs', async () => {
  const b = arg('b'), a = arg('a');
  const before = withTarget(partialStoreFixture(), b), after = withTarget(partialStoreFixture(), a);
  const request = requestFor(before, after, { inputs:[{ before:b, after:a }] });
  const result = await queryMemoryEquivalence(request);
  assert.equal(result.verdict, 'proved', result.reason);
  assert.equal(isAdoptableMemoryEquivalence(result, request), true);
  assert.equal(isAdoptableMemoryEquivalence(result, { ...request, inputs:[] }), false);
  const unbound = await queryMemoryEquivalence(requestFor(before, after));
  assert.equal(unbound.eligible, false);
  assert.equal(unbound.verdict, 'unknown');
});

test('a terminal-target-only difference produces a validated symbolic counterexample', async () => {
  const b = arg('b'), a = arg('a');
  const before = withTarget(partialStoreFixture(), b), after = withTarget(partialStoreFixture(), 0n, 8);
  const result = await queryMemoryEquivalence(requestFor(before, after, { inputs:[{ before:b, after:a }] }));
  assert.equal(result.verdict, 'refuted', result.reason);
  assert.equal(result.firstDivergence.kind, 'return-target');
  assert.notEqual(result.firstDivergence.before, result.firstDivergence.after);
});

test('target mutation, replacement, missing metadata and stale identity revoke a terminal-control receipt', async () => {
  for (const mutate of [
    request => { request.afterIr.instructions.at(-1).returnTargetValue.const = 0x2000n; },
    request => { const ret = request.afterIr.instructions.at(-1); ret.returnTargetValue = { ...ret.returnTargetValue }; },
    request => { delete request.afterIr.instructions.at(-1).extra.returnControlTarget; },
    request => { request.identity = { ...identity, snapshotId:'different' }; },
  ]) {
    const request = requestFor(withTarget(partialStoreFixture()), withTarget(partialStoreFixture()));
    const result = await queryMemoryEquivalence(request);
    assert.equal(result.verdict, 'proved', result.reason);
    mutate(request);
    assert.equal(isAdoptableMemoryEquivalence(result, request), false);
  }
});

test('cancellation and exhausted work or solver budgets do not publish terminal-control proof', async () => {
  const controller = new AbortController(); controller.abort();
  for (const options of [{ signal:controller.signal }, { limits:{ workItems:1 } }, { limits:{ solverCalls:0 } }]) {
    const result = await queryMemoryEquivalence(requestFor(withTarget(partialStoreFixture()),
      withTarget(partialStoreFixture()), options));
    assert.equal(result.eligible, false);
    assert.equal(result.verdict, 'unknown');
  }
});

test('generic terminal comparison does not promote unknown native faults or other machine effects', async () => {
  for (const lines of [['ret'], ['mov x30, #4097','ret'], ['mov x30, #4096','ret']]) {
    const result = await queryMemoryEquivalence(requestFor(machineIR(lines), machineIR(lines)));
    assert.equal(result.eligible, false);
    assert.equal(result.verdict, 'unknown');
    assert.match(result.reason, /return-control-normal-completion-unproved|unmodeled-machine-effects|unmodeled-terminal-control-effects/);
  }
});

test('ordinary byte-only callers retain their previous proof scope and result', async () => {
  const request = requestFor(partialStoreFixture(), partialStoreFixture());
  const result = await queryMemoryEquivalence(request);
  assert.equal(result.verdict, 'proved', result.reason);
  assert.equal(result.scope.version, 1);
  assert.deepEqual(result.scope.effects, ['terminal-return','all-terminal-memory-bytes']);
  assert.equal(isAdoptableMemoryEquivalence(result, request), true);
});
