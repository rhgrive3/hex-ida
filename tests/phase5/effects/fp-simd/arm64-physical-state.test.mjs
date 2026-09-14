// #947: S/D are architectural views of one 128-bit Vn physical state; narrow writes must explicitly zero upper bits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { liftArm64FpEffects } from '../../../../js/targets/architecture/arm64/effects/fp.js';
import { liftArm64SimdEffects } from '../../../../js/targets/architecture/arm64/effects/simd.js';

const fp = (num, bits) => ({ k:'reg', cls:'fp', num, bits, text:`${bits === 32 ? 's' : bits === 64 ? 'd' : 'q'}${num}` });
const lift = (mnemonic, operands, id) => liftArm64FpEffects({
  instructionId:id, mnemonic, ops:operands, operands:operands.map((op) => op.text).join(', '),
}, { instructionId:id });
const ops = (bundle, kind) => bundle.operations.filter((operation) => operation.kind === kind);
const stateOps = (bundle, kind, registerId) => ops(bundle, kind).filter((operation) => operation.register?.registerId === registerId);

test('FMOV D0,D0 reads and writes canonical 128-bit V0 and explicitly zeroes upper 64 bits', () => {
  const bundle = lift('fmov', [fp(0,64), fp(0,64)], 'issue947:fmov-d');
  assert.equal(bundle.completeness, 'exact');
  assert.equal(stateOps(bundle, 'register-read', 'v0').length, 1);
  assert.equal(stateOps(bundle, 'register-read', 'v0')[0].register.widthBits, 128);
  assert.equal(stateOps(bundle, 'register-write', 'v0').length, 1);
  assert.equal(stateOps(bundle, 'register-write', 'v0')[0].register.widthBits, 128);
  assert.equal(stateOps(bundle, 'register-write', 'v0')[0].metadata?.writePolicy, 'zero-upper-vector-bits');
  assert.ok(ops(bundle, 'value').some((operation) => operation.opcode === 'truncate' && operation.metadata?.fromBits === 128 && operation.metadata?.toBits === 64));
  assert.ok(ops(bundle, 'value').some((operation) => operation.opcode === 'zero-extend' && operation.metadata?.fromBits === 64 && operation.metadata?.toBits === 128));
  assert.equal(bundle.operations.some((operation) => operation.kind === 'register-write' && operation.register?.registerId === 'v0' && operation.register?.widthBits === 64), false);
});

test('FADD D0 and FADD S0 materialize scalar results into the same 128-bit V0 physical state', () => {
  for (const bits of [64,32]) {
    const bundle = lift('fadd', [fp(0,bits), fp(1,bits), fp(2,bits)], `issue947:fadd-${bits}`);
    assert.equal(bundle.completeness, 'exact-with-intrinsic');
    const writes = stateOps(bundle, 'register-write', 'v0');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].register.widthBits, 128);
    assert.equal(writes[0].metadata?.writePolicy, 'zero-upper-vector-bits');
    assert.ok(ops(bundle, 'value').some((operation) => operation.opcode === 'zero-extend' && operation.metadata?.fromBits === bits && operation.metadata?.toBits === 128));
    assert.equal(stateOps(bundle, 'register-read', 'v1')[0].register.widthBits, 128);
    assert.equal(stateOps(bundle, 'register-read', 'v2')[0].register.widthBits, 128);
  }
});

test('scalar FP source views are projections from canonical Vn rather than independent 32/64-bit physical state', () => {
  const bundle = lift('fadd', [fp(0,64), fp(1,64), fp(2,64)], 'issue947:source-view');
  for (const registerId of ['v1','v2']) {
    const reads = stateOps(bundle, 'register-read', registerId);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].register.widthBits, 128);
    assert.equal(bundle.operations.some((operation) => operation.kind === 'register-read' && operation.register?.registerId === registerId && operation.register?.widthBits === 64), false);
  }
  assert.ok(ops(bundle, 'value').filter((operation) => operation.opcode === 'truncate' && operation.metadata?.purpose === 'arm64-fp-register-view').length >= 2);
});


