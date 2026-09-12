import test from 'node:test';
import assert from 'node:assert/strict';

import { RISCV_LP64F_ABI, RISCV_LP64D_ABI } from '../../../js/targets/abi/riscv-lp64.js';

function classifyReturn(abi, prototype) {
  return abi.classifyFunctionReturn({ functionPrototype: prototype });
}

function canonicalAggregate(returnType, members, { bits = 64, bytes = bits / 8 } = {}) {
  return {
    returnType,
    aggregate:true,
    returnBits:bits,
    layout:{ bits, bytes, members, padding:[] },
  };
}

const u64 = (byteOffset) => ({ type:'uint64_t', bits:64, bytes:8, byteOffset });
const f32 = (byteOffset) => ({ type:'float', floating:true, bits:32, bytes:4, byteOffset });
const f64 = (byteOffset) => ({ type:'double', floating:true, bits:64, bytes:8, byteOffset });

test('#6039 LP64D all-integer 8-byte aggregate returns in a0', () => {
  const result = classifyReturn(RISCV_LP64D_ABI, canonicalAggregate('struct S', [u64(0)]));
  assert.equal(result.partial, undefined);
  assert.equal(result.aggregate, true);
  assert.equal(result.reg, 'x10');
  assert.deepEqual(result.regs, ['x10']);
});

test('#6039 LP64D all-integer 16-byte aggregate returns in a0/a1', () => {
  const result = classifyReturn(RISCV_LP64D_ABI,
    canonicalAggregate('struct Pair', [u64(0), u64(8)], { bits:128, bytes:16 }));
  assert.equal(result.partial, undefined);
  assert.deepEqual(result.regs, ['x10', 'x11']);
});

test('#6039 LP64F uses the same proven integer fallback', () => {
  const result = classifyReturn(RISCV_LP64F_ABI, canonicalAggregate('struct S', [u64(0)]));
  assert.equal(result.partial, undefined);
  assert.equal(result.reg, 'x10');
});

test('#6039 a union never receives hard-float flattening', () => {
  const aggregate = canonicalAggregate('union U', [f64(0)]);
  const result = classifyReturn(RISCV_LP64D_ABI, aggregate);
  assert.equal(result.partial, undefined);
  assert.equal(result.reg, 'x10');
  assert.equal(result.abiClass, undefined);
  assert.deepEqual(result.regs, ['x10']);
  const argument = RISCV_LP64D_ABI.classifyArguments({ callPrototype:{ args:[{
    type:aggregate.returnType, aggregate:true, bits:aggregate.returnBits, layout:aggregate.layout,
  }] } }).arguments[0];
  assert.equal(argument.abiClass, 'aggregate-integer-registers');
  assert.deepEqual(argument.regs, ['x10']);
});

test('#6039 proven hard-float eligible aggregates keep fa returns', () => {
  const doubleResult = classifyReturn(RISCV_LP64D_ABI, canonicalAggregate('struct D', [f64(0)]));
  assert.equal(doubleResult.reg, 'f10');
  assert.equal(doubleResult.abiClass, 'aggregate-hard-float-flattened');

  const floatResultF = classifyReturn(RISCV_LP64F_ABI,
    canonicalAggregate('struct F', [f32(0)], { bits:32, bytes:4 }));
  const floatResultD = classifyReturn(RISCV_LP64D_ABI,
    canonicalAggregate('struct F', [f32(0)], { bits:32, bytes:4 }));
  assert.equal(floatResultF.reg, 'f10');
  assert.equal(floatResultD.reg, 'f10');
});

test('#6039 proven mixed FP+integer aggregate keeps mixed return registers', () => {
  const result = classifyReturn(RISCV_LP64D_ABI,
    canonicalAggregate('struct Mixed', [f64(0), u64(8)], { bits:128, bytes:16 }));
  assert.deepEqual(result.regs, ['f10', 'x10']);
  assert.deepEqual(result.parts.map((part) => part.abiClass), ['float', 'integer']);
});

test('#6039 LP64F double aggregate is proven ineligible and falls back to a0', () => {
  const result = classifyReturn(RISCV_LP64F_ABI, canonicalAggregate('struct D', [f64(0)]));
  assert.equal(result.partial, undefined);
  assert.equal(result.reg, 'x10');
  assert.deepEqual(result.regs, ['x10']);
});

test('#6039 malformed or insufficient layout remains fail-closed', () => {
  const result = classifyReturn(RISCV_LP64D_ABI, {
    returnType:'struct Unknown', aggregate:true, returnBits:64,
    members:[{ type:'uint64_t', bits:64 }],
  });
  assert.equal(result.partial, true);
  assert.match(result.reason, /layout-unproven/);
});

test('#6039 recursively proven nested FP aggregate does not fall back to integer', () => {
  const nested = canonicalAggregate('struct Outer', [
    {
      type:'struct Inner', aggregate:true, bits:32, bytes:4, byteOffset:0,
      members:[f32(0)],
    },
    f32(4),
  ], { bits:64, bytes:8 });
  const result = classifyReturn(RISCV_LP64D_ABI, nested);
  assert.deepEqual(result.regs, ['f10', 'f11']);
  assert.deepEqual(result.parts.map((part) => part.byteOffset), [0, 4]);
});

test('#6039 nested union is proven non-flattenable and uses the integer convention', () => {
  const nestedUnion = {
    type:'union Inner', aggregate:true, bits:64, bytes:8, byteOffset:0,
    members:[f64(0)],
  };
  const result = classifyReturn(RISCV_LP64D_ABI,
    canonicalAggregate('struct Outer', [nestedUnion]));
  assert.equal(result.partial, undefined);
  assert.deepEqual(result.regs, ['x10']);
});

test('#6039 unproven nested layout remains unknown rather than integer fallback', () => {
  const nestedUnknown = {
    type:'struct Inner', aggregate:true, bits:32, bytes:4, byteOffset:0,
  };
  const result = classifyReturn(RISCV_LP64D_ABI,
    canonicalAggregate('struct Outer', [nestedUnknown, f32(4)]));
  assert.equal(result.partial, true);
  assert.match(result.reason, /flattening-not-proven/);
});

test('#6039 return fallback agrees with first-named-argument placement', () => {
  const aggregate = canonicalAggregate('struct Pair', [u64(0), u64(8)], { bits:128, bytes:16 });
  const returnResult = classifyReturn(RISCV_LP64D_ABI, aggregate);
  const argument = RISCV_LP64D_ABI.classifyArguments({ callPrototype:{
    args:[{
      type:aggregate.returnType,
      aggregate:true,
      bits:aggregate.returnBits,
      layout:aggregate.layout,
    }],
  } }).arguments[0];
  assert.deepEqual(returnResult.regs, argument.regs);
  assert.deepEqual(returnResult.regs, ['x10', 'x11']);
});
