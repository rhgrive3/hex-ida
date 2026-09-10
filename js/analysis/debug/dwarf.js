/**
 * P7-5a — DWARF provider.
 *
 * Reads a practical subset of DWARF 4 and 5: the abbreviation table, the
 * compilation-unit DIE tree, and the string sections. That is enough to produce
 * function symbols and the type records the TypeConstraintGraph consumes, which
 * is what proves the boundary.
 *
 * Everything outside that subset is reported as an explicit diagnostic and an
 * incomplete status rather than being skipped silently. A DWARF form this
 * reader does not understand means the attribute is *unknown*, and the record
 * it belongs to must not claim to be complete.
 *
 * Identity comes from the ELF build id (`.note.gnu.build-id`) or, for split
 * debug files, from `.gnu_debuglink` and its CRC32. Filename equality is never
 * accepted — the provider contract rejects it outright.
 */

import { parseELF as parseELFImage } from '../../binary/elf.js';
import { createAnalysisStatus } from '../status.js';
import {
  DEBUG_DEFAULT_BUDGET,
  DEBUG_DEFAULT_PAGE_SIZE,
  DebugInfoProvider,
  createDebugPage,
  createDebugProviderResult,
  createDebugRecord,
  resolveDebugBudget,
} from './provider.js';

export const DWARF_PROVIDER_ID = 'phase7.debug.dwarf';
export const DWARF_PROVIDER_VERSION = '1.0.0';

// DWARF tags this reader models. Anything else becomes a diagnostic.
const DW_TAG = Object.freeze({
  array_type: 0x01,
  structure_type: 0x13,
  union_type: 0x17,
  class_type: 0x02,
  enumeration_type: 0x04,
  formal_parameter: 0x05,
  member: 0x0d,
  pointer_type: 0x0f,
  compile_unit: 0x11,
  partial_unit: 0x12,
  base_type: 0x24,
  const_type: 0x26,
  subprogram: 0x2e,
  variable: 0x34,
  typedef: 0x16,
  volatile_type: 0x35,
  subroutine_type: 0x15,
});

const DW_AT = Object.freeze({
  location: 0x02,
  name: 0x03,
  byte_size: 0x0b,
  stmt_list: 0x10,
  low_pc: 0x11,
  high_pc: 0x12,
  language: 0x13,
  comp_dir: 0x1b,
  const_value: 0x1c,
  upper_bound: 0x2f,
  producer: 0x25,
  prototyped: 0x27,
  count: 0x37,
  data_member_location: 0x38,
  declaration: 0x3c,
  encoding: 0x3e,
  external: 0x3f,
  frame_base: 0x40,
  specification: 0x47,
  type: 0x49,
  ranges: 0x55,
  str_offsets_base: 0x72,
  addr_base: 0x73,
  rnglists_base: 0x74,
});

const DW_FORM = Object.freeze({
  addr: 0x01, block2: 0x03, block4: 0x04, data2: 0x05, data4: 0x06, data8: 0x07,
  string: 0x08, block: 0x09, block1: 0x0a, data1: 0x0b, flag: 0x0c, sdata: 0x0d,
  strp: 0x0e, udata: 0x0f, ref_addr: 0x10, ref1: 0x11, ref2: 0x12, ref4: 0x13,
  ref8: 0x14, ref_udata: 0x15, indirect: 0x16, sec_offset: 0x17, exprloc: 0x18,
  flag_present: 0x19, strx: 0x1a, addrx: 0x1b, ref_sup4: 0x1c, strp_sup: 0x1d,
  data16: 0x1e, line_strp: 0x1f, ref_sig8: 0x20, implicit_const: 0x21,
  loclistx: 0x22, rnglistx: 0x23, ref_sup8: 0x24,
  strx1: 0x25, strx2: 0x26, strx3: 0x27, strx4: 0x28,
  addrx1: 0x29, addrx2: 0x2a, addrx3: 0x2b, addrx4: 0x2c,
});

// DWARF5 address forms carry a zero-based index into the unit's `.debug_addr`
// address array (#6184), not an address themselves.
const ADDRX_FORMS = Object.freeze([DW_FORM.addrx, DW_FORM.addrx1, DW_FORM.addrx2, DW_FORM.addrx3, DW_FORM.addrx4]);
/** Forms whose resolved value is an absolute address (direct or addrx-resolved). */
const ADDRESS_CLASS_FORMS = Object.freeze([DW_FORM.addr, ...ADDRX_FORMS]);
const DEFAULT_MAX_ADDR_CONTRIBUTION_SCANS = 4096;

const DW_UT = Object.freeze({
  compile: 0x01,
  type: 0x02,
  partial: 0x03,
  skeleton: 0x04,
  split_compile: 0x05,
  split_type: 0x06,
});

/** DW_ATE base-type encodings, mapped to the machine layer's classes. */
const ENCODING_CLASS = Object.freeze({
  0x02: 'boolean', 0x04: 'float', 0x05: 'integer', 0x06: 'integer',
  0x07: 'integer', 0x08: 'integer', 0x0d: 'integer', 0x0e: 'integer',
});

// Abbreviation parsing is independent of the DIE-record budget. Keep explicit
// parser-local ceilings so a large `.debug_abbrev` cannot consume unbounded CPU
// or memory before the first DIE is charged (#3932).
const DEFAULT_MAX_ABBREV_DECLARATIONS = 65_536;
const DEFAULT_MAX_ABBREV_ATTRIBUTES = 1_048_576;

class Cursor {
  constructor(bytes, offset = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
    // Reads must not walk past a caller-declared end (a compilation-unit
    // boundary, #1860). `subarray()` silently clamps an out-of-range end, so a
    // short block would otherwise read nothing, advance the offset anyway, and
    // slip through every truncation check.
    this.limit = bytes.length;
  }

  get eof() { return this.offset >= this.limit; }

  u8() { if (this.offset + 1 > this.limit) throw new RangeError('dwarf-read-past-limit'); const value = this.view.getUint8(this.offset); this.offset += 1; return value; }
  u16() { if (this.offset + 2 > this.limit) throw new RangeError('dwarf-read-past-limit'); const value = this.view.getUint16(this.offset, true); this.offset += 2; return value; }
  u32() { if (this.offset + 4 > this.limit) throw new RangeError('dwarf-read-past-limit'); const value = this.view.getUint32(this.offset, true); this.offset += 4; return value; }
  u64() { if (this.offset + 8 > this.limit) throw new RangeError('dwarf-read-past-limit'); const value = this.view.getBigUint64(this.offset, true); this.offset += 8; return value; }

