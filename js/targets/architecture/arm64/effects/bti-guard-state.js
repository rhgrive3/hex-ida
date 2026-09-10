import {
  createBitVectorValue,
  createIntrinsicEffectSummary,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
  createTemporaryValue,
} from '../../../../semantics/effects/index.js';

export const ARM64_BTI_PAGE_GUARD_STATE_ID = 'arm64.exec-page.guarded';

const ARM64_BTYPE_REGISTER_ID = 'pstate.btype';
const ARM64_BTYPE_PRODUCERS = new Set(['br','braa','brab','braaz','brabz','blr','blraa','blrab','blraaz','blrabz']);

// PACIASP/PACIBSP carry an implicit BTI landing pad (FEAT_BTI): incoming
// BTYPE 0b01/0b10 are always compatible, 0b11 compatibility depends on the
// SCTLR_ELx.BT policy, and an incompatible branch target must fault before
// the pointer authentication executes. They are landing instructions even
// though their mnemonic is not literally `bti`.
export const ARM64_IMPLICIT_BTI_LANDING_MNEMONICS = new Set(['paciasp', 'pacibsp']);
const IMPLICIT_LANDING_PAD_KIND = 'implicit-cj';

function mnemonicOf(instruction) {
  if (typeof instruction?.mnemonic !== 'string') return '';
  return instruction.mnemonic.trim().toLowerCase();
}

function deepCopyEvidence(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(deepCopyEvidence);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepCopyEvidence(item)]));
  return value;
}

function parseGuardedField(val) {
  if (val === undefined || val === null) return { present:false };
  if (val === true || val === 'guarded') return { present:true, kind:'guarded', bool:true };
  if (val === false || val === 'unguarded') return { present:true, kind:'unguarded', bool:false };
  if (val === 'unknown') return { present:true, kind:'unknown', bool:null };
  return { present:true, kind:'malformed', bool:null, raw:val };
}

export function normalizeArm64BtiGuardedPageState(input = null) {
  if (typeof input === 'boolean') {
    return Object.freeze({
      state:input ? 'guarded' : 'unguarded',
      mappedPageGuarded:input,
      source:'explicit-execution-context',
      evidence:null,
      loaderPolicy:null,
    });
  }
  if (!input || typeof input !== 'object') {
    return Object.freeze({
      state:'unknown', mappedPageGuarded:null, source:'not-observed', evidence:null, loaderPolicy:null,
    });
  }
  const fMapped = parseGuardedField(input.mappedPageGuarded);
  const fGuarded = parseGuardedField(input.guarded);
  const fGuardedPage = parseGuardedField(input.guardedPage);
  const fState = parseGuardedField(input.state);
  const presentFields = [fMapped, fGuarded, fGuardedPage, fState].filter((f) => f.present);
  const hasMalformed = presentFields.some((f) => f.kind === 'malformed');
  const hasGuarded = presentFields.some((f) => f.kind === 'guarded');
  const hasUnguarded = presentFields.some((f) => f.kind === 'unguarded');
  let state = 'unknown';
  let mappedPageGuarded = null;
  let conflict = input.conflict === true;
  let conflictReason = conflict
    ? (typeof input.conflictReason === 'string' && input.conflictReason.trim()
      ? input.conflictReason.trim()
      : 'conflicting-guarded-page-state')
    : null;
  if (conflict) {
    // Preserve a prior normalized conflict; null aliases must not make it selectable.
  } else if (hasMalformed) {
    conflict = true;
    conflictReason = 'malformed-guarded-page-state-alias';
  } else if (hasGuarded && hasUnguarded) {
    conflict = true;
    conflictReason = 'conflicting-guarded-page-state-aliases';
  } else if (hasGuarded) {
    state = 'guarded';
    mappedPageGuarded = true;
  } else if (hasUnguarded) {
    state = 'unguarded';
    mappedPageGuarded = false;
  }
  const sourceEvidence = deepCopyEvidence(input.evidence ?? input.mappingEvidence ?? null);
  const evidence = conflict
    ? {
      ...(sourceEvidence && typeof sourceEvidence === 'object' && !Array.isArray(sourceEvidence) ? sourceEvidence : {}),
      conflict:{ reason:conflictReason },
    }
    : sourceEvidence;
  return Object.freeze({
    state,
    mappedPageGuarded,
    source:String(input.source || input.mappedPageGuardedSource || (conflict ? 'conflicting-execution-context' : 'execution-context')),
    evidence,
    loaderPolicy:deepCopyEvidence(input.loaderPolicy ?? input.elfPolicy ?? null),
    ...(conflict ? { conflict:true, conflictReason } : {}),
  });
}

