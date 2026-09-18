import { createOriginSet } from '../../core/identity/origin.js';
import { createVMOperationId } from '../shared/identity.js';
import { createVMEffectBundle, createVMEffectFunction } from '../shared/vm-effects.js';
import {
  createCilCallSignatureResolver,
  createCilCallStackEffect,
  createCilLocalTypeResolver,
  createCilMethodSignatureResolver,
} from './call-signatures.js';
import { liftCilMethod as liftCilMethodCore } from './lifter-core.js';
import { isCilManagedFamilyInstruction, liftCilManagedFamilyInstruction } from './managed-family-overlay.js';

const CALL_MNEMONICS = new Set(['call', 'callvirt', 'newobj']);
const NATIVE_WIDTH_STACK_TYPES = new Set(['object-ref', 'native-int', 'managed-pointer']);

function attachNativeWidth(value, nativePointerBits) {
  if (nativePointerBits == null || !value || typeof value !== 'object') return value;
  if (value.bits != null || !NATIVE_WIDTH_STACK_TYPES.has(value.stackType)) return value;
  return Object.freeze({ ...value, bits: nativePointerBits });
}

function attachBundleNativeWidth(bundle, nativePointerBits) {
  if (nativePointerBits == null) return bundle;
  return {
    ...bundle,
    consumedValues:(bundle.consumedValues || []).map((value) => attachNativeWidth(value, nativePointerBits)),
    producedValues:(bundle.producedValues || []).map((value) => attachNativeWidth(value, nativePointerBits)),
  };
}

function shiftControlEffect(effect, baseOffset) {
  const shifted = { ...effect };
  for (const key of ['targetOffset','falseTargetOffset','defaultTargetOffset']) if (Number.isSafeInteger(shifted[key])) shifted[key] += baseOffset;
  if (Array.isArray(shifted.targetOffsets)) shifted.targetOffsets = shifted.targetOffsets.map((value) => Number.isSafeInteger(value) ? value + baseOffset : value);
  return shifted;
}