  uleb() {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = this.u8();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
      if (shift > 128n) throw new RangeError('dwarf-uleb-too-long');
    }
    return result;
  }

  sleb() {
    let result = 0n;
    let shift = 0n;
    let byte;
    do {
      byte = this.u8();
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if (shift > 128n) throw new RangeError('dwarf-sleb-too-long');
    } while (byte & 0x80);
    if (shift < 128n && (byte & 0x40)) result -= 1n << shift;
    return result;
  }

  skip(count) { this.offset += count; }
  /** Bounded slice: fails closed rather than silently clamping (#1860). */
  slice(count) {
    if (this.offset + count > this.limit) throw new RangeError('dwarf-read-past-limit');
    const out = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }
}

/**
 * Reads a NUL-terminated string from a string section.
 *
 * A section-backed string is only valid when the offset points inside the
 * section *and* a NUL terminator follows before its end (#1861). Anything else
 * returns `null`, which callers propagate as an unresolved attribute instead of
 * silently decoding an empty or unterminated span.
 */
function cstring(bytes, offset) {
  if (!bytes || offset < 0 || offset >= bytes.length) return null;
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  if (end === bytes.length) return null;
  return new TextDecoder('utf8').decode(bytes.subarray(offset, end));
}

/** Parses one `.debug_abbrev` table with shared per-parse budgets. */
function parseAbbrev(bytes, tableOffset, state = null) {
  const table = new Map();
  // DWARF §7.5.3: an abbreviation code is unique within one table. A duplicate
  // declaration makes the DIE→declaration mapping ambiguous, so the table is
  // marked malformed and its duplicates must not silently overwrite (#5728).
  let duplicateCode = false;
  // DWARF v5 Table 7.4: the child determination encodes exactly
  // DW_CHILDREN_no (0x00) or DW_CHILDREN_yes (0x01). Any other byte collapses
  // to a legal value under a boolean read and must fail the table closed
  // instead (#5237).
  let invalidChildByte = false;
  if (!bytes || tableOffset >= bytes.length) return { table, stopReason: null, duplicateCode, invalidChildByte };
  const cursor = new Cursor(bytes, tableOffset);
  while (!cursor.eof) {
    if (state?.isCancelled?.()) return { table: null, stopReason: 'cancelled' };
    const code = Number(cursor.uleb());
    if (code === 0) break;
    if (state) {
      state.declarations += 1;
      if (state.declarations > state.maxDeclarations) return { table: null, stopReason: 'declaration-budget' };
    }
    const tag = Number(cursor.uleb());
    const childByte = cursor.u8();
    if (childByte > 1) invalidChildByte = true;
    const hasChildren = childByte === 1;
    const attributes = [];
    for (;;) {
      if (state?.isCancelled?.()) return { table: null, stopReason: 'cancelled' };
      const attribute = Number(cursor.uleb());
      const form = Number(cursor.uleb());
      const implicitConst = form === DW_FORM.implicit_const ? cursor.sleb() : null;
      if (attribute === 0 && form === 0) break;
      if (state) {
        state.attributes += 1;
        if (state.attributes > state.maxAttributes) return { table: null, stopReason: 'attribute-budget' };
      }
      attributes.push({ attribute, form, implicitConst });
    }
    if (table.has(code)) duplicateCode = true;
    else table.set(code, { tag, hasChildren, attributes });
  }
  return { table, stopReason: null, duplicateCode, invalidChildByte };
}

/** Reads a bounded little-endian unsigned integer of exactly `width` bytes. */
function readUnsignedWidth(cursor, width) {
  if (!Number.isInteger(width) || width < 1 || width > 8) throw new RangeError('dwarf-address-size-unsupported');
  let value = 0n;
  for (let index = 0; index < width; index += 1) {
    value |= BigInt(cursor.u8()) << BigInt(index * 8);
  }
  return value;
}

/**
 * Reads one attribute value.
 *
 * Returns `{ value, unsupported }`. An unsupported form is *not* an exception:
 * the DIE keeps its other attributes and records that one is unknown, which is
 * how a partially understood record stays honest instead of being dropped.
 */
function readForm(cursor, form, unit, sections, implicitConst) {
  switch (form) {
    case DW_FORM.addr: {
      // DW_FORM_addr occupies exactly the CU's address size, which the DWARF
      // spec does not restrict to 4/8: reading any other width desyncs every
      // following attribute (#5305).
      const width = unit.addressSize;
      if (!Number.isSafeInteger(width) || width < 1 || width > 8) return { value: null, unsupported: true, fatal: true };
      let value = 0n;
      for (let index = 0; index < width; index++) value |= BigInt(cursor.u8()) << BigInt(8 * index);
      return { value };
    }
    case DW_FORM.data1: case DW_FORM.ref1: case DW_FORM.strx1: case DW_FORM.addrx1: case DW_FORM.flag:
      return { value: BigInt(cursor.u8()) };
    case DW_FORM.data2: case DW_FORM.ref2: case DW_FORM.strx2: case DW_FORM.addrx2:
      return { value: BigInt(cursor.u16()) };
    case DW_FORM.strx3: case DW_FORM.addrx3: {
      const low = cursor.u16();
      return { value: BigInt(low | (cursor.u8() << 16)) };
    }
    case DW_FORM.data4: case DW_FORM.ref4: case DW_FORM.strx4: case DW_FORM.addrx4: case DW_FORM.ref_sup4:
      return { value: BigInt(cursor.u32()) };
    case DW_FORM.data8: case DW_FORM.ref8: case DW_FORM.ref_sig8: case DW_FORM.ref_sup8:
      return { value: cursor.u64() };
    case DW_FORM.data16: return { value: cursor.slice(16) };
    case DW_FORM.sdata: return { value: cursor.sleb() };
    case DW_FORM.udata: case DW_FORM.ref_udata: case DW_FORM.strx: case DW_FORM.addrx:
    case DW_FORM.loclistx: case DW_FORM.rnglistx:
      return { value: cursor.uleb() };
    case DW_FORM.string: {
      const start = cursor.offset;
      let end = start;
      while (end < cursor.limit && cursor.bytes[end] !== 0) end += 1;
      if (end === cursor.limit) throw new RangeError('dwarf-read-past-limit');
      const text = new TextDecoder('utf8').decode(cursor.bytes.subarray(start, end));
      cursor.offset = end + 1;
      return { value: text };
    }
    case DW_FORM.strp: {
      const offset = unit.offsetSize === 8 ? Number(cursor.u64()) : cursor.u32();
      const text = sections.debug_str ? cstring(sections.debug_str, offset) : null;
      return { value: text, unsupported: !sections.debug_str || text == null };
    }
    case DW_FORM.line_strp: {
      const offset = unit.offsetSize === 8 ? Number(cursor.u64()) : cursor.u32();
      const text = sections.debug_line_str ? cstring(sections.debug_line_str, offset) : null;
      return { value: text, unsupported: !sections.debug_line_str || text == null };
    }
    case DW_FORM.ref_addr:
      return { value: unit.version === 2
        ? readUnsignedWidth(cursor, unit.addressSize)
        : (unit.offsetSize === 8 ? cursor.u64() : BigInt(cursor.u32())) };
    case DW_FORM.sec_offset: case DW_FORM.strp_sup:
      return { value: unit.offsetSize === 8 ? cursor.u64() : BigInt(cursor.u32()) };
    case DW_FORM.exprloc: case DW_FORM.block: {
      const length = Number(cursor.uleb());
      return { value: cursor.slice(length) };
    }
    case DW_FORM.block1: return { value: cursor.slice(cursor.u8()) };
    case DW_FORM.block2: return { value: cursor.slice(cursor.u16()) };
    case DW_FORM.block4: return { value: cursor.slice(cursor.u32()) };
    case DW_FORM.flag_present: return { value: 1n };
    case DW_FORM.implicit_const: return { value: implicitConst };
    case DW_FORM.indirect: {
      const actual = Number(cursor.uleb());
      return readForm(cursor, actual, unit, sections, null);
    }
    default:
      // An unrecognised form has an unknown length, so the DIE stream cannot be
      // resynchronised. The unit stops here and reports itself incomplete.
      return { value: null, unsupported: true, fatal: true };
  }
}