export function arm64BtiGuardedPageStateFromImage(image, address, runtime = {}) {
  const loaderPolicy = image?.metadata?.arm64Bti ?? null;
  const actual = runtime.mappedPageGuarded ?? runtime.guardedPage ?? null;
  if (typeof actual === 'boolean') {
    return normalizeArm64BtiGuardedPageState({
      mappedPageGuarded:actual,
      source:runtime.source || 'runtime-mapping',
      mappingEvidence:{
        address:address == null ? null : String(address),
        ...(runtime.evidence == null ? {} : { runtime:runtime.evidence }),
      },
      loaderPolicy,
    });
  }
  return normalizeArm64BtiGuardedPageState({
    state:'unknown',
    source:'loader-policy-is-not-runtime-page-state',
    mappingEvidence:{ address:address == null ? null : String(address) },
    loaderPolicy,
  });
}

function landingKindOf(instruction) {
  const operands = Array.isArray(instruction?.ops)
    ? instruction.ops
    : Array.isArray(instruction?.parsed)
      ? instruction.parsed
      : Array.isArray(instruction?.operandsParsed)
        ? instruction.operandsParsed
        : [];
  const structuredText = operands[0]?.text;
  let raw = '';
  if (structuredText != null) {
    if (typeof structuredText !== 'string') return null;
    raw = structuredText;
  } else if (instruction?.operands != null) {
    if (typeof instruction.operands !== 'string') return null;
    raw = instruction.operands;
  }
  raw = raw.trim().toLowerCase();
  if (!raw) return Object.freeze({ kind:'encoded', code:0 });
  const normalized = raw.replace(/^bti\s+/, '').trim();
  if (normalized === 'c') return Object.freeze({ kind:'c', code:1 });
  if (normalized === 'j') return Object.freeze({ kind:'j', code:2 });
  if (normalized === 'jc') return Object.freeze({ kind:'jc', code:3 });
  return null;
}

function rebuildIntrinsic(operation, guardValue, landing) {
  const summary = operation.effectSummary;
  return createMachineOperation({
    kind:'intrinsic',
    ...(operation.id == null ? {} : { id:operation.id }),
    intrinsicId:operation.intrinsicId,
    effectSummary:createIntrinsicEffectSummary({
      inputs:[guardValue, ...summary.inputs, createBitVectorValue(2, landing.code)],
      outputs:summary.outputs,
      registersRead:summary.registersRead,
      registersWritten:summary.registersWritten,
      memoryRead:summary.memoryRead,
      memoryWrite:summary.memoryWrite,
      controlEffects:summary.controlEffects,
      determinism:summary.determinism,
      symbolicDetail:summary.symbolicDetail,
    }),
    metadata:{
      ...(operation.metadata || {}),
      landingPadKind:landing.kind,
      guardedPageInput:true,
      inputOrder:['page-guarded','pstate.btype','landing-pad-kind'],
    },
  });
}

function withoutResolvedLandingMetadata(operation) {
  if (operation?.kind !== 'intrinsic' || operation?.intrinsicId !== 'arm64.system.bti') return operation;
  return createMachineOperation({
    kind:'intrinsic',
    ...(operation.id == null ? {} : { id:operation.id }),
    intrinsicId:operation.intrinsicId,
    effectSummary:operation.effectSummary,
    metadata:{ ...(operation.metadata || {}), landingPadKind:'unresolved' },
  });
}

