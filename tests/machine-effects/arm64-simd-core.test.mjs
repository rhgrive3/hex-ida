import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import { validateMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { liftArm64SimdEffects } from '../../js/targets/architecture/arm64/effects/simd.js';

let address = 0x3000n;
function instruction(mnemonic, ops, operands = '') {
  const virtualAddress = address;
  address += 4n;
  const instructionId = createInstructionId({
    binaryId:'bin_arm64_simd', sliceId:'slice_arm64_simd', virtualAddress,
    decodeMode:'a64', decoderSemanticVersion:'1',
  });
  return { mnemonic, ops, operands, instructionId, origin:{ instructionIds:[instructionId] } };
}
const vec = (num, arr, bits = 128) => ({ k:'reg', cls:'vec', num, bits, arr, text:`v${num}.${arr}` });
const fp = (num, bits) => ({ k:'reg', cls:'fp', num, bits, text:`${bits === 8 ? 'b' : bits === 16 ? 'h' : bits === 32 ? 's' : bits === 64 ? 'd' : 'q'}${num}` });
const elem = (num, size, index) => ({ k:'elem', num, size, index, text:`v${num}.${size}[${index}]` });
const gp = (num, bits = 64, cls = 'gp') => ({ k:'reg', cls, num, bits, text:cls === 'zr' ? (bits === 32 ? 'wzr' : 'xzr') : `${bits === 32 ? 'w' : 'x'}${num}` });
const imm = (value, shift = undefined) => ({ k:'imm', value:BigInt(value), text:`#${value}`, ...(shift ? { shift } : {}) });
const intrinsic = (effect) => effect?.operations.find((op) => op.kind === 'intrinsic');
const stateOps = (effect, kind, registerId) => effect.operations.filter((op) => op.kind === kind && op.register?.registerId === registerId);
const assertPartial = (effect, reason) => {
  assert.ok(effect, 'SIMD-owned malformed form must fail closed rather than disappear');
  assert.equal(effect.completeness, 'partial');
  if (reason) assert.match(effect.unknownEffects.reason, reason);
};

{
  const effect = liftArm64SimdEffects(instruction('add', [vec(0,'4s'), vec(1,'4s'), vec(2,'4s')]));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  assert.equal(effect.metadata.laneCount, 4);
  assert.equal(effect.metadata.laneWidthBits, 32);
  const op = intrinsic(effect);
  assert.equal(op.intrinsicId, 'arm64.simd.add');
  assert.equal(op.effectSummary.outputs[0].valueType.kind, 'vector');
  assert.equal(op.effectSummary.outputs[0].valueType.laneCount, 4);
  assert.equal(op.effectSummary.outputs[0].valueType.elementType.widthBits, 32);
  const write = stateOps(effect, 'register-write', 'v0')[0];
  assert.equal(write.register.widthBits, 128);
  assert.equal(write.register.view, 'v0', 'physical SIMD state must be canonical Vn, not an arrangement-specific pseudo-register');
  assert.equal(write.metadata.architecturalViewWritten, 'v0.4s');
  assert.doesNotThrow(() => validateMachineEffectBundle(effect));
}

{
  const effect = liftArm64SimdEffects(instruction('add', [vec(3,'8h'), vec(4,'8h'), vec(5,'8h')]));
  assert.equal(effect.metadata.laneCount, 8);
  assert.equal(effect.metadata.laneWidthBits, 16, 'lane identity must not be flattened to a generic 128-bit integer');
}

{
  const effect = liftArm64SimdEffects(instruction('add', [vec(0,'2s'), vec(1,'2s'), vec(2,'2s')]));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  for (const reg of ['v1','v2']) assert.equal(stateOps(effect, 'register-read', reg)[0].register.widthBits, 128);
  const write = stateOps(effect, 'register-write', 'v0')[0];
  assert.equal(write.register.widthBits, 128);
  assert.equal(write.metadata.writePolicy, 'zero-upper-vector-bits');
  assert.ok(effect.operations.some((op) => op.kind === 'value' && op.opcode === 'truncate' && op.metadata?.fromBits === 128 && op.metadata?.toBits === 64));
  assert.ok(effect.operations.some((op) => op.kind === 'value' && op.opcode === 'zero-extend' && op.metadata?.fromBits === 64 && op.metadata?.toBits === 128));
}

{
  const effect = liftArm64SimdEffects(instruction('ins', [elem(0,'s',2), gp(1,32)]));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  const op = intrinsic(effect);
  assert.equal(op.metadata.destinationLane, 2);
  assert.equal(op.metadata.laneWidthBits, 32);
  assert.ok(op.effectSummary.registersRead.includes('v0'), 'lane insert must read the preserved destination lanes');
  const write = stateOps(effect, 'register-write', 'v0')[0];
  assert.equal(write.metadata.laneWritten, 2);
  assert.equal(write.metadata.destinationSemantics, 'merge-selected-lane');
  assert.equal(write.metadata.writePolicy, 'full-width');
}

{
  const effect = liftArm64SimdEffects(instruction('ins', [elem(0,'s',2), elem(0,'s',1)]));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  const firstWrite = effect.operations.findIndex((op) => op.kind === 'register-write' && op.register?.registerId === 'v0');
  const reads = effect.operations
    .map((op,index) => [op,index])
    .filter(([op]) => op.kind === 'register-read' && op.register?.registerId === 'v0')
    .map(([,index]) => index);
  assert.equal(reads.length, 2, 'destination prior state and aliased source lane must both be captured');
  assert.ok(reads.every((index) => index < firstWrite), 'all aliased reads must precede destructive destination write');
}

{
  const effect = liftArm64SimdEffects(instruction('umov', [gp(0,32), elem(1,'b',7)]));
  assert.equal(effect.metadata.laneIndex, 7);
  assert.equal(effect.metadata.laneWidthBits, 8);
  const physicalWrite = stateOps(effect, 'register-write', 'x0')[0];
  assert.equal(physicalWrite.register.widthBits, 64, 'W destination must include architectural zero-extension');
  assert.equal(physicalWrite.metadata.architecturalViewWritten, 'w0');
}

{
  const effect = liftArm64SimdEffects(instruction('sqxtn', [vec(0,'4h'), vec(1,'4s')]));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  const op = intrinsic(effect);
  assert.ok(op.effectSummary.registersRead.includes('fpsr'), 'saturating narrow must consume cumulative saturation state');
  assert.ok(op.effectSummary.registersWritten.includes('fpsr'), 'saturating narrow must update cumulative saturation state');
}

{
  const effect = liftArm64SimdEffects(instruction('fadd', [vec(0,'4s'), vec(1,'4s'), vec(2,'4s')]));
  const op = intrinsic(effect);
  assert.ok(op.effectSummary.registersRead.includes('fpcr'));
  assert.ok(op.effectSummary.registersRead.includes('fpsr'));
  assert.ok(op.effectSummary.registersWritten.includes('fpsr'));
  assert.equal(op.effectSummary.outputs[0].valueType.elementType.kind, 'float');
}

{
  const effect = liftArm64SimdEffects(instruction('fcmeq', [vec(0,'4s'), vec(1,'4s'), vec(2,'4s')]));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  assert.equal(intrinsic(effect).effectSummary.outputs[0].valueType.elementType.kind, 'bitvector', 'FP compare destination lanes are integer masks');
  assert.equal(intrinsic(effect).effectSummary.inputs[0].valueType.elementType.kind, 'float');
}

{
  const effect = liftArm64SimdEffects(instruction('scvtf', [vec(0,'4s'), vec(1,'4s')]));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  assert.equal(intrinsic(effect).effectSummary.inputs[0].valueType.elementType.kind, 'bitvector');
  assert.equal(intrinsic(effect).effectSummary.outputs[0].valueType.elementType.kind, 'float');
  const scaled = liftArm64SimdEffects(instruction('fcvtzs', [vec(2,'2d'), vec(3,'2d'), imm(64)]));
  assert.equal(scaled.completeness, 'exact-with-intrinsic');
  assert.equal(intrinsic(scaled).effectSummary.inputs[0].valueType.elementType.kind, 'float');
  assert.equal(intrinsic(scaled).effectSummary.outputs[0].valueType.elementType.kind, 'bitvector');
}

{
  const effect = liftArm64SimdEffects(instruction('suqadd', [vec(0,'16b'), vec(1,'16b')]));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  assert.ok(intrinsic(effect).effectSummary.registersRead.includes('v0'), 'SUQADD is destructive and must preserve destination-as-input ordering');
}

{
  const effect = liftArm64SimdEffects(instruction('add', [fp(0,64), fp(1,64), fp(2,64)]));
  assert.equal(effect.completeness, 'exact-with-intrinsic', 'Advanced SIMD scalar ADD D must not fall through to GP integer semantics');
  assert.equal(effect.metadata.scalarSimd, true);
  assert.equal(stateOps(effect, 'register-read', 'v1')[0].register.widthBits, 128);
  assert.equal(stateOps(effect, 'register-write', 'v0')[0].register.widthBits, 128);
  assert.equal(stateOps(effect, 'register-write', 'v0')[0].metadata.writePolicy, 'zero-upper-vector-bits');
}

{
  const effect = liftArm64SimdEffects(instruction('fcmeq', [fp(0,32), fp(1,32), fp(2,32)]));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  assert.equal(effect.metadata.scalarSimd, true);
  assert.equal(intrinsic(effect).effectSummary.inputs[0].valueType.kind, 'float');
  assert.equal(intrinsic(effect).effectSummary.outputs[0].valueType.kind, 'bitvector');
}

{
  const effect = liftArm64SimdEffects(instruction('sqadd', [fp(0,8), fp(1,8), fp(2,8)]));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  assert.ok(intrinsic(effect).effectSummary.registersRead.includes('fpsr'));
  assert.ok(intrinsic(effect).effectSummary.registersWritten.includes('fpsr'));
}

{
  const effect = liftArm64SimdEffects(instruction('addp', [fp(0,64), vec(1,'2d')]));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  assert.equal(effect.metadata.scalarSimd, true);
  assert.equal(stateOps(effect, 'register-write', 'v0')[0].register.widthBits, 128);
}

// Negative/proof-oriented structured-shape cases. None may claim exact.
{
  assertPartial(liftArm64SimdEffects(instruction('add', [vec(0,'3s'), vec(1,'3s'), vec(2,'3s')])), /operand-shape-invalid/); // invalid arrangement
  assert.equal(liftArm64SimdEffects(instruction('add', [], 'v0.4s, v1.4s, v2.4s')), null, 'text without structured operands is not exact evidence');
  assertPartial(liftArm64SimdEffects(instruction('add', [vec(0,'4s',64), vec(1,'4s'), vec(2,'4s')])), /operand-shape-invalid/); // wrong vector width
  assertPartial(liftArm64SimdEffects(instruction('ins', [elem(0,'s',1), elem(1,'h',1)])), /lane-width-mismatch/); // wrong lane width
  assertPartial(liftArm64SimdEffects(instruction('add', [vec(32,'4s'), vec(1,'4s'), vec(2,'4s')])), /operand-shape-invalid/); // invalid V register
  assertPartial(liftArm64SimdEffects(instruction('dup', [vec(0,'4s'), gp(31,32)])), /general-source-width-invalid/); // x31/w31 is not a physical GP register
  assertPartial(liftArm64SimdEffects(instruction('add', [vec(0,'4s'), vec(1,'4s'), vec(2,'4s'), vec(3,'4s')])), /operand-shape-invalid/); // malformed decode / extra operand
  assertPartial(liftArm64SimdEffects(instruction('add', [vec(0,'4s'), vec(1,'8h'), vec(2,'4s')])), /operand-shape-invalid/); // arrangement mismatch
  assertPartial(liftArm64SimdEffects(instruction('add', [vec(0,'4s'), vec(1,'4s'), elem(2,'s',0)])), /operand-shape-invalid/); // invalid lane form for mnemonic
  assertPartial(liftArm64SimdEffects(instruction('movi', [vec(0,'4s'), imm(1,{op:'asr',amount:8})])), /arrangement-or-immediate-invalid/); // malformed shift
  assertPartial(liftArm64SimdEffects(instruction('ext', [vec(0,'8b'), vec(1,'8b'), vec(2,'8b'), imm(8)])), /ext-shape-invalid/); // non-canonical masked immediate
}

{
  const effect = liftArm64SimdEffects(instruction('add', [], 'z0.s, z1.s, z2.s'));
  assert.equal(effect.completeness, 'partial');
  assert.match(effect.unknownEffects.reason, /sve-scalable-vector/);
  const structured = liftArm64SimdEffects(instruction('add', [{k:'reg',cls:'z',num:0,bits:128,text:'z0.s'}], 'z0.s, z1.s, z2.s'));
  assert.equal(structured.completeness, 'partial');
}

{
  assert.equal(liftArm64SimdEffects(instruction('add', [gp(0), gp(1), gp(2)])), null, 'scalar ADD is not owned by SIMD');
  assert.equal(liftArm64SimdEffects(instruction('fadd', [fp(0,32), fp(1,32), fp(2,32)])), null, 'scalar FADD is not owned by SIMD');
}

{
  const effect = liftArm64SimdEffects(instruction('mysteryvec', [vec(0,'16b'), vec(1,'16b')]));
  assert.equal(effect.completeness, 'partial');
  assert.match(effect.unknownEffects.reason, /simd-instruction-unsupported/);
}

console.log('arm64 SIMD MachineEffects: PASS');
