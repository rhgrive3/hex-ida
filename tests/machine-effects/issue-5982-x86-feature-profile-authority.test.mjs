import assert from 'node:assert/strict';

import {
  X86_LONG64_BASE_PROFILE_ID,
  resolveX86Long64FeatureEnvelope,
} from '../../js/targets/architecture/x86_64/feature-contract.js';

const BASE = X86_LONG64_BASE_PROFILE_ID;

function assertMismatch(result, expectedProfileId = null) {
  assert.equal(result.supported, false);
  assert.equal(result.reason, 'x86-feature-profile-mismatch');
  assert.equal(result.profileId, expectedProfileId);
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

console.log('issue-5982-x86-feature-profile-authority: PASS');