function shiftBundle(bundle, baseOffset) {
  if (baseOffset === 0) return bundle;
  const metadata = Object.fromEntries(Object.entries(bundle.metadata || {}).map(([key, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [key, value];
    return [key, {
      ...value,
      ...(Number.isSafeInteger(value.bytecodeOffset) ? { bytecodeOffset:value.bytecodeOffset + baseOffset } : {}),
      ...(value.provenance && typeof value.provenance === 'object' ? {
        provenance:{
          ...value.provenance,
          ...(Number.isSafeInteger(value.provenance.start) ? { start:value.provenance.start + baseOffset } : {}),
          ...(Number.isSafeInteger(value.provenance.end) ? { end:value.provenance.end + baseOffset } : {}),
        },
      } : {}),
    }];
  }));
  return { ...bundle, bytecodeOffset:bundle.bytecodeOffset + baseOffset, controlEffects:(bundle.controlEffects || []).map((effect) => shiftControlEffect(effect, baseOffset)), metadata };
}

function canonicalizeBundleIds(methodId, bundles, options) {
  return bundles.map((bundle, index) => {
    const operationId = createVMOperationId(methodId, bundle.bytecodeOffset, index + 1);
    const origin = createOriginSet({ operationIds:[operationId], byteRanges:bundle.origin?.byteRanges || [] });
    return createVMEffectBundle({ ...bundle, operationId, origin }, options);
  });
}

function liftCilMethodWithManagedFamily(bodyIndex, cilImage, options, methodAuthority, nativePointerBits) {
  const originalBody = cilImage?.methodBodies?.[bodyIndex];
  if (!originalBody) return liftCilMethodCore(bodyIndex, cilImage, options, methodAuthority);
  const bytecode = originalBody.bytecode;
  const codeBase = originalBody.codeOffset ?? originalBody.headerOffset;
  let baseOffset = 0;
  const merged = [];
  let template = null;
  while (baseOffset < bytecode.length) {
    const segmentBody = baseOffset === 0 ? originalBody : {
      ...originalBody,
      bytecode:bytecode.subarray(baseOffset),
      codeOffset:codeBase + baseOffset,
      headerOffset:(originalBody.headerOffset ?? codeBase) + baseOffset,
      exceptionClauses:[],
    };
    const bodies = cilImage.methodBodies.slice();
    bodies[bodyIndex] = segmentBody;
    const segmentImage = baseOffset === 0 ? cilImage : { ...cilImage, methodBodies:bodies };
    const segment = liftCilMethodCore(bodyIndex, segmentImage, options, methodAuthority);
    template ||= segment;
    const shifted = segment.bundles.map((bundle) => shiftBundle(bundle, baseOffset));
    const last = shifted.at(-1);
    const globalUnsupportedOffset = last?.bytecodeOffset;
    if (last && isCilManagedFamilyInstruction(bytecode, globalUnsupportedOffset)) {
      merged.push(...shifted.slice(0, -1));
      const operationId = createVMOperationId(segment.methodId, globalUnsupportedOffset, merged.length + 1);
      const lifted = liftCilManagedFamilyInstruction({
        bytecode, offset:globalUnsupportedOffset, codeBase, cilImage, methodId:segment.methodId,
        operationId, nativePointerBits, profileId:cilImage.vmSpecEdition, options,
      });
      merged.push(lifted.bundle);
      baseOffset = lifted.end;
      continue;
    }
    merged.push(...shifted);
    break;
  }
  if (!template) return liftCilMethodCore(bodyIndex, cilImage, options, methodAuthority);
  const bundles = canonicalizeBundleIds(template.methodId, merged, options);
  const { bundles:_bundles, aggregateCompleteness:_aggregateCompleteness, ...rest } = template;
  return createVMEffectFunction({ ...rest, bundles }, options);
}

function enrichCallBundle(bundle, resolveSignature, nativePointerBits = null) {
  if (!CALL_MNEMONICS.has(bundle?.mnemonic)) return bundle;
  const kind = bundle.mnemonic;
  const primaryCall = bundle.callEffects?.[0] ?? null;
  const stackEffect = createCilCallStackEffect(kind, resolveSignature(primaryCall?.token));
  const callEffects = (bundle.callEffects || []).map((effect, index) => index !== 0 ? effect : ({
    ...effect,
    signatureResolved:stackEffect.complete,
    ...(stackEffect.complete ? {
      signatureProvenance:stackEffect.provenance,
      parameterCount:stackEffect.parameterCount,
      hasThis:stackEffect.hasThis,
      returnsValue:stackEffect.returnsValue,
      callTargetResolved:stackEffect.callTargetResolved,
      ...(stackEffect.callTargetResolved ? {} : { callTargetReason:stackEffect.callTargetReason }),
    } : { signatureReason:stackEffect.reason }),
  }));
  const producedValues = stackEffect.producedValues.map((value) => attachNativeWidth(value, nativePointerBits));
  if (stackEffect.complete) {
    const targetUnresolved = stackEffect.callTargetResolved === false;
    return {
      ...bundle,
      consumedValues:stackEffect.consumedValues,
      producedValues,
      callEffects,
      ...(targetUnresolved ? {
        completeness:bundle.completeness === 'unknown' ? 'unknown' : 'partial',
        unknownEffects:[...(bundle.unknownEffects || []), { category:'calls', reason:stackEffect.callTargetReason || 'cil-call-target-owner-external' }],
      } : {}),
    };
  }
  return {
    ...bundle,
    consumedValues:stackEffect.consumedValues,
    producedValues,
    callEffects,
    completeness:bundle.completeness === 'unknown' ? 'unknown' : 'partial',
    unknownEffects:[...(bundle.unknownEffects || []), { category:'stack', reason:stackEffect.reason }],
  };
}

export function liftCilMethod(bodyIndex, cilImage, options = {}, methodAuthority = null) {
  const methodBody = cilImage?.methodBodies?.[bodyIndex];
  const authority = methodAuthority != null && methodAuthority.bodyOffset === methodBody?.headerOffset
    ? methodAuthority
    : createCilMethodSignatureResolver(cilImage)(methodBody);
  const nativePointerBits = cilImage?.requires32Bit === true ? 32
    : cilImage?.requires64Bit === true ? 64
      : null;
  const lifted = liftCilMethodWithManagedFamily(bodyIndex, cilImage, options, authority, nativePointerBits);
  const hasCalls = lifted.bundles.some((bundle) => CALL_MNEMONICS.has(bundle.mnemonic));
  if (!hasCalls && nativePointerBits == null) return lifted;
  const resolveSignature = hasCalls ? createCilCallSignatureResolver(cilImage) : null;
  const bundles = lifted.bundles.map((bundle) => attachBundleNativeWidth(
    hasCalls ? enrichCallBundle(bundle, resolveSignature, nativePointerBits) : bundle,
    nativePointerBits,
  ));
  const { bundles:_bundles, aggregateCompleteness:_aggregateCompleteness, ...functionInput } = lifted;
  return createVMEffectFunction({ ...functionInput, bundles }, options);
}
