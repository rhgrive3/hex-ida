const ACCESS_FAULT_KIND = 'fp-advsimd-access-trap';
const ACCESS_CONDITION_KIND = 'arm64-fp-advsimd-access-check';

function canonicalState(value) {
  return value === 'allowed' || value === 'trapped' || value === 'unknown' ? value : null;
}

function canonicalCurrentEL(value) {
  return Number.isInteger(value) && value >= 0 && value <= 3 ? value : null;
}

function canonicalFpen(value) {
  return Number.isInteger(value) && value >= 0 && value <= 3 ? value : null;
}

function canonicalBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function allowed(reason) {
  return Object.freeze({ state:'allowed', reason });
}

function trapped(reason, trapTargetEL) {
  return Object.freeze({ state:'trapped', reason, trapTargetEL });
}

function unknown(reason) {
  return Object.freeze({ state:'unknown', reason });
}

function cpacrEl1Decision(input, currentEL) {
  if (currentEL > 1) return allowed('cpacr-el1-not-applicable');

  const el2Enabled = canonicalBoolean(input?.el2Enabled);
  const hcrEl2E2h = canonicalBoolean(input?.hcrEl2E2h);
  const hcrEl2Tge = canonicalBoolean(input?.hcrEl2Tge);

  // IsInHost() is true for host EL0 only in the VHE E2H+TGE regime. In that
  // regime CPACR_EL1 does not control the host FP/AdvSIMD access check.
  if (currentEL === 0) {
    if (el2Enabled == null) return unknown('el2-enabled-unproven');
    if (el2Enabled === true) {
      if (hcrEl2E2h == null) return unknown('hcr-el2-e2h-unproven');
      if (hcrEl2E2h === true) {
        if (hcrEl2Tge == null) return unknown('hcr-el2-tge-unproven');
        if (hcrEl2Tge === true) return allowed('cpacr-el1-skipped-in-vhe-host');
      }
    }
  }

  const fpen = canonicalFpen(input?.cpacrEl1Fpen);
  if (fpen == null) return unknown('cpacr-el1-fpen-unproven');
  if (fpen === 3) return allowed('cpacr-el1-fpen-allows-fp-advsimd');
  if (fpen === 1 && currentEL === 1) return allowed('cpacr-el1-fpen-allows-el1-fp-advsimd');
  return trapped('cpacr-el1-fpen-traps-fp-advsimd', 1);
}

function cptrEl2Decision(input, currentEL) {
  if (currentEL === 3) return allowed('cptr-el2-not-applicable');

  const el2Enabled = canonicalBoolean(input?.el2Enabled);
  if (el2Enabled == null) return unknown('el2-enabled-unproven');
  if (el2Enabled === false) return allowed('el2-disabled');

  const hcrEl2E2h = canonicalBoolean(input?.hcrEl2E2h);
  if (hcrEl2E2h == null) return unknown('hcr-el2-e2h-unproven');

  if (hcrEl2E2h === false) {
    const tfp = canonicalBoolean(input?.cptrEl2Tfp);
    if (tfp == null) return unknown('cptr-el2-tfp-unproven');
    return tfp
      ? trapped('cptr-el2-tfp-traps-fp-advsimd', 2)
      : allowed('cptr-el2-tfp-allows-fp-advsimd');
  }

  const fpen = canonicalFpen(input?.cptrEl2Fpen);
  if (fpen == null) return unknown('cptr-el2-fpen-unproven');
  if (fpen === 3) return allowed('cptr-el2-fpen-allows-fp-advsimd');
  if (fpen === 0 || fpen === 2) return trapped('cptr-el2-fpen-traps-fp-advsimd', 2);

  // CPTR_EL2.FPEN=01 only disables EL0 when the host TGE regime is active.
  if (currentEL !== 0) return allowed('cptr-el2-fpen-allows-non-el0-fp-advsimd');
  const hcrEl2Tge = canonicalBoolean(input?.hcrEl2Tge);
  if (hcrEl2Tge == null) return unknown('hcr-el2-tge-unproven');
  return hcrEl2Tge
    ? trapped('cptr-el2-fpen-traps-host-el0-fp-advsimd', 2)
    : allowed('cptr-el2-fpen-allows-guest-el0-fp-advsimd');
}

