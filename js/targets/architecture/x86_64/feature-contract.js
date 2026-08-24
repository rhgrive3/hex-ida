export const X86_LONG64_FEATURE_CONTRACT_VERSION = 'x86-long64-feature-envelope/v1';
export const X86_LONG64_BASE_PROFILE_ID = 'x86_64:long-64';

export const X86_LONG64_RESERVED_FEATURE_PROFILES = Object.freeze({
  cetShadowStack:'x86_64:long-64+cet-shadow-stack',
  cetIndirectBranchTracking:'x86_64:long-64+cet-ibt',
  mpx:'x86_64:long-64+mpx',
});

export const X86_LONG64_BASE_FEATURE_STATE = Object.freeze({
  cet:Object.freeze({ shadowStackEnabled:false, indirectBranchTrackingEnabled:false }),
  mpx:Object.freeze({ enabled:false, bndPreserve:null }),
});

export const X86_LONG64_FEATURE_PROFILE = Object.freeze({
  contractVersion:X86_LONG64_FEATURE_CONTRACT_VERSION,
  profileId:X86_LONG64_BASE_PROFILE_ID,
  scopeResolution:'ambiguous-frozen-contract-made-explicit-without-denominator-subtraction',
  featureState:X86_LONG64_BASE_FEATURE_STATE,
  reservedFeatureProfiles:X86_LONG64_RESERVED_FEATURE_PROFILES,
  authorities:Object.freeze([
    'intel-sdm-vol1-64-bit-mode-near-branch-semantics',
    'intel-sdm-vol1-control-flow-enforcement-shadow-stack',
    'intel-sdm-vol1-mpx-branch-prefix-bndpreserve',
  ]),
});

function bool(value, code) {
  if (typeof value !== 'boolean') throw new TypeError(code);
  return value;
}

function normalizeFeatureState(input) {
  if (input == null) return X86_LONG64_BASE_FEATURE_STATE;
  if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('x86-feature-state-object-required');
  const cetInput = input.cet ?? {};
  const mpxInput = input.mpx ?? {};
  if (typeof cetInput !== 'object' || Array.isArray(cetInput)) throw new TypeError('x86-cet-feature-state-object-required');
  if (typeof mpxInput !== 'object' || Array.isArray(mpxInput)) throw new TypeError('x86-mpx-feature-state-object-required');
  const shadowStackEnabled = cetInput.shadowStackEnabled == null ? false : bool(cetInput.shadowStackEnabled, 'x86-cet-shadow-stack-feature-state-invalid');
  const indirectBranchTrackingEnabled = cetInput.indirectBranchTrackingEnabled == null ? false : bool(cetInput.indirectBranchTrackingEnabled, 'x86-cet-ibt-feature-state-invalid');
  const enabled = mpxInput.enabled == null ? false : bool(mpxInput.enabled, 'x86-mpx-feature-state-invalid');
  let bndPreserve = mpxInput.bndPreserve ?? null;
  if (bndPreserve != null) bndPreserve = bool(bndPreserve, 'x86-mpx-bndpreserve-feature-state-invalid');
  if (!enabled && bndPreserve != null) throw new TypeError('x86-mpx-bndpreserve-requires-mpx-enabled');
  return Object.freeze({
    cet:Object.freeze({ shadowStackEnabled, indirectBranchTrackingEnabled }),
    mpx:Object.freeze({ enabled, bndPreserve }),
  });
}

export function resolveX86Long64FeatureEnvelope(instruction = {}, context = {}) {
  const profileId = String(
    context.targetProfileId
    ?? context.featureProfileId
    ?? instruction.featureProfileId
    ?? X86_LONG64_BASE_PROFILE_ID
  );
  if (profileId !== X86_LONG64_BASE_PROFILE_ID) {
    return Object.freeze({ supported:false, profileId, reason:'x86-feature-profile-mismatch', contractVersion:X86_LONG64_FEATURE_CONTRACT_VERSION });
  }

  let featureState;
  try {
    featureState = normalizeFeatureState(context.x86FeatureState ?? instruction.featureState ?? null);
  } catch (error) {
    return Object.freeze({
      supported:false,
      profileId,
      reason:'x86-feature-state-malformed',
      detail:String(error?.message || error),
      contractVersion:X86_LONG64_FEATURE_CONTRACT_VERSION,
    });
  }

  if (featureState.cet.shadowStackEnabled) {
    return Object.freeze({ supported:false, profileId, featureState, reason:'x86-cet-shadow-stack-requires-feature-enabled-profile', contractVersion:X86_LONG64_FEATURE_CONTRACT_VERSION });
  }
  if (featureState.cet.indirectBranchTrackingEnabled) {
    return Object.freeze({ supported:false, profileId, featureState, reason:'x86-cet-ibt-requires-feature-enabled-profile', contractVersion:X86_LONG64_FEATURE_CONTRACT_VERSION });
  }
  if (featureState.mpx.enabled) {
    return Object.freeze({ supported:false, profileId, featureState, reason:'x86-mpx-requires-feature-enabled-profile', contractVersion:X86_LONG64_FEATURE_CONTRACT_VERSION });
  }

  return Object.freeze({
    supported:true,
    profileId,
    featureState,
    contractVersion:X86_LONG64_FEATURE_CONTRACT_VERSION,
    scopeResolution:X86_LONG64_FEATURE_PROFILE.scopeResolution,
  });
}
