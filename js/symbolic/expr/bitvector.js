/**
 * js/symbolic/expr/bitvector.js
 *
 * Exact fixed-width bitvector arithmetic and bitwise semantics.
 * Implements SMT-LIB 2.6 and machine-faithful BV semantics including
 * exact wraparound, signed two's-complement arithmetic, shift saturation,
 * div/rem edge cases (division by zero, signed MIN_INT / -1 overflow),
 * truncations, extensions, and bit slices.
 */

import { MAX_BV_WIDTH } from './kinds.js';

export { MAX_BV_WIDTH };

function assertValidWidth(width, fnName = 'bitvector') {
  if (typeof width !== 'number' || !Number.isSafeInteger(width) || width <= 0) {
    throw new RangeError(`${fnName}: width must be a positive safe integer >= 1, got ${width}`);
  }
  if (width > MAX_BV_WIDTH) {
    throw new RangeError(`${fnName}: width exceeds maximum supported width (${MAX_BV_WIDTH}), got ${width}`);
  }
}

function toValidBigInt(val, name = 'value') {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') {
    if (Number.isSafeInteger(val)) return BigInt(val);
    throw new TypeError(`${name} must be a safe integer or bigint, got ${val}`);
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^[+-]?(?:0x[0-9a-fA-F]+|\d+)$/.test(trimmed)) {
      return BigInt(trimmed);
    }
    throw new TypeError(`${name} must be a valid integer string, got "${val}"`);
  }
  throw new TypeError(`${name} must be a bigint, integer number, or integer string, got ${typeof val === 'object' && val !== null ? (Array.isArray(val) ? 'Array' : val.constructor?.name || 'object') : typeof val}`);
}

export function mask(width) {
  assertValidWidth(width, 'mask');
  return (1n << BigInt(width)) - 1n;
}

export function wrap(val, width) {
  assertValidWidth(width, 'wrap');
  const big = toValidBigInt(val, 'wrap value');
  return BigInt.asUintN(width, big);
}

export function toUnsigned(val, width) {
  return wrap(val, width);
}

export function toSigned(val, width) {
  assertValidWidth(width, 'toSigned');
  return BigInt.asIntN(width, wrap(val, width));
}

export function bvAdd(a, b, width) {
  return wrap(toUnsigned(a, width) + toUnsigned(b, width), width);
}

export function bvSub(a, b, width) {
  return wrap(toUnsigned(a, width) - toUnsigned(b, width), width);
}

export function bvMul(a, b, width) {
  return wrap(toUnsigned(a, width) * toUnsigned(b, width), width);
}

export function bvUdiv(a, b, width) {
  const ub = toUnsigned(b, width);
  if (ub === 0n) {
    // SMT-LIB 2.6 standard for bvudiv by zero: all ones (mask)
    return mask(width);
  }
  const ua = toUnsigned(a, width);
  return wrap(ua / ub, width);
}

export function bvUrem(a, b, width) {
  const ub = toUnsigned(b, width);
  if (ub === 0n) {
    // SMT-LIB 2.6 standard for bvurem by zero: first operand (a)
    return toUnsigned(a, width);
  }
  const ua = toUnsigned(a, width);
  return wrap(ua % ub, width);
}

export function bvSdiv(a, b, width) {
  const sb = toSigned(b, width);
  if (sb === 0n) {
    // SMT-LIB 2.6 standard for bvsdiv by zero:
    // (bvslt a 0) ? 1 : -1
    const sa = toSigned(a, width);
    return sa < 0n ? 1n : mask(width); // mask(width) represents -1 in two's complement unsigned
  }
  const sa = toSigned(a, width);
  const minInt = -(1n << BigInt(width - 1));
  // Two's-complement overflow: MIN_INT / -1 wraps around to MIN_INT
  if (sa === minInt && sb === -1n) {
    return wrap(minInt, width);
  }
  return wrap(sa / sb, width);
}

export function bvSrem(a, b, width) {
  const sb = toSigned(b, width);
  if (sb === 0n) {
    // SMT-LIB 2.6 standard for bvsrem by zero: a
    return toUnsigned(a, width);
  }
  const sa = toSigned(a, width);
  const minInt = -(1n << BigInt(width - 1));
  if (sa === minInt && sb === -1n) {
    return 0n;
  }
  return wrap(sa % sb, width);
}

export function bvAnd(a, b, width) {
  return wrap(toUnsigned(a, width) & toUnsigned(b, width), width);
}

export function bvOr(a, b, width) {
  return wrap(toUnsigned(a, width) | toUnsigned(b, width), width);
}