/** Resolves the string for a DW_FORM_strx index through `.debug_str_offsets`. */
function strxString(index, unit, sections) {
  const table = sections.debug_str_offsets;
  if (!table || !sections.debug_str) return null;
  const base = unit.strOffsetsBase ?? 8;
  const entrySize = unit.offsetSize;
  const at = base + Number(index) * entrySize;
  if (at + entrySize > table.length) return null;
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const offset = entrySize === 8 ? Number(view.getBigUint64(at, true)) : view.getUint32(at, true);
  return cstring(sections.debug_str, offset);
}

/**
 * Finds the `.debug_addr` contribution whose first address entry is `base`.
 *
 * DW_AT_addr_base names the first entry, not the contribution header. Walking
 * contribution lengths from the section start lets addrx resolution prove that
 * the base is not a header/interior offset and binds it to the header fields
 * that define the entry layout (#6184).
 */
function debugAddrContributionAtBase(table, base, state = null) {
  if (!table || !Number.isSafeInteger(base) || base < 0 || base > table.length) return null;
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  let offset = 0;
  while (offset < table.length) {
    // A lookup for a later contribution re-inspects earlier headers. Charge
    // each header before reading it so the shared parse-wide budget bounds the
    // actual work across all distinct addrBase values, not just lookup count.
    if (state && state.scans >= state.maxScans) {
      state.exhausted = true;
      return null;
    }
    if (state) state.scans += 1;
    if (offset + 4 > table.length) return null;
    const initialLength = view.getUint32(offset, true);
    let length;
    let lengthFieldSize;
    if (initialLength === 0xffffffff) {
      if (offset + 12 > table.length) return null;
      const wideLength = view.getBigUint64(offset + 4, true);
      if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      length = Number(wideLength);
      lengthFieldSize = 12;
    } else {
      // 0xfffffff0..0xfffffffe are reserved initial-length encodings.
      if (initialLength >= 0xfffffff0) return null;
      length = initialLength;
      lengthFieldSize = 4;
    }
    // version(2) + address_size(1) + segment_selector_size(1)
    if (length < 4) return null;
    const bodyStart = offset + lengthFieldSize;
    const end = bodyStart + length;
    if (!Number.isSafeInteger(end) || end > table.length) return null;
    const entriesStart = bodyStart + 4;
    if (entriesStart > end) return null;
    const contribution = {
      entriesStart,
      end,
      version: view.getUint16(bodyStart, true),
      addressSize: view.getUint8(bodyStart + 2),
      segmentSelectorSize: view.getUint8(bodyStart + 3),
    };
    if (base === entriesStart) return contribution;
    // A base inside this contribution but not at its first entry is not the
    // authority described by this header (including header/interior offsets).
    if (base >= offset && base < end) return null;
    offset = end;
  }
  return null;
}

/** Resolves a DW_FORM_addrx* index through a validated DWARF5 `.debug_addr` contribution. */
function addrxAddress(index, unit, sections, state = null) {
  const table = sections.debug_addr;
  const base = unit.addrBase;
  let contribution;
  if (state?.cache?.has(base)) {
    contribution = state.cache.get(base);
  } else {
    // The shared state is charged by contribution header below, not once per
    // lookup: a late base may otherwise make a fresh full-section walk for
    // every distinct CU and exceed the global work budget (#6184).
    contribution = debugAddrContributionAtBase(table, base, state);
    if (state?.cache) state.cache.set(base, contribution);
  }
  if (!contribution
      || contribution.version !== 5
      || contribution.addressSize !== unit.addressSize
      || contribution.addressSize < 1
      || contribution.addressSize > 8
      || contribution.segmentSelectorSize !== 0) return null;
  const indexNumber = Number(index);
  if (!Number.isSafeInteger(indexNumber) || indexNumber < 0) return null;
  const entrySize = contribution.addressSize;
  const relative = indexNumber * entrySize;
  if (!Number.isSafeInteger(relative)) return null;
  const at = base + relative;
  if (!Number.isSafeInteger(at) || at + entrySize > contribution.end) return null;
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  let value = 0n;
  for (let i = 0; i < entrySize; i += 1) value |= BigInt(view.getUint8(at + i)) << BigInt(8 * i);
  return value;
}

/**
 * Walks `.debug_info` and returns the DIE forest.
 *
 * DIEs are kept flat, keyed by their section offset, with a `parent` link. That
 * is what DW_AT_type references need, and it avoids building a deep object
 * graph for a structure that is already addressed by offset.
 */
