import assert from 'node:assert/strict';

import { closeTrustedX86Partial } from '../../js/targets/architecture/x86_64/effects/trusted-decoder-terminal.js';

const DECODER_SEMANTIC = 'capstone-5-x86-structured-v2';
const CAPSTONE_ABI = 'capstone-5-wasm32-x86-detail/v1';

function trustedIretInstruction(family) {
  const rawBytes = family === 'iretq'
    ? new Uint8Array([0x48, 0xcf])
    : new Uint8Array([0xcf]);
  return Object.freeze({
    instructionFamily:family,
    length:rawBytes.length,
    rawBytes,
    decoderSemanticVersion:DECODER_SEMANTIC,
    detailAvailable:true,
    detailStatus:'complete',
    detail:Object.freeze({
      abiContractVersion:CAPSTONE_ABI,
      operands:Object.freeze([]),
      groups:Object.freeze([Object.freeze({ name:'iret' })]),
      eflags:0n,
    }),
  });
}

function failClosedPartial(family) {
  return Object.freeze({
    instructionId:`issue-5563:${family}`,
    architectureId:'x86_64',
    mode:'long-64',
    completeness:'partial',
    controlEffect:Object.freeze({
      kind:'unknown',
      reason:'x86-extended-system-control-effect-unproven',
    }),
    possibleFaults:Object.freeze([]),
  });
}

for (const family of ['iret', 'iretd', 'iretq']) {
  const partial = failClosedPartial(family);
  const result = closeTrustedX86Partial(
    trustedIretInstruction(family),
    'system',
    partial,
  );

  assert.equal(result, partial, `${family} must preserve the upstream fail-closed bundle`);
  assert.equal(result.completeness, 'partial');
  assert.equal(result.controlEffect.kind, 'unknown');
}
