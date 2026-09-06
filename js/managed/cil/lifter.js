import { createVMEffectFunction } from '../shared/vm-effects.js';
import { createCilCallSignatureResolver, createCilCallStackEffect } from './call-signatures.js';
import { liftCilMethod as liftCilMethodCore } from './lifter-core.js';

const CALL_MNEMONICS = new Set(['call', 'callvirt', 'newobj']);

function enrichCallBundle(bundle, resolveSignature) {
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

  if (stackEffect.complete) {
    return {
      ...bundle,
      consumedValues:stackEffect.consumedValues,
      producedValues:stackEffect.producedValues,
      callEffects,
    };
  }

  return {
    ...bundle,
    consumedValues:stackEffect.consumedValues,
    producedValues:stackEffect.producedValues,
    callEffects,
    completeness:bundle.completeness === 'unknown' ? 'unknown' : 'partial',
    unknownEffects:[
      ...(bundle.unknownEffects || []),
      { category:'stack', reason:stackEffect.reason },
    ],
  };
}

export function liftCilMethod(bodyIndex, cilImage, options = {}) {
  const lifted = liftCilMethodCore(bodyIndex, cilImage, options);
  if (!lifted.bundles.some((bundle) => CALL_MNEMONICS.has(bundle.mnemonic))) return lifted;

  const resolveSignature = createCilCallSignatureResolver(cilImage);
  const bundles = lifted.bundles.map((bundle) => enrichCallBundle(bundle, resolveSignature));
  const { bundles:_bundles, aggregateCompleteness:_aggregateCompleteness, ...functionInput } = lifted;
  return createVMEffectFunction({ ...functionInput, bundles }, options);
}