export function parseDebugInfo(sections, budget = DEBUG_DEFAULT_BUDGET, { signal = null } = {}) {
  const info = sections.debug_info;
  const diagnostics = [];
  const dies = new Map();
  if (!info) return { dies, units: [], diagnostics: ['missing .debug_info'], complete: false, cancelled: false };
  // Missing or malformed budgets fall back to explicit defaults, never disable
  // a cap: comparisons against undefined/NaN are always false (#5352, #3932,
  // #5604). maxRecords merges over the shared provider defaults; the abbrev
  // caps use their own DWARF-specific defaults.
  const { maxRecords } = resolveDebugBudget(budget);
  const maxAbbrevDeclarations = Number.isSafeInteger(budget?.maxAbbrevDeclarations) && budget.maxAbbrevDeclarations > 0
    ? budget.maxAbbrevDeclarations
    : DEFAULT_MAX_ABBREV_DECLARATIONS;
  const maxAbbrevAttributes = Number.isSafeInteger(budget?.maxAbbrevAttributes) && budget.maxAbbrevAttributes > 0
    ? budget.maxAbbrevAttributes
    : DEFAULT_MAX_ABBREV_ATTRIBUTES;

  const units = [];
  const cursor = new Cursor(info, 0);
  const abbrevCache = new Map();
  const requestedAddrContributionScans = Number.isSafeInteger(budget?.maxAddrContributionScans)
    && budget.maxAddrContributionScans > 0
    ? budget.maxAddrContributionScans
    : DEFAULT_MAX_ADDR_CONTRIBUTION_SCANS;
  const addrContributionState = {
    cache: new Map(),
    maxScans: Math.max(1, Math.min(requestedAddrContributionScans, DEFAULT_MAX_ADDR_CONTRIBUTION_SCANS, maxRecords)),
    scans: 0,
    exhausted: false,
  };
  const abbrevState = {
    declarations: 0,
    attributes: 0,
    maxDeclarations: maxAbbrevDeclarations,
    maxAttributes: maxAbbrevAttributes,
    isCancelled: () => signal?.aborted === true,
  };
  let recordCount = 0;
  let complete = true;
  let cancelled = false;

  while (cursor.offset + 11 <= info.length) {
    if (abbrevState.isCancelled()) {
      diagnostics.push('debug parse cancelled');
      complete = false;
      cancelled = true;
      break;
    }
    const unitStart = cursor.offset;
    let length = cursor.u32();
    let offsetSize = 4;
    if (length === 0xffffffff) {
      if (cursor.offset + 8 > info.length) {
        diagnostics.push(`truncated compilation unit at 0x${unitStart.toString(16)}`);
        complete = false;
        break;
      }
      length = Number(cursor.u64());
      offsetSize = 8;
    }
    if (length === 0 || cursor.offset + length > info.length) {
      diagnostics.push(`truncated compilation unit at 0x${unitStart.toString(16)}`);
      complete = false;
      break;
    }
    const unitEnd = cursor.offset + length;
    cursor.limit = unitEnd;   // attribute reads are unit-local (#1860)
    const version = cursor.u16();
    let abbrevOffset;
    let addressSize;
    let unitType = 0x01;
    if (version >= 5) {
      unitType = cursor.u8();
      addressSize = cursor.u8();
      abbrevOffset = offsetSize === 8 ? Number(cursor.u64()) : cursor.u32();
    } else {
      abbrevOffset = offsetSize === 8 ? Number(cursor.u64()) : cursor.u32();
      addressSize = cursor.u8();
    }
    if (version < 2 || version > 5) {
      diagnostics.push(`unsupported DWARF version ${version} at 0x${unitStart.toString(16)}`);
      complete = false;
      cursor.offset = unitEnd;
      cursor.limit = info.length;   // the unit-end advance itself is not unit-local
      continue;
    }

    // DWARF5 extends the common unit header according to unit_type. These bytes
    // are metadata, not DIE abbreviation codes (#3810). Reads stay unit-local so
    // truncated type signatures/type offsets/dwo_ids fail closed.
    if (version === 5) {
      try {
        if (unitType === DW_UT.type || unitType === DW_UT.split_type) {
          cursor.u64();
          if (offsetSize === 8) cursor.u64(); else cursor.u32();
        } else if (unitType === DW_UT.skeleton || unitType === DW_UT.split_compile) {
          cursor.u64();
        }
      } catch (error) {
        diagnostics.push(`truncated DWARF5 unit header at 0x${unitStart.toString(16)}`);
        complete = false;
        cursor.offset = unitEnd;
        cursor.limit = info.length;
        continue;
      }
    }

    const unit = { start: unitStart, version, addressSize, offsetSize, abbrevOffset, unitType, strOffsetsBase: null, addrBase: null };
    let abbrev;
    let duplicateCode = false;
    let invalidChildByte = false;
    if (abbrevCache.has(abbrevOffset)) {
      const cached = abbrevCache.get(abbrevOffset);
      abbrev = cached.table;
      duplicateCode = cached.duplicateCode;
      invalidChildByte = cached.invalidChildByte ?? false;
    } else {
      let parsedAbbrev;
      try {
        parsedAbbrev = parseAbbrev(sections.debug_abbrev, abbrevOffset, abbrevState);
      } catch (error) {
        const boundedReadFailure = error instanceof RangeError
          && ['dwarf-read-past-limit', 'dwarf-uleb-too-long', 'dwarf-sleb-too-long'].includes(error.message);
        if (!boundedReadFailure) throw error;
        const malformed = error.message !== 'dwarf-read-past-limit';
        diagnostics.push(`${malformed ? 'malformed' : 'truncated'} abbreviation table for unit at 0x${unitStart.toString(16)}`);
        complete = false;
        cursor.offset = unitEnd;
        cursor.limit = info.length;
        continue;
      }
      if (parsedAbbrev.stopReason != null) {
        complete = false;
        if (parsedAbbrev.stopReason === 'cancelled') {
          diagnostics.push('debug parse cancelled');
          cancelled = true;
        } else if (parsedAbbrev.stopReason === 'declaration-budget') {
          diagnostics.push('abbreviation declaration budget exhausted');
        } else {
          diagnostics.push('abbreviation attribute budget exhausted');
        }
        break;
      }
      abbrev = parsedAbbrev.table;
      duplicateCode = parsedAbbrev.duplicateCode;
      invalidChildByte = parsedAbbrev.invalidChildByte;
      abbrevCache.set(abbrevOffset, { table: abbrev, duplicateCode, invalidChildByte });
    }
    if (abbrev.size === 0) {
      diagnostics.push(`no abbreviations for unit at 0x${unitStart.toString(16)}`);
      complete = false;
      cursor.offset = unitEnd;
      cursor.limit = info.length;   // the unit-end advance itself is not unit-local
      continue;
    }
    if (duplicateCode) {
      diagnostics.push(`duplicate abbreviation code in table at 0x${abbrevOffset.toString(16)}`);
      complete = false;
    }
    if (invalidChildByte) {
      // DWARF v5 Table 7.4: only 0x00/0x01 are child determination encodings;
      // anything else made the declaration structure unreliable (#5237).
      diagnostics.push(`abbreviation table at 0x${abbrevOffset.toString(16)} has an invalid child determination byte`);
      complete = false;
    }

    const stack = [];
    let rootDie = null;
    let unitComplete = true;
    // A structural violation (wrong root tag, extra top-level DIE) fails the
    // unit closed but does not stop the walk: later DIE offsets and their
    // facts stay available, and only the completeness claim is withheld.
    let unitStructurallyMalformed = false;
    while (cursor.offset < unitEnd) {
      if (abbrevState.isCancelled()) {
        diagnostics.push('debug parse cancelled');
        complete = false;
        unitComplete = false;
        cancelled = true;
        break;
      }
      if (recordCount >= maxRecords) {
        diagnostics.push('record budget exhausted');
        complete = false;
        unitComplete = false;
        break;
      }
      const dieOffset = cursor.offset;
      let code;
      try {
        code = Number(cursor.uleb());
      } catch (error) {
        // A DIE header that overruns the unit is the same truncation as an
        // attribute read past the boundary (#1860): fail closed, do not resync.
        diagnostics.push(`read past unit boundary at 0x${dieOffset.toString(16)}`);
        complete = false;
        unitComplete = false;
        break;
      }
      if (code === 0) {
        // DWARF4 §2.3 / v5 §2.3: sibling chains terminate with a null entry.
        // A null entry with no open sibling chain is structure nobody declared,
        // not a no-op (#5244).
        if (stack.length === 0) {
          diagnostics.push(`unmatched null DIE entry at 0x${dieOffset.toString(16)}`);
          complete = false;
          unitComplete = false;
          continue;
        }
        stack.pop();
        continue;
      }
      const declaration = abbrev.get(code);
      if (!declaration) {
        diagnostics.push(`unknown abbreviation code ${code} at 0x${dieOffset.toString(16)}`);
        complete = false;
        unitComplete = false;
        break;
      }
      // A .debug_info compilation unit roots at exactly one DW_TAG_compile_unit
      // or DW_TAG_partial_unit DIE (DWARF4 §7.5). Any other root tag, or a
      // second top-level DIE, is a structure the format cannot express (#5251).
      // The unit fails closed; the remaining DIEs keep parsing so their facts
      // stay available without the result ever claiming completeness. DWARF5
      // roots are a per-unit-type contract and are validated separately.
      if (stack.length === 0 && version < 5) {
        if (rootDie == null) {
          rootDie = dieOffset;
          if (declaration.tag !== DW_TAG.compile_unit && declaration.tag !== DW_TAG.partial_unit) {
            diagnostics.push(`unit at 0x${unitStart.toString(16)} does not start with a compilation or partial unit DIE (tag 0x${declaration.tag.toString(16)})`);
            complete = false;
            unitStructurallyMalformed = true;
          }
        } else {
          diagnostics.push(`multiple top-level DIEs in unit at 0x${unitStart.toString(16)}`);
          complete = false;
          unitStructurallyMalformed = true;
        }
      }
      const attributes = new Map();
      // Keep the first declaration for deterministic decoding, but never
      // publish a DIE from an ambiguous abbreviation table as complete
      // evidence (#5728).
      let dieComplete = !duplicateCode;
      try {
        for (const spec of declaration.attributes) {
          const read = readForm(cursor, spec.form, unit, sections, spec.implicitConst);
          if (read.unsupported) {
            dieComplete = false;
            diagnostics.push(`unsupported form 0x${spec.form.toString(16)} at 0x${dieOffset.toString(16)}`);
            if (read.fatal) { unitComplete = false; break; }
          }
          // strx forms need the unit's str_offsets base, which may appear in this
          // very DIE, so they are resolved after the whole attribute list is read.
          attributes.set(spec.attribute, { form: spec.form, value: read.value });
        }
      } catch (error) {
        // A read past the unit boundary (a block whose declared length overruns
        // the unit, #1860) is a truncation, not an exception to propagate: the
        // unit fails closed with a diagnostic, like any other truncated record.
        diagnostics.push(`read past unit boundary at 0x${dieOffset.toString(16)}`);
        complete = false;
        unitComplete = false;
      }
      if (!unitComplete) { complete = false; break; }

      if (attributes.has(DW_AT.str_offsets_base)) {
        unit.strOffsetsBase = Number(attributes.get(DW_AT.str_offsets_base).value);
      }
      if (attributes.has(DW_AT.addr_base)) {
        const raw = attributes.get(DW_AT.addr_base).value;
        const base = Number(raw);
        // addr_base is a section offset in bytes: it must land inside
        // `.debug_addr` past its header, or no addrx entry can resolve (#6184).
        unit.addrBase = Number.isSafeInteger(base) && base >= 0 && sections.debug_addr && base <= sections.debug_addr.length
          ? base
          : null;
      }
      for (const [attribute, entry] of attributes) {
        if ([DW_FORM.strx, DW_FORM.strx1, DW_FORM.strx2, DW_FORM.strx3, DW_FORM.strx4].includes(entry.form)) {
          const resolved = strxString(entry.value, unit, sections);
          attributes.set(attribute, { form: entry.form, value: resolved });
          if (resolved == null) dieComplete = false;
        } else if (ADDRX_FORMS.includes(entry.form)) {
          // addrx forms are indices into `.debug_addr`, not addresses (#6184).
          // An unresolvable index stays unknown (null) and marks the DIE
          // partial: publishing the raw index as an address would point
          // consumers at a function start that does not exist.
          const resolved = unit.version >= 5 ? addrxAddress(entry.value, unit, sections, addrContributionState) : null;
          attributes.set(attribute, { form: entry.form, value: resolved, addressForm: resolved != null });
          if (resolved == null) {
            // An address the parser cannot establish must make the whole unit's
            // evidence partial, not only the DIE: a raw index must never be
            // published as a PC (#6184).
            dieComplete = false;
            complete = false;
            diagnostics.push(`unresolved DW_FORM_addrx index ${entry.value} at 0x${dieOffset.toString(16)}`);
            if (addrContributionState.exhausted) {
              const diagnostic = 'debug_addr contribution scan budget exhausted';
              if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic);
            }
          }
        }
      }
      // DW_AT_ranges carries non-contiguous address evidence in
      // .debug_rnglists/.debug_ranges. No resolver exists for either format,
      // so a DIE that locates its code only through a range list cannot claim
      // complete evidence: the DIE stays incomplete (no fabricated address)
      // and the parse result never reports complete (#5731). Sibling DIEs
      // keep parsing so their facts remain available.
      if (attributes.has(DW_AT.ranges)) {
        dieComplete = false;
        complete = false;
        if (!unit.rangesUnsupportedReported) {
          diagnostics.push('DW_AT_ranges range lists (.debug_rnglists/.debug_ranges) are not resolvable; affected DIEs stay incomplete');
          unit.rangesUnsupportedReported = true;
        }
      }

      const die = {
        offset: dieOffset,
        tag: declaration.tag,
        attributes,
        parent: stack.length ? stack[stack.length - 1] : null,
        unit,
        complete: dieComplete,
        children: [],
      };
      dies.set(dieOffset, die);
      recordCount += 1;
      if (die.parent != null) dies.get(die.parent)?.children.push(dieOffset);
      if (declaration.hasChildren) stack.push(dieOffset);
    }
    // A unit whose bytes exactly fill its declared length can still end with a
    // child/sibling chain that was never closed by its terminating null entry;
    // physical truncation and structural truncation are different defects and
    // both must withhold completeness (#5244).
    if (unitComplete && stack.length > 0) {
      diagnostics.push(`unterminated DIE tree at end of unit at 0x${unitStart.toString(16)}`);
      unitComplete = false;
      complete = false;
    }
    if (unitStructurallyMalformed) unitComplete = false;
    if (!unitComplete) complete = false;
    units.push(unit);
    cursor.offset = unitEnd;
    cursor.limit = info.length;   // the unit-end advance itself is not unit-local
    if (cancelled) break;
  }

  if (complete && cursor.offset < info.length) {
    diagnostics.push(`truncated compilation unit at 0x${cursor.offset.toString(16)}`);
    complete = false;
  }

  return { dies, units, diagnostics, complete, cancelled };
}