function rebuiltBundle(bundle, { operations, possibleFaults, completeness, unknownEffects = null, statePreservation = null, metadata = {} }) {
  return createMachineEffectBundle({
    instructionId:bundle.instructionId,
    architectureId:bundle.architectureId,
    mode:bundle.mode,
    operations,
    controlEffect:bundle.controlEffect,
    possibleFaults,
    origin:bundle.origin,
    completeness,
    ...(unknownEffects == null ? {} : { unknownEffects }),
    ...(statePreservation == null ? {} : { statePreservation }),
    metadata:{ ...(bundle.metadata || {}), ...metadata },
  });
}

function normalizeBtype(val) {
  if (val == null) return null;
  if (typeof val === 'number') return Number.isInteger(val) && val >= 0 && val <= 3 ? val : null;
  if (typeof val === 'bigint') return normalizeBtype(Number(val));
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (s.startsWith('0b')) return normalizeBtype(parseInt(s.slice(2), 2));
    if (/^\d+$/.test(s)) return normalizeBtype(parseInt(s, 10));
  }
  return null;
}

function normalizeSctlrBt(val) {
  if (val === true || val === 1 || val === '1' || val === 'enabled' || val === 'incompatible') return true;
  if (val === false || val === 0 || val === '0' || val === 'disabled' || val === 'compatible') return false;
  return null;
}

function guardFaultCondition(guardState, landing, sctlrBt = null) {
  return {
    kind:'and',
    terms:[
      {
        kind:'mapped-page-guarded',
        value:guardState.mappedPageGuarded == null ? 'unknown' : guardState.mappedPageGuarded,
        source:guardState.source,
        evidence:guardState.evidence,
      },
      {
        kind:'not',
        condition:{
          kind:'bti-compatible',
          btype:'pstate.btype',
          landingPadKind:landing.kind,
          ...(sctlrBt != null ? { sctlrBt } : {}),
        },
      },
    ],
  };
}

function guardRead() {
  const value = createTemporaryValue('bti:page-guarded', createBitVectorValue(1));
  return {
    value,
    operation:createMachineOperation({
      kind:'register-read',
      register:createRegisterValue(ARM64_BTI_PAGE_GUARD_STATE_ID, 1, { view:ARM64_BTI_PAGE_GUARD_STATE_ID }),
      value,
      metadata:{ architecture:'arm64', externalState:'executable-page-guarded', authority:'runtime-mapping' },
    }),
  };
}

function incomingBtypeRead() {
  const value = createTemporaryValue('bti:incoming-btype', createBitVectorValue(2));
  return {
    value,
    operation:createMachineOperation({
      kind:'register-read',
      register:createRegisterValue(ARM64_BTYPE_REGISTER_ID, 2),
      value,
      metadata:{ architecture:'arm64', stateKind:'branch-target-identification', purpose:'implicit-landing-compatibility-input' },
    }),
  };
}

function implicitLandingFaultCondition(guardState, sctlrBt = null) {
  return {
    kind:'and',
    terms:[
      {
        kind:'mapped-page-guarded',
        value:guardState.mappedPageGuarded == null ? 'unknown' : guardState.mappedPageGuarded,
        source:guardState.source,
        evidence:guardState.evidence,
      },
      {
        kind:'not',
        condition:{
          kind:'bti-compatible',
          btype:ARM64_BTYPE_REGISTER_ID,
          landingPadKind:IMPLICIT_LANDING_PAD_KIND,
          compatibleBtypes:['0b01','0b10'],
          sctlrDependentBtypes:['0b11'],
          ...(sctlrBt != null ? { sctlrBt } : {}),
        },
      },
    ],
  };
}