const vec = (num, arr) => ({ k:'reg', cls:'vec', num, bits:128, arr, text:`v${num}.${arr}` });
const elem = (num, size, index) => ({ k:'elem', num, size, index, text:`v${num}.${size}[${index}]` });
const gp = (num, bits) => ({ k:'reg', cls:'gp', num, bits, text:`${bits === 32 ? 'w' : 'x'}${num}` });
const simdLift = (mnemonic, operands, id) => liftArm64SimdEffects({
  instructionId:id, mnemonic, ops:operands, operands:operands.map((op) => op.text).join(', '),
}, { instructionId:id });

test('64-bit SIMD views project from Vn128 and zero the upper 64 bits on write', () => {
  const bundle = simdLift('add', [vec(0,'2s'), vec(1,'2s'), vec(2,'2s')], 'a2-simd:physical-64');
  assert.equal(bundle.completeness, 'exact-with-intrinsic');
  for (const registerId of ['v1','v2']) {
    const reads = stateOps(bundle, 'register-read', registerId);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].register.widthBits, 128);
  }
  const write = stateOps(bundle, 'register-write', 'v0');
  assert.equal(write.length, 1);
  assert.equal(write[0].register.widthBits, 128);
  assert.equal(write[0].metadata?.writePolicy, 'zero-upper-vector-bits');
  assert.ok(ops(bundle, 'value').some((operation) => operation.opcode === 'zero-extend' && operation.metadata?.fromBits === 64 && operation.metadata?.toBits === 128));
  assert.equal(bundle.operations.some((operation) => operation.kind === 'register-write' && operation.register?.registerId === 'v0' && operation.register?.widthBits === 64), false);
});

test('SIMD reduction scalar destination is a zero-upper write to canonical Vn128', () => {
  const bundle = simdLift('addv', [fp(0,32), vec(1,'4s')], 'a2-simd:reduction');
  assert.equal(bundle.completeness, 'exact-with-intrinsic');
  const write = stateOps(bundle, 'register-write', 'v0')[0];
  assert.equal(write.register.widthBits, 128);
  assert.equal(write.metadata?.writePolicy, 'zero-upper-vector-bits');
  assert.ok(ops(bundle, 'value').some((operation) => operation.opcode === 'zero-extend' && operation.metadata?.fromBits === 32 && operation.metadata?.toBits === 128));
});

test('aliased INS captures both old destination and source lane before canonical Vn write', () => {
  const bundle = simdLift('ins', [elem(0,'s',2), elem(0,'s',1)], 'a2-simd:alias-order');
  assert.equal(bundle.completeness, 'exact-with-intrinsic');
  const writeIndex = bundle.operations.findIndex((operation) => operation.kind === 'register-write' && operation.register?.registerId === 'v0');
  const readIndexes = bundle.operations
    .map((operation,index) => [operation,index])
    .filter(([operation]) => operation.kind === 'register-read' && operation.register?.registerId === 'v0')
    .map(([,index]) => index);
  assert.equal(readIndexes.length, 2);
  assert.ok(readIndexes.every((index) => index < writeIndex));
  const write = stateOps(bundle, 'register-write', 'v0')[0];
  assert.equal(write.register.widthBits, 128);
  assert.equal(write.metadata?.destinationSemantics, 'merge-selected-lane');
});

test('XTN and XTN2 distinguish zero-upper replacement from high-half merge', () => {
  const low = simdLift('xtn', [vec(0,'4h'), vec(1,'4s')], 'a2-simd:xtn-low');
  assert.equal(low.completeness, 'exact-with-intrinsic');
  assert.equal(stateOps(low, 'register-read', 'v0').length, 0);
  assert.equal(stateOps(low, 'register-write', 'v0')[0].metadata?.writePolicy, 'zero-upper-vector-bits');

  const high = simdLift('xtn2', [vec(0,'8h'), vec(1,'4s')], 'a2-simd:xtn-high');
  assert.equal(high.completeness, 'exact-with-intrinsic');
  assert.equal(stateOps(high, 'register-read', 'v0').length, 1);
  assert.equal(stateOps(high, 'register-read', 'v0')[0].register.widthBits, 128);
  assert.equal(stateOps(high, 'register-write', 'v0')[0].register.widthBits, 128);
  assert.equal(stateOps(high, 'register-write', 'v0')[0].metadata?.destinationSemantics, 'merge-high-half');
});
