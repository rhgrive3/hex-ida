const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function nonNegativeSafeInteger(value) {
  if (typeof value === 'bigint') {
    return value >= 0n && value <= MAX_SAFE_BIGINT ? value : null;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  return null;
}

/**
 * True only when an Objective-C ivar's concrete storage range is contained in
 * the declaring class' statically allocated instance extent. A null size means
 * the width is unknown, so the offset itself must still be strictly in-bounds.
 */
export function objcIvarRangeWithinInstance(offset, size, instanceSize) {
  const off = nonNegativeSafeInteger(offset);
  const extent = nonNegativeSafeInteger(instanceSize);
  if (off == null || extent == null || extent <= 0n || off >= extent) return false;
  if (size == null) return true;
  const width = nonNegativeSafeInteger(size);
  if (width == null || width <= 0n) return false;
  return width <= extent - off;
}
