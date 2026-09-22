/**
 * Phase 2 canonical vtable / RTTI evidence producer.
 *
 * Turns real binary facts (symbol tables, vtable bytes, Itanium ABI `typeinfo`
 * records) into the existing canonical C++ evidence types
 * (`createCppClassIdentity`, `createCppVtableEvidence`) without inventing a new
 * type system and without adding a global analysis pass: callers supply the
 * symbol index and a bounded reader, and only the discovered vtables are read.
 *
 * Ground rules encoded here:
 * 1. A class name is emitted only from a real `_ZTS` typeinfo string or a real
 *    `_ZTV`/`_ZTI` symbol. Otherwise the class stays `anonymous`.
 * 2. RTTI-present and RTTI-absent binaries are reported as distinct states; a
 *    binary without RTTI never grows a fabricated inheritance graph.
 * 3. A vtable's slot count comes from a proven extent (declared symbol size,
 *    the next vtable symbol in the same section, or the end of the containing
 *    section). Without a proven extent no slots are reported at all, because
 *    the neighbouring table's words would otherwise become fabricated slots.
 * 4. A slot target keeps every symbol name at that address, because identical
 *    code folding merges distinct virtual methods onto one address.
 */

import { deepFreeze, stableDigest } from '../../core/identity/index.js';
import { demangleCxx } from '../../rtti.js';
import {
  createCppClassIdentity,
  createCppVtableEvidence,
} from './object-evidence.js';

export const CPP_RTTI_EVIDENCE_SCHEMA = 'cpp-rtti-evidence/v1';
export const CPP_RTTI_EVIDENCE_VERSION = '1.0.0';

const ABI_NAMESPACE_PREFIX = '__cxxabiv1::';
const MAX_TYPE_NAME_BYTES = 512;
const MAX_SLOT_LIMIT = 4096;

function fail(code, detail = '') {
  throw new TypeError(detail ? `${code}: ${detail}` : code);
}

function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value.trim())) {
    try { return BigInt(value.trim()); } catch { return null; }
  }
  return null;
}

function symbolNameAt(symbols, address) {
  if (address == null || !symbols) return null;
  const raw = symbols.nameAt?.(address) ?? symbols.label?.(address) ?? null;
  if (typeof raw !== 'string' || !raw) return null;
  // `label()` may append a `+0x10` displacement; the base symbol identifies the
  // object.
  return raw.replace(/\+0x[0-9a-fA-F]+$/, '');
}

function abiKindFromVtableSymbol(symbol) {
  if (!symbol) return null;
  const demangled = demangleCxx(symbol);
  if (!demangled || !demangled.startsWith('vtable for ')) return null;
  return demangled.slice('vtable for '.length).trim();
}

function classNameFromTypeinfoSymbol(symbol) {
  if (!symbol) return null;
  const demangled = demangleCxx(symbol);
  const prefix = 'typeinfo name for ';
  if (!demangled || !demangled.startsWith(prefix)) return null;
  return demangled.slice(prefix.length).trim() || null;
}

function classNameFromVtableSymbol(symbol) {
  if (!symbol) return null;
  const demangled = demangleCxx(symbol);
  if (!demangled || !demangled.startsWith('vtable for ')) return null;
  const name = demangled.slice('vtable for '.length).trim();
  return name && !name.startsWith(ABI_NAMESPACE_PREFIX) ? name : null;
}

function normalizeName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > MAX_TYPE_NAME_BYTES) return null;
  return name;
}

function readWords(bytes, pointerBytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const words = [];
  for (let offset = 0; offset + pointerBytes <= bytes.byteLength; offset += pointerBytes) {
    words.push(pointerBytes === 4 ? BigInt(view.getUint32(offset, true)) : view.getBigUint64(offset, true));
  }
  return words;
}

/**
 * Parses a bounded, length-prefixed Itanium type name as stored in `_ZTS`
 * records (`6Entity`, `N3Foo3BarE`, ...). Any unsupported construct returns
 * null so the caller keeps the class anonymous instead of guessing.
 */
