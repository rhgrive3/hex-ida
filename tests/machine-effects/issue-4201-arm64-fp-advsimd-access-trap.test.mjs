import assert from 'node:assert/strict';

import { validateMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { liftArm64FpEffects } from '../../js/targets/architecture/arm64/effects/fp.js';
import { liftArm64SimdEffects } from '../../js/targets/architecture/arm64/effects/simd.js';

const fp = (num, bits = 32) => ({
  k:'reg', cls:'fp', num, bits,
  text:`${bits === 16 ? 'h' : bits === 32 ? 's' : 'd'}${num}`,
});
const vec = (num, arr) => ({ k:'reg', cls:'vec', num, bits:128, arr, text:`v${num}.${arr}` });
const cond = (text) => ({ k:'cond', text });

function expectedAccessFault(operation) {
  return [{
    kind:'fp-advsimd-access-trap',
    condition:{ kind:'architectural-access-check', access:'fp-advsimd', operation },
  }];
}

function assertAccessControlled(effect, operation, label) {
  assert.ok(effect, `${label}:missing-effect`);
  assert.ok(['exact','exact-with-intrinsic'].includes(effect.completeness), `${label}:not-exact`);
  assert.deepEqual(effect.possibleFaults, expectedAccessFault(operation), `${label}:missing-access-trap`);
  assert.doesNotThrow(() => validateMachineEffectBundle(effect), `${label}:invalid-bundle`);
}

for (const [mnemonic, ops] of [
  ['fadd', [fp(0),fp(1),fp(2)]],
  ['fmov', [fp(0),fp(1)]],
  ['fabs', [fp(0),fp(1)]],
  ['fcmp', [fp(0),fp(1)]],
  ['fcsel', [fp(0),fp(1),fp(2),cond('eq')]],
]) {
  assertAccessControlled(liftArm64FpEffects({
    instructionId:`issue-4201:fp:${mnemonic}`,
    mnemonic,
    ops,
    mode:'a64',
  }), mnemonic, `scalar-${mnemonic}`);
}

for (const [mnemonic, arr] of [
  ['add','4s'],
  ['fadd','4s'],
  ['zip1','16b'],
]) {
  assertAccessControlled(liftArm64SimdEffects({
    instructionId:`issue-4201:simd:${mnemonic}`,
    mnemonic,
    ops:[vec(0,arr),vec(1,arr),vec(2,arr)],
    mode:'a64',
  }), mnemonic, `simd-${mnemonic}`);
}

const malformedFp = liftArm64FpEffects({
  instructionId:'issue-4201:malformed-fp',
  mnemonic:'fadd',
  ops:[],
  mode:'a64',
});
assert.equal(malformedFp.completeness, 'partial');
assert.deepEqual(malformedFp.possibleFaults, [], 'malformed FP must remain fail-closed instead of gaining an exact trap claim');
assert.doesNotThrow(() => validateMachineEffectBundle(malformedFp));

const malformedSimd = liftArm64SimdEffects({
  instructionId:'issue-4201:malformed-simd',
  mnemonic:'add',
  ops:[vec(0,'3s'),vec(1,'3s'),vec(2,'3s')],
  mode:'a64',
});
assert.equal(malformedSimd.completeness, 'partial');
assert.deepEqual(malformedSimd.possibleFaults, [], 'malformed AdvSIMD must remain fail-closed instead of gaining an exact trap claim');
assert.doesNotThrow(() => validateMachineEffectBundle(malformedSimd));

console.log('issue #4201 ARM64 FP/AdvSIMD access-control trap provenance: PASS');
