import {
  createBitVectorValue,
  createIntrinsicEffectSummary,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
  createTemporaryValue,
} from '../../../semantics/effects/index.js';
import { arm64DecodedEncodingWord } from '../arm64/encoding-word.js';

const POINTER_BITS = 64;
const PAUTH_STATE_BITS = 64;
const PAUTH_STATE_ID = 'PAuthState';
export const ARM64E_PACM_ENCODING_WORD = 0xd50324ff;
export const ARM64E_PACM_EFFECTS_SEMANTIC_VERSION = '1';

function mnemonicOf(decoded) {
  const raw = typeof decoded?.mnemonic === 'string'
    ? decoded.mnemonic
    : typeof decoded?.opcode === 'string'
      ? decoded.opcode
      : null;
  return raw ? raw.trim().toLowerCase() : '';
}

function splitOperands(text) {
  return String(text || '').split(',').map((part) => part.trim()).filter(Boolean);
}

function operandList(decoded) {
  if (Array.isArray(decoded?.operands) && decoded.operands.length > 0) return decoded.operands;
  if (Array.isArray(decoded?.ops)) return decoded.ops;
  if (Array.isArray(decoded?.operands)) return decoded.operands;
  if (typeof decoded?.operands === 'string') return splitOperands(decoded.operands);
  return splitOperands(decoded?.opStr ?? decoded?.op_str ?? decoded?.operandString ?? decoded?.args);
}

function immediateValue(operand) {
  const raw = operand && typeof operand === 'object' && !Array.isArray(operand)
    ? operand.value
    : operand;
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) return BigInt(raw);
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toLowerCase().replace(/^#/, '');
  if (!/^(?:0x[0-9a-f]+|[0-9]+)$/.test(text)) return null;
  try { return BigInt(text); } catch { return null; }
}

function isPrintedPacmHintAlias(decoded) {
  if (mnemonicOf(decoded) !== 'hint') return false;
  const operands = operandList(decoded);
  return operands.length === 1 && immediateValue(operands[0]) === 0x27n;
}

function hasArm64EncodingEvidence(decoded) {
  return decoded?.word != null
    || decoded?.encodingWord != null
    || decoded?.rawBytes != null
    || decoded?.bytes != null;
}

export function isArm64ePacmInstruction(decoded) {
  return mnemonicOf(decoded) === 'pacm' || arm64DecodedEncodingWord(decoded) === ARM64E_PACM_ENCODING_WORD;
}

function isArm64ePacmCandidate(decoded) {
  return isArm64ePacmInstruction(decoded) || isPrintedPacmHintAlias(decoded);
}

function instructionIdOf(decoded, context) {
  const instructionId = String(context?.instructionId ?? decoded?.instructionId ?? '').trim();
  if (!instructionId) throw new TypeError('arm64e-instruction-id-required');
  return instructionId;
}

function originOf(decoded, context, instructionId) {
  return context?.origin ?? decoded?.origin ?? { instructionIds:[instructionId] };
}

function modeOf(decoded, context) {
  return String(context?.mode ?? decoded?.mode ?? 'arm64e').trim() || 'arm64e';
}

function reg(id, bits = POINTER_BITS) {
  return createRegisterValue(id, bits);
}

function tmp(id, bits = POINTER_BITS) {
  return createTemporaryValue(id, createBitVectorValue(bits));
}

function bundle(decoded, context, instructionId, operations, completeness, extra = {}) {
  return createMachineEffectBundle({
    instructionId,
    architectureId:'arm64e',
    mode:modeOf(decoded, context),
    operations,
    controlEffect:{ kind:'fallthrough' },
    possibleFaults:[],
    origin:originOf(decoded, context, instructionId),
    completeness,
    ...(extra.unknownEffects == null ? {} : { unknownEffects:extra.unknownEffects }),
    ...(extra.statePreservation == null ? {} : { statePreservation:extra.statePreservation }),
    metadata:{
      semanticVersion:`pacm/${ARM64E_PACM_EFFECTS_SEMANTIC_VERSION}`,
      family:'arm64e-pointer-authentication',
      mnemonic:'pacm',
      ...extra.metadata,
    },
  }, context?.machineEffectsOptions ?? context?.options ?? {});
}

function unresolvedAlias(decoded, context, instructionId) {
  const encodingEvidence = hasArm64EncodingEvidence(decoded);
  const reason = encodingEvidence
    ? 'PACM HINT alias encoding evidence is contradictory or nonmatching'
    : 'PACM HINT alias encoding evidence is unavailable';
  const categories = ['other', 'registers'];
  return bundle(decoded, context, instructionId, [
    createMachineOperation({ kind:'unknown', reason, categories }),
  ], 'partial', {
    unknownEffects:{
      categories,
      reason,
      detail:{
        printedMnemonic:'hint',
        printedImmediate:'0x27',
        expectedEncodingWord:`0x${ARM64E_PACM_ENCODING_WORD.toString(16)}`,
        encodingEvidence:encodingEvidence ? 'contradictory-or-nonmatching' : 'unavailable',
      },
    },
    metadata:{
      pacmAliasCandidate:true,
      failClosed:true,
      environmentBoundary:true,
      environmentFootprintComplete:false,
      encodingWordExpected:`0x${ARM64E_PACM_ENCODING_WORD.toString(16)}`,
    },
  });
}

