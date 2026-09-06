import assert from 'node:assert/strict';

import { createX86DecodedInstruction } from '../../../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftX86SimdEffects } from '../../../js/targets/architecture/x86_64/effects/simd.js';
import { x86RegisterDescriptor } from '../../../js/targets/architecture/x86_64/registers.js';

let instructionCode = 0x598600;

function register(registerId, widthBits, access = 'read', registerCode = 1) {
  return { type:'register', registerId, registerCode, widthBits, access };
}

function vectorInstruction({ family, rawBytes, legacy = [], vector = null, operands }) {
  instructionCode += 1;
  return createX86DecodedInstruction({
    address:0x598600n + BigInt(instructionCode),
    length:rawBytes.length,
    rawBytes:Uint8Array.from(rawBytes),
    mode:'long-64',
    instructionId:`issue-5986-${instructionCode}`,
    instructionCode,
    instructionFamily:family,
    mnemonic:family,
    detailAvailable:true,
    detailStatus:'complete',
    detail:{
      abiContractVersion:'capstone-5-wasm32-x86-detail/v1',
      operandCount:operands.length,
      operands,
      implicitReads:[],
      implicitWrites:[],
      prefixes:{ legacy, rex:null, vector },
    },
  });
}

// Core physical-state policy exposes XMM/YMM0-15 only. High XMM/YMM views
// remain decoder evidence until the EVEX lane proves their encoding bits.
assert.ok(x86RegisterDescriptor('xmm15'));
assert.ok(x86RegisterDescriptor('ymm15'));
assert.equal(x86RegisterDescriptor('xmm16'), null);
assert.equal(x86RegisterDescriptor('ymm31'), null);
assert.ok(x86RegisterDescriptor('zmm31'), 'ZMM remains the EVEX-only composite architectural view');

const canonicalVex = vectorInstruction({
  family:'vpxor',
  rawBytes:[0xc5, 0xf9, 0xef, 0xc1],
  vector:{ kind:'vex2', bytes:[0xc5, 0xf9] },
  operands:[
    register('xmm0', 128, 'write'),
    register('xmm0', 128),
    register('xmm1', 128),
  ],
});
const canonicalResult = liftX86SimdEffects(canonicalVex);
assert.equal(canonicalResult.completeness, 'exact');
assert.ok(canonicalResult.operations.length > 0);

function assertHighVectorFailsClosed(instruction, expectedReason) {
  const destination = instruction.detail.operands[0];
  assert.equal(destination.register.modeled, false);
  assert.equal(destination.register.kind, 'decoder-supplementary');
  assert.equal(destination.register.architecturalKind, 'vector');
  const result = liftX86SimdEffects(instruction);
  assert.equal(result.completeness, 'partial');
  assert.equal(result.unknownEffects?.reason, expectedReason);
  assert.equal(result.operations.length, 0, 'unproven high vector registers must emit no definite effects');
}

// VEX cannot encode XMM16-31. The structured register survives only as
// decoder-supplementary evidence and cannot become a modeled SIMD operand.
assertHighVectorFailsClosed(vectorInstruction({
  family:'vpxor',
  rawBytes:[0xc5, 0xf9, 0xef, 0xc1],
  vector:{ kind:'vex2', bytes:[0xc5, 0xf9] },
  operands:[
    register('xmm16', 128, 'write'),
    register('xmm0', 128),
    register('xmm1', 128),
  ],
}), 'x86-vpxor-operand-shape-unmodelled');

// The same authority boundary applies to 256-bit VEX YMM16-31 and legacy SSE.
assertHighVectorFailsClosed(vectorInstruction({
  family:'vpxor',
  rawBytes:[0xc5, 0xfd, 0xef, 0xc1],
  vector:{ kind:'vex2', bytes:[0xc5, 0xfd] },
  operands:[
    register('ymm16', 256, 'write'),
    register('ymm0', 256),
    register('ymm1', 256),
  ],
}), 'x86-vpxor-operand-shape-unmodelled');

assertHighVectorFailsClosed(vectorInstruction({
  family:'pxor',
  rawBytes:[0x66, 0x0f, 0xef, 0xc1],
  legacy:[0x66],
  operands:[
    register('xmm16', 128, 'read-write'),
    register('xmm1', 128),
  ],
}), 'x86-pxor-operand-shape-unmodelled');

// EVEX itself remains fail-closed under the existing physical-state policy;
// this change does not prematurely enable high-vector exact semantics.
assertHighVectorFailsClosed(vectorInstruction({
  family:'vpxor',
  rawBytes:[0x62, 0x01, 0x04, 0x00, 0xef, 0xc1],
  vector:{ kind:'evex', bytes:[0x62, 0x01, 0x04, 0x00] },
  operands:[
    register('xmm16', 128, 'write'),
    register('xmm0', 128),
    register('xmm1', 128),
  ],
}), 'x86-evex-physical-state-unmodelled');

console.log('issue-5986 x86 high XMM/YMM EVEX authority: ok');
