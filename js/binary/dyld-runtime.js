const MAX_U64 = (1n << 64n) - 1n;

/**
 * Normalize a user/API supplied dyld shared-cache runtime slide without losing
 * integer precision. Browser text input commonly arrives as hexadecimal text;
 * callers may also pass an exact bigint or safe integer.
 */
export function normalizeDyldRuntimeSlide(value) {
  let slide;
  if (typeof value === 'bigint') slide = value;
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('dyld runtime slide must be an exact integer');
    slide = BigInt(value);
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(text)) {
      throw new TypeError('dyld runtime slide must be hexadecimal (0x...) or decimal');
    }
    slide = BigInt(text);
  } else {
    throw new TypeError('dyld runtime slide must be an exact integer');
  }
  if (slide < 0n || slide > MAX_U64) throw new RangeError('dyld runtime slide is outside the 64-bit address range');
  return slide;
}