function malformedDirectPacm(decoded, context, instructionId) {
  const reason = 'arm64e-pacm-operand-shape-invalid';
  const categories = ['registers'];
  return bundle(decoded, context, instructionId, [
    createMachineOperation({ kind:'unknown', reason, categories }),
  ], 'partial', {
    unknownEffects:{
      categories,
      reason,
      detail:{ expectedOperandCount:0, actualOperandCount:operandList(decoded).length },
    },
    metadata:{ failClosed:true, encodingValidation:'operand-arity' },
  });
}

function featureState(context) {
  return context?.featPAuthLr === true || context?.featPAuthLr === false
    ? context.featPAuthLr
    : null;
}

function enableState(context) {
  return context?.pacmEnabled === true || context?.pacmEnabled === false
    ? context.pacmEnabled
    : null;
}

function liftPacm(decoded, context, instructionId) {
  if (mnemonicOf(decoded) === 'pacm' && operandList(decoded).length !== 0) {
    return malformedDirectPacm(decoded, context, instructionId);
  }

  const feature = featureState(context);
  if (feature === false) {
    return bundle(decoded, context, instructionId, [], 'exact', {
      statePreservation:{ proven:true, reason:'PACM is architecturally a NOP when FEAT_PAuth_LR is absent' },
      metadata:{
        pacm:true,
        pacmFeatureImplemented:false,
        encodingWord:`0x${ARM64E_PACM_ENCODING_WORD.toString(16)}`,
        architecturalBehavior:'nop-when-feat-pauth-lr-absent',
      },
    });
  }

  const operations = [];
  const architectureState = tmp(`${instructionId}.state`, PAUTH_STATE_BITS);
  operations.push(createMachineOperation({
    kind:'register-read',
    register:reg(PAUTH_STATE_ID, PAUTH_STATE_BITS),
    value:architectureState,
    metadata:{ implicit:true, stateKind:'pointer-authentication-architecture-state' },
  }));

  const enable = feature === true ? enableState(context) : null;
  const exact = feature === true && enable != null;
  const output = tmp(`${instructionId}.pacm.state`, PAUTH_STATE_BITS);
  operations.push(createMachineOperation({
    kind:'intrinsic',
    intrinsicId:'arm64e.pauth.pacm',
    effectSummary:createIntrinsicEffectSummary({
      inputs:exact
        ? [architectureState, createBitVectorValue(1, enable ? 1n : 0n)]
        : [architectureState],
      outputs:[output],
      registersRead:[PAUTH_STATE_ID],
      registersWritten:[],
      memoryRead:{ scope:'none' },
      memoryWrite:{ scope:'none' },
      controlEffects:[],
      determinism:exact ? 'input-dependent' : 'unknown',
      symbolicDetail:'summary-only',
    }),
    metadata:{
      operation:'set-pstate-pacm',
      feature:'FEAT_PAuth_LR',
      architectureStateInput:PAUTH_STATE_ID,
      architectureStateOutput:PAUTH_STATE_ID,
      condition:'IsPACMEnabled()',
      conditionResolution:exact ? 'resolved' : 'unknown',
      ...(exact ? { pacmValue:enable ? 1 : 0 } : {}),
    },
  }));
  operations.push(createMachineOperation({
    kind:'register-write',
    register:reg(PAUTH_STATE_ID, PAUTH_STATE_BITS),
    value:output,
    metadata:{
      implicit:true,
      stateKind:'pointer-authentication-architecture-state',
      stateField:'PSTATE.PACM',
      ...(exact ? { pacmValue:enable ? 1 : 0 } : { conditional:'FEAT_PAuth_LR && IsPACMEnabled()' }),
    },
  }));

  if (exact) {
    return bundle(decoded, context, instructionId, operations, 'exact-with-intrinsic', {
      metadata:{
        pacm:true,
        pacmFeatureImplemented:true,
        pacmValue:enable ? 1 : 0,
        architectureStateInput:PAUTH_STATE_ID,
        architectureStateOutput:PAUTH_STATE_ID,
        encodingWord:`0x${ARM64E_PACM_ENCODING_WORD.toString(16)}`,
      },
    });
  }

  const reason = feature == null
    ? 'PACM FEAT_PAuth_LR implementation state is unresolved'
    : 'PACM enable state is unresolved';
  return bundle(decoded, context, instructionId, operations, 'partial', {
    unknownEffects:{
      categories:['registers'],
      reason,
      detail:{
        stateRegister:PAUTH_STATE_ID,
        stateField:'PSTATE.PACM',
        feature:'FEAT_PAuth_LR',
        condition:'IsPACMEnabled()',
      },
    },
    metadata:{
      pacm:true,
      pacmFeatureImplemented:feature,
      architectureStateInput:PAUTH_STATE_ID,
      architectureStateOutput:PAUTH_STATE_ID,
      encodingWord:`0x${ARM64E_PACM_ENCODING_WORD.toString(16)}`,
      environmentFootprintComplete:false,
    },
  });
}

export function liftArm64ePacmEffects(decoded, context = {}) {
  if (!isArm64ePacmCandidate(decoded)) return null;
  const instructionId = instructionIdOf(decoded, context);
  if (!isArm64ePacmInstruction(decoded)) return unresolvedAlias(decoded, context, instructionId);
  return liftPacm(decoded, context, instructionId);
}

export function extendArm64eWithPacmEffects(baseLiftExact) {
  if (baseLiftExact != null && typeof baseLiftExact !== 'function') {
    throw new TypeError('arm64e-pacm-base-lifter-must-be-function');
  }
  return function liftArm64ePacmExtension(decoded, context = {}) {
    const refined = liftArm64ePacmEffects(decoded, context);
    if (refined != null) return refined;
    return baseLiftExact ? baseLiftExact(decoded, context) : null;
  };
}
