import assert from 'node:assert/strict';

import {
  X86_LONG64_BASE_PROFILE_ID,
  resolveX86Long64FeatureEnvelope,
} from '../../js/targets/architecture/x86_64/feature-contract.js';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';

const BASE = X86_LONG64_BASE_PROFILE_ID;

function assertMismatch(result, expectedProfileId = null) {
  assert.equal(result.supported, false);
  assert.equal(result.reason, 'x86-feature-profile-mismatch');
  assert.equal(result.profileId, expectedProfileId);
}

function trustedNop(featureProfileId = BASE) {
  return {
    contractVersion:'x86-64-decoded-instruction/v1',
    decoderSemanticVersion:'capstone-5-x86-structured-v2',
    mode:'long-64',
    instructionId:'issue-5982:trusted-nop',
    instructionCode:1,
    instructionFamily:'nop',
    mnemonic:'nop',
    address:0x1000n,
    length:1,
    rawBytes:Uint8Array.of(0x90),
    detailStatus:'complete',
    featureProfileId,
    detail:{
      abiContractVersion:'capstone-5-wasm32-x86-detail/v1',
      operandCount:0,
      operands:[],
      prefixes:{ legacy:[], rex:null, vector:null },
      implicitReads:[],
      implicitWrites:[],
    },
  };
}

const omitted = resolveX86Long64FeatureEnvelope();
assert.equal(omitted.supported, true);
assert.equal(omitted.profileId, BASE);

for (const [name, result] of [
  ['context.targetProfileId', resolveX86Long64FeatureEnvelope({}, { targetProfileId:BASE })],
  ['context.featureProfileId', resolveX86Long64FeatureEnvelope({}, { featureProfileId:BASE })],
  ['instruction.featureProfileId', resolveX86Long64FeatureEnvelope({ featureProfileId:BASE }, {})],
]) {
  assert.equal(result.supported, true, `${name} must accept the canonical primitive profile id`);
  assert.equal(result.profileId, BASE, `${name} must preserve the canonical profile id`);
}

assertMismatch(
  resolveX86Long64FeatureEnvelope({}, { featureProfileId:'x86_64:not-base' }),
  'x86_64:not-base',
);

for (const [name, result] of [
  ['context.targetProfileId', resolveX86Long64FeatureEnvelope({}, { targetProfileId:[BASE] })],
  ['context.featureProfileId', resolveX86Long64FeatureEnvelope({}, { featureProfileId:[BASE] })],
  ['instruction.featureProfileId', resolveX86Long64FeatureEnvelope({ featureProfileId:[BASE] }, {})],
]) {
  assertMismatch(result);
  assert.equal(result.profileId, null, `${name} must not launder an Array into the base profile`);
}

const malformedHigherPriority = resolveX86Long64FeatureEnvelope(
  { featureProfileId:BASE },
  { targetProfileId:[BASE], featureProfileId:BASE },
);
assertMismatch(malformedHigherPriority);

let coercionCalls = 0;
const hostileProfile = {
  [Symbol.toPrimitive]() {
    coercionCalls += 1;
    return BASE;
  },
  toString() {
    coercionCalls += 1;
    return BASE;
  },
};
assertMismatch(resolveX86Long64FeatureEnvelope({}, { targetProfileId:hostileProfile }));
assert.equal(coercionCalls, 0, 'feature profile authority must not invoke coercion hooks');

for (const malformed of [true, 1, '', false]) {
  assertMismatch(resolveX86Long64FeatureEnvelope({}, { featureProfileId:malformed }));
}

const malformedFeatureState = resolveX86Long64FeatureEnvelope({}, {
  targetProfileId:BASE,
  x86FeatureState:{ cet:true },
});
assert.equal(malformedFeatureState.supported, false);
assert.equal(malformedFeatureState.reason, 'x86-feature-state-malformed');

const cetShadowStack = resolveX86Long64FeatureEnvelope({}, {
  targetProfileId:BASE,
  x86FeatureState:{ cet:{ shadowStackEnabled:true } },
});
assert.equal(cetShadowStack.supported, false);
assert.equal(cetShadowStack.reason, 'x86-cet-shadow-stack-requires-feature-enabled-profile');

const cetIbt = resolveX86Long64FeatureEnvelope({}, {
  targetProfileId:BASE,
  x86FeatureState:{ cet:{ indirectBranchTrackingEnabled:true } },
});
assert.equal(cetIbt.supported, false);
assert.equal(cetIbt.reason, 'x86-cet-ibt-requires-feature-enabled-profile');

const mpx = resolveX86Long64FeatureEnvelope({}, {
  targetProfileId:BASE,
  x86FeatureState:{ mpx:{ enabled:true } },
});
assert.equal(mpx.supported, false);
assert.equal(mpx.reason, 'x86-mpx-requires-feature-enabled-profile');

const canonicalMachineEffects = liftX86MachineEffects(trustedNop());
assert.equal(canonicalMachineEffects?.completeness, 'exact');
assert.equal(canonicalMachineEffects?.statePreservation?.proven, true);
assert.equal(canonicalMachineEffects?.metadata?.featureProfileId, BASE);

for (const [name, featureProfileId] of [
  ['array', [BASE]],
  ['object', { profileId:BASE }],
]) {
  const result = liftX86MachineEffects(trustedNop(featureProfileId));
  assert.equal(result?.completeness, 'partial', `${name} profile must remain fail-closed after trusted decode`);
  assert.equal(result?.unknownEffects?.reason, 'x86-feature-profile-mismatch');
  assert.equal(result?.metadata?.failClosed, true);
  assert.equal(result?.metadata?.featureProfileId, null);
  assert.equal(result?.metadata?.terminalizedBy, undefined, `${name} profile must not gain trusted-terminal exact authority`);
}

console.log('issue-5982-x86-feature-profile-authority: PASS');
