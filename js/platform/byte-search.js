/**
 * Bounded Boyer-Moore-Horspool matcher for the worker's byte-search contract.
 * Text is ASCII-folded only; hex patterns retain bit/nibble masks. The table
 * skips only starts ruled out by the current window's final byte. Returning
 * each match separately lets the caller retain overlaps, paging and its cap.
 * Repeated suffixes fall back to bounded-width bit-parallel matching rather
 * than repeatedly comparing the same long suffix at every candidate start.
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
      *findAll(bytes, from = 0) {
        if (matches) for (let at = from; at <= bytes.length - length; at++) yield at;
      },
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
  // Build byte-admission masks lazily, only if the fast path exhausts its
  // source-probe allowance. At most 256 masks of <=4096 bits are retained.
  // This also handles arbitrary nibble/bit masks: ordinary KMP prefix tables
  // are not sound for these overlapping character classes.
  let admissions = null;
  function* findAllBitParallel(bytes, from) {
    const accepted = admissions ??= Object.create(null);
    const finalBit = 1n << BigInt(length - 1);
    let state = 0n;
    for (let at = from; at < bytes.length; at++) {
      const byte = foldAscii ? lower(bytes[at]) : bytes[at] & 255;
      // A non-byte text operand cannot equal a captured byte. Do not let it
      // create arbitrary properties on the bounded admission table.
      if (foldAscii && (!Number.isInteger(byte) || byte < 0 || byte > 255)) { state = 0n; continue; }
      let positions = accepted[byte];
      if (positions === undefined) {
        positions = 0n;
        let bit = 1n;
        for (let index = 0; index < length; index++, bit <<= 1n) {
          if (masks ? (byte & masks[index]) === expected[index] : byte === expected[index]) positions |= bit;
        }
        accepted[byte] = positions;
      }
      state = ((state << 1n) | 1n) & positions;
      if ((state & finalBit) !== 0n) yield at - length + 1;
    }
  }
  return Object.freeze({
    // A fresh, lazy iterator owns each haystack scan. Count successful probes
    // across matches as well: repeatedly calling find() resets its allowance
    // and can otherwise repeat a full pattern comparison for every overlap.
    // No partial haystack state survives between iterators or find() calls.
    *findAll(bytes, from = 0) {
      const last = length - 1;
      const end = bytes.length - length;
      const allowance = 2 * (bytes.length - from);
      let probes = 0;
      for (let at = from; at <= end;) {
        const tail = foldAscii ? lower(bytes[at + last]) : bytes[at + last];
        probes++;
        let index = last;
        for (; index >= 0; index--) {
          const actual = foldAscii ? lower(bytes[at + index]) : bytes[at + index];
          probes++;
          if (masks ? (actual & masks[index]) !== expected[index] : actual !== expected[index]) break;
        }
        if (index < 0) {
          yield at;
          at++; // retain overlapping matches
        } else at += skip[tail];
        if (probes > allowance && at <= end) {
          yield* findAllBitParallel(bytes, at);
          return;
        }
      }
    },
    find(bytes, from = 0) {
      const last = length - 1;
      const end = bytes.length - length;
      // Count byte probes, not elapsed time. One final comparison can exceed
      // this allowance by at most length+1 before switching to the fallback.
      const allowance = 2 * (bytes.length - from);
      let probes = 0;
      for (let at = from; at <= end;) {
        const tail = foldAscii ? lower(bytes[at + last]) : bytes[at + last];
        probes++;
        let index = last;
        for (; index >= 0; index -= 1) {
          const actual = foldAscii ? lower(bytes[at + index]) : bytes[at + index];
          probes++;
          if (masks ? (actual & masks[index]) !== expected[index] : actual !== expected[index]) break;
        }
        if (index < 0) return at;
        at += skip[tail];
        // The BMH shift already proved earlier starts impossible. A fresh
        // bit-parallel state at the next start retains first-match ordering.
        if (probes > allowance && at <= end) return findAllBitParallel(bytes, at).next().value ?? -1;
      }
      return -1;
    },
  });
}