export function parseItaniumTypeName(bytes) {
  if (!bytes || bytes.length === 0) return null;
  let limit = 0;
  while (limit < bytes.length && bytes[limit] !== 0 && limit < MAX_TYPE_NAME_BYTES) limit++;
  if (limit === 0) return null;
  const text = new TextDecoder('ascii', { fatal: false }).decode(bytes.subarray(0, limit));
  let i = 0;
  let nested = false;
  if (text[i] === 'N') { nested = true; i++; }
  const parts = [];
  while (i < text.length && parts.length < 16) {
    if (nested && text[i] === 'E') { i++; break; }
    let digits = '';
    while (i < text.length && text[i] >= '0' && text[i] <= '9') digits += text[i++];
    if (!digits) return null;
    const length = Number(digits);
    if (!Number.isSafeInteger(length) || length <= 0 || i + length > text.length) return null;
    const word = text.slice(i, i + length);
    if (!/^[\w$][\w$.]*$/.test(word)) return null;
    parts.push(word);
    i += length;
  }
  if (!parts.length) return null;
  if (nested && text[i - 1] !== 'E') return null;
  if (i !== text.length) return null;
  return parts.join('::');
}

const VTABLE_NAME = /^_?_ZTV/;
const TYPEINFO_NAME = /^_?_ZTI/;
// Cheap prefilter: only `_Z...`/`__Z...` symbols can carry RTTI. Checking the
// first characters by code unit keeps the ordinary-C path to a comparison per
// symbol instead of three regular expressions.
function looksMangled(name) {
  if (name.charCodeAt(0) !== 95 /* _ */) return false;
  if (name.charCodeAt(1) === 90 /* Z */) return true;
  return name.charCodeAt(1) === 95 /* _ */ && name.charCodeAt(2) === 90 /* Z */;
}

/**
 * Cheap first pass over the symbol table.
 *
 * Only `_ZTV`/`_ZTI` names are relevant. Ordinary C binaries have tens of
 * thousands of symbols and no C++ evidence, so nothing heavier than a name test
 * may run per symbol; the address alias index is built separately and only when
 * a vtable was actually found.
 */
function scanCxxSymbols(symbols) {
  const addrs = symbols?.addrs;
  const names = symbols?.names;
  if (!addrs || !names || typeof addrs.length !== 'number' || addrs.length !== names.length) {
    return { vtableSymbols: [], hasTypeinfoSymbols: false };
  }
  const vtableSymbols = [];
  let hasTypeinfoSymbols = false;
  for (let index = 0; index < addrs.length; index++) {
    const name = names[index];
    if (typeof name !== 'string' || name.length < 5 || !looksMangled(name)) continue;
    if (VTABLE_NAME.test(name)) {
      const address = toBigInt(addrs[index]);
      if (address != null) vtableSymbols.push({ index, address, name });
      continue;
    }
    if (TYPEINFO_NAME.test(name)) hasTypeinfoSymbols = true;
  }
  return { vtableSymbols, hasTypeinfoSymbols };
}

/** Every symbol name at one address, for slot alias retention. */
function buildAliasIndex(symbols) {
  const addrs = symbols?.addrs;
  const names = symbols?.names;
  const byAddress = new Map();
  if (!addrs || !names || addrs.length !== names.length) return byAddress;
  for (let index = 0; index < addrs.length; index++) {
    const name = names[index];
    if (typeof name !== 'string' || !name) continue;
    const address = toBigInt(addrs[index]);
    if (address == null) continue;
    const key = address.toString();
    const list = byAddress.get(key);
    if (list) { if (!list.includes(name)) list.push(name); }
    else byAddress.set(key, [name]);
  }
  return byAddress;
}

/**
 * Parses one Itanium ABI typeinfo record.
 *
 * Returns `readable:false` only when the record cannot be read at all.
 * Individual fields that cannot be proven stay null with an explicit reason.
 */
