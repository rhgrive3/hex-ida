import assert from 'node:assert/strict';
import test from 'node:test';

import { OP } from '../../js/ir.js';
import { inferSemanticTypes } from '../../js/decompiler/type-recovery.js';

// Minimal legacy-v1 IR: one unary conversion, a 32-bit source and a 32-bit
// destination (#5494's "意味上の最小IR").
function conversionIr(sub) {
  const src = { id: 'src', bits: 32, uses: [] };
  const dst = { id: 'dst', bits: 32, uses: [] };
  return {
    values: [src, dst],
    instructions: [{
      id: 'conv', row: 1, op: OP.UN, sub,
      dst: { id: dst.id, bits: 32 },
      args: [{ value: src }],
    }],
  };
}

function decidedType(t, id) {
  const e = t.values.get(id);
  return { name: e.name, kind: e.kind, signed: e.signed };
}

test('#5494 f2i keeps the source floating and recovers a signed destination', () => {
  const t = inferSemanticTypes(conversionIr('f2i'), {});
  const src = decidedType(t, 'src');
  const dst = decidedType(t, 'dst');
  assert.equal(src.name, 'float', `f2i source must decide as floating, not from integer evidence: ${JSON.stringify(src)}`);
  assert.equal(src.kind, 'float');
  assert.equal(src.signed ?? null, null, `f2i source must not prove integer signedness: ${JSON.stringify(src)}`);
  assert.equal(dst.name, 'int32', `f2i destination should decide as int32: ${JSON.stringify(dst)}`);
  assert.equal(dst.kind, 'integer');
  assert.equal(dst.signed, true, `f2i destination must prove signedness: ${JSON.stringify(dst)}`);
});

test('#5494 f2u keeps the source floating and recovers an unsigned destination', () => {
  const t = inferSemanticTypes(conversionIr('f2u'), {});
  const src = decidedType(t, 'src');
  const dst = decidedType(t, 'dst');
  assert.equal(src.name, 'float', `f2u source must decide as floating, not from integer evidence: ${JSON.stringify(src)}`);
  assert.equal(src.kind, 'float');
  assert.equal(src.signed ?? null, null, `f2u source must not prove integer signedness: ${JSON.stringify(src)}`);
  assert.equal(dst.name, 'uint32', `f2u destination should decide as uint32: ${JSON.stringify(dst)}`);
  assert.equal(dst.kind, 'integer');
  assert.equal(dst.signed, false, `f2u destination must prove unsignedness: ${JSON.stringify(dst)}`);
});

test('#5494 i2f/u2f keep proving source integer signedness and a floating result', () => {
  const ti = inferSemanticTypes(conversionIr('i2f'), {});
  const isrc = decidedType(ti, 'src');
  const idst = decidedType(ti, 'dst');
  assert.equal(isrc.name, 'int32', `i2f source keeps signed integer type: ${JSON.stringify(isrc)}`);
  assert.equal(isrc.signed, true);
  assert.equal(idst.name, 'float', `i2f destination keeps floating type: ${JSON.stringify(idst)}`);
  assert.equal(idst.kind, 'float');

  const tu = inferSemanticTypes(conversionIr('u2f'), {});
  const usrc = decidedType(tu, 'src');
  const udst = decidedType(tu, 'dst');
  assert.equal(usrc.name, 'uint32', `u2f source keeps unsigned integer type: ${JSON.stringify(usrc)}`);
  assert.equal(usrc.signed, false);
  assert.equal(udst.name, 'float', `u2f destination keeps floating type: ${JSON.stringify(udst)}`);
  assert.equal(udst.kind, 'float');
});