function attributeValue(die, attribute) {
  return die.attributes.get(attribute)?.value ?? null;
}

// DW_FORM_flag carries an explicit value; presence alone is not truth.
function attributeFlag(die, attribute) {
  const value = attributeValue(die, attribute);
  return value != null && value !== 0n && value !== 0 && value !== false;
}

function attributeName(die, dies) {
  const value = attributeValue(die, DW_AT.name);
  if (typeof value === 'string') return value;
  // A defining DIE inherits name (and other declaration attributes) from the
  // declaration it specifies (#5738).
  const inherited = dies ? effectiveAttribute(die, DW_AT.name, dies) : null;
  return inherited && typeof inherited.entry.value === 'string' ? inherited.entry.value : null;
}

/** Resolves one DW_AT_specification target, honoring unit-relative ref forms. */
function specificationTarget(die, dies) {
  const entry = die.attributes.get(DW_AT.specification);
  if (!entry) return null;
  const raw = Number(entry.value ?? 0);
  const isUnitRelative = [DW_FORM.ref1, DW_FORM.ref2, DW_FORM.ref4, DW_FORM.ref8, DW_FORM.ref_udata].includes(entry.form);
  const target = isUnitRelative && die.unit ? die.unit.start + raw : raw;
  return dies.get(target) ?? null;
}

