import assert from 'node:assert/strict';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftX86ControlEffects } from '../../js/targets/architecture/x86_64/effects/control.js';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';

const DECODER_SEMANTIC = 'capstone-5-x86-structured-v2';
const DECODER_ABI = 'capstone-5-wasm32-x86-detail/v1';

function decoded(family, bytes, operands = [], groups = []) {
  return createX86DecodedInstruction({
    instructionId:`issue-3854:${family}:${bytes.join('-')}`,
    instructionCode:1,
    instructionFamily:family,
    address:0x400000n,
    length:bytes.length,
    rawBytes:Uint8Array.from(bytes),
    mode:'long-64',
    decoderSemanticVersion:DECODER_SEMANTIC,
    detailAvailable:true,
    detailStatus:'complete',
    detail:{
      abiContractVersion:DECODER_ABI,
      operandCount:operands.length,
      operands,
      implicitReads:[],
      implicitWrites:[],
      registersRead:[],
      registersWritten:[],
      groups,
      eflags:0n,
      addressSizeBits:64,
      prefixes:{ legacy:[], rex:null, vector:null },
    },
  });
}

function intInstruction(vector = 0x20, bytes = [0xcd, vector]) {
  return decoded('int', bytes, [{
    type:'immediate',
    value:BigInt(vector),
    widthBits:8,
    encodedWidthBits:8,
    access:'read',
  }], [{ id:4, name:'int' }]);
}

function assertIntDeliveryIntrinsic(bundle, label) {
  assert.ok(bundle, `${label}:owned`);
  assert.equal(bundle.completeness, 'exact-with-intrinsic', `${label}:completeness`);
  assert.equal(bundle.controlEffect.kind, 'indirect', `${label}:control`);
  assert.equal(bundle.controlEffect.target?.kind, 'x86-interrupt-delivery-target', `${label}:control-target`);
  assert.equal(bundle.controlEffect.target?.vector, 0x20, `${label}:target-vector`);
  assert.equal(bundle.controlEffect.target?.contract, 'x86-long64-interrupt-delivery/v1', `${label}:target-contract`);
  assert.equal(bundle.controlEffect.target?.address, undefined, `${label}:no-invented-address`);
  assert.equal(bundle.unknownEffects, undefined, `${label}:no-unknown-effects`);

  assert.equal(bundle.metadata?.operation, 'int', `${label}:operation`);
  assert.equal(bundle.metadata?.vector, 0x20, `${label}:vector`);
  assert.equal(bundle.metadata?.architecturalTrap, false, `${label}:architectural-trap`);
  assert.equal(bundle.metadata?.interruptDeliveryModeled, true, `${label}:delivery-modeled`);
  assert.equal(bundle.metadata?.environmentExact, true, `${label}:environment-exact`);

  const intrinsicOp = bundle.operations.find((op) => op.kind === 'intrinsic');
  assert.ok(intrinsicOp, `${label}:has-intrinsic-op`);
  assert.equal(intrinsicOp.intrinsicId, 'x86.control.interrupt-delivery', `${label}:intrinsic-id`);
  assert.equal(intrinsicOp.metadata?.summaryContractVersion, 'x86-intrinsic-summary/v1', `${label}:intrinsic-contract`);
  assert.equal(intrinsicOp.metadata?.deliveryContract, 'x86-long64-interrupt-delivery/v1', `${label}:delivery-contract`);
  assert.equal(intrinsicOp.effectSummary.inputs.length, 4, `${label}:vector-return-rip-rsp-rflags-inputs`);
  assert.equal(intrinsicOp.effectSummary.inputs[0].value, '32', `${label}:vector-input`);
  assert.equal(intrinsicOp.effectSummary.memoryRead.scope, 'all', `${label}:declared-memory-read-scope`);
  assert.deepEqual(intrinsicOp.effectSummary.memoryRead.spaces, ['memory'], `${label}:declared-memory-read-space`);
  assert.equal(intrinsicOp.effectSummary.memoryRead.detail?.kind, 'x86-interrupt-delivery-reads', `${label}:read-detail`);
  assert.equal(intrinsicOp.effectSummary.memoryWrite.scope, 'all', `${label}:declared-memory-write-scope`);
  assert.deepEqual(intrinsicOp.effectSummary.memoryWrite.spaces, ['memory'], `${label}:declared-memory-write-space`);
  assert.equal(intrinsicOp.effectSummary.memoryWrite.detail?.kind, 'x86-interrupt-delivery-writes', `${label}:write-detail`);
  assert.ok(intrinsicOp.effectSummary.registersRead.includes('sys:x86.IDTR'), `${label}:reads-IDTR`);
  assert.ok(intrinsicOp.effectSummary.registersRead.includes('sys:x86.CPL'), `${label}:reads-CPL`);
  assert.ok(intrinsicOp.effectSummary.registersRead.includes('sys:x86.GDTR'), `${label}:reads-GDTR`);
  assert.ok(intrinsicOp.effectSummary.registersRead.includes('sys:x86.TR'), `${label}:reads-TR`);
  assert.ok(intrinsicOp.effectSummary.registersRead.includes('rsp'), `${label}:reads-rsp`);
  assert.ok(intrinsicOp.effectSummary.registersRead.includes('rflags'), `${label}:reads-rflags`);
  assert.ok(intrinsicOp.effectSummary.registersWritten.includes('rsp'), `${label}:writes-rsp`);
  assert.ok(intrinsicOp.effectSummary.registersWritten.includes('rflags'), `${label}:writes-rflags`);
  assert.ok(intrinsicOp.effectSummary.registersWritten.includes('sys:x86.CS'), `${label}:writes-CS`);
  assert.ok(intrinsicOp.effectSummary.registersWritten.includes('sys:x86.SS'), `${label}:writes-SS`);
  assert.deepEqual(intrinsicOp.effectSummary.controlEffects, [bundle.controlEffect], `${label}:intrinsic-control-effect`);

  assert.equal(
    bundle.possibleFaults.some((fault) => fault?.kind === 'software-interrupt' && fault?.condition?.kind === 'always'),
    false,
    `${label}:must-not-claim-unconditional-successful-delivery`,
  );
  assert.ok(bundle.possibleFaults.some((f) => f.kind === 'general-protection'), `${label}:has-gp-fault`);
  assert.ok(bundle.possibleFaults.some((f) => f.kind === 'segment-not-present'), `${label}:has-np-fault`);
  assert.ok(bundle.possibleFaults.some((f) => f.kind === 'stack-segment'), `${label}:has-ss-fault`);
}

