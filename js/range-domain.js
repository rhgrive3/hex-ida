// A bit width is the semantic domain of the range/value it describes. An
// omitted (nullish) width keeps the documented 64-bit default; an explicitly
// invalid width (non-number, non-integer, <=0, >64) is never repaired to 64 —
// callers decide the fail-closed behavior for their own error policy (#6155).
function normalizeBits(bits, defaultBits) {
  if (bits == null) return defaultBits;
  if (typeof bits !== 'number' || !Number.isInteger(bits) || bits <= 0 || bits > 64) return null;
  return bits;
}

function invalidWidthError() {
  return new TypeError('bit width must be a positive integer within 1..64');
}

function strictBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('integer value must be a safe integer');
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) throw new TypeError('integer value must not be blank');
    try { return BigInt(text); } catch { throw new TypeError('integer value must be an integer string'); }
  }
  throw new TypeError('integer value must be bigint, safe integer number, or integer string');
}

export function normalizedSignedness(signed) {
  return signed === true ? true : signed === false ? false : null;
}

function rangeFitsDomain(min, max, bits, signed) {
  const modulus = 1n << BigInt(bits);
  const sign = modulus >> 1n;
  const unsignedFits = min >= 0n && max < modulus;
  const signedFits = min >= -sign && max < sign;
  return signed === false ? unsignedFits : signed === true ? signedFits : unsignedFits || signedFits;
}

export function normalizeIntegerValue(value, bits = 64, signed = false) {
  const width = normalizeBits(bits, 64);
  if (width == null) throw invalidWidthError();
  const raw = BigInt.asUintN(width, strictBigInt(value));
  return signed === true ? BigInt.asIntN(width, raw) : raw;
}

export function rangeWithDomain(min, max, bits = 64, signed = null) {
  const width = normalizeBits(bits, 64);
  if (width == null) throw invalidWidthError();
  const domainSigned = normalizedSignedness(signed);
  const normalizedMin = strictBigInt(min);
  const normalizedMax = strictBigInt(max);
  if (normalizedMin > normalizedMax || !rangeFitsDomain(normalizedMin, normalizedMax, width, domainSigned)) {
    throw new RangeError('range exceeds declared integer domain');
  }
  return {
    min: normalizedMin,
    max: normalizedMax,
    bits: width,
    signed: domainSigned,
  };
}

/**
 * Reinterpret one contiguous integer interval in another signedness domain.
 * If reinterpretation crosses the sign discontinuity, the image is two
 * intervals and cannot be represented by the range model; fail closed.
 */
export function normalizeRangeDomain(range, bits, signed) {
  if (!range || range.min == null || range.max == null) return null;
  const width = normalizeBits(bits != null ? bits : (range.bits != null ? range.bits : null), 64);
  if (width == null) return null;
  const srcBits = range.bits != null ? normalizeBits(range.bits, width) : width;
  if (srcBits == null) return null;
  const srcSigned = normalizedSignedness(range.signed);
  const dstSigned = normalizedSignedness(signed);
  if (srcBits !== width) return null;
  let min, max;
  try {
    min = strictBigInt(range.min);
    max = strictBigInt(range.max);
  } catch {
    return null;
  }
  if (min > max || !rangeFitsDomain(min, max, srcBits, srcSigned)) return null;
  if (srcSigned == null || dstSigned == null) {
    return srcSigned === dstSigned ? rangeWithDomain(min, max, width, dstSigned) : null;
  }
  if (srcSigned === dstSigned) return rangeWithDomain(min, max, width, dstSigned);

  const modulus = 1n << BigInt(width);
  const sign = 1n << BigInt(width - 1);

  if (srcSigned === false && dstSigned === true) {
    if (max < sign) return rangeWithDomain(min, max, width, true);
    if (min >= sign) return rangeWithDomain(min - modulus, max - modulus, width, true);
    return null;
  }

  // signed -> unsigned
  if (min >= 0n) return rangeWithDomain(min, max, width, false);
  if (max < 0n) return rangeWithDomain(min + modulus, max + modulus, width, false);
  return null;
}

export function mergeRangeDomain(a, b, bits = null, signed = undefined) {
  if (!a && !b) return null;
  const source = a || b;
  const width = normalizeBits(bits != null ? bits : (a?.bits != null ? a.bits : (b?.bits != null ? b.bits : null)), 64);
  if (width == null) return null;
  const targetSigned = signed === undefined ? normalizedSignedness(source.signed) : normalizedSignedness(signed);
  if (!a) return normalizeRangeDomain(b, width, targetSigned);
  if (!b) return normalizeRangeDomain(a, width, targetSigned);
  const x = normalizeRangeDomain(a, width, targetSigned);
  const y = normalizeRangeDomain(b, width, targetSigned);
  if (!x || !y) return null;
  const min = x.min < y.min ? x.min : y.min;
  const max = x.max > y.max ? x.max : y.max;
  // Two individually coherent unknown-signedness ranges may require different
  // interpretations. Their hull is publishable only if one coherent domain can
  // represent the entire merged interval; otherwise the range lattice has no
  // sound single-interval value for it.
  if (!rangeFitsDomain(min, max, width, targetSigned)) return null;
  return rangeWithDomain(min, max, width, targetSigned);
}
