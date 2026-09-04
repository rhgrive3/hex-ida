import test from 'node:test';
import assert from 'node:assert/strict';
import { deserializeExprDag, serializeExprDag } from '../js/symbolic/expr/serialize.js';
import { createBv, createBool, createFreshSymbol } from '../js/symbolic/expr/factory.js';
import { bvSort } from '../js/symbolic/expr/kinds.js';

test('issue #4947: canonical serializer output round-trips correctly', () => {
  const original = createBv(8, 0x42n);
  const wire = serializeExprDag(original);
  const restored = deserializeExprDag(wire);
  assert.equal(restored.value, 0x42n);
  assert.equal(restored.sort.width, 8);
});

test('issue #4947: non-canonical and structured BV const values are rejected with TypeError', () => {
  const badValues = [
    true,
    false,
    255,
    ['255'],
    { value: '0xff' },
    '255', // decimal string
    '0x', // missing hex digits
    '0xGG', // invalid hex
    null,
    undefined,
  ];

  for (const value of badValues) {
    const dag = {
      schemaVersion: '1.0.0',
      expressionDagVersion: '1.0.0',
      root: {
        kind: 'const',
        sort: { kind: 'bv', width: 8 },
        value,
      },
    };
    assert.throws(
      () => deserializeExprDag(dag),
      TypeError,
      `Expected TypeError for value: ${JSON.stringify(value)}`
    );
  }
});

test('issue #4947: Bool const enforces primitive boolean contract', () => {
  const validTrue = deserializeExprDag({
    schemaVersion: '1.0.0',
    expressionDagVersion: '1.0.0',
    root: { kind: 'const', sort: { kind: 'bool' }, value: true },
  });
  assert.equal(validTrue.value, true);

  for (const invalid of [1, 'true', [true], { b: true }, null]) {
    assert.throws(
      () => deserializeExprDag({
        schemaVersion: '1.0.0',
        expressionDagVersion: '1.0.0',
        root: { kind: 'const', sort: { kind: 'bool' }, value: invalid },
      }),
      TypeError
    );
  }
});

test('issue #4947: FreshSymbol restore/allocator semantics are preserved', () => {
  const sym = createFreshSymbol(bvSort(32), 'test_sym');
  const wire = serializeExprDag(sym);
  const restored = deserializeExprDag(wire);
  assert.equal(restored.name, 'test_sym');
  assert.equal(restored.symbolId, sym.symbolId);
});
