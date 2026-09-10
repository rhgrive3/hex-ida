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

function explicitTrapTargetEL(value) {
  return Number.isInteger(value) && value >= 1 && value <= 3 ? value : null;
}

function rawTrapDecision(input) {
  const currentEL = canonicalCurrentEL(input?.currentEL);
  if (currentEL == null) return null;

  const el3Present = canonicalBoolean(input?.el3Present);
  const el2Enabled = canonicalBoolean(input?.el2Enabled);
  const cptrEl3Tfp = canonicalBoolean(input?.cptrEl3Tfp);
  const cptrEl2Tfp = canonicalBoolean(input?.cptrEl2Tfp);
  const cpacrEl1Fpen = canonicalFpen(input?.cpacrEl1Fpen);

  if (currentEL < 3 && el3Present === true && cptrEl3Tfp === true) {
    return Object.freeze({
      state:'trapped',
      reason:'cptr-el3-tfp-traps-fp-advsimd',
      trapTargetEL:3,
    });
  }
  if (currentEL < 2 && el2Enabled === true && cptrEl2Tfp === true) {
    const higherTrapExcluded = el3Present === false
      || (el3Present === true && cptrEl3Tfp === false);
    return Object.freeze({
      state:'trapped',
      reason:'cptr-el2-tfp-traps-fp-advsimd',
      ...(higherTrapExcluded ? { trapTargetEL:2 } : {}),
    });
  }
  if (currentEL <= 1 && cpacrEl1Fpen === 0) {
    const higherTrapExcluded = el3Present === false && el2Enabled === false;
    return Object.freeze({
      state:'trapped',
      reason:'cpacr-el1-fpen-traps-fp-advsimd',
      ...(higherTrapExcluded ? { trapTargetEL:1 } : {}),
    });
  }
  return null;
}

function accessDecision(context = {}) {
  const input = context?.fpAdvSimdAccess;
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return Object.freeze({ state:'unknown', source:'execution-context-unproven' });
  }

  const explicitState = canonicalState(input.state);
  const explicitProof = input.proven === true;
  const rawTrap = rawTrapDecision(input);
  const source = typeof input.source === 'string' && input.source.trim()
    ? input.source.trim()
    : 'execution-context';

  if (rawTrap && explicitState === 'allowed' && explicitProof) {
    return Object.freeze({
      state:'unknown',
      source,
      reason:'contradictory-fp-advsimd-access-evidence',
      evidenceConflict:true,
    });
  }
  if (rawTrap) return Object.freeze({ ...rawTrap, source });

  if (explicitState === 'trapped' && explicitProof) {
    const trapTargetEL = explicitTrapTargetEL(input.trapTargetEL);
    return Object.freeze({
      state:'trapped',
      source,
      reason:'explicit-fp-advsimd-access-trap-proof',
      ...(trapTargetEL == null ? {} : { trapTargetEL }),
    });
  }
  if (explicitState === 'allowed' && explicitProof) {
    return Object.freeze({ state:'allowed', source });
  }
  return Object.freeze({ state:'unknown', source });
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
        'CPTR_EL2.TFP',
        'CPTR_EL3.TFP',
      ]),
      evidenceSource:decision.source,
    }),
  });
}
