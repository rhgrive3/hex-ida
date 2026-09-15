/**
 * Shared fixture for the #8733 strp-alias regressions.
 *
 * DWARF string forms are offsets into a shared table, so an input can alias one
 * physical string from arbitrarily many DIEs. These builders produce that shape
 * without depending on the parser under test.
 */

function uleb(value) {
  const out = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return out;
}

function u32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/**
 * One DWARF4 compile unit whose children each carry `DW_AT_name` as
 * `DW_FORM_strp` pointing at one of the supplied `.debug_str` offsets.
 */
export function strpAliasSections({ offsets, stringBytes }) {
  const debugAbbrev = Uint8Array.from([
    ...uleb(1), 0x11, 0x01, 0x00, 0x00,
    ...uleb(2), 0x34, 0x00, 0x03, 0x0e, 0x00, 0x00,
    0x00,
  ]);
  const body = [
    ...u16(4),
    ...u32(0),
    0x08,
    ...uleb(1),
  ];
  for (const offset of offsets) body.push(...uleb(2), ...u32(offset));
  body.push(0x00);
  const debugInfo = Uint8Array.from([...u32(body.length), ...body]);
  return {
    debug_info: debugInfo,
    debug_abbrev: debugAbbrev,
    debug_str: Uint8Array.from(stringBytes),
  };
}

function u16(value) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

/** A single long NUL-terminated string of `length` filler bytes. */
export function singleLongString(length, filler = 0x41) {
  const bytes = new Uint8Array(length + 1).fill(filler);
  bytes[length] = 0;
  return bytes;
}

/** `count` NUL-terminated strings of `length` bytes each, laid out back to back. */
export function distinctStrings(count, length, filler = 0x42) {
  const bytes = new Uint8Array(count * (length + 1));
  const offsets = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * (length + 1);
    bytes.fill(filler, start, start + length);
    bytes[start + length] = 0;
    offsets.push(start);
  }
  return { bytes, offsets };
}

/**
 * The issue's reproducer: one ~64 KiB string aliased by many DIEs.
 */
export function strpAliasReproducer({ aliases = 1000, stringLength = 65_535 } = {}) {
  return strpAliasSections({
    offsets: Array.from({ length: aliases }, () => 0),
    stringBytes: singleLongString(stringLength),
  });
}