function rebuildIntrinsicWithImplicitLanding(operation, guardValue, btypeValue) {
  const summary = operation.effectSummary;
  return createMachineOperation({
    kind:'intrinsic',
    ...(operation.id == null ? {} : { id:operation.id }),
    intrinsicId:operation.intrinsicId,
    effectSummary:createIntrinsicEffectSummary({
      inputs:[guardValue, btypeValue, ...summary.inputs, createBitVectorValue(2, 3)],
      outputs:summary.outputs,
      registersRead:[...summary.registersRead, ARM64_BTYPE_REGISTER_ID],
      registersWritten:summary.registersWritten,
      memoryRead:summary.memoryRead,
      memoryWrite:summary.memoryWrite,
      controlEffects:summary.controlEffects,
      determinism:summary.determinism,
      symbolicDetail:summary.symbolicDetail,
    }),
    metadata:{
      ...(operation.metadata || {}),
      landingPadKind:IMPLICIT_LANDING_PAD_KIND,
      guardedPageInput:true,
      incomingBtypeInput:true,
      inputOrder:['page-guarded','pstate.btype','implicit-landing-pad-kind'],
      sctlrBtDependentBtypes:['0b11'],
    },
  });
}

function decorateImplicitBtiLanding(instruction, bundle, context) {
  const guardState = normalizeArm64BtiGuardedPageState(
    context.btiGuardedPage ?? context.guardedPageState ?? context.pageGuardState ?? null,
  );
  const featBti = context.featBti ?? context.hasBti ?? true;
  const btype = normalizeBtype(context.incomingBtype ?? context.btype ?? context.pstateBtype);
  const sctlrBt = normalizeSctlrBt(context.sctlrBt ?? context.sctlr_elx_bt ?? context.btPolicy ?? context.sctlrPolicy);

  // PACIASP/PACIBSP retain pointer-authentication semantics when FEAT_BTI is
  // unavailable: the implicit landing-pad check is architecturally absent.
  if (featBti === false) {
    return rebuiltBundle(bundle, {
      operations:bundle.operations,
      possibleFaults:bundle.possibleFaults,
      completeness:bundle.completeness,
      unknownEffects:bundle.unknownEffects,
      metadata:{
        btiGuardedPage:guardState,
        btiCheck:'disabled-by-feat-bti',
        landingPadKind:'pacixsp',
        implicitBtiLanding:false,
        featBti:false,
      },
    });
  }

  if (guardState.state === 'unguarded') {
    return rebuiltBundle(bundle, {
      operations:bundle.operations,
      possibleFaults:bundle.possibleFaults,
      completeness:bundle.completeness,
      unknownEffects:bundle.unknownEffects,
      metadata:{
        btiGuardedPage:guardState,
        btiCheck:'implicit-skipped-non-guarded-page',
        loaderPolicyDoesNotImplyMappedState:true,
      },
    });
  }

  const intrinsicIndex = bundle.operations.findIndex((operation) => operation.kind === 'intrinsic' && operation.intrinsicId === 'arm64e.pointer.sign');
  if (intrinsicIndex < 0) return bundle;

  if (guardState.state === 'guarded' && btype != null) {
    const compatible = btype === 0 || btype === 1 || btype === 2 || (btype === 3 && sctlrBt === false);
    if (compatible) {
      return rebuiltBundle(bundle, {
        operations:bundle.operations,
        possibleFaults:bundle.possibleFaults.filter((fault) => fault?.kind !== 'branch-target-exception'),
        completeness:bundle.completeness,
        unknownEffects:bundle.unknownEffects,
        metadata:{
          btiGuardedPage:guardState,
          btiCheck:btype === 0 ? 'skipped-zero-btype' : (btype === 3 ? 'compatible-sctlr-policy' : 'compatible-call-btype'),
          landingPadKind:'pacixsp',
          implicitBtiLanding:true,
          incomingBtype:btype,
          ...(sctlrBt != null ? { sctlrBt } : {}),
        },
      });
    }
    if (btype === 3 && sctlrBt === true) {
      const fault = Object.freeze({
        kind:'branch-target-exception',
        condition:Object.freeze({ kind:'bti-incompatible', btype:3, landingPadKind:'pacixsp', sctlrBt:true }),
        detail:Object.freeze({ guardedPageState:'guarded', landingPadKind:'pacixsp', sctlrBt:true }),
      });
      return rebuiltBundle(bundle, {
        operations:bundle.operations,
        possibleFaults:[...bundle.possibleFaults.filter((item) => item?.kind !== 'branch-target-exception'), fault],
        completeness:bundle.completeness,
        unknownEffects:bundle.unknownEffects,
        metadata:{
          btiGuardedPage:guardState,
          btiCheck:'incompatible-branch-target',
          landingPadKind:'pacixsp',
          implicitBtiLanding:true,
          incomingBtype:btype,
          sctlrBt:true,
        },
      });
    }
  }

  const operations = bundle.operations.slice();
  let guardValue;
  if (guardState.state === 'guarded') {
    guardValue = createBitVectorValue(1, 1);
  } else {
    const read = guardRead();
    operations.splice(intrinsicIndex, 0, read.operation);
    guardValue = read.value;
  }
  const btypeRead = incomingBtypeRead();
  operations.splice(intrinsicIndex + (guardState.state === 'guarded' ? 0 : 1), 0, btypeRead.operation);
  const adjustedIntrinsicIndex = intrinsicIndex + (guardState.state === 'guarded' ? 1 : 2);
  operations[adjustedIntrinsicIndex] = rebuildIntrinsicWithImplicitLanding(operations[adjustedIntrinsicIndex], guardValue, btypeRead.value);

  return rebuiltBundle(bundle, {
    operations,
    possibleFaults:[
      ...(bundle.possibleFaults ?? []),
      {
        kind:'branch-target-exception',
        condition:implicitLandingFaultCondition(guardState, sctlrBt),
        detail:{
          guardedPageState:guardState.state,
          landingPadKind:IMPLICIT_LANDING_PAD_KIND,
          implicitLanding:true,
          sctlrBtDependentBtypes:['0b11'],
          ...(sctlrBt != null ? { sctlrBt } : {}),
          loaderPolicy:guardState.loaderPolicy,
        },
      },
    ],
    completeness:guardState.conflict ? 'partial' : bundle.completeness,
    unknownEffects:guardState.conflict
      ? { categories:['control','faults'], reason:'bti-mapped-page-guarded-state-conflict', detail:{ conflictReason:guardState.conflictReason } }
      : bundle.unknownEffects,
    metadata:{
      btiGuardedPage:guardState,
      btiCheck:guardState.conflict ? 'conflicting-page-guard-state' : (guardState.state === 'guarded' ? 'implicit-guarded-page-compatibility' : 'implicit-guarded-page-unknown-conditional-fault'),
      implicitBtiLanding:true,
      loaderPolicyDoesNotImplyMappedState:true,
      ...(sctlrBt != null ? { sctlrBt } : {}),
    },
  });
}

