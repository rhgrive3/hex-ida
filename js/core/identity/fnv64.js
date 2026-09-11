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
const CHAR_CODE_AT = String.prototype.charCodeAt;
const IMUL = Math.imul;
const NUMBER_TO_STRING = Number.prototype.toString;
const PAD_START = String.prototype.padStart;
// A plain Uint8Array already guarantees the public byte domain. An indexed
// loop is permitted only when it is equivalent to the ordinary iterator.
const BYTE_ARRAY_PROTOTYPE = Uint8Array.prototype;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(BYTE_ARRAY_PROTOTYPE);
const TYPED_ARRAY_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'length').get;
const TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'buffer').get;
const TYPED_ARRAY_ITERATOR = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, Symbol.iterator).value;
const ITERATOR_PROTOTYPE = Object.getPrototypeOf(TYPED_ARRAY_ITERATOR.call(new Uint8Array(0)));
const ITERATOR_NEXT = Object.getOwnPropertyDescriptor(ITERATOR_PROTOTYPE, 'next').value;
const BUFFER_RESIZABLE = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const BUFFER_BYTE_LENGTH = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const MIN_INDEXED_BYTES = 4096;

function ordinaryByteLength(bytes) {
  // Never reflect on a Proxy or call caller-supplied .length/.buffer getters.
  if (!ArrayBuffer.isView(bytes) || Object.getPrototypeOf(bytes) !== BYTE_ARRAY_PROTOTYPE) return 0;
  const length = TYPED_ARRAY_LENGTH.call(bytes);
  if (length < MIN_INDEXED_BYTES) return 0; // includes empty/detached/out-of-bounds views
  if (Object.hasOwn(bytes, Symbol.iterator) || Object.hasOwn(BYTE_ARRAY_PROTOTYPE, Symbol.iterator)
    || Object.getPrototypeOf(BYTE_ARRAY_PROTOTYPE) !== TYPED_ARRAY_PROTOTYPE
    || Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, Symbol.iterator)?.value !== TYPED_ARRAY_ITERATOR
    || Object.getOwnPropertyDescriptor(ITERATOR_PROTOTYPE, 'next')?.value !== ITERATOR_NEXT
    || Object.getOwnPropertyDescriptor(Math, 'imul')?.value !== IMUL) return 0;
  const buffer = TYPED_ARRAY_BUFFER.call(bytes);
  // Shared/growable storage and resizable buffers retain iterator semantics.
  try {
    // Native internal-slot checks do not execute user-defined @@hasInstance.
    if (BUFFER_RESIZABLE) { if (BUFFER_RESIZABLE.call(buffer)) return 0; }
    else BUFFER_BYTE_LENGTH.call(buffer);
  } catch { return 0; }
  return length;
}

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

/**
 * The canonical digest uses the same text with two fixed initial states.
 * Advance both lanes during one UTF-16 traversal; the public single-lane
 * primitive and its caller-supplied seeds remain unchanged.
 */
export function fnv64TextDigest(text) {
  // Preserve the historical two traversals for user-supplied string-like
  // objects or replaced accessors; the fused loop is for ordinary strings.
  if (typeof text !== 'string'
    || Object.getOwnPropertyDescriptor(String.prototype, 'charCodeAt')?.value !== CHAR_CODE_AT
    || Object.getOwnPropertyDescriptor(Math, 'imul')?.value !== IMUL
    || Object.getOwnPropertyDescriptor(Number.prototype, 'toString')?.value !== NUMBER_TO_STRING
    || Object.getOwnPropertyDescriptor(String.prototype, 'padStart')?.value !== PAD_START) {
    return fnv64Text(text) + fnv64Text(text, OFFSET_HIGH, OFFSET_LOW);
  }
  let low0 = OFFSET_LOW, high0 = OFFSET_HIGH;
  let low1 = OFFSET_HIGH, high1 = OFFSET_LOW;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    low0 ^= code;
    low1 ^= code;
    const carry0 = ((low0 >>> 16) * 0x1b3 + (((low0 & 0xffff) * 0x1b3) >>> 16)) >>> 16;
    const carry1 = ((low1 >>> 16) * 0x1b3 + (((low1 & 0xffff) * 0x1b3) >>> 16)) >>> 16;
    high0 = (Math.imul(high0, 0x1b3) + (low0 << 8) + carry0) | 0;
    high1 = (Math.imul(high1, 0x1b3) + (low1 << 8) + carry1) | 0;
    low0 = Math.imul(low0, 0x1b3);
    low1 = Math.imul(low1, 0x1b3);
  }
  return fnv64Hex(low0, high0) + fnv64Hex(low1, high1);
}

/** Accepts byte iterables and returns state so chunk boundaries never affect identity. */
export function fnv64Bytes(bytes, low = OFFSET_LOW, high = OFFSET_HIGH) {
  checkSeed(low, high);
  const length = ordinaryByteLength(bytes);
  if (length) {
    for (let index = 0; index < length; index++) {
      low ^= bytes[index];
      const carry = ((low >>> 16) * 0x1b3 + (((low & 0xffff) * 0x1b3) >>> 16)) >>> 16;
      high = (Math.imul(high, 0x1b3) + (low << 8) + carry) | 0;
      low = Math.imul(low, 0x1b3);
    }
    return { low: low >>> 0, high: high >>> 0 };
  }
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