const instruction = intInstruction();
assertIntDeliveryIntrinsic(liftX86ControlEffects(instruction), 'direct-control-lifter');
assertIntDeliveryIntrinsic(liftX86MachineEffects(instruction), 'canonical-machine-effects');

const malformed = liftX86ControlEffects(intInstruction(0x20, [0xcd, 0x21]));
assert.ok(malformed, 'malformed-int-owned');
assert.equal(malformed.completeness, 'partial');
assert.equal(malformed.controlEffect.kind, 'unknown');
assert.equal(malformed.unknownEffects?.reason, 'x86-int-encoding-unmodelled');

for (const [family, bytes, expectedReason, expectedVector] of [
  ['int3', [0xcc], 'x86-int3-breakpoint', '#BP'],
  ['int1', [0xf1], 'x86-int1-icebp', '#DB'],
]) {
  const bundle = liftX86MachineEffects(decoded(family, bytes, [], [{ id:4, name:'int' }]));
  assert.ok(bundle, `${family}:owned`);
  assert.equal(bundle.completeness, 'exact', `${family}:exact`);
  assert.equal(bundle.controlEffect.kind, 'trap', `${family}:trap`);
  assert.equal(bundle.controlEffect.reason, expectedReason, `${family}:reason`);
  assert.ok(bundle.possibleFaults.some((fault) => fault?.detail?.vector === expectedVector), `${family}:vector`);
}

console.log('issue 3854 x86 INT delivery typed intrinsic: PASS');
