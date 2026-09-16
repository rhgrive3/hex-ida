import { canonicalIdentityField } from '../arm64/effects/common.js';

export const ARM64E_EFFECT_DEFAULT_MODE = 'arm64e';
export const ARM64E_EFFECT_DEFAULT_DATA_ENDIANNESS = 'little';

// The ARM64e extension previously rebuilt instruction identity, mode, and
// endianness with local `String()` coercion, so an Array, a custom-toString
// object, or a number collapsed into a canonical-looking identity and reached
// `exact`/`exact-with-intrinsic` PAuth bundles without ever passing the strict
// base-ARM64 boundary (#8815, #5992). Every ARM64e effect owner now resolves
// those fields through the shared primitive-only contract instead.
export function arm64eEffectInstructionId(decoded, context) {
  return canonicalIdentityField(
    [context?.instructionId, decoded?.instructionId],
    { errorCode: 'arm64e-instruction-id-required' },
  );
}

export function arm64eEffectMode(decoded, context) {
  return canonicalIdentityField(
    [context?.mode, decoded?.mode],
    { fallback: ARM64E_EFFECT_DEFAULT_MODE, errorCode: 'arm64e-mode-invalid' },
  );
}

export function arm64eEffectDataEndianness(decoded, context) {
  return canonicalIdentityField(
    [context?.dataEndianness, decoded?.dataEndianness, context?.endian, decoded?.endian],
    { fallback: ARM64E_EFFECT_DEFAULT_DATA_ENDIANNESS, errorCode: 'arm64e-data-endianness-invalid' },
  );
}

export function arm64eEffectOrigin(decoded, context, instructionId) {
  const origin = context?.origin ?? decoded?.origin;
  return origin == null ? { instructionIds: [instructionId] } : origin;
}