function hasBtypeWrite(bundle) {
  return bundle.operations.some((operation) => operation.kind === 'register-write' && operation.register?.registerId === ARM64_BTYPE_REGISTER_ID);
}

function withArchitecturalBtypeReset(instruction, bundle) {
  const mnemonic = mnemonicOf(instruction);
  if (!bundle || !mnemonic || ARM64_BTYPE_PRODUCERS.has(mnemonic) || hasBtypeWrite(bundle)) return bundle;
  const failClosedPartial = bundle.completeness === 'partial'
    && bundle.operations.every((operation) => operation.kind === 'unknown');
  if (bundle.metadata?.failClosed === true || failClosedPartial) return bundle;
  const operations = [
    ...bundle.operations,
    createMachineOperation({
      kind:'register-write',
      register:createRegisterValue(ARM64_BTYPE_REGISTER_ID, 2),
      value:createBitVectorValue(2, 0n),
      metadata:{
        stateKind:'branch-target-identification',
        branchKind:'non-indirect-reset',
        mnemonic,
        architecturalValue:0,
      },
    }),
  ];
  return rebuiltBundle(bundle, {
    operations,
    possibleFaults:bundle.possibleFaults,
    completeness:bundle.completeness,
    unknownEffects:bundle.unknownEffects,
    metadata:{
      btypeTransition:{ kind:'known', branchKind:'non-indirect-reset', value:0, mnemonic },
    },
  });
}

