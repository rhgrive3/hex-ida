import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyCallArguments } from '../../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';

const scalar64 = () => ({ type:'uint64_t', bits:64 });
const large = (bits = 192) => ({ type:'struct Big', abiClass:'aggregate', aggregate:true, bits });

test('#4984 >16-byte composite is replaced by a pointer in the next GP register', () => {
  const out = classifyCallArguments({ callPrototype:{ args:[large(192)] } }, {});
  const arg = out.arguments[0];
  assert.equal(arg.location, 'register');
  assert.equal(arg.reg, 'x0');
  assert.equal(arg.abiClass, 'aggregate-indirect-copy');
  assert.equal(arg.pointer, true);
  assert.equal(arg.bits, 64);
  assert.equal(arg.pointeeBits, 192);
  assert.equal(arg.aggregate, true);
  assert.equal(arg.callerCopy, true);
  assert.deepEqual(out.srcs, [{ t:'reg', reg:'x0', bits:64, purpose:'aggregate-indirect-copy' }]);
});

test('#4984 very large composite preserves original pointee width instead of the 128-bit clamp', () => {
  const out = classifyCallArguments({ callPrototype:{ args:[large(1024)] } }, {});
  const arg = out.arguments[0];
  assert.equal(arg.pointer, true);
  assert.equal(arg.bits, 64);
  assert.equal(arg.pointeeBits, 1024);
});

test('#4984 exhausted GP bank puts the replacement pointer in one 8-byte stack slot', () => {
  const out = classifyCallArguments({
    callPrototype:{ args:[...Array.from({ length:8 }, scalar64), large(192)] },
  }, {});
  const arg = out.arguments[8];
  assert.equal(arg.location, 'stack');
  assert.equal(arg.offset, 0);
  assert.equal(arg.bytes, 8);
  assert.equal(arg.bits, 64);
  assert.equal(arg.pointer, true);
  assert.equal(arg.pointeeBits, 192);
  assert.equal(arg.abiClass, 'aggregate-indirect-copy');
  assert.equal(out.stackArgsMayContainPointers, true);
});

test('#4984 pointer replacement consumes exactly one NGRN before a following scalar', () => {
  const out = classifyCallArguments({ callPrototype:{ args:[large(192), scalar64()] } }, {});
  assert.equal(out.arguments[0].reg, 'x0');
  assert.equal(out.arguments[1].reg, 'x1');
});

test('#4984 16-byte composite control is not reclassified by the >16-byte rule', () => {
  const out = classifyCallArguments({ callPrototype:{ args:[large(128)] } }, {});
  const arg = out.arguments[0];
  assert.equal(arg.reg, 'x0');
  assert.equal(arg.pointer, false);
  assert.equal(arg.abiClass, 'integer');
  assert.equal(arg.bits, 128);
});

test('#4984 ordinary scalar and explicit pointer controls are unchanged', () => {
  const scalar = classifyCallArguments({ callPrototype:{ args:[scalar64()] } }, {}).arguments[0];
  assert.equal(scalar.reg, 'x0');
  assert.equal(scalar.pointer, false);
  assert.equal(scalar.bits, 64);

  const pointer = classifyCallArguments({
    callPrototype:{ args:[{ type:'struct Big *', pointer:true, bits:192 }] },
  }, {}).arguments[0];
  assert.equal(pointer.reg, 'x0');
  assert.equal(pointer.pointer, true);
  assert.equal(pointer.abiClass, 'pointer');
  assert.equal(pointer.bits, 128, 'existing compat width clamp remains unchanged outside composite-by-copy');
});

test('#4984 HFA keeps its FP-register rule even when aggregate payload exceeds 16 bytes', () => {
  const out = classifyCallArguments({
    callPrototype:{ args:[{ type:'double', abiClass:'hfa', hfa:true, members:4, bits:64 }] },
  }, {});
  const arg = out.arguments[0];
  assert.deepEqual(arg.regs, ['v0','v1','v2','v3']);
  assert.equal(arg.reg, 'v0');
  assert.equal(arg.abiClass, 'hfa');
  assert.notEqual(arg.pointer, true);
});

test('type spelling alone preserves large-composite indirect authority', () => {
  const result = classifyCallArguments({ callPrototype:{ args:[{ type:'struct Big', bits:192 }] } });
  const arg = result.arguments[0];
  assert.equal(arg.location, 'register');
  assert.equal(arg.reg, 'x0');
  assert.equal(arg.abiClass, 'aggregate-indirect-copy');
  assert.equal(arg.pointer, true);
  assert.equal(arg.bits, 64);
  assert.equal(arg.pointeeBits, 192);
});

test('large composite consumes x7 as one pointer slot at NGRN=7', () => {
  const args = [
    ...Array.from({length:7}, () => ({ type:'uint64_t', bits:64 })),
    { type:'struct Big', aggregate:true, bits:192 },
    { type:'uint64_t', bits:64 },
  ];
  const result = classifyCallArguments({ callPrototype:{ args } });
  assert.equal(result.arguments[7].reg, 'x7');
  assert.equal(result.arguments[7].pointer, true);
  assert.equal(result.arguments[7].abiClass, 'aggregate-indirect-copy');
  assert.equal(result.arguments[8].location, 'stack');
  assert.equal(result.arguments[8].offset, 0);
});

test('sizeBits alias retains original large-composite size', () => {
  const result = classifyCallArguments({ callPrototype:{ args:[{ abiClass:'aggregate', aggregate:true, sizeBits:320 }] } });
  const arg = result.arguments[0];
  assert.equal(arg.pointer, true);
  assert.equal(arg.pointeeBits, 320);
  assert.equal(arg.bytes, 8);
});
