import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCil } from '../fixtures/medium-cil.mjs';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';

const TYPE1 = [0x01, 0x00, 0x00, 0x02]; // TypeDef #1
const VOID0 = [0x00, 0x00, 0x01];
const I4_I4ARR_I4 = [0x00, 0x02, 0x08, 0x1d, 0x08, 0x08];
const VOID_I4ARR_I4_I4 = [0x00, 0x03, 0x01, 0x1d, 0x08, 0x08, 0x08];

function lift(body, signature = VOID0) {
  const bytes = buildCil({
    types: [{ name:'T', namespace:'N', methodList:1, fieldList:1 }],
    methods: [{ name:'M', flags:0x0016, signature, body }],
  }).bytes;
  return liftCilMethod(0, parseCil(bytes));
}
const by = (fx, name) => fx.bundles.find((b) => b.mnemonic === name);

test('#5308 newarr and ldlen preserve allocation/element identity and continue to ret', () => {
  const fx = lift([0x17, 0x8d, ...TYPE1, 0x25, 0x8e, 0x26, 0x26, 0x2a]);
  const alloc = by(fx, 'newarr');
  assert.equal(alloc.completeness, 'exact');
  assert.equal(alloc.producedValues[0].allocationKind, 'array');
  assert.equal(alloc.producedValues[0].elementTypeToken, 0x02000001);
  assert.equal(alloc.producedValues[0].elementType.table, 'TypeDef');
  assert.ok(alloc.producedValues[0].allocationSite);
  assert.deepEqual(by(fx, 'ldlen').possibleExceptions, [{ kind:'null-reference', condition:'array==null' }]);
  assert.equal(fx.bundles.at(-1).mnemonic, 'ret');
});

test('#5308 primitive ldelem.i4 emits a 4-byte array read with null/bounds authority', () => {
  const fx = lift([0x02, 0x03, 0x94, 0x2a], I4_I4ARR_I4);
  const b = by(fx, 'ldelem.i4');
  assert.equal(b.completeness, 'exact');
  assert.deepEqual(b.producedValues[0], { stackType:'int32', bits:32, primitive:'i4' });
  assert.equal(b.memoryEffects[0].space, 'array-element');
  assert.equal(b.memoryEffects[0].byteWidth, 4);
  assert.equal(b.memoryEffects[0].isWrite, false);
  assert.deepEqual(b.possibleExceptions.map((e) => e.kind), ['null-reference', 'index-out-of-range']);
  assert.equal(fx.bundles.at(-1).mnemonic, 'ret');
});

test('#5308 primitive stelem.i4 emits a 4-byte array write and store-type authority', () => {
  const fx = lift([0x02, 0x03, 0x04, 0x9e, 0x2a], VOID_I4ARR_I4_I4);
  const b = by(fx, 'stelem.i4');
  assert.equal(b.completeness, 'exact');
  assert.equal(b.memoryEffects[0].space, 'array-element');
  assert.equal(b.memoryEffects[0].byteWidth, 4);
  assert.equal(b.memoryEffects[0].isWrite, true);
  assert.deepEqual(b.possibleExceptions.map((e) => e.kind), ['null-reference', 'index-out-of-range']);
});

test('#5308 castclass/isinst keep target type identity and invalid-cast authority', () => {
  const fx = lift([0x14, 0x74, ...TYPE1, 0x26, 0x14, 0x75, ...TYPE1, 0x26, 0x2a]);
  const cast = by(fx, 'castclass');
  const inst = by(fx, 'isinst');
  assert.equal(cast.completeness, 'exact');
  assert.equal(cast.producedValues[0].typeToken, 0x02000001);
  assert.equal(cast.producedValues[0].managedType.name, 'T');
  assert.deepEqual(cast.possibleExceptions.map((e) => e.kind), ['invalid-cast']);
  assert.equal(inst.completeness, 'exact');
  assert.equal(inst.producedValues[0].managedType.table, 'TypeDef');
  assert.deepEqual(inst.possibleExceptions, []);
});

test('#5308 box/unbox/unbox.any are lifted instead of terminating semantic lifting', () => {
  const fx = lift([0x16, 0x8c, ...TYPE1, 0x79, ...TYPE1, 0x26, 0x14, 0xa5, ...TYPE1, 0x26, 0x2a]);
  assert.equal(by(fx, 'box').producedValues[0].allocationKind, 'box');
  assert.equal(by(fx, 'unbox').producedValues[0].stackType, 'managed-pointer');
  assert.equal(by(fx, 'unbox.any').producedValues[0].typeToken, 0x02000001);
  assert.equal(fx.bundles.at(-1).mnemonic, 'ret');
});

test('#5308 ldobj/stobj/initobj fail closed on unresolved storage width but do not stop following IL', () => {
  const fx = lift([
    0x14, 0x71, ...TYPE1, 0x26,
    0x14, 0x16, 0x81, ...TYPE1,
    0x14, 0xfe, 0x15, ...TYPE1,
    0x2a,
  ]);
  for (const name of ['ldobj', 'stobj', 'initobj']) {
    const b = by(fx, name);
    assert.equal(b.completeness, 'partial');
    assert.ok(b.unknownEffects.some((e) => e.reason.includes('storage-width-unresolved')));
  }
  assert.equal(fx.bundles.at(-1).mnemonic, 'ret');
});

test('#5308 token-typed ldelem/stelem preserve type token and fail closed without width proof', () => {
  const fx = lift([0x14, 0x16, 0xa3, ...TYPE1, 0x26, 0x14, 0x16, 0x16, 0xa4, ...TYPE1, 0x2a]);
  const load = by(fx, 'ldelem');
  const store = by(fx, 'stelem');
  assert.equal(load.memoryEffects[0].typeToken, 0x02000001);
  assert.equal(load.completeness, 'partial');
  assert.equal(store.memoryEffects[0].typeToken, 0x02000001);
  assert.equal(store.completeness, 'partial');
  assert.equal(fx.bundles.at(-1).mnemonic, 'ret');
});