export function decorateArm64BtiGuardedPageEffects(instruction, bundle, context = {}) {
  if (!bundle) return bundle;
  const mnemonic = mnemonicOf(instruction);
  if (ARM64_IMPLICIT_BTI_LANDING_MNEMONICS.has(mnemonic)) {
    return withArchitecturalBtypeReset(instruction, decorateImplicitBtiLanding(instruction, bundle, context));
  }
  if (mnemonic !== 'bti') return withArchitecturalBtypeReset(instruction, bundle);
  const guardState = normalizeArm64BtiGuardedPageState(
    context.btiGuardedPage ?? context.guardedPageState ?? context.pageGuardState ?? null,
  );
  const landing = landingKindOf(instruction);

  if (guardState.state === 'unguarded') {
    return withArchitecturalBtypeReset(instruction, rebuiltBundle(bundle, {
      operations:[],
      possibleFaults:[],
      completeness:'exact',
      statePreservation:{ proven:true, reason:'BTI on an observed non-guarded executable page is architecturally NOP-like before the architectural BTYPE post-state reset' },
      metadata:{
        btiGuardedPage:guardState,
        btiCheck:'skipped-non-guarded-page',
        loaderPolicyDoesNotImplyMappedState:true,
      },
    }));
  }

  const intrinsicIndex = bundle.operations.findIndex((operation) => operation.kind === 'intrinsic' && operation.intrinsicId === 'arm64.system.bti');
  if (intrinsicIndex < 0 || !landing) {
    return withArchitecturalBtypeReset(instruction, rebuiltBundle(bundle, {
      operations:landing ? bundle.operations : bundle.operations.map(withoutResolvedLandingMetadata),
      possibleFaults:bundle.possibleFaults,
      completeness:'partial',
      unknownEffects:{ categories:['control','faults'], reason:intrinsicIndex < 0 ? 'bti-intrinsic-missing' : 'bti-landing-pad-kind-unresolved' },
      metadata:{ btiGuardedPage:guardState, btiCheck:'partial' },
    }));
  }

  const operations = bundle.operations.slice();
  let guardValue;
  if (guardState.state === 'guarded') {
    guardValue = createBitVectorValue(1, 1);
  } else {
    const read = guardRead();
    operations.splice(intrinsicIndex, 0, read.operation);
    guardValue = read.value;
  }
  const adjustedIntrinsicIndex = intrinsicIndex + (guardState.state === 'unknown' ? 1 : 0);
  operations[adjustedIntrinsicIndex] = rebuildIntrinsic(operations[adjustedIntrinsicIndex], guardValue, landing);
  const possibleFaults = [{
    kind:'branch-target-exception',
    condition:guardFaultCondition(guardState, landing),
    detail:{
      guardedPageState:guardState.state,
      landingPadKind:landing.kind,
      loaderPolicy:guardState.loaderPolicy,
    },
  }];

  if (guardState.state === 'guarded') {
    return withArchitecturalBtypeReset(instruction, rebuiltBundle(bundle, {
      operations,
      possibleFaults,
      completeness:'exact-with-intrinsic',
      metadata:{
        btiGuardedPage:guardState,
        btiCheck:'guarded-page-compatibility',
        loaderPolicyDoesNotImplyMappedState:true,
      },
    }));
  }

  return withArchitecturalBtypeReset(instruction, rebuiltBundle(bundle, {
    operations,
    possibleFaults,
    completeness:'partial',
    unknownEffects:{
      categories:['control','faults'],
      reason:guardState.conflict ? 'bti-mapped-page-guarded-state-conflict' : 'bti-mapped-page-guarded-state-unresolved',
      detail:{ loaderPolicy:guardState.loaderPolicy, ...(guardState.conflictReason ? { conflictReason:guardState.conflictReason } : {}) },
    },
    metadata:{
      btiGuardedPage:guardState,
      btiCheck:guardState.conflict ? 'conflicting-page-guard-state' : 'conditional-on-unknown-page-guard-state',
      loaderPolicyDoesNotImplyMappedState:true,
    },
  }));
}
