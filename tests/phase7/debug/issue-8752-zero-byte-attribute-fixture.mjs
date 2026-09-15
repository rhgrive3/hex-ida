/**
 * Shared fixture for the #8752 zero-byte attribute regressions.
 *
 * A DWARF abbreviation may declare thousands of vendor-extension attributes as
 * `DW_FORM_flag_present`, which consumes no `.debug_info` byte at all. Every DIE
 * that reuses that abbreviation still materializes the full attribute list, so
 * the retained state grows as declaration width x DIE count while every
 * existing byte/record/depth dimension stays comfortably inside its cap.
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

function le32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/** `DW_AT_lo_user..DW_AT_hi_user`: the 8,192 vendor-extension attribute numbers. */
export const VENDOR_ATTRIBUTE_COUNT = 0x2000;

const DW_FORM_flag_present = 0x19;
const DW_FORM_implicit_const = 0x21;

export function zeroByteAbbrevTable({
  code = 2,
  attributeCount = VENDOR_ATTRIBUTE_COUNT,
  form = DW_FORM_flag_present,
  implicitValue = 7,
} = {}) {
  const attributes = [];
  for (let index = 0; index < attributeCount; index += 1) {
    attributes.push(...uleb(0x2000 + index), form);
    if (form === DW_FORM_implicit_const) attributes.push(...uleb(implicitValue));
  }
  return Uint8Array.from([
    0x01, 0x11, 0x01, 0x00, 0x00,
    code, 0x34, 0x00, ...attributes, 0x00, 0x00,
    0x00,
  ]);
}

export function zeroByteAttributeSections({
  children = 250,
  code = 2,
  attributeCount = VENDOR_ATTRIBUTE_COUNT,
  form = DW_FORM_flag_present,
} = {}) {
  const body = [
    0x04, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x08,
    0x01,
    ...Array.from({ length: children }, () => code),
    0x00,
  ];
  const debugInfo = Uint8Array.from([...le32(body.length), ...body]);
  return {
    debug_info: debugInfo,
    debug_abbrev: zeroByteAbbrevTable({ code, attributeCount, form }),
  };
}

/** Total attribute entries retained across a parsed DIE forest. */
export function materializedEntries(dies) {
  let total = 0;
  for (const die of dies.values()) total += die.attributes.size;
  return total;
}
