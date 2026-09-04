function validBits(bits) {
  return typeof bits === 'number' && Number.isInteger(bits) && bits > 0 && bits <= 64 ? bits : 64;
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
  const width = validBits(bits);
  const raw = BigInt.asUintN(width, strictBigInt(value));
  return signed === true ? BigInt.asIntN(width, raw) : raw;
}

export function rangeWithDomain(min, max, bits = 64, signed = null) {
  const width = validBits(bits);
  const domainSigned = normalizedSignedness(signed);
  const normalizedMin = strictBigInt(min);
  const normalizedMax = strictBigInt(max);
  if (!rangeFitsDomain(normalizedMin, normalizedMax, width, domainSigned)) {
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
  const width = validBits(bits || range.bits || 64);
  const srcBits = validBits(range.bits || width);
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
  const width = validBits(bits || a?.bits || b?.bits || 64);
  const targetSigned = signed === undefined ? normalizedSignedness(source.signed) : normalizedSignedness(signed);
  if (!a) return normalizeRangeDomain(b, width, targetSigned);
  if (!b) return normalizeRangeDomain(a, width, targetSigned);
  const x = normalizeRangeDomain(a, width, targetSigned);
  const y = normalizeRangeDomain(b, width, targetSigned);
  if (!x || !y) return null;
  return rangeWithDomain(x.min < y.min ? x.min : y.min, x.max > y.max ? x.max : y.max, width, targetSigned);
}
