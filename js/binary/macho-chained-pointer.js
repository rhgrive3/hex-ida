/**
 * Structural validation shared by the canonical Mach-O loader and the
 * lightweight chained-import recovery path.  Apple defines these fields as
 * reserved/zero, so non-zero values are malformed evidence rather than bits a
 * value decoder may silently discard.
 */
export function chainedPointerReservedBitsReason(raw, format) {
  if (format === 2 || format === 6) {
    const bind = ((raw >> 63n) & 1n) !== 0n;
    if (bind) {
      return ((raw >> 32n) & 0x7ffffn) === 0n
        ? null
        : 'non-zero reserved/zero bits in bind encoding';
    }
    return ((raw >> 44n) & 0x7fn) === 0n
      ? null
      : 'non-zero reserved/zero bits in rebase encoding';
  }

  if (format === 1 || format === 7 || format === 9 || format === 10 || format === 12) {
    const bind = ((raw >> 62n) & 1n) !== 0n;
    if (!bind) return null;
    const ordinalBits = format === 12 ? 24n : 16n;
    const zeroMask = (1n << (32n - ordinalBits)) - 1n;
    return ((raw >> ordinalBits) & zeroMask) === 0n
      ? null
      : 'non-zero reserved/zero bits in ARM64E bind encoding';
  }

  return null;
}
