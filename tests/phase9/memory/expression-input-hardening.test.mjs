import test from 'node:test';
import assert from 'node:assert/strict';
import { createByteMemory, verifyDeobfuscationCandidate, expr as E } from '../../../js/symbolic/index.js';
import { identity } from '../taint/fixtures.mjs';

test('nested Expr accessors are rejected before parent factories inspect children', () => {
  let reads = 0;
  const bad = Object.freeze({ kind: 'const', get sort() { reads++; return E.bvSort(8); }, value: 1n });
  const parent = Object.freeze({ kind: 'binary', sort: E.bvSort(8), op: 'add', left: bad, right: E.createBv(8, 1n) });
  const result = createByteMemory({ identity }).store(0n, 1, parent);
  assert.equal(result.status, 'unknown'); assert.equal(reads, 0);
});

test('inherited Expr/sort properties cannot masquerade as immutable canonical data', () => {
  const inherited = Object.freeze(Object.create({ kind: 'const', sort: E.bvSort(8), value: 7n }));
  assert.equal(createByteMemory({ identity }).store(0n, 1, inherited).status, 'unknown');
  const inheritedSort = Object.freeze(Object.create({ kind: 'bv', width: 8 }));
  const expression = Object.freeze({ kind: 'const', sort: inheritedSort, value: 7n });
  assert.equal(createByteMemory({ identity }).store(0n, 1, expression).status, 'unknown');
});

test('connective operand array accessors are not invoked by validation or spreading', () => {
  let reads = 0;
  const args = [];
  Object.defineProperty(args, '0', { enumerable: true, get() { reads++; throw new Error('operand getter executed'); } });
  Object.freeze(args);
  const condition = Object.freeze({ kind: 'connective', sort: E.boolSort(), op: 'not', args });
  const expression = Object.freeze({ kind: 'ite', sort: E.bvSort(8), cond: condition, thenExpr: E.createBv(8, 1n), elseExpr: E.createBv(8, 0n) });
  let result;
  assert.doesNotThrow(() => { result = createByteMemory({ identity }).store(0n, 1, expression); });
  assert.equal(result.status, 'unknown'); assert.equal(reads, 0);
});

test('proof consumers do not execute getter-backed provenance on frozen symbols', async () => {
  let reads = 0;
  const base = E.createFreshSymbol(E.bvSort(3), 'provenance-input');
  const before = Object.freeze({ ...base, meta: Object.freeze({ get source() { reads++; return 'argument'; } }) });
  const result = await verifyDeobfuscationCandidate({ candidateId: 'c', beforeValueId: 'b', afterValueId: 'a',
    before, after: before, identity, memoryObservables: [], effectObservables: [] });
  assert.equal(result.eligible, false); assert.equal(reads, 0);
});

test('unknown semantic diagnostics reject accessors and coercive objects without invoking them', () => {
  for (const mode of ['accessor', 'coercion']) {
    let reads = 0;
    const node = { kind: 'unknown_semantic', sort: E.bvSort(8) };
    if (mode === 'accessor') Object.defineProperty(node, 'reason', {
      get() { reads++; return 'unmodeled'; }, enumerable: true,
    });
    else node.reason = Object.freeze({ toString() { reads++; return 'unmodeled'; } });
    const result = createByteMemory({ identity }).store(0n, 1, Object.freeze(node));
    assert.equal(result.status, 'unknown'); assert.equal(reads, 0, mode);
  }
});
