/**
 * Exact FNV-1a-64 in two unsigned 32-bit limbs. No UTF-8 conversion is done by
 * the text variant: canonical IDs have always hashed JavaScript UTF-16 units.
 * The prime is 2**40 + 0x1b3. Splitting the low limb into two 16-bit parts
 * computes its carry with exact small integer arithmetic (each product < 2**25).
 * The wrapped cross-products and that carry give the high limb, with no BigInt
 * allocation and no floating-point division in the character/byte loop.
 * Keep the BigInt reference implementation in the tests, not in the hot loop.
 */
const OFFSET_LOW = 0x84222325;
const OFFSET_HIGH = 0xcbf29ce4;

function checkSeed(low, high) {
  if (!Number.isInteger(low) || low < 0 || low > 0xffffffff
    || !Number.isInteger(high) || high < 0 || high > 0xffffffff) {
    throw new TypeError('fnv64-invalid-seed');
  }
}

export function fnv64Hex(low, high) {
  return (high >>> 0).toString(16).padStart(8, '0') + (low >>> 0).toString(16).padStart(8, '0');
}

export function fnv64Text(text, low = OFFSET_LOW, high = OFFSET_HIGH) {
  checkSeed(low, high);
  for (let index = 0; index < text.length; index += 1) {
    low ^= text.charCodeAt(index);
    const carry = ((low >>> 16) * 0x1b3 + (((low & 0xffff) * 0x1b3) >>> 16)) >>> 16;
    high = (Math.imul(high, 0x1b3) + (low << 8) + carry) | 0;
    low = Math.imul(low, 0x1b3);
  }
  return fnv64Hex(low, high);
}

/** Accepts byte iterables and returns state so chunk boundaries never affect identity. */
export function fnv64Bytes(bytes, low = OFFSET_LOW, high = OFFSET_HIGH) {
  checkSeed(low, high);
  for (const byte of bytes) {
    // Retain the public hashBytes domain and its exact error, including holes,
    // non-numbers, signed values and values from custom iterators.
    if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new TypeError('hashBytes byte must be an integer 0..255');
    }
    low ^= byte;
    const carry = ((low >>> 16) * 0x1b3 + (((low & 0xffff) * 0x1b3) >>> 16)) >>> 16;
    high = (Math.imul(high, 0x1b3) + (low << 8) + carry) | 0;
    low = Math.imul(low, 0x1b3);
  }
  return { low: low >>> 0, high: high >>> 0 };
}

/** ByteSource hashing uses indexed reads, deliberately ignoring custom iterators. */
export function fnv64ByteView(bytes, low = OFFSET_LOW, high = OFFSET_HIGH) {
  checkSeed(low, high);
  for (let index = 0; index < bytes.length; index += 1) {
    low ^= bytes[index];
    const carry = ((low >>> 16) * 0x1b3 + (((low & 0xffff) * 0x1b3) >>> 16)) >>> 16;
    high = (Math.imul(high, 0x1b3) + (low << 8) + carry) | 0;
    low = Math.imul(low, 0x1b3);
  }
  return { low: low >>> 0, high: high >>> 0 };
}
