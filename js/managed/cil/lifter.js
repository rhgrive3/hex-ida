import { createVMEffectFunction } from '../shared/vm-effects.js';
import {
  createCilCallSignatureResolver,
  createCilCallStackEffect,
  createCilLocalTypeResolver,
  createCilMethodSignatureResolver,
} from './call-signatures.js';
import { liftCilMethod as liftCilMethodCore } from './lifter-core.js';

const CALL_MNEMONICS = new Set(['call', 'callvirt', 'newobj']);
// Native-size stack types (ECMA-335 I.12.1.1): `O`, `&`, `native int`. When
// the image's pointer-width authority is known (32BITREQUIRED / PE32+), the
// final public output carries it; unresolved widths stay unstated (#7775).
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
    } : {
      signatureReason:stackEffect.reason,
    }),
  }));

  // The stack effect replaces the core produced values when the signature
  // resolves, so the native-width authority must be re-applied here — the
  // constructed-object / call-result native-size values would otherwise lose
  // it on the final public output (#7775).
  const producedValues = stackEffect.producedValues.map((value) => attachNativeWidth(value, nativePointerBits));

  if (stackEffect.complete) {
    return {
      ...bundle,
      consumedValues:stackEffect.consumedValues,
      producedValues,
      callEffects,
    };
  }

  return {
    ...bundle,
    consumedValues:stackEffect.consumedValues,
    producedValues,
    callEffects,
    completeness:bundle.completeness === 'unknown' ? 'unknown' : 'partial',
    unknownEffects:[
      ...(bundle.unknownEffects || []),
      { category:'stack', reason:stackEffect.reason },
    ],
  };
}

export function liftCilMethod(bodyIndex, cilImage, options = {}) {
  const methodBody = cilImage?.methodBodies?.[bodyIndex];
  const resolveMethodSignature = createCilMethodSignatureResolver(cilImage);
  const methodAuthority = resolveMethodSignature(methodBody);
  const lifted = liftCilMethodCore(bodyIndex, cilImage, options, methodAuthority);
  const hasCalls = lifted.bundles.some((bundle) => CALL_MNEMONICS.has(bundle.mnemonic));
  const nativePointerBits = cilImage?.requires32Bit === true ? 32
    : cilImage?.requires64Bit === true ? 64
      : null;
  if (!hasCalls && nativePointerBits == null) return lifted;

  const resolveSignature = hasCalls ? createCilCallSignatureResolver(cilImage) : null;
  const bundles = lifted.bundles.map((bundle) => attachBundleNativeWidth(
    hasCalls ? enrichCallBundle(bundle, resolveSignature, nativePointerBits) : bundle,
    nativePointerBits,
  ));
  const { bundles:_bundles, aggregateCompleteness:_aggregateCompleteness, ...functionInput } = lifted;
  return createVMEffectFunction({ ...functionInput, bundles }, options);
}
