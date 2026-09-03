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

function assertEnvironmentFailClosed(bundle, label) {
  assert.ok(bundle, `${label}:owned`);
  assert.equal(bundle.completeness, 'partial', `${label}:completeness`);
  assert.equal(bundle.controlEffect.kind, 'unknown', `${label}:control`);
  assert.equal(bundle.unknownEffects?.reason, 'x86-int-delivery-state-unmodelled', `${label}:reason`);
  assert.deepEqual(
    new Set(bundle.unknownEffects?.categories),
    new Set(['control','faults','registers','memory','flags']),
    `${label}:unknown-categories`,
  );
  assert.equal(bundle.metadata?.operation, 'int', `${label}:operation`);
  assert.equal(bundle.metadata?.vector, 0x20, `${label}:vector`);
  assert.equal(bundle.metadata?.architecturalTrap, false, `${label}:architectural-trap`);
  assert.equal(bundle.metadata?.interruptDeliveryModeled, false, `${label}:delivery-modeled`);
  assert.equal(bundle.metadata?.failClosed, true, `${label}:fail-closed`);
  assert.equal(bundle.metadata?.terminalizedBy, undefined, `${label}:must-not-terminalize`);
  assert.equal(
    bundle.possibleFaults.some((fault) => fault?.kind === 'software-interrupt' && fault?.condition?.kind === 'always'),
    false,
    `${label}:must-not-claim-unconditional-successful-delivery`,
  );
}

const instruction = intInstruction();
assertEnvironmentFailClosed(liftX86ControlEffects(instruction), 'direct-control-lifter');
assertEnvironmentFailClosed(liftX86MachineEffects(instruction), 'canonical-machine-effects');

const malformed = liftX86MachineEffects(intInstruction(0x20, [0xcd, 0x21]));
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

console.log('issue 3854 x86 INT delivery fail-closed: PASS');