/**
 * Resolves the complete DW_AT_specification chain used for inherited
 * attributes. A missing target, cycle, or chain that would require more than
 * eight specification hops is unresolved and therefore cannot authorize a
 * complete descriptor (#5738).
 */
function resolveSpecificationChain(die, dies) {
  const chain = [die];
  const seen = new Set([die.offset]);
  let current = die;
  for (let depth = 0; current.attributes.has(DW_AT.specification); depth += 1) {
    if (depth >= 8) return { resolved: false, chain };
    const target = specificationTarget(current, dies);
    if (!target || seen.has(target.offset)) return { resolved: false, chain };
    chain.push(target);
    seen.add(target.offset);
    current = target;
  }
  return { resolved: true, chain };
}

/**
 * Reads an attribute from a DIE, falling back through its DW_AT_specification
 * chain (DWARF v5 §2.13/§3.3.5: a defining DIE need not repeat attributes
 * already present on the non-defining declaration it specifies).
 *
 * Returns `{ entry, owner }` where `owner` is the DIE the attribute was found
 * on (unit-relative reference forms resolve against the owner's unit), or
 * null when neither the DIE nor a fully resolved specification chain carries
 * the attribute. Direct attributes always take precedence.
 */
function effectiveAttribute(die, attribute, dies) {
  const direct = die.attributes.get(attribute);
  if (direct) return { entry: direct, owner: die };
  const resolution = resolveSpecificationChain(die, dies);
  if (!resolution.resolved) return null;
  for (const owner of resolution.chain.slice(1)) {
    const inherited = owner.attributes.get(attribute);
    if (inherited) return { entry: inherited, owner };
  }
  return null;
}

/** A DIE's specification chain must resolve completely before it is complete. */
function specificationResolved(die, dies) {
  return resolveSpecificationChain(die, dies).resolved;
}

function referencedType(die, dies) {
  const effective = effectiveAttribute(die, DW_AT.type, dies);
  if (!effective) return null;
  const { entry, owner } = effective;
  const raw = Number(entry.value ?? 0);
  const isUnitRelative = [DW_FORM.ref1, DW_FORM.ref2, DW_FORM.ref4, DW_FORM.ref8, DW_FORM.ref_udata].includes(entry.form);
  const target = isUnitRelative && owner.unit ? owner.unit.start + raw : raw;
  return dies.get(target) ?? null;
}

/**
 * Renders a DWARF type DIE as a nominal type name plus its machine facts.
 *
 * Qualifier and typedef chains are followed with a depth limit, because DWARF
 * type graphs can be cyclic through pointer members and a naive walk would not
 * terminate.
 */
function describeType(die, dies, depth = 0, seen = new Set()) {
  if (!die || depth > 32 || seen.has(die.offset)) return { name: 'unknown', complete: false };
  seen.add(die.offset);
  const name = attributeName(die);
  const byteSize = attributeValue(die, DW_AT.byte_size);

  switch (die.tag) {
    case DW_TAG.base_type: {
      const encoding = Number(attributeValue(die, DW_AT.encoding) ?? 0);
      return {
        name: name ?? 'base',
        widthBits: byteSize == null ? null : Number(byteSize) * 8,
        class: ENCODING_CLASS[encoding] ?? 'integer',
        complete: byteSize != null && die.complete,
      };
    }
    case DW_TAG.pointer_type: {
      const target = describeType(referencedType(die, dies), dies, depth + 1, seen);
      return {
        name: `${target.name} *`,
        widthBits: byteSize == null ? die.unit.addressSize * 8 : Number(byteSize) * 8,
        class: 'pointer',
        complete: die.complete,
      };
    }
    case DW_TAG.typedef: {
      const target = describeType(referencedType(die, dies), dies, depth + 1, seen);
      return {
        name: name ?? target.name,
        aliases: [name, target.name].filter(Boolean),
        widthBits: target.widthBits ?? null,
        class: target.class ?? null,
        complete: die.complete && target.complete,
      };
    }
    case DW_TAG.const_type: case DW_TAG.volatile_type: {
      const target = describeType(referencedType(die, dies), dies, depth + 1, seen);
      const qualifier = die.tag === DW_TAG.const_type ? 'const' : 'volatile';
      return { ...target, name: `${qualifier} ${target.name}`, complete: target.complete && die.complete };
    }
    case DW_TAG.structure_type: case DW_TAG.class_type: case DW_TAG.union_type: {
      const keyword = die.tag === DW_TAG.union_type ? 'union' : die.tag === DW_TAG.class_type ? 'class' : 'struct';
      return {
        name: name ? `${keyword} ${name}` : `${keyword} <anonymous>`,
        sizeBytes: byteSize == null ? null : Number(byteSize),
        // A DW_AT_declaration DIE is a forward declaration: it names the type
        // but says nothing about its layout, so it is not a complete fact.
        complete: die.complete && !attributeFlag(die, DW_AT.declaration) && byteSize != null,
        isAggregate: true,
        isUnion: die.tag === DW_TAG.union_type,
      };
    }
    case DW_TAG.enumeration_type:
      return { name: name ? `enum ${name}` : 'enum <anonymous>', widthBits: byteSize == null ? null : Number(byteSize) * 8, class: 'integer', complete: die.complete };
    case DW_TAG.array_type: {
      const element = describeType(referencedType(die, dies), dies, depth + 1, seen);
      return { name: `${element.name}[]`, class: 'array', complete: false };
    }
    case DW_TAG.subroutine_type:
      return { name: 'subroutine', class: 'code', complete: die.complete };
    default:
      return { name: name ?? 'unknown', complete: false };
  }
}

