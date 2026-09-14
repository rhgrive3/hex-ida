import { checkedRange, fail } from './validation-utils.js';

// DEX LEB128 denotes a 32-bit quantity, including in debug/exception metadata.
// Check the high payload before any 32-bit operation can discard it.
export function readDexUleb128(bytes, offset, limit = bytes.length, code = 'dex-malformed-uleb128') {
  checkedRange(bytes.length, 0, limit, code);
  checkedRange(limit, offset, 1, code);
  let value = 0, factor = 1, pos = offset;
  for (let count = 0; count < 5; count++) {
    if (pos >= limit) fail(code);
    const byte = bytes[pos++];
    if (count === 4 && (byte & 0xf0) !== 0) fail(code);
    value += (byte & 0x7f) * factor;
    if ((byte & 0x80) === 0) return { value, nextOffset: pos };
    factor *= 128;
  }
  fail(code);
}

export function readDexSleb128(bytes, offset, limit = bytes.length, code = 'dex-malformed-sleb128') {
  checkedRange(bytes.length, 0, limit, code);
  checkedRange(limit, offset, 1, code);
  let value = 0, factor = 1, pos = offset;
  for (let count = 0; count < 5; count++) {
    if (pos >= limit) fail(code);
    const byte = bytes[pos++], payload = byte & 0x7f;
    if (count === 4 && ((byte & 0x80) !== 0 || (payload > 7 && payload < 0x78))) fail(code);
    value += payload * factor;
    factor *= 128;
    if ((byte & 0x80) === 0) {
      if (byte & 0x40) value -= factor;
      return { value, nextOffset: pos };
    }
  }
  fail(code);
}