function cptrEl3Decision(input, currentEL) {
  if (currentEL === 3) return allowed('cptr-el3-not-applicable');

  const el3Present = canonicalBoolean(input?.el3Present);
  if (el3Present == null) return unknown('el3-presence-unproven');
  if (el3Present === false) return allowed('el3-not-present');

  const tfp = canonicalBoolean(input?.cptrEl3Tfp);
  if (tfp == null) return unknown('cptr-el3-tfp-unproven');
  return tfp
    ? trapped('cptr-el3-tfp-traps-fp-advsimd', 3)
    : allowed('cptr-el3-tfp-allows-fp-advsimd');
}

function rawAccessDecision(input) {
  const currentEL = canonicalCurrentEL(input?.currentEL);
  if (currentEL == null) return unknown('current-el-unproven');

  const decisions = [
    cptrEl3Decision(input, currentEL),
    cptrEl2Decision(input, currentEL),
    cpacrEl1Decision(input, currentEL),
  ];

  let higherControlUnknown = false;
  for (const decision of decisions) {
    if (decision.state === 'unknown') {
      higherControlUnknown = true;
      continue;
    }
    if (decision.state === 'trapped') {
      return Object.freeze({
        ...decision,
        ...(higherControlUnknown ? { trapTargetEL:undefined } : {}),
      });
    }
  }

  if (decisions.every((decision) => decision.state === 'allowed')) {
    return allowed('validated-architectural-controls-allow-fp-advsimd');
  }
  return unknown('fp-advsimd-access-controls-incomplete');
}

function accessDecision(context = {}) {
  const input = context?.fpAdvSimdAccess;
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return Object.freeze({ state:'unknown', source:'execution-context-unproven' });
  }

  const rawDecision = rawAccessDecision(input);
  const explicitState = canonicalState(input.state);
  const explicitProof = input.proven === true;
  const source = typeof input.source === 'string' && input.source.trim()
    ? input.source.trim()
    : 'execution-context';

  // A caller-controlled {state, proven} record is not authority. Only the
  // canonical architectural controls above can suppress the access fault.
  // Preserve contradictory labels as diagnostics without weakening raw proof.
  const evidenceConflict = explicitProof
    && explicitState != null
    && explicitState !== 'unknown'
    && rawDecision.state !== 'unknown'
    && explicitState !== rawDecision.state;

  return Object.freeze({
    ...rawDecision,
    source,
    ...(evidenceConflict ? { evidenceConflict:true } : {}),
  });
}

export function arm64FpAdvSimdAccessTrapFault(mnemonic, context = {}) {
  if (typeof mnemonic !== 'string') return null;
  const operation = mnemonic.trim().toLowerCase();
  if (!operation) return null;

  const decision = accessDecision(context);
  if (decision.state === 'allowed') return null;

  return Object.freeze({
    kind:ACCESS_FAULT_KIND,
    condition:Object.freeze({
      kind:ACCESS_CONDITION_KIND,
      operation,
      accessState:decision.state,
      ...(decision.reason == null ? {} : { reason:decision.reason }),
      ...(decision.trapTargetEL == null ? {} : { trapTargetEL:decision.trapTargetEL }),
      ...(decision.evidenceConflict === true ? { evidenceConflict:true } : {}),
    }),
    detail:Object.freeze({
      architecture:'arm64',
      synchronous:true,
      normalCompletionEffectsCommitOnFault:false,
      ordering:'before-fp-simd-execution',
      accessControlRegisters:Object.freeze([
        'CPACR_EL1.FPEN',
        'HCR_EL2.E2H',
        'HCR_EL2.TGE',
        'CPTR_EL2.FPEN',
        'CPTR_EL2.TFP',
        'CPTR_EL3.TFP',
      ]),
      evidenceSource:decision.source,
    }),
  });
}