function toAddress(value) {
  if (value == null) return null;
  return `0x${BigInt(value).toString(16)}`;
}

/**
 * Computes an ELF build id from `.note.gnu.build-id`.
 *
 * Returns null when the note is absent — which becomes `identity-unavailable`,
 * not a match.
 */
export function readBuildId(noteSection) {
  if (!noteSection || noteSection.length < 16) return null;
  const view = new DataView(noteSection.buffer, noteSection.byteOffset, noteSection.byteLength);
  let offset = 0;
  while (offset + 12 <= noteSection.length) {
    const nameSize = view.getUint32(offset, true);
    const descSize = view.getUint32(offset + 4, true);
    const type = view.getUint32(offset + 8, true);
    const nameStart = offset + 12;
    if (nameSize > noteSection.length - nameStart) return null;
    const paddedNameSize = Math.ceil(nameSize / 4) * 4;
    if (paddedNameSize > noteSection.length - nameStart) return null;
    const descStart = nameStart + paddedNameSize;
    if (descSize > noteSection.length - descStart) return null;
    const descEnd = descStart + descSize;
    // The owner name lives inside the declared nameSize: alignment padding
    // past it must not serve as the terminator (#5301).
    let nameEnd = nameStart;
    while (nameEnd < nameStart + nameSize && nameEnd < noteSection.length && noteSection[nameEnd] !== 0) nameEnd += 1;
    const name = nameEnd < nameStart + nameSize && nameEnd < noteSection.length
      ? new TextDecoder('utf8').decode(noteSection.subarray(nameStart, nameEnd))
      : null;
    // NT_GNU_BUILD_ID
    if (type === 3 && name === 'GNU') {
      return [...noteSection.subarray(descStart, descEnd)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    offset = descEnd + ((4 - (descSize & 3)) & 3);
  }
  return null;
}

/** CRC-32 as used by `.gnu_debuglink`. */
export function gnuDebugLinkCrc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Parses `.gnu_debuglink`: a NUL-terminated name followed by a CRC32. */
export function readDebugLink(section) {
  if (!section || section.length < 5) return null;
  let nulOffset = 0;
  while (nulOffset < section.length && section[nulOffset] !== 0) nulOffset += 1;
  if (nulOffset === section.length) return null;
  const name = new TextDecoder('utf8').decode(section.subarray(0, nulOffset));
  const crcOffset = (nulOffset + 4) & ~3;
  if (crcOffset + 4 > section.length) return null;
  const view = new DataView(section.buffer, section.byteOffset, section.byteLength);
  return { name, crc32: view.getUint32(crcOffset, true) >>> 0 };
}

/**
 * A CRC-verified split-debug companion is an ELF that carries the .debug_*
 * sections the stripped binary lacks. Verification alone is not restoration:
 * after the identity matches, the companion's DWARF sections must become the
 * parse source or the split-debug configuration loses every symbol/type
 * (#5461). Anything that is not a readable ELF simply yields no sections.
 */
function companionDebugSections(companion) {
  if (!(companion instanceof Uint8Array) || companion.length < 64) return null;
  if (companion[0] !== 0x7f || companion[1] !== 0x45 || companion[2] !== 0x4c || companion[3] !== 0x46) return null;
  let parsed;
  try {
    parsed = parseELFImage(companion);
  } catch {
    return null;
  }
  const out = {};
  for (const section of parsed.sections) {
    if (!section.name?.startsWith('.debug_') || section.type === 8) continue;
    const start = Number(section.fileOffset);
    const size = Number(section.fileSize);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || size <= 0 || start < 0 || start + size > companion.length) continue;
    out[section.name] = companion.slice(start, start + size);
  }
  return Object.keys(out).length ? out : null;
}

export class DwarfDebugInfoProvider extends DebugInfoProvider {
  constructor() {
    super({ id: DWARF_PROVIDER_ID, version: DWARF_PROVIDER_VERSION, ecosystem: 'dwarf' });
  }

  /**
   * Determines the identity verdict and parses the DIE forest.
   *
   * `image.debugSections` are the sections of the debug source; `image.identity`
   * carries what the *binary* expects. The two are compared explicitly.
   */
  probe(image, { budget = DEBUG_DEFAULT_BUDGET, signal = null } = {}) {
    const sections = image?.debugSections ?? {};
    const diagnostics = [];
    const status = (completeness, stopReason) => createAnalysisStatus({
      snapshotId: image?.snapshotId ?? 'snapshot-unbound',
      analyzerId: DWARF_PROVIDER_ID,
      analyzerVersion: DWARF_PROVIDER_VERSION,
      completeness,
      stopReason,
    });

    if (signal?.aborted) {
      return createDebugProviderResult({
        ecosystem: 'dwarf',
        identity: { verdict: 'unsupported', providerId: this.id, providerVersion: this.version, method: 'cancelled' },
        status: status('partial', 'cancelled'),
      });
    }

    const expected = image?.identity?.buildId ?? null;
    const observed = readBuildId(sections['.note.gnu.build-id'] ?? sections.note_gnu_build_id);
    const debugLink = readDebugLink(sections['.gnu_debuglink'] ?? sections.gnu_debuglink);

    let verdict = 'identity-unavailable';
    let method = 'unavailable';
    let expectedIdentity = expected;
    let observedIdentity = observed;
    let detail = null;

    if (expected != null && observed != null) {
      method = 'gnu-build-id';
      verdict = expected === observed ? 'matched-authoritative' : 'identity-mismatch';
      if (verdict === 'identity-mismatch') detail = 'build id of the debug source does not match the binary';
    } else if (debugLink != null) {
      // Split debug info: the binary points at a companion file by CRC. Without
      // the companion's bytes there is nothing to verify.
      method = 'gnu-debuglink-crc32';
      const companion = image?.companionBytes ?? null;
      if (companion == null) {
        verdict = 'companion-missing';
        detail = `debug link names ${debugLink.name} but the companion file was not supplied`;
        expectedIdentity = `crc32:${debugLink.crc32.toString(16)}`;
        observedIdentity = null;
      } else {
        const actual = gnuDebugLinkCrc32(companion);
        expectedIdentity = `crc32:${debugLink.crc32.toString(16)}`;
        observedIdentity = `crc32:${actual.toString(16)}`;
        verdict = actual === debugLink.crc32 ? 'matched-authoritative' : 'identity-mismatch';
        if (verdict === 'identity-mismatch') detail = 'companion debug file CRC does not match the debug link';
      }
    } else if (expected == null && observed == null) {
      verdict = 'identity-unavailable';
      detail = 'neither the binary nor the debug source carries a build identity';
    } else {
      verdict = 'identity-unavailable';
      detail = expected == null ? 'binary carries no build id' : 'debug source carries no build id';
    }

    // Split debug: once the companion is CRC-verified, its .debug_* sections
    // become the parse source for everything the stripped binary lacks. The
    // identity verdict is unaffected by whether the extraction succeeds
    // (#5461).
    let parseSource = sections;
    if (verdict === 'matched-authoritative' && method === 'gnu-debuglink-crc32') {
      const companionSections = companionDebugSections(image?.companionBytes ?? null);
      if (companionSections) {
        parseSource = { ...sections };
        for (const [name, sectionBytes] of Object.entries(companionSections)) {
          const withoutDot = name.slice(1);
          if (parseSource[name] == null && parseSource[withoutDot] == null) parseSource[name] = sectionBytes;
        }
      }
    }

    if (!parseSource.debug_info && !parseSource['.debug_info']) {
      diagnostics.push('no .debug_info section');
    }

    const normalized = normalizeSections(parseSource);
    const parsed = parseDebugInfo(normalized, budget, { signal });
    diagnostics.push(...parsed.diagnostics);

    const result = createDebugProviderResult({
      ecosystem: 'dwarf',
      identity: {
        // Cancellation is an authority boundary, not merely a partial status.
        // A matched build must not keep hard-fact authority after parsing stops
        // before the debug source has been fully validated (#3932).
        verdict: parsed.cancelled ? 'unsupported' : verdict,
        providerId: this.id,
        providerVersion: this.version,
        expected: expectedIdentity,
        observed: observedIdentity,
        method: parsed.cancelled ? 'cancelled' : method,
        detail: parsed.cancelled ? 'debug parsing cancelled before completion' : detail,
      },
      sections: Object.keys(normalized).filter((key) => normalized[key] != null),
      counts: { dies: parsed.dies.size, units: parsed.units.length },
      diagnostics,
      status: parsed.complete && diagnostics.length === 0
        ? status('complete', null)
        : status('partial', parsed.cancelled ? 'cancelled' : 'evidence-missing'),
    });
    // The parsed forest travels with the result rather than being re-parsed by
    // every reader; it is not part of the frozen contract surface.
    return Object.freeze({ ...result, parsed });
  }

  /** Function and variable symbols, paged. */
  symbols(result, { cursor = null, pageSize = DEBUG_DEFAULT_PAGE_SIZE } = {}) {
    const dies = result.parsed?.dies;
    if (!dies) return createDebugPage({ records: [] });
    const ordered = [...dies.values()].filter((die) => die.tag === DW_TAG.subprogram || die.tag === DW_TAG.variable);
    return page(ordered, cursor, pageSize, (die) => {
      const lowPc = attributeValue(die, DW_AT.low_pc);
      const highPc = attributeValue(die, DW_AT.high_pc);
      const isFunction = die.tag === DW_TAG.subprogram;
      // DW_AT_high_pc is an offset from low_pc when its form is a constant, and
      // an absolute address when its form is an address class (DW_FORM_addr or
      // an addrx form resolved through .debug_addr, #6184).
      const highForm = die.attributes.get(DW_AT.high_pc)?.form;
      const highIsAddress = ADDRESS_CLASS_FORMS.includes(highForm);
      const sizeBytes = highPc == null
        ? null
        : highIsAddress
          ? lowPc == null
            ? null
            : Number(BigInt(highPc) - BigInt(lowPc))
          : Number(highPc);
      const descriptor = {
        isFunction,
        external: attributeFlag(die, DW_AT.external),
        complete: die.complete && specificationResolved(die, dies),
      };
      // DW_AT_external is inherited through DW_AT_specification, but a direct
      // flag (including an explicit false) always wins. Other boolean flags
      // remain DIE-local at their call sites.
      const effectiveExternal = effectiveAttribute(die, DW_AT.external, dies);
      if (effectiveExternal?.owner && effectiveExternal.owner !== die) {
        descriptor.external = attributeFlag(effectiveExternal.owner, DW_AT.external);
      }
      return createDebugRecord({
        kind: 'symbol',
        entityId: `dwarf_die_${die.offset}`,
        name: attributeName(die, dies),
        address: toAddress(lowPc),
        sizeBytes,
        descriptor,
        providerId: result.providerId,
        providerVersion: result.providerVersion,
        buildIdentity: result.identity.observed,
        evidenceIds: [`dwarf:die:${die.offset}`],
      });
    });
  }

  /** Type records for the TypeConstraintGraph, paged. */
  types(result, { cursor = null, pageSize = DEBUG_DEFAULT_PAGE_SIZE } = {}) {
    const dies = result.parsed?.dies;
    if (!dies) return createDebugPage({ records: [] });
    const typed = [...dies.values()].filter((die) => (
      die.tag === DW_TAG.subprogram || die.tag === DW_TAG.variable || die.tag === DW_TAG.formal_parameter
    ) && effectiveAttribute(die, DW_AT.type, dies) != null);
    return page(typed, cursor, pageSize, (die) => {
      const described = describeType(referencedType(die, dies), dies);
      return createDebugRecord({
        kind: 'type',
        entityId: `dwarf_die_${die.offset}`,
        name: attributeName(die, dies),
        descriptor: {
          layer: 'nominal',
          claim: { name: described.name, aliases: described.aliases ?? [] },
          machine: described.widthBits == null ? null : { widthBits: described.widthBits, class: described.class },
          complete: described.complete && specificationResolved(die, dies),
        },
        providerId: result.providerId,
        providerVersion: result.providerVersion,
        buildIdentity: result.identity.observed,
        evidenceIds: [`dwarf:die:${die.offset}`],
      });
    });
  }
}

function page(items, cursor, pageSize, map) {
  /* A page size must make progress: pageSize 0 (or any non-positive value)
     would otherwise return the same cursor forever, letting a normal
     nextCursor consumer loop without advancing (#5691). */
  const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : DEBUG_DEFAULT_PAGE_SIZE;
  const start = cursor == null ? 0 : Number(cursor);
  const slice = items.slice(start, start + size);
  const next = start + slice.length;
  return createDebugPage({
    records: slice.map(map),
    nextCursor: next < items.length ? String(next) : null,
    truncated: next < items.length,
  });
}

/** Accepts both `.debug_info` and `debug_info` spellings for section keys. */
function normalizeSections(sections) {
  const out = {};
  for (const key of ['debug_info', 'debug_abbrev', 'debug_str', 'debug_line_str', 'debug_str_offsets', 'debug_line', 'debug_addr', 'debug_rnglists']) {
    out[key] = sections[key] ?? sections[`.${key}`] ?? null;
  }
  return out;
}
