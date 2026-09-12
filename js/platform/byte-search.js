/**
 * Bounded Boyer-Moore-Horspool matcher for the worker's byte-search contract.
 * Text is ASCII-folded only; hex patterns retain bit/nibble masks. The table
 * skips only starts ruled out by the current window's final byte. Returning
 * each match separately lets the caller retain overlaps, paging and its cap.
 */
const MAX_COMPILED_PATTERN = 4096;
function lower(byte) { return byte >= 65 && byte <= 90 ? byte + 32 : byte; }

function plainByteList(value, length) {
  if (!Array.isArray(value) && !(value instanceof Uint8Array)) return false;
  if (value.length !== length) return false;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor && !Object.hasOwn(lengthDescriptor, 'value')) return false;
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
    const byte = descriptor.value;
    if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) return false;
  }
  return true;
}

/** Null means use the existing comparison path; it is not a rejected query. */
export function compileBytePattern(pattern, mask = null, foldAscii = false) {
  const length = pattern?.length;
  if (!Number.isInteger(length) || length < 3 || length > MAX_COMPILED_PATTERN) return null;
  try {
    if (!plainByteList(pattern, length) || (!foldAscii && !plainByteList(mask, length))) return null;
  } catch { return null; }
  const expected = new Uint8Array(length);
  const masks = foldAscii ? null : new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    expected[index] = foldAscii ? lower(pattern[index]) : pattern[index];
    if (masks) masks[index] = mask[index];
  }
  if (masks && masks.every((maskByte) => maskByte === 0)) {
    // A fully wildcarded pattern needs no per-byte comparison or skip table.
    // A nonzero literal under a zero mask was impossible in the old predicate.
    const matches = expected.every((byte) => byte === 0);
    return Object.freeze({
      find(bytes, from = 0) { return matches && from <= bytes.length - length ? from : -1; },
    });
  }
  const skip = new Uint32Array(256).fill(length);
  for (let index = 0; index < length - 1; index += 1) {
    const distance = length - 1 - index;
    if (!masks || masks[index] === 255) skip[expected[index]] = distance;
    else {
      // Include every byte admitted by the mask, not just the literal. This
      // conservative shift retains nibble masks and all-wildcard patterns.
      for (let byte = 0; byte < 256; byte += 1) {
        if ((byte & masks[index]) === expected[index]) skip[byte] = distance;
      }
    }
  }
  return Object.freeze({
    find(bytes, from = 0) {
      const last = length - 1;
      const end = bytes.length - length;
      for (let at = from; at <= end;) {
        const tail = foldAscii ? lower(bytes[at + last]) : bytes[at + last];
        let index = last;
        for (; index >= 0; index -= 1) {
          const actual = foldAscii ? lower(bytes[at + index]) : bytes[at + index];
          if (masks ? (actual & masks[index]) !== expected[index] : actual !== expected[index]) break;
        }
        if (index < 0) return at;
        at += skip[tail];
      }
      return -1;
    },
  });
}