export async function parseItaniumTypeInfo({ read, symbols, typeinfoAddress, pointerBytes = 8 } = {}) {
  const address = toBigInt(typeinfoAddress);
  if (address == null) fail('cpp-rtti-typeinfo-address-invalid');
  if (typeof read !== 'function') fail('cpp-rtti-read-required');

  const header = await read(address, pointerBytes * 2);
  if (!header || header.length < pointerBytes * 2) {
    return { address, readable: false, reason: 'typeinfo-unreadable', className: null, bases: [] };
  }
  const [vptr, namePointer] = readWords(header, pointerBytes);

  const abiVtableSymbol = vptr !== 0n ? symbolNameAt(symbols, vptr) : null;
  const abiVtable = abiKindFromVtableSymbol(abiVtableSymbol);

  // Name resolution: prefer the authoritative `_ZTS` symbol when the symbol
  // table still has one, then fall back to the length-prefixed type name string
  // the pointer targets.
  let className = null;
  let nameSource = null;
  if (namePointer !== 0n) {
    const ztsSymbol = symbolNameAt(symbols, namePointer);
    const fromSymbol = classNameFromTypeinfoSymbol(ztsSymbol);
    if (fromSymbol) { className = fromSymbol; nameSource = 'zts-symbol'; }
    else {
      const nameBytes = await read(namePointer, 64);
      const parsed = nameBytes ? parseItaniumTypeName(nameBytes) : null;
      if (parsed) { className = parsed; nameSource = 'zts-string'; }
    }
  }

  const record = {
    address,
    readable: true,
    // Only a real `__cxxabiv1::*_type_info` vptr carries an ABI kind. Slicing a
    // plain class name would publish a truncated fragment as `typeinfoKind`.
    kind: abiVtable && abiVtable.startsWith(ABI_NAMESPACE_PREFIX)
      ? abiVtable.slice(ABI_NAMESPACE_PREFIX.length)
      : null,
    abiVtable,
    className: normalizeName(className),
    nameSource,
    namePointer,
    bases: [],
    baseEvidence: 'none',
  };

  // The vptr must resolve to a recognised `__cxxabiv1::*_type_info` vtable. A
  // plain class vtable (or an unreadable one) leaves no base-array layout to
  // follow, so no base may be claimed from it.
  if (!record.kind) {
    record.baseEvidence = 'abi-kind-unresolved';
    return record;
  }

  // `kind` keeps the ABI's own leading underscores (`__si_class_type_info`).
  const isSi = record.kind === '__si_class_type_info';
  const isVmi = record.kind === '__vmi_class_type_info';
  if (!isSi && !isVmi) {
    record.baseEvidence = 'no-base-array';
    return record;
  }

  if (isSi) {
    const tail = await read(address, pointerBytes * 3);
    const words = tail ? readWords(tail, pointerBytes) : [];
    if (words.length >= 3 && words[2] !== 0n) {
      record.bases.push({
        typeinfoAddress: words[2],
        className: null,
        offsetFlags: null,
        offsetToTop: 0n,
        isPublic: true,
        isVirtual: false,
      });
      record.baseEvidence = 'si-base-pointer';
    }
    return record;
  }

  // __vmi_class_type_info: [vptr, name, flags(u32), base_count(u32), {typeinfo, offset_flags}...]
  //
  // `flags` and `base_count` are 4-byte `unsigned int`s in the ABI, not
  // pointer-sized words. Reading them at pointer granularity (as an earlier
  // revision did) hides the real count inside the high half of one word, so a
  // multiple-inheritance class reported no bases at all.
  const metaOffset = BigInt(pointerBytes * 2);
  const meta = await read(address + metaOffset, 8);
  if (!meta || meta.length < 8) {
    record.baseEvidence = 'vmi-header-unreadable';
    return record;
  }
  const metaView = new DataView(meta.buffer, meta.byteOffset, meta.byteLength);
  record.vmiFlags = metaView.getUint32(0, true);
  const baseCount = metaView.getUint32(4, true);
  if (!Number.isSafeInteger(baseCount) || baseCount <= 0 || baseCount > 8) {
    record.baseEvidence = baseCount > 8 ? 'vmi-base-count-too-large' : 'vmi-base-count-unavailable';
    return record;
  }
  const pairs = await read(address + metaOffset + 8n, pointerBytes * 2 * baseCount);
  const pairWords = pairs ? readWords(pairs, pointerBytes) : [];
  for (let index = 0; index < baseCount; index++) {
    const baseTypeinfo = pairWords[index * 2];
    const offsetFlags = pairWords[index * 2 + 1];
    if (baseTypeinfo == null || baseTypeinfo === 0n) continue;
    // `__base_class_type_info::__offset_flags` is a signed `long`, so decode it
    // as such before shifting. BigInt `>>` is arithmetic on a negative value,
    // which is what turns a stored `-0x18` into `offsetToTop: -24n` rather than a
    // very large positive. Clang currently stores the positive subobject offset
    // for a non-virtual base (measured: `offsetFlags: 6146` -> `offsetToTop: 24`
    // for `Component` at +0x18), so this is a correctness guard against a
    // producer that stores the negated offset, not a fix for observed output.
    const flags = BigInt.asIntN(pointerBytes * 8, offsetFlags ?? 0n);
    record.bases.push({
      typeinfoAddress: baseTypeinfo,
      className: null,
      offsetFlags: flags,
      offsetToTop: flags >> 8n,
      isPublic: (flags & 2n) === 2n,
      isVirtual: (flags & 1n) === 1n,
    });
  }
  record.baseEvidence = record.bases.length ? 'vmi-base-array' : 'vmi-base-array-unreadable';
  return record;
}

