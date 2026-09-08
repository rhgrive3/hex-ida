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
  const raw = input.mappedPageGuarded ?? input.guarded ?? input.state;
  let state = 'unknown';
  let mappedPageGuarded = null;
  if (raw === true || raw === 'guarded') { state = 'guarded'; mappedPageGuarded = true; }
  else if (raw === false || raw === 'unguarded') { state = 'unguarded'; mappedPageGuarded = false; }
  return Object.freeze({
    state,
    mappedPageGuarded,
    source:String(input.source || input.mappedPageGuardedSource || 'execution-context'),
    evidence:deepCopyEvidence(input.evidence ?? input.mappingEvidence ?? null),
    loaderPolicy:deepCopyEvidence(input.loaderPolicy ?? input.elfPolicy ?? null),
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

function guardFaultCondition(guardState, landing) {
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
        condition:{ kind:'bti-compatible', btype:'pstate.btype', landingPadKind:landing.kind },
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

function implicitLandingFaultCondition(guardState) {
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
  if (guardState.state === 'unguarded') {
    // The implicit landing check cannot fault on an observed non-guarded
    // page; the pointer-authentication semantics and the BTYPE reset stand.
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
        condition:implicitLandingFaultCondition(guardState),
        detail:{
          guardedPageState:guardState.state,
          landingPadKind:IMPLICIT_LANDING_PAD_KIND,
          implicitLanding:true,
          sctlrBtDependentBtypes:['0b11'],
          loaderPolicy:guardState.loaderPolicy,
        },
      },
    ],
    completeness:bundle.completeness,
    unknownEffects:bundle.unknownEffects,
    metadata:{
      btiGuardedPage:guardState,
      btiCheck:guardState.state === 'guarded' ? 'implicit-guarded-page-compatibility' : 'implicit-guarded-page-unknown-conditional-fault',
      implicitBtiLanding:true,
      loaderPolicyDoesNotImplyMappedState:true,
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
      reason:'bti-mapped-page-guarded-state-unresolved',
      detail:{ loaderPolicy:guardState.loaderPolicy },
    },
    metadata:{
      btiGuardedPage:guardState,
      btiCheck:'conditional-on-unknown-page-guard-state',
      loaderPolicyDoesNotImplyMappedState:true,
    },
  }));
}
