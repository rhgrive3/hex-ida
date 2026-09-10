import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAnalysisIdentity as current } from '../../js/decompiler/phase8/analysis-identity.js';
import { canonicalAnalysisIdentity as original } from '../helpers/analysis-identity-baseline-oracle.mjs';
import { createOriginSet } from '../../js/core/identity/origin.js';
import { fixture } from '../phase8/helpers/ir-fixtures.mjs';

function graph(origin) {
  const f = fixture('performance-identity');
  f.block(0);
  const a = f.constant(7n, 32), b = f.constant(2n, 32);
  f.binary('add', a, b, 32);
  f.ret();
  const ir = f.build();
  ir.origin = origin;
  for (const block of ir.blocks) {
    block.origin = origin;
    for (const instruction of block.insts) instruction.origin = origin;
  }
  for (const value of ir.values) value.origin = origin;
  return ir;
}
function compare(ir, repetitions = 4) {
  let result;
  for (let i = 0; i < repetitions; i += 1) {
    result = current({ ir });
    assert.deepEqual(result, original({ ir }));
  }
  return result;
}

test('analysis identity retains exact typed content across cold and repeated immutable origins', () => {
  const inputs = [
    createOriginSet({ instructionIds: ['instruction:a'], sourceLocations: [{ file: '日本語', line: 2 }] }),
    Object.freeze({ n: -0, nested: Object.freeze({ n: 0, big: 18446744073709551617n }) }),
    Object.freeze(Object.assign(Object.create(null), { data: Object.freeze([1, '1', 1n, null, true]) })),
    Object.freeze({ sparse: Object.freeze([1, , 3]) }),
    // This is larger than the cache entry limit; its exact meaning must still be retained.
    Object.freeze({ text: 'abc日本語'.repeat(5000) }),
  ];
  for (const origin of inputs) assert.equal(compare(graph(origin)).valid, true);
  const ir = graph(inputs[0]);
  const before = compare(ir);
  ir.origin = createOriginSet({ instructionIds: ['instruction:different'] });
  const after = compare(ir);
  assert.notDeepEqual(before.identity, after.identity);
});

test('shallow freezing never hides mutations of origin descendants or host containers', () => {
  const nested = { flags: [1, 2], metadata: { tag: 'old' } };
  const ir = graph(Object.freeze(nested));
  const before = compare(ir);
  nested.flags.push(3); nested.metadata.tag = 'new';
  const after = compare(ir);
  assert.notDeepEqual(before.identity, after.identity);
  for (const [host, mutate] of [
    [new Map([['key', 1]]), (value) => value.set('key', 2)],
    [new Set([1]), (value) => value.add(2)],
    [new Date('2020-01-01'), (value) => value.setUTCFullYear(2021)],
  ]) {
    Object.freeze(host);
    const fixtureIr = graph(Object.freeze({ host }));
    const first = compare(fixtureIr);
    mutate(host);
    const second = compare(fixtureIr);
    if (first.valid && second.valid) assert.notDeepEqual(first.identity, second.identity);
  }
});

test('analysis identity preserves legacy handling of cycles, accessors, symbols and non-finite values', () => {
  let reads = 0;
  const accessor = Object.freeze(Object.defineProperty({}, 'x', { enumerable: true, get() { reads++; return 1; } }));
  const cycle = {}; cycle.self = cycle; Object.freeze(cycle);
  for (const [index, origin] of [accessor, cycle, Object.freeze({ [Symbol('x')]: 1 }),
    Object.freeze({ n: NaN }), Object.freeze({ n: Infinity }), Object.freeze({ fn() {} }),
    Object.freeze(Object.defineProperty({}, 'hidden', { value: 2 }))].entries()) {
    const ir = graph(origin);
    // Some frozen origin metadata follows the pre-existing JSON fallback.
    // Performance work must preserve that behavior, not silently harden it.
    reads = 0; const expected = original({ ir }); const originalReads = reads;
    reads = 0; const actual = current({ ir }); const currentReads = reads;
    assert.deepEqual(actual, expected, `hostile origin ${index}`);
    assert.equal(currentReads, originalReads, `getter reads for origin ${index}`);
    compare(ir);
  }
});