/**
 * Bounded vtable extent with an explicit basis.
 *
 * Order of authority: declared symbol size, then the next vtable symbol in the
 * file, then the containing section end. A section end is only a *bound*: the
 * caller still gets `extentBasis:'section-end'`, which marks the slot list as
 * bounded-but-not-exactly-proven.
 */
export function vtableExtent({ address, pointerBytes, maxSlots, symbolSize = null, nextVtableAddress = null, sectionEnd = null }) {
  if (typeof address !== 'bigint' || address < 0n) fail('cpp-rtti-vtable-address-invalid');
  const maxWords = 2 + Math.max(0, Math.min(maxSlots, MAX_SLOT_LIMIT));

  let end = null;
  let basis = null;
  if (symbolSize != null && symbolSize > 0n) { end = address + symbolSize; basis = 'symbol-size'; }
  if (nextVtableAddress != null && nextVtableAddress > address && (end == null || nextVtableAddress < end)) {
    end = nextVtableAddress;
    basis = 'next-vtable';
  }
  if (end == null && sectionEnd != null && sectionEnd > address) { end = sectionEnd; basis = 'section-end'; }
  if (end == null) return { slotCount: 0, extentBasis: null, extentProven: false, cappedByLimit: false, reason: 'vtable-extent-unknown' };

  const words = Number((end - address) / BigInt(pointerBytes));
  if (!Number.isSafeInteger(words) || words < 2) {
    return { slotCount: 0, extentBasis: basis, extentProven: false, cappedByLimit: false, reason: 'vtable-extent-too-small' };
  }
  const capped = Math.min(words, maxWords);
  return {
    slotCount: capped - 2,
    extentBasis: basis,
    extentProven: basis === 'symbol-size' || basis === 'next-vtable',
    extentBoundedBySection: basis === 'section-end',
    cappedByLimit: words > maxWords,
    reason: null,
  };
}

/**
 * Builds canonical C++ class/vtable evidence from a real binary.
 *
 * @param {object} input
 * @param {object} input.symbols          SymbolIndex-like value (`addrs`, `names`, `nameAt`, `label`).
 * @param {(address: bigint, length: number) => Uint8Array|null|Promise<Uint8Array|null>} input.read
 * @param {number} [input.pointerBytes=8]
 * @param {number} [input.maxClasses=128]
 * @param {number} [input.maxSlots=64]
 * @param {boolean} [input.includeAbiClasses=false]
 * @param {(address: bigint) => bigint|null} [input.symbolSizeOf]  Declared symbol size, when the loader retains it.
 * @param {(address: bigint) => bigint|null} [input.sectionEndOf]  End address of the containing data section.
 */