export function bvXor(a, b, width) {
  return wrap(toUnsigned(a, width) ^ toUnsigned(b, width), width);
}

export function bvNot(a, width) {
  return wrap(~toUnsigned(a, width), width);
}

export function bvNeg(a, width) {
  return wrap(-toSigned(a, width), width);
}

export function bvShl(a, b, width) {
  const w = width;
  const amt = toUnsigned(b, w);
  if (amt >= BigInt(w)) {
    return 0n;
  }
  return wrap(toUnsigned(a, w) << amt, w);
}

export function bvLshr(a, b, width) {
  const w = width;
  const amt = toUnsigned(b, w);
  if (amt >= BigInt(w)) {
    return 0n;
  }
  return wrap(toUnsigned(a, w) >> amt, w);
}

export function bvAshr(a, b, width) {
  const w = width;
  const amt = toUnsigned(b, w);
  const sa = toSigned(a, w);
  if (amt >= BigInt(w)) {
    return sa < 0n ? mask(w) : 0n;
  }
  return wrap(sa >> amt, w);
}

export function bvEq(a, b, width) {
  return toUnsigned(a, width) === toUnsigned(b, width);
}

export function bvNe(a, b, width) {
  return toUnsigned(a, width) !== toUnsigned(b, width);
}

export function bvUlt(a, b, width) {
  return toUnsigned(a, width) < toUnsigned(b, width);
}

export function bvUle(a, b, width) {
  return toUnsigned(a, width) <= toUnsigned(b, width);
}

export function bvUgt(a, b, width) {
  return toUnsigned(a, width) > toUnsigned(b, width);
}

export function bvUge(a, b, width) {
  return toUnsigned(a, width) >= toUnsigned(b, width);
}

export function bvSlt(a, b, width) {
  return toSigned(a, width) < toSigned(b, width);
}

export function bvSle(a, b, width) {
  return toSigned(a, width) <= toSigned(b, width);
}

export function bvSgt(a, b, width) {
  return toSigned(a, width) > toSigned(b, width);
}

export function bvSge(a, b, width) {
  return toSigned(a, width) >= toSigned(b, width);
}

export function bvTrunc(val, fromWidth, toWidth) {
  assertValidWidth(fromWidth, 'bvTrunc fromWidth');
  assertValidWidth(toWidth, 'bvTrunc toWidth');
  if (toWidth >= fromWidth) {
    throw new RangeError(`bvTrunc: toWidth (${toWidth}) must be strictly less than fromWidth (${fromWidth})`);
  }
  return wrap(val, toWidth);
}

export function bvZext(val, fromWidth, toWidth) {
  assertValidWidth(fromWidth, 'bvZext fromWidth');
  assertValidWidth(toWidth, 'bvZext toWidth');
  if (toWidth <= fromWidth) {
    throw new RangeError(`bvZext: toWidth (${toWidth}) must be strictly greater than fromWidth (${fromWidth})`);
  }
  return wrap(toUnsigned(val, fromWidth), toWidth);
}

export function bvSext(val, fromWidth, toWidth) {
  assertValidWidth(fromWidth, 'bvSext fromWidth');
  assertValidWidth(toWidth, 'bvSext toWidth');
  if (toWidth <= fromWidth) {
    throw new RangeError(`bvSext: toWidth (${toWidth}) must be strictly greater than fromWidth (${fromWidth})`);
  }
  return wrap(toSigned(val, fromWidth), toWidth);
}

export function bvExtract(val, width, high, low) {
  assertValidWidth(width, 'bvExtract');
  const h = high;
  const l = low;
  if (!Number.isSafeInteger(h) || !Number.isSafeInteger(l) || l < 0 || h < l || h >= width) {
    throw new RangeError(`bvExtract: invalid bit indices [high=${high}, low=${low}] for width ${width}`);
  }
  const extractedWidth = h - l + 1;
  assertValidWidth(extractedWidth, 'bvExtract extractedWidth');
  const shifted = toUnsigned(val, width) >> BigInt(l);
  return wrap(shifted, extractedWidth);
}

export function bvConcat(a, widthA, b, widthB) {
  assertValidWidth(widthA, 'bvConcat widthA');
  assertValidWidth(widthB, 'bvConcat widthB');
  const totalWidth = widthA + widthB;
  assertValidWidth(totalWidth, 'bvConcat totalWidth');
  const highPart = wrap(a, widthA) << BigInt(widthB);
  const lowPart = wrap(b, widthB);
  return wrap(highPart | lowPart, totalWidth);
}