export async function buildCxxClassEvidence({
  symbols = null,
  read = null,
  pointerBytes = 8,
  maxClasses = 128,
  maxSlots = 64,
  includeAbiClasses = false,
  symbolSizeOf = null,
  sectionEndOf = null,
  maxReads = 4096,
} = {}) {
  if (pointerBytes !== 4 && pointerBytes !== 8) fail('cpp-rtti-pointer-bytes-invalid', 'must be 4 or 8');
  if (typeof read !== 'function') fail('cpp-rtti-read-required');
  if (!Number.isSafeInteger(maxClasses) || maxClasses < 1) fail('cpp-rtti-max-classes-invalid');
  if (!Number.isSafeInteger(maxSlots) || maxSlots < 1) fail('cpp-rtti-max-slots-invalid');
  const budget = Number.isSafeInteger(maxReads) && maxReads > 0 ? maxReads : 4096;

  let reads = 0;
  const boundedRead = async (address, length) => {
    if (reads >= budget) return null;
    reads++;
    let result;
    try { result = await read(address, length); } catch { return null; }
    return result && result.length ? result : null;
  };

  const { vtableSymbols, hasTypeinfoSymbols } = scanCxxSymbols(symbols);
  const allVtableAddresses = [...new Set(vtableSymbols.map((entry) => entry.address))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const nextVtableAfter = (address) => allVtableAddresses.find((candidate) => candidate > address) ?? null;

  const candidates = vtableSymbols
    .filter((entry) => includeAbiClasses || !entry.name.includes('__cxxabiv1'))
    .map((entry) => ({ ...entry, className: classNameFromVtableSymbol(entry.name) }))
    .sort((left, right) => (left.address < right.address ? -1 : left.address > right.address ? 1 : 0));

  // The alias index is only needed once a vtable is actually being read.
  const byAddress = candidates.length ? buildAliasIndex(symbols) : new Map();

  const classes = [];
  const skipped = [];
  let rttiPresent = hasTypeinfoSymbols;
  let truncated = false;

  for (const symbol of candidates) {
    if (classes.length >= maxClasses) { truncated = true; break; }

    const extent = vtableExtent({
      address: symbol.address,
      pointerBytes,
      maxSlots,
      symbolSize: symbolSizeOf ? toBigInt(symbolSizeOf(symbol.address)) : null,
      nextVtableAddress: nextVtableAfter(symbol.address),
      sectionEnd: sectionEndOf ? toBigInt(sectionEndOf(symbol.address)) : null,
    });
    if (extent.slotCount === 0) {
      skipped.push(Object.freeze({ address: symbol.address, name: symbol.name, reason: extent.reason || 'vtable-extent-too-small' }));
      continue;
    }

    const bytes = await boundedRead(symbol.address, (extent.slotCount + 2) * pointerBytes);
    if (!bytes || bytes.length < pointerBytes * 2) {
      skipped.push(Object.freeze({ address: symbol.address, name: symbol.name, reason: 'vtable-unreadable' }));
      continue;
    }
    const words = readWords(bytes, pointerBytes);
    const offsetToTop = BigInt.asIntN(pointerBytes * 8, words[0]);
    const typeinfoAddress = words[1];
    const limit = pointerBytes === 4 ? 0xffffffffn : 0x0000ffffffffffffn;

    // One `_ZTV` symbol covers the primary table **and** one sub-table per
    // secondary base: `[offset, typeinfo, slots...][offset2, typeinfo2, slots...]`.
    // A sub-table restarts with its own header, so the header words must end the
    // primary slot run. Without this the secondary header is reported as slots:
    // a negative offset-to-top as an unresolved slot, and the typeinfo pointer -
    // a data address - as a "method target".
    //
    // The boundary is found **structurally**: neither an RTTI record nor a
    // symbol is required. A slot holds a code address, so it is never negative;
    // a sub-table's first word is the negated subobject offset, so it always is.
    // Measured on `_ZTV5Enemy` (`Enemy : Entity, Component`, `Component` at
    // +0x18): `w[7] = -0x18` opens the `Component` sub-table and `w[8]` is its
    // typeinfo, in both the RTTI and the `-fno-rtti` fixture.
    //
    // Two earlier signals were removed because each mis-fires:
    //   - requiring the *next* word to be the null `-fno-rtti` typeinfo made the
    //     test trigger on the offset word and then discard the word before it,
    //     which silently dropped the last real primary-table slot
    //     (`Enemy::tick`) from the `-fno-rtti` fixture;
    //   - requiring a `_ZTI` symbol misses the header entirely whenever the
    //     typeinfo pointer carries no symbol, and then publishes the offset word
    //     as an unresolved slot and the typeinfo pointer as a method target.
    // A `_ZTI` alias is kept only as an independent fail-closed check for a word
    // that resolves to a typeinfo record mid-run.
    const slots = [];
    let secondarySubTableAt = null;
    for (let index = 0; index < extent.slotCount; index++) {
      const word = words[index + 2];
      if (word == null) break;
      const resolvable = word !== 0n && word <= limit;
      const aliases = resolvable ? (byAddress.get(word.toString()) || []) : [];
      if (BigInt.asIntN(pointerBytes * 8, word) < 0n) {
        // The offset-to-top of a secondary sub-table: data, not a slot.
        secondarySubTableAt = index;
        break;
      }
      if (index > 0 && aliases.some((name) => TYPEINFO_NAME.test(name))) {
        // A typeinfo record reached from the slot run. This sub-table's
        // offset-to-top is the word before it, which is data as well.
        slots.pop();
        secondarySubTableAt = index - 1;
        break;
      }
      slots.push(Object.freeze({
        index,
        offset: (index + 2) * pointerBytes,
        address: resolvable ? word : null,
        raw: word,
        unresolved: !resolvable,
        reason: resolvable ? null : 'encoded-pointer-without-fixup-context',
        aliases: Object.freeze([...aliases]),
      }));
    }

    let typeinfo = null;
    if (typeinfoAddress != null && typeinfoAddress !== 0n && typeinfoAddress <= limit) {
      typeinfo = await parseItaniumTypeInfo({
        read: boundedRead,
        symbols,
        typeinfoAddress,
        pointerBytes,
      });
      if (typeinfo?.className) rttiPresent = true;
    }
    const resolvedTypeinfo = typeinfo && typeinfo.className ? typeinfoAddress : null;

    const typeinfoClassName = normalizeName(typeinfo?.className);
    const className = typeinfoClassName || symbol.className || null;
    const nameSource = typeinfoClassName ? `rtti-${typeinfo.nameSource}` : (symbol.className ? 'vtable-symbol' : null);

    const classIdentity = createCppClassIdentity({
      kind: className ? 'named' : 'anonymous',
      className,
      vtableAddress: symbol.address,
      typeinfoAddress: resolvedTypeinfo,
      offsetToTop,
      isAnonymous: !className,
    });

    classes.push({
      className,
      nameSource,
      classIdentity,
      vtableAddress: symbol.address,
      vtableSymbol: symbol.name,
      offsetToTop,
      isSecondary: offsetToTop !== 0n,
      typeinfoAddress: resolvedTypeinfo,
      typeinfoRaw: typeinfoAddress,
      typeinfoKind: typeinfo?.kind ?? null,
      typeinfoNameSource: typeinfo?.nameSource ?? null,
      baseEvidence: typeinfo?.baseEvidence ?? 'none',
      bases: typeinfo?.bases ?? [],
      slots,
      slotCount: slots.length,
      extentProven: extent.extentProven,
      extentBasis: extent.extentBasis,
      extentBoundedBySection: Boolean(extent.extentBoundedBySection),
      extentCappedByLimit: Boolean(extent.cappedByLimit),
      // Index of the word that starts a secondary sub-table's header, when the
      // symbol covers more than the primary table. Reported so a consumer can
      // tell "this class has one vtable" from "this symbol holds several".
      secondarySubTableAt,
    });
  }

  const byTypeinfoAddress = new Map();
  for (const record of classes) {
    if (record.typeinfoAddress != null && !byTypeinfoAddress.has(record.typeinfoAddress)) {
      byTypeinfoAddress.set(record.typeinfoAddress, record);
    }
  }
  // Resolve base class names only from already-parsed sibling records. A base
  // whose record was not discovered stays null; it is never named from lexical
  // similarity.
  for (const record of classes) {
    for (const base of record.bases) {
      const target = byTypeinfoAddress.get(base.typeinfoAddress);
      if (target) base.className = target.className;
    }
  }
  const derivedFrom = new Map();
  for (const record of classes) {
    if (!record.className) continue;
    for (const base of record.bases) {
      if (!base.className) continue;
      const list = derivedFrom.get(base.className) || [];
      if (!list.includes(record.className)) list.push(record.className);
      derivedFrom.set(base.className, list);
    }
  }
  for (const record of classes) {
    record.derivedFrom = Object.freeze(record.className ? [...(derivedFrom.get(record.className) || [])] : []);
    record.resolvedBases = Object.freeze(record.bases.map((base) => Object.freeze({ ...base })));
    Object.freeze(record.slots);
  }

  const report = {
    schema: CPP_RTTI_EVIDENCE_SCHEMA,
    version: CPP_RTTI_EVIDENCE_VERSION,
    pointerBytes,
    rttiPresent,
    classes: Object.freeze(classes),
    skipped: Object.freeze(skipped),
    truncated,
    reads,
  };
  report.digest = stableDigest({
    schema: report.schema,
    version: report.version,
    pointerBytes,
    rttiPresent,
    classes: classes.map((record) => ({
      className: record.className,
      nameSource: record.nameSource,
      vtableAddress: record.vtableAddress,
      slotCount: record.slotCount,
      extentBasis: record.extentBasis,
      typeinfoAddress: record.typeinfoAddress,
    })),
  });
  return deepFreeze(report);
}

/**
 * Opt-in memo for the producer.
 *
 * The producer is pure and cheap, but a UI/summary path may be re-entered for
 * the same slice. Caching is keyed by a caller-supplied identity (the slice or
 * snapshot id) because two different binaries can share a symbol-table shape;
 * without a key nothing is cached, so a stale binary can never be served.
 */
export function createCxxEvidenceCache({ maxEntries = 4 } = {}) {
  const limit = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : 4;
  const entries = new Map();
  return {
    async get(input, cacheKey = null) {
      if (cacheKey == null || cacheKey === '') return buildCxxClassEvidence(input);
      const key = String(cacheKey);
      const cached = entries.get(key);
      if (cached) return cached;
      const pending = buildCxxClassEvidence(input);
      entries.set(key, pending);
      while (entries.size > limit) entries.delete(entries.keys().next().value);
      return pending;
    },
    clear() { entries.clear(); },
    size() { return entries.size; },
  };
}

/**
 * Projects a class record into the canonical `CppVtableEvidence` type so
 * decompiler-facing consumers keep a single representation.
 */
export function vtableEvidenceFor(record, { pointerBytes = 8 } = {}) {
  if (!record || record.vtableAddress == null) return null;
  return createCppVtableEvidence({
    vtableAddress: record.vtableAddress,
    pointerBytes,
    offsetToTop: record.offsetToTop ?? 0n,
    typeinfo: record.typeinfoAddress,
    isSecondary: record.isSecondary,
    slots: (record.slots || []).map((slot) => ({
      index: slot.index,
      offset: slot.offset,
      address: slot.address,
      symbolName: slot.aliases?.[0] ?? null,
      unresolved: slot.unresolved,
      reason: slot.reason,
    })),
  });
}
