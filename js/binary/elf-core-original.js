import { ByteView } from './reader.js';
import { BinaryImage, functionSeed, sectionHasMappedAddress } from './model.js';
import { parseEhFrameHeader } from './elf-unwind.js';
import { parseProgramDynamic } from './elf-dynamic.js';
import { createELFMetadataBudget, markELFMetadataPartial } from './elf-budget.js';
import { elfExactFunctionStartRejection, elfFunctionExtentRejection, elfInstructionStartAlignmentRejection, elfInstructionTargetRejection, elfSectionFileSpanConsistentWithLoads, executableELFRange } from './elf-mapping.js';
import { relocationFieldWidth } from './elf-relocation-target.js';
import { isRiscvMappingSymbolRecord, parseRiscvAttributes, parseRiscvMappingSymbol } from './riscv-isa.js';

const ET_REL = 1;
const ET_EXEC = 2;
const PT_LOAD = 1;
const PT_GNU_EH_FRAME = 0x6474e550;
const PN_XNUM = 0xffff;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_DYNAMIC = 6;
const SHT_DYNSYM = 11;
const SHT_REL = 9;
const SHT_SYMTAB_SHNDX = 18;
const SHN_UNDEF = 0;
const SHN_LORESERVE = 0xff00;
const SHN_ABS = 0xfff1;
const SHN_COMMON = 0xfff2;
const SHN_XINDEX = 0xffff;
const STB_GNU_UNIQUE = 10;
const STT_GNU_IFUNC = 10;
const SHF_WRITE = 0x1n;
const SHF_ALLOC = 0x2n;
const SHF_EXECINSTR = 0x4n;
const EM_RISCV = 243;
const SECTION_NAME_MAX_SPAN = 1 << 20;
export const EM_AARCH64 = 183;
export const STO_RISCV_VARIANT_CC = 0x80;
export const STO_AARCH64_VARIANT_PCS = 0x80;

const SHT_RISCV_ATTRIBUTES = 0x70000003;
const R_RISCV_JUMP_SLOT = 5;
const DT_RISCV_VARIANT_CC = 0x70000001n;
const DT_INIT = 12n;
const DT_NEEDED = 1n;
const DT_SONAME = 14n;
const ELF_RUNTIME_PAGE_SIZE = 0x1000n;

function elfAddressRangeFits(bits, address, size) {
  const limit = 1n << BigInt(bits);
  return address >= 0n && size >= 0n && address <= limit && size <= limit && address <= limit - size;
}

export function parseELF(input, options = {}) {
  const initial = new ByteView(input, { littleEndian: true });
  const bytes = initial.bytes;
  if (initial.length < 16 || initial.u8(0) !== 0x7f || initial.u8(1) !== 0x45 || initial.u8(2) !== 0x4c || initial.u8(3) !== 0x46) throw new Error('not an ELF file');
  const cls = initial.u8(4);
  const data = initial.u8(5);
  if (cls !== 1 && cls !== 2) throw new Error(`unsupported ELF class ${cls}`);
  if (data !== 1 && data !== 2) throw new Error(`unsupported ELF data encoding ${data}`);
  const bits = cls === 2 ? 64 : 32;
  const littleEndian = data === 1;
  const r = new ByteView(bytes, { littleEndian });
  const h = readHeader(r, bits);
  validateHeaderTableSizes(r, h, bits);
  resolveExtendedProgramHeaderCount(r, h, bits);
  validateHeaderTablePresence(h);
  const image = new BinaryImage(bytes, {
    format: 'elf', arch: elfMachineName(h.machine, bits), bits,
    endian: littleEndian ? 'little' : 'big', platform: elfOsAbi(r.u8(7)),
    entrypoint: h.entry, imageBase: 0n,
    abi: h.machine === 183 && bits === 32 ? 'aapcs64-ilp32' : null,
    metadata: {
      type: h.type, machine: h.machine, flags: h.flags, osabi: r.u8(7), abiVersion: r.u8(8),
      extendedProgramHeaderCount: h.extendedPhnum ?? null,
      dataModel: bits === 32 ? 'ilp32' : 'lp64',
      pointerBits: bits,
    },
  });

  // Program headers, raw section headers, and section names are structural
  // metadata fan-out and therefore share one finite budget. Admission must
  // happen before materializing each header object (#8714).
  const metadataBudget = createELFMetadataBudget(image, { signal: options.signal, limits: options.metadataLimits });
  const programHeaders = parseProgramHeaders(r, h, image, bits, metadataBudget);
  const rawSections = parseSectionHeaders(r, h, bits, image, metadataBudget);
  // Keep section-table presence separate from parse success. `[]` can mean a
  // genuinely sectionless ELF *or* a declared table that was truncated /
  // invalid; PT_DYNAMIC symbol authority must not conflate those cases (#4197).
  image.metadata.elfSectionTableAuthority = Object.freeze({
    declared: h.shoff !== 0n,
    valid: h.shoff === 0n || rawSections.length > 0,
  });
  // Section names must also be resolved inside the budget established above.
  nameSections(r, rawSections, h, image, metadataBudget);
  let riscvFileIsa = null;
  const isRiscv = Number(h.machine) === EM_RISCV || image.arch === 'riscv64' || image.arch === 'riscv32';
  if (isRiscv && !metadataBudget.stopped) {
    const namedAttributeSections = rawSections.filter((section) => section.name === '.riscv.attributes');
    const attributes = namedAttributeSections.find((section) => section.type === SHT_RISCV_ATTRIBUTES) || null;
    if (namedAttributeSections.some((section) => section.type !== SHT_RISCV_ATTRIBUTES)) {
      image.warnings.push('RISC-V .riscv.attributes section name without SHT_RISCV_ATTRIBUTES is not authoritative');
    }
    if (attributes) {
      const start = safeOffset(attributes.offset), size = safeOffset(attributes.size);
      if (start == null || size == null || size > 1024 * 1024 || start > r.length || size > r.length - start) {
        image.warnings.push('RISC-V attributes section is outside the bounded file span');
      } else {
        riscvFileIsa = parseRiscvAttributes(r.bytes.subarray(start, start + size), { littleEndian });
        if (riscvFileIsa && riscvFileIsa.xlen !== bits) {
          image.warnings.push(`RISC-V Tag_RISCV_arch XLEN ${riscvFileIsa.xlen} disagrees with ELFCLASS${bits}`);
          riscvFileIsa = null;
        } else if (!riscvFileIsa) {
          image.warnings.push('RISC-V Tag_RISCV_arch is missing or malformed');
        }
      }
    }
    if (riscvFileIsa) image.metadata.riscvFileIsa = riscvFileIsa;
  }
  if (h.type === ET_REL) assignRelocatableSectionAddresses(rawSections, image);
  for (const s of rawSections) {
    const allocRuntimeRangeInvalid = h.type !== ET_REL && (s.flags & SHF_ALLOC) !== 0n
      && !elfAddressRangeFits(bits, s.addr, s.size);
    if (allocRuntimeRangeInvalid) {
      image.warnings.push(`ELF section ${s.index} (${s.name || 'unnamed'}) virtual range exceeds ELF${bits} address space and is excluded from canonical sections`);
      continue;
    }
    // A file-backed section must have its whole payload inside the input to
    // serve as canonical mapping authority: `sh_offset` is the section's first
    // file byte and `sh_size` its length, so a span crossing EOF declares
    // payload that does not exist (#4223). Only SHT_NOBITS is exempt, because it
    // owns no file bytes. This holds regardless of SHF_ALLOC or image type: an
    // ET_REL synthetic-address section claims file bytes the same way (#4223),
    // and `sectionHasMappedAddress()` ranks the smallest covering mapping, so an
    // unvalidated section header could otherwise shadow a validated PT_LOAD and
    // turn readable VAs into out-of-file offsets (#5888). Such a section stays
    // listed for metadata but loses mapping authority ('unmapped-section').
    const noBits = s.type === 8;
    const fileSpanInvalid = !noBits
      && (s.offset > BigInt(r.length) || s.size > BigInt(r.length) - s.offset);
    const mappingInconsistent = !fileSpanInvalid && h.type !== ET_REL
      && (s.flags & SHF_ALLOC) !== 0n && s.size > 0n
      && !elfSectionFileSpanConsistentWithLoads(image, s.addr, s.size, s.offset, noBits);
    if (mappingInconsistent) {
      image.warnings.push(`ELF section ${s.index} (${s.name || 'unnamed'}) has a sh_addr/sh_offset relation inconsistent with the runtime PT_LOAD mapping and is excluded from virtual mapping authority`);
    }
    if (fileSpanInvalid) {
      image.warnings.push(`ELF section ${s.index} (${s.name || 'unnamed'}) has a file span beyond EOF and is excluded from virtual mapping authority`);
    }
    const relocatableMappingInvalid = h.type === ET_REL && s.syntheticAddr == null;
    image.addSection({
      name: s.name || `section_${s.index}`, segment: null,
      address: h.type === ET_REL ? (s.syntheticAddr ?? 0n) : s.addr, size: s.size, fileOffset: s.offset,
      fileSize: noBits ? 0n : s.size,
      perms: { read: !!(s.flags & SHF_ALLOC), write: !!(s.flags & SHF_WRITE), execute: !!(s.flags & SHF_EXECINSTR) },
      flags: s.flags, type: s.type, index: s.index,
      source: relocatableMappingInvalid || fileSpanInvalid || mappingInconsistent ? 'unmapped-section' : h.type === ET_REL ? 'ET_REL-synthetic-section' : 'section-header',
    });
  }

  image.imageBase = h.type === ET_REL ? 0n : findImageBase(image);
  if (h.type !== ET_REL && image.entrypoint != null) {
    const zeroResetVector = image.entrypoint === 0n && image.arch === 'arm64' && h.type === ET_EXEC;
    if (image.entrypoint !== 0n || zeroResetVector) {
      const rejection = elfInstructionTargetRejection(image, image.entrypoint);
      if (rejection == null) {
        image.functions.push(functionSeed(image.entrypoint, { source: 'entrypoint', confidence: 0.9 }));
        if (zeroResetVector) image.metadata.entrypointZeroEvidence = 'aarch64-executable-pt-load-at-zero';
      } else {
        image.warnings.push(`Ignored ELF entrypoint 0x${image.entrypoint.toString(16)}: ${rejection}`);
        if (zeroResetVector) image.metadata.entrypointZeroEvidence = 'zero-sentinel-unproven';
      }
    } else {
      image.metadata.entrypointZeroEvidence = 'zero-sentinel-unproven';
    }
  }

  const symbolTables = rawSections.filter((s) => s.type === SHT_SYMTAB || s.type === SHT_DYNSYM);
  let dynsymAuthoritative = false;
  for (const s of symbolTables) {
    const complete = parseSymbols(r, s, rawSections, image, bits, h.type, metadataBudget);
    if (s.type === SHT_DYNSYM && complete) dynsymAuthoritative = true;
  }
  if (isRiscv) {
    // Raw headers and reserved symbol indices do not establish section authority.
    const mappedSections = image.sections.filter(sectionHasMappedAddress);
    const mappedSectionsByIndex = new Map(mappedSections.map((section) => [section.index, section]));
    const mappings = image.symbols
      .filter((symbol) => {
        if (!isRiscvMappingSymbolRecord(symbol)) return false;
        const section = mappedSectionsByIndex.get(symbol.sectionIndex);
        return section != null
          && symbol.address >= section.address
          && symbol.address < section.address + section.size;
      })
      .map((symbol) => {
        const parsed = parseRiscvMappingSymbol(symbol.name);
        if (!parsed) return null;
        if (parsed.isa && parsed.isa.xlen !== bits) {
          image.warnings.push(`RISC-V mapping symbol ISA XLEN ${parsed.isa.xlen} disagrees with ELFCLASS${bits}`);
          return { address:symbol.address, sectionIndex:symbol.sectionIndex, kind:parsed.kind, isa:null };
        }
        return { address:symbol.address, sectionIndex:symbol.sectionIndex, ...parsed };
      })
      .filter(Boolean)
      .sort((left, right) => left.address < right.address ? -1 : left.address > right.address ? 1 : 0);
    const sections = mappedSections
      .filter((section) => section.perms.execute && section.size > 0n)
      .map((section) => ({
        sectionIndex:section.index,
        start:section.address,
        end:section.address + section.size,
      }));
    image.metadata.riscvIsa = {
      file:riscvFileIsa,
      mappings,
      sections,
      evidence:riscvFileIsa ? 'elf-attribute' : 'missing',
    };
  }
  const hasRelocations = rawSections.some((s) => s.type === SHT_REL || s.type === SHT_RELA);
  const relocationIndexes = hasRelocations ? prepareRelocationIndexes(image, metadataBudget) : null;
  for (const s of rawSections) {
    if (metadataBudget.stopped) break;
    if (s.type === SHT_REL || s.type === SHT_RELA) parseRelocations(r, s, rawSections, image, bits, h.type, metadataBudget, relocationIndexes);
    else if (s.type === SHT_DYNAMIC) parseDynamic(r, s, rawSections, image, bits, metadataBudget);
  }
  const hasDynamic = rawSections.some((s) => s.type === SHT_DYNAMIC);
  parseProgramDynamic(r, programHeaders, image, bits, {
    signal: options.signal,
    symbols: !dynsymAuthoritative,
    relocations: !hasRelocations,
    sectionDynamicPresent: hasDynamic,
  });
  if (!dynsymAuthoritative) reconcileDynamicSymbolFallbackEvidence(image);
  if (!metadataBudget.stopped) validateSectionRiscvVariantCcTag(image, rawSections);
  let ehFrameHdr = rawSections.find((s) => s.name === '.eh_frame_hdr') || null;
  if (!ehFrameHdr) {
    const ph = programHeaders.find((item) => item.type === PT_GNU_EH_FRAME && item.filesz > 0n);
    if (ph) ehFrameHdr = { name: 'PT_GNU_EH_FRAME', addr: ph.vaddr, offset: ph.offset, size: ph.filesz };
  }
  if (ehFrameHdr && !metadataBudget.stopped) parseEhFrameHeader(r, ehFrameHdr, image, bits, metadataBudget);
  image.metadata.elfMetadata = metadataBudget.snapshot();

  return image.finalize();
}

function alignUp(value, alignment) {
  const a = alignment > 0n ? alignment : 1n;
  const rem = value % a;
  return rem === 0n ? value : value + (a - rem);
}

function alignDown(value, alignment) {
  const a = alignment > 0n ? alignment : 1n;
  return value - (value % a);
}

function validELFSectionAlignment(alignment) {
  return alignment <= 1n || (alignment & (alignment - 1n)) === 0n;
}

// The ET_REL synthetic analysis namespace is laid out with a fixed base above
// the 32-bit target range and grows upward in a 64-bit-wide address domain, so
// every placement (base and base+sh_size) must stay representable as a 64-bit
// architecture address. A tiny SHT_NOBITS section declares an arbitrarily large
// sh_size without backing it with file bytes, so an unbounded `cursor += size`
// could push a later section's base/end past 2^64-1 while still publishing the
// section as ordinary canonical mapping authority (#8743).
const ELF_RELOCATABLE_SYNTHETIC_ADDRESS_BITS = 64;

function assignRelocatableSectionAddresses(sections, image) {
  let cursor = 0x100000000n;
  for (const sec of sections) {
    // Section header 0 is the reserved SHT_NULL sentinel, never a real section.
    // Extended-count ET_REL files store the section COUNT in its sh_size, so
    // publishing it at synthetic address 0 with that size fabricates a VA-0
    // mapped extent (#8741). Keep the sentinel listed for metadata but withhold
    // mapping authority, the same 'unmapped-section' treatment as other invalid spans.
    if (sec.index === 0) { sec.syntheticAddr = null; continue; }
    const requested = sec.addralign > 0n ? sec.addralign : 1n;
    if (!validELFSectionAlignment(requested)) {
      sec.syntheticAddr = null;
      markELFMetadataPartial(image, `section-addralign:${sec.index}`, `ELF ET_REL section ${sec.index} has invalid sh_addralign ${sec.addralign}; synthetic address authority was withheld`);
      continue;
    }
    if (sec.size <= 0n) { sec.syntheticAddr = 0n; continue; }
    const aligned = alignUp(cursor, requested);
    if (!elfAddressRangeFits(ELF_RELOCATABLE_SYNTHETIC_ADDRESS_BITS, aligned, sec.size)) {
      sec.syntheticAddr = null;
      markELFMetadataPartial(image, `section-synthetic-address-domain:${sec.index}`, `ELF ET_REL section ${sec.index} synthetic layout ${aligned}+${sec.size} exceeds the 64-bit synthetic address domain; mapping authority was withheld`);
      continue;
    }
    cursor = aligned;
    sec.syntheticAddr = cursor;
    cursor += sec.size > 0n ? sec.size : 1n;
  }
  image.metadata.relocatableAddressModel = {
    kind:'synthetic-section-layout', base:'0x100000000', sections:sections.filter((s)=>s.syntheticAddr).length,
  };
}

function normalSectionIndex(index, sections) {
  return Number.isInteger(index) && index > 0 && index < sections.length && index < SHN_LORESERVE;
}

function actualSectionIndex(index, sections) {
  return Number.isInteger(index) && index > 0 && index < sections.length;
}

function symbolAddressForELF(elfType, value, sectionIndex, sections, extendedSectionIndex = false) {
  if (!extendedSectionIndex && sectionIndex === SHN_ABS) return value;
  if (!extendedSectionIndex && (sectionIndex === SHN_COMMON || sectionIndex === SHN_UNDEF)) return null;
  if (elfType !== ET_REL) return value;
  const valid = extendedSectionIndex
    ? actualSectionIndex(sectionIndex, sections)
    : normalSectionIndex(sectionIndex, sections);
  if (!valid) return null;
  const sec = sections[sectionIndex];
  if (value > sec.size || sec.syntheticAddr == null) return null;
  return sec.syntheticAddr + value;
}

function readHeader(r, bits) {
  if (bits === 64) {
    r.check(0, 64);
    return {
      type: r.u16(16), machine: r.u16(18), version: r.u32(20), entry: r.u64(24),
      phoff: r.u64(32), shoff: r.u64(40), flags: r.u32(48), ehsize: r.u16(52),
      phentsize: r.u16(54), phnum: r.u16(56), shentsize: r.u16(58), shnum: r.u16(60), shstrndx: r.u16(62),
    };
  }
  r.check(0, 52);
  return {
    type: r.u16(16), machine: r.u16(18), version: r.u32(20), entry: BigInt(r.u32(24)),
    phoff: BigInt(r.u32(28)), shoff: BigInt(r.u32(32)), flags: r.u32(36), ehsize: r.u16(40),
    phentsize: r.u16(42), phnum: r.u16(44), shentsize: r.u16(46), shnum: r.u16(48), shstrndx: r.u16(50),
  };
}

function validateHeaderTableSizes(r, h, bits) {
  const minHeader = bits === 64 ? 64 : 52;
  const minProgram = bits === 64 ? 56 : 32;
  const minSection = bits === 64 ? 64 : 40;
  if (h.ehsize < minHeader) throw new Error(`ELF e_ehsize ${h.ehsize} is smaller than ${minHeader}`);
  if (h.phoff !== 0n && h.phnum !== 0 && h.phentsize < minProgram) throw new Error(`ELF e_phentsize ${h.phentsize} is smaller than ${minProgram}`);
  if (h.shoff !== 0n && h.shentsize < minSection) throw new Error(`ELF e_shentsize ${h.shentsize} is smaller than ${minSection}`);
  if (h.phnum === PN_XNUM && h.shoff === 0n) throw new Error('ELF PN_XNUM requires section header 0');
  void r;
}

function validateHeaderTablePresence(h) {
  if (h.phoff === 0n && h.phnum !== 0) throw new Error(`ELF e_phnum ${h.phnum} requires a non-zero e_phoff`);
  if (h.shoff === 0n && h.shnum !== 0) throw new Error(`ELF e_shnum ${h.shnum} requires a non-zero e_shoff`);
}

function resolveExtendedProgramHeaderCount(r, h, bits) {
  if (h.phnum !== PN_XNUM) return;
  const off = safeOffset(h.shoff);
  const minSection = bits === 64 ? 64 : 40;
  if (off == null || off <= 0 || off + minSection > r.length) throw new Error('ELF PN_XNUM section header 0 is truncated');
  const actual = r.u32(off + (bits === 64 ? 44 : 28));
  if (actual > 1_000_000) throw new Error(`invalid ELF extended program header count ${actual}`);
  h.extendedPhnum = actual;
  h.phnum = actual;
}

// #8665 — the PT_LOAD overlap safety check (originally added for #7610) is
// load-bearing and must reject every genuinely ambiguous byte-provenance pair,
// but its original form scanned *all* previously accepted segments per new load,
// so N page-disjoint loads forced N*(N-1)/2 prior-segment iterations before the
// ELF metadata wall-clock/operation budget existed. This page-interval index
// (keyed by the image, so it stays entirely inside this parse) reduces the
// common/disjoint case to a binary search: an existing load can only conflict
// with the new load if their page-rounded VM intervals intersect, so the whole
// linear prefix is skipped whenever its running maximum page end does not reach
// the query start. Non-ELF images are never registered.
const ptLoadOverlapIndex = new WeakMap();
// Defense in depth: a pathological input that forces many genuinely
// page-overlapping candidates is bounded rather than allowed to run unbounded;
// exceeding it fails closed exactly like any other rejected topology.
const ELF_PT_LOAD_OVERLAP_SCAN_BUDGET = 200_000;

function ptLoadPageInterval(entry) {
  const pageStart = alignDown(entry.address, ELF_RUNTIME_PAGE_SIZE);
  const pageEnd = alignUp(entry.address + entry.size, ELF_RUNTIME_PAGE_SIZE);
  return { pageStart, pageEnd };
}

function ptLoadOverlapState(image) {
  let state = ptLoadOverlapIndex.get(image);
  if (!state) {
    state = { entries: [], prefMaxEnd: [], scanned: 0, dirty: false, work: 0, order: 0 };
    ptLoadOverlapIndex.set(image, state);
  }
  // Consume any PT_LOAD segments appended since the last query. `addSegment`
  // only ever appends, and the caller adds exactly one load after each check,
  // so this amortizes to O(1) per accepted load.
  const segments = image.segments;
  while (state.scanned < segments.length) {
    const segment = segments[state.scanned++];
    if (segment.source !== 'PT_LOAD' || segment.size === 0n) continue;
    const { pageStart, pageEnd } = ptLoadPageInterval(segment);
    const entries = state.entries;
    const last = entries.length ? entries[entries.length - 1] : null;
    // `order` preserves the accepted-file order so the reported first conflict
    // matches the original per-segment scan regardless of VM sort position.
    const entry = { segment, address: segment.address, size: segment.size, fileOffset: segment.fileOffset, fileSize: segment.fileSize, pageStart, pageEnd, order: state.order++ };
    if (last === null || pageStart >= last.pageStart) {
      entries.push(entry);
      const prevRun = last === null ? null : lastPref(state.prefMaxEnd);
      state.prefMaxEnd.push(prevRun === null || pageEnd > prevRun ? pageEnd : prevRun);
      continue;
    }
    // Out-of-order page base: binary-insert so the array stays sorted for the
    // prefix-max short-circuit. Rare in real ELFs; bounded by the scan budget.
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].pageStart <= pageStart) lo = mid + 1; else hi = mid;
    }
    entries.splice(lo, 0, entry);
    state.dirty = true;
  }
  if (state.dirty) {
    state.prefMaxEnd = [];
    let run = null;
    for (const entry of state.entries) {
      run = run === null || entry.pageEnd > run ? entry.pageEnd : run;
      state.prefMaxEnd.push(run);
    }
    state.dirty = false;
  }
  return state;
}

function lastPref(prefMaxEnd) {
  return prefMaxEnd[prefMaxEnd.length - 1];
}

// Existing loads that could page-overlap [pageVmStart, pageVmEnd), returned in
// accepted-file order to reproduce the original first-conflict message exactly.
function ptLoadOverlapCandidates(state, pageVmStart, pageVmEnd) {
  const entries = state.entries;
  if (entries.length === 0) return [];
  // hi = number of entries whose pageStart < pageVmEnd.
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].pageStart < pageVmEnd) lo = mid + 1; else hi = mid;
  }
  if (lo === 0) return [];
  // If no earlier interval reaches the query start, none can overlap it.
  if (state.prefMaxEnd[lo - 1] <= pageVmStart) return [];
  const matched = [];
  for (let i = 0; i < lo; i++) {
    state.work++;
    if (state.work > ELF_PT_LOAD_OVERLAP_SCAN_BUDGET) {
      const error = new Error('ELF PT_LOAD overlap validation exceeded the topology scan budget');
      error.code = 'ELF_PT_LOAD_OVERLAP_SCAN_BUDGET';
      throw error;
    }
    const entry = entries[i];
    if (entry.pageEnd > pageVmStart && entry.pageStart < pageVmEnd) matched.push(entry);
  }
  matched.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  return matched;
}

function ptLoadBackedPageEnd(address, size, fileSize, pageStart) {
  return fileSize > 0n ? alignUp(address + size, ELF_RUNTIME_PAGE_SIZE) : pageStart;
}

function rejectAmbiguousPtLoadOverlap(image, index, ph) {
  // Linux maps PT_LOADs at page granularity. A later half-page claim can remap
  // the earlier half of the same page even when the declared p_vaddr/p_memsz
  // intervals are merely adjacent. BinaryImage is intentionally raw-range
  // based, so those loader-page aliases must be rejected before any first-wins
  // mapping authority can be published (#7610).
  const vmStart = ph.vaddr;
  const vmEnd = ph.vaddr + ph.memsz;
  const backedEnd = ph.vaddr + ph.filesz;
  const pageVmStart = alignDown(vmStart, ELF_RUNTIME_PAGE_SIZE);
  const pageVmEnd = alignUp(vmEnd, ELF_RUNTIME_PAGE_SIZE);
  const backedPageEnd = ph.filesz > 0n ? alignUp(backedEnd, ELF_RUNTIME_PAGE_SIZE) : pageVmStart;
  const filePageStart = alignDown(ph.offset, ELF_RUNTIME_PAGE_SIZE);
  const state = ptLoadOverlapState(image);
  // Only page-rounded VM interval intersections can be ambiguous; the raw
  // VM interval is always contained in its page interval, so this candidate
  // filter never drops a real #7610 rejection. #8665.
  for (const { segment: existing } of ptLoadOverlapCandidates(state, pageVmStart, pageVmEnd)) {
    const eVmEnd = existing.address + existing.size;
    const eBackedEnd = existing.address + existing.fileSize;

    const ePageVmStart = alignDown(existing.address, ELF_RUNTIME_PAGE_SIZE);
    const ePageVmEnd = alignUp(eVmEnd, ELF_RUNTIME_PAGE_SIZE);
    const eBackedPageEnd = existing.fileSize > 0n ? alignUp(eBackedEnd, ELF_RUNTIME_PAGE_SIZE) : ePageVmStart;
    const eFilePageStart = alignDown(existing.fileOffset, ELF_RUNTIME_PAGE_SIZE);
    const pageOverlapStart = pageVmStart > ePageVmStart ? pageVmStart : ePageVmStart;
    const pageOverlapEnd = pageVmEnd < ePageVmEnd ? pageVmEnd : ePageVmEnd;
    if (pageOverlapStart < pageOverlapEnd) {
      const pagePoints = [pageOverlapStart, pageOverlapEnd];
      for (const point of [backedPageEnd, eBackedPageEnd]) {
        if (point > pageOverlapStart && point < pageOverlapEnd) pagePoints.push(point);
      }
      pagePoints.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (let i = 0; i + 1 < pagePoints.length; i++) {
        const point = pagePoints[i];
        const newBackedPage = point >= pageVmStart && point < backedPageEnd;
        const oldBackedPage = point >= ePageVmStart && point < eBackedPageEnd;
        if (!newBackedPage && !oldBackedPage) continue;
        if (newBackedPage !== oldBackedPage) {
          const error = new Error(`PT_LOAD ${index} mapped page overlaps ${existing.name || 'PT_LOAD'} with ambiguous file/zero ownership`);
          error.code = 'ELF_PT_LOAD_VM_OVERLAP';
          throw error;
        }
        const newPageOffset = filePageStart + (point - pageVmStart);
        const oldPageOffset = eFilePageStart + (point - ePageVmStart);
        if (newPageOffset !== oldPageOffset) {
          const error = new Error(`PT_LOAD ${index} mapped page overlaps ${existing.name || 'PT_LOAD'} with a different file mapping`);
          error.code = 'ELF_PT_LOAD_VM_OVERLAP';
          throw error;
        }
      }
    }

    // Preserve the byte-exact raw-range check as a second boundary. Page-level
    // congruence alone does not prove that file-backed/zero-fill transitions
    // inside a shared page are identical.
    const overlapStart = vmStart > existing.address ? vmStart : existing.address;
    const overlapEnd = vmEnd < eVmEnd ? vmEnd : eVmEnd;
    if (overlapStart >= overlapEnd) continue;
    const points = [overlapStart, overlapEnd];
    for (const point of [backedEnd, eBackedEnd]) {
      if (point > overlapStart && point < overlapEnd) points.push(point);
    }
    points.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 0; i + 1 < points.length; i++) {
      const point = points[i];
      const newBacked = point >= vmStart && point < backedEnd;
      const oldBacked = point >= existing.address && point < eBackedEnd;
      if (!newBacked && !oldBacked) continue;
      if (newBacked !== oldBacked) {
        const error = new Error(`PT_LOAD ${index} VM range overlaps ${existing.name || 'PT_LOAD'} with ambiguous file/zero ownership`);
        error.code = 'ELF_PT_LOAD_VM_OVERLAP';
        throw error;
      }
      const newOffset = ph.offset + (point - vmStart);
      const oldOffset = existing.fileOffset + (point - existing.address);
      if (newOffset !== oldOffset) {
        const error = new Error(`PT_LOAD ${index} VM range overlaps ${existing.name || 'PT_LOAD'} with a different file mapping`);
        error.code = 'ELF_PT_LOAD_VM_OVERLAP';
        throw error;
      }
    }
  }
}

function parseProgramHeaders(r, h, image, bits, budget) {
  const out = [];
  const off = safeOffset(h.phoff);
  if (off == null) { image.warnings.push('ELF program header offset is not safely representable'); return out; }
  if (!h.phnum || !h.phentsize || off <= 0) return out;
  // The declared count is only authority for what the file can actually hold.
  // Reading the in-file prefix and marking the table partial keeps a `PN_XNUM`
  // expansion from turning a small file into an unbudgeted object fan-out
  // (#8714), the same fail-closed shape `parseSymbols` uses for truncated tables.
  const capacity = Math.max(0, Math.floor((r.length - off) / h.phentsize));
  let count = h.phnum;
  if (count > capacity) {
    markELFMetadataPartial(image, 'program-headers:truncated', `ELF program header table declares ${count} entries of ${h.phentsize} bytes at offset ${off} but only ${capacity} fit in the file`);
    count = capacity;
  }
  let parsed = 0;
  for (let i = 0; i < count; i++) {
    if (!budget.take({ inputBytes: h.phentsize, objects: 1, operations: 4, estimatedHeapBytes: 288 }, 'program-header')) break;
    parsed++;
    const p = off + i * h.phentsize;
    let ph;
    if (bits === 64) {
      ph = { type: r.u32(p), flags: r.u32(p + 4), offset: r.u64(p + 8), vaddr: r.u64(p + 16), filesz: r.u64(p + 32), memsz: r.u64(p + 40), align: r.u64(p + 48) };
    } else {
      ph = { type: r.u32(p), offset: BigInt(r.u32(p + 4)), vaddr: BigInt(r.u32(p + 8)), filesz: BigInt(r.u32(p + 16)), memsz: BigInt(r.u32(p + 20)), flags: r.u32(p + 24), align: BigInt(r.u32(p + 28)) };
    }
    if (ph.type === PT_LOAD) {
      const fileLength = BigInt(r.length);
      const invalidSize = ph.filesz > ph.memsz;
      const invalidRange = ph.offset > fileLength || ph.filesz > fileLength - ph.offset;
      const invalidAlign = ph.align > 1n && (ph.align & (ph.align - 1n)) !== 0n;
      const invalidCongruence = !invalidAlign && ph.align > 1n && ph.vaddr % ph.align !== ph.offset % ph.align;
      const invalidVmRange = !elfAddressRangeFits(bits, ph.vaddr, ph.memsz);
      if (invalidSize || invalidRange || invalidAlign || invalidCongruence || invalidVmRange) {
        const reason = invalidSize ? 'p_filesz > p_memsz'
          : invalidRange ? 'file range exceeds input'
            : invalidAlign ? 'p_align is not a power of two'
              : invalidCongruence ? 'p_vaddr/p_offset are not congruent modulo p_align'
                : `virtual range exceeds ELF${bits} address space`;
        image.warnings.push(`invalid ELF PT_LOAD ${i}: ${reason}`);
        continue;
      }
    }
    out.push(ph);
    if (ph.type === PT_LOAD) {
      rejectAmbiguousPtLoadOverlap(image, i, ph);
      image.addSegment({
        name: `LOAD${i}`, address: ph.vaddr, size: ph.memsz, fileOffset: ph.offset, fileSize: ph.filesz,
        perms: { read: !!(ph.flags & 4), write: !!(ph.flags & 2), execute: !!(ph.flags & 1) }, flags: ph.flags, source: 'PT_LOAD',
      });
    }
  }
  // `e_phnum = PN_XNUM` stores the real count in section header 0's `sh_info`,
  // which is attacker-controlled. Publish what was actually consumed, never the
  // declared figure, so downstream authority cannot size itself from a count the
  // file does not contain (#8714).
  if (h.extendedPhnum != null) image.metadata.extendedProgramHeaderCount = parsed;
  return out;
}

function parseSectionHeaders(r, h, bits, image, budget) {
  const off = safeOffset(h.shoff);
  let count = h.shnum;
  if (off == null) { image.warnings.push('ELF section header offset is not safely representable'); return []; }
  if (!off || !h.shentsize) return [];
  if (off + h.shentsize > r.length) { image.warnings.push('ELF section header table is truncated'); return []; }
  if (count === 0) count = bits === 64 ? Number(r.u64(off + 32)) : r.u32(off + 20);
  if (count > 100000 || off + count * h.shentsize > r.length) { image.warnings.push(`invalid ELF section count ${count}`); return []; }
  const out = [];
  for (let i = 0; i < count; i++) {
    if (!budget.take({ inputBytes: h.shentsize, records: 1, objects: 1, operations: 6, estimatedHeapBytes: 384 }, 'section-header')) break;
    const p = off + i * h.shentsize;
    if (bits === 64) {
      out.push({ index: i, nameOffset: r.u32(p), type: r.u32(p + 4), flags: r.u64(p + 8), addr: r.u64(p + 16), offset: r.u64(p + 24), size: r.u64(p + 32), link: r.u32(p + 40), info: r.u32(p + 44), addralign: r.u64(p + 48), entsize: r.u64(p + 56), name: '' });
    } else {
      out.push({ index: i, nameOffset: r.u32(p), type: r.u32(p + 4), flags: BigInt(r.u32(p + 8)), addr: BigInt(r.u32(p + 12)), offset: BigInt(r.u32(p + 16)), size: BigInt(r.u32(p + 20)), link: r.u32(p + 24), info: r.u32(p + 28), addralign: BigInt(r.u32(p + 32)), entsize: BigInt(r.u32(p + 36)), name: '' });
    }
  }
  return out;
}

/*
 * Section-backed string tables must contain a real NUL terminator inside the
 * table's file-backed span (#2167). ByteView.cstring() returns the whole span
 * when no NUL exists, which would admit malformed bytes as canonical symbol /
 * DT_NEEDED / SONAME / section names. Returns null when the span has no NUL.
 */
function terminatedStringInTable(r, strStart, strSize, offset, maxSpan, stats = null) {
  const max = Math.min(strSize - offset, maxSpan);
  if (max <= 0) { if (stats) stats.scanned = 0; return null; }
  const slice = r.slice(strStart + offset, max);
  const nul = slice.indexOf(0);
  if (nul < 0) { if (stats) stats.scanned = max; return null; }
  const span = Math.min(nul + 1, max);
  if (stats) stats.scanned = span;
  return r.cstring(strStart + offset, span);
}

function nameSections(r, sections, h, image, budget) {
  let shstrndx = h.shstrndx;
  if (shstrndx === SHN_XINDEX) {
    const link = sections[0]?.link;
    if (link == null || link === 0 || link >= sections.length) {
      markELFMetadataPartial(image, 'section-names:shstrndx-invalid', `ELF e_shstrndx SHN_XINDEX section-0 sh_link ${link ?? '<absent>'} does not resolve to a section`);
      return;
    }
    shstrndx = link;
  }
  // e_shstrndx == SHN_UNDEF (0) declares the file has NO section-name string
  // table, and section header 0 is the reserved SHT_NULL sentinel: extended
  // section-count files store the real section COUNT in its sh_size, so reading
  // section 0 as a name table decodes the ELF header / start of the section
  // table as bogus section names (#8741). A name table must be a real, in-range
  // SHT_STRTAB section, never the index-0 sentinel.
  if (shstrndx === 0) return;
  if (shstrndx >= sections.length) {
    markELFMetadataPartial(image, 'section-names:shstrndx-invalid', `ELF e_shstrndx ${shstrndx} is outside the section header table (${sections.length} sections)`);
    return;
  }
  const str = sections[shstrndx];
  if (!str || str.type !== SHT_STRTAB) {
    markELFMetadataPartial(image, 'section-names:shstrndx-not-strtab', `ELF e_shstrndx ${shstrndx} does not name an SHT_STRTAB section`);
    return;
  }
  if (str.offset + str.size > BigInt(r.length)) return;
  const strStart = Number(str.offset);
  const strBytes = Number(str.size);
  // `sh_name` is an offset, so a conforming ELF may point any number of section
  // headers at one shared string. Resolve each distinct offset exactly once and
  // charge the scan plus the retained text against the metadata budget; repeated
  // references are free (#8678). Failed (unterminated/out-of-span) lookups are
  // cached too, so an adversarial table cannot re-scan the same bytes per row.
  const resolved = new Map();
  const scan = { scanned: 0 };
  for (const s of sections) {
    if (BigInt(s.nameOffset) >= str.size) continue;
    const cached = resolved.get(s.nameOffset);
    if (cached !== undefined) { s.name = cached; continue; }
    if (!budget.take({ records: 1, objects: 1, operations: 2 }, 'section-name')) return;
    const sectionName = terminatedStringInTable(r, strStart, strBytes, s.nameOffset, SECTION_NAME_MAX_SPAN, scan) || '';
    // The scan itself already happened, so charging it afterwards still caps the
    // total bytes examined at the configured input limit plus one bounded span
    // instead of the previous per-reference cost.
    if (!budget.take({
      inputBytes: scan.scanned,
      stringBytes: sectionName.length * 2,
      estimatedHeapBytes: sectionName.length * 2 + 32,
    }, 'section-name')) return;
    resolved.set(s.nameOffset, sectionName);
    s.name = sectionName;
  }
}

function markFixedTableRemainder(section, entrySize, budget, label) {
  if (entrySize > 0n && section.size % entrySize !== 0n) {
    budget.partial(
      `${label}:${section.index}:trailing-bytes`,
      `ELF ${label} section ${section.index} size ${section.size} is not divisible by entry size ${entrySize}`,
    );
  }
}

export function parseSymbols(r, table, sections, image, bits, elfType, budget) {
  const str = sections[table.link];
  if (!str) {
    budget.partial(`symbols:${table.index}:string-table-link`, `ELF symbol table ${table.index} links to missing section ${table.link}`);
    return false;
  }
  if (str.type !== SHT_STRTAB) {
    budget.partial(`symbols:${table.index}:string-table-type`, `ELF symbol table ${table.index} links to section ${table.link}, which is not SHT_STRTAB`);
    return false;
  }
  if (!table.entsize) {
    budget.partial(`symbols:${table.index}:entry-size`, `ELF symbol table ${table.index} has zero entry size`);
    return false;
  }
  const minEnt = BigInt(bits === 64 ? 24 : 16);
  if (table.entsize < minEnt) {
    budget.partial(`symbols:${table.index}:entry-size`, `ELF symbol table ${table.index} entry size ${table.entsize} is smaller than ${minEnt}`);
    return false;
  }
  let authoritative = true;
  if (table.size < table.entsize || table.size % table.entsize !== 0n) {
    authoritative = false;
    budget.partial(`symbols:${table.index}:table-size`, `ELF symbol table ${table.index} size ${table.size} is not a whole non-empty sequence of ${table.entsize}-byte entries`);
  }
  // #3973: keep complete entries for best-effort decoding, but do not let a
  // fixed-entry section with trailing bytes become closed-world authority.
  markFixedTableRemainder(table, table.entsize, budget, 'symbols');
  const tableStart = safeOffset(table.offset), ent = safeOffset(table.entsize);
  const strStart = safeOffset(str.offset), strBytes = safeOffset(str.size);
  if (tableStart == null || ent == null || strStart == null || strBytes == null || tableStart > r.length || strStart > r.length || strBytes > r.length-strStart) {
    budget.partial(`symbols:${table.index}:file-span`, `ELF symbol/string table ${table.index} exceeds the file`);
    return false;
  }
  const declaredBig = table.size / table.entsize;
  const fileCapacity = Math.floor((r.length-tableStart)/ent);
  const declared = declaredBig > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(declaredBig);
  const count = Math.min(declared,fileCapacity);
  if (declaredBig > BigInt(fileCapacity)) {
    authoritative = false;
    budget.partial(`symbols:${table.index}:truncated`, `ELF symbol table ${table.index} exceeds its file-backed capacity`);
  }
  const xindex = sections.find((sec) => sec.type === SHT_SYMTAB_SHNDX && sec.link === table.index) || null;
  const xindexValid = !!xindex && xindex.entsize === 4n
    && xindex.size === BigInt(count) * 4n
    && xindex.offset <= BigInt(r.length) && xindex.size <= BigInt(r.length) - xindex.offset;
  if (xindex && !xindexValid) {
    authoritative = false;
    budget.partial(`symbols:${table.index}:xindex-malformed`, `ELF SHT_SYMTAB_SHNDX for table ${table.index} is malformed`);
  }

  for (let i=0;i<count;i++) {
    if (!budget.take({inputBytes:ent,records:1,objects:1,operations:2,estimatedHeapBytes:224},`symbols-${table.index}`)) { authoritative = false; break; }
    const p=tableStart+i*ent;
    let nameOff,info,other,shndx,value,size;
    if(bits===64){nameOff=r.u32(p);info=r.u8(p+4);other=r.u8(p+5);shndx=r.u16(p+6);value=r.u64(p+8);size=r.u64(p+16);}
    else{nameOff=r.u32(p);value=BigInt(r.u32(p+4));size=BigInt(r.u32(p+8));info=r.u8(p+12);other=r.u8(p+13);shndx=r.u16(p+14);}
    if (BigInt(nameOff) >= str.size || nameOff >= strBytes) {
      authoritative = false;
      if (i !== 0 || nameOff !== 0) budget.partial(`symbols:${table.index}:name-offset-range`, `ELF symbol table ${table.index} references a string-table offset outside its string table`);
      continue;
    }
    const maxName=Math.min(strBytes-nameOff,1<<20,Math.max(1,Math.floor(budget.remainingStringBytes/2)+1));
    const name=terminatedStringInTable(r,strStart,strBytes,nameOff,maxName);
    if(name==null){authoritative=false;budget.partial(`symbols:${table.index}:unterminated-name`,`ELF symbol ${i} in table ${table.index} references a string without a NUL terminator in its string table`);continue;}
    const bind=info>>>4,type=info&0xf;
    const isAnonymousSectionSym = !name && type === 3 && i > 0;
    if(!name && !isAnonymousSectionSym)continue;
    if(name && !budget.take({inputBytes:Math.min(maxName,name.length+1),stringBytes:name.length*2,estimatedHeapBytes:name.length*2+32},'symbol-name')){authoritative=false;break;}
    let resolvedShndx=shndx,sectionIdentityKnown=true;
    if(shndx===SHN_XINDEX){
      resolvedShndx=null;sectionIdentityKnown=false;
      const xoff=xindexValid?safeOffset(xindex.offset+BigInt(i*4)):null;
      if(xoff==null||xoff+4>r.length||BigInt((i+1)*4)>xindex.size){image.warnings.push(`ELF symbol ${i} uses SHN_XINDEX without a valid SHT_SYMTAB_SHNDX entry`);}
      else{const candidate=r.u32(xoff);if(candidate===SHN_UNDEF||actualSectionIndex(candidate,sections)){resolvedShndx=candidate;sectionIdentityKnown=true;}else image.warnings.push(`ELF symbol ${i} has out-of-range extended section index ${candidate}`);}
    }
    const extendedSectionIndex=shndx===SHN_XINDEX&&actualSectionIndex(resolvedShndx,sections);
    const normal=sectionIdentityKnown&&(extendedSectionIndex?actualSectionIndex(resolvedShndx,sections):normalSectionIndex(resolvedShndx,sections));
    const specialKnown=!extendedSectionIndex&&(resolvedShndx===SHN_UNDEF||resolvedShndx===SHN_ABS||resolvedShndx===SHN_COMMON);
    if(sectionIdentityKnown&&!normal&&!specialKnown){sectionIdentityKnown=false;image.warnings.push(`ELF symbol ${i} uses unsupported reserved section index ${resolvedShndx}`);}
    const defined=sectionIdentityKnown?(resolvedShndx!==SHN_UNDEF):null;
    const common=sectionIdentityKnown&&!extendedSectionIndex&&resolvedShndx===SHN_COMMON;
    // STT_TLS: a defined TLS symbol's st_value is its TLS offset, not a
    // virtual address (ELF gABI). It must never enter the VA domain or
    // image.exports as a canonical address (#5843).
    const tls=type===6;
    const isArm32=Number(image.metadata.machine)===40||image.arch==='arm';
    const isThumb=isArm32&&(type===2||type===STT_GNU_IFUNC)&&(value&1n)===1n;
    const effectiveValue=isThumb?(value&~1n):value;
    const address=sectionIdentityKnown&&!tls?symbolAddressForELF(elfType,effectiveValue,resolvedShndx,sections,extendedSectionIndex):null;
    // STB_GNU_UNIQUE (10) is a process-wide unique global binding (GNU ELF
    // ABI): it must stay in the export/linkage truth, not be lumped into an
    // anonymous `bind-N` bucket (#5844).
    const binding=bind===0?'local':bind===1?'global':bind===2?'weak':bind===STB_GNU_UNIQUE?'gnu-unique':`bind-${bind}`;
    const kind=type===2?'function':type===1?'object':type===3?'section':tls?'tls':type===STT_GNU_IFUNC?'indirect-function':`type-${type}`;
    const ifunc=type===STT_GNU_IFUNC&&defined===true&&!common;
    const riscvVariantCcFlag=image.metadata.machine===EM_RISCV&&(other&STO_RISCV_VARIANT_CC)!==0;
    const riscvVariantCc=riscvVariantCcFlag&&type===2;
    const aarch64VariantPcsFlag=Number(image.metadata.machine)===EM_AARCH64&&(other&STO_AARCH64_VARIANT_PCS)!==0;
    const aarch64VariantPcs=aarch64VariantPcsFlag&&type===2;
    const canonicalAddress=tls?null:sectionIdentityKnown?(elfType===ET_REL&&normal&&address==null?null:(address??0n)):null;
    const sym={name:name||'',address:canonicalAddress,originalValue:value,isThumb,size,kind,binding,defined,sectionIndex:sectionIdentityKnown?resolvedShndx:null,visibility:other&3,stOther:other,processorSpecificOther:other&~3,riscvVariantCcFlag,riscvVariantCc,aarch64VariantPcsFlag,aarch64VariantPcs,callingConvention:aarch64VariantPcs?'aarch64-variant-pcs':riscvVariantCc?'riscv-vector-variant':null,source:table.type===SHT_DYNSYM?'dynsym':'symtab',index:i,tableIndex:table.index,...(ifunc?{resolverAddress:address??(elfType===ET_REL&&normal?null:effectiveValue),resolution:'runtime-resolver'}:{}),
      ...(tls?{tlsOffset:value}:{}),...(common?{commonAlignment:value,commonSize:size,allocation:'common-unallocated'}:{}),sectionRelative:elfType===ET_REL&&normal?{sectionIndex:resolvedShndx,offset:effectiveValue}:null,addressDomain:tls?'tls-offset':common?'common-unallocated':elfType===ET_REL&&normal?(address==null?'section-relative-unmapped':'section-relative-synthetic'):'virtual'};
    image.symbols.push(sym);
    const externallyVisible=Boolean(name)&&(bind===1||bind===2||bind===STB_GNU_UNIQUE);
    if(defined===false&&externallyVisible){if(!budget.take({objects:1,operations:1,estimatedHeapBytes:160},'symbol-import')){authoritative=false;break;}image.imports.push({name,library:null,ordinal:null,weak:bind===2,symbolIndex:i,tableIndex:table.index,source:'elf-dynsym',sites:[]});}
    if(defined===true&&externallyVisible&&(sym.visibility===0||sym.visibility===3)){
      // TLS exports keep their name/visibility fact but never mint a VA:
      // a defined TLS symbol's value is a TLS offset, not an address (#5843).
      if(tls){if(!budget.take({objects:1,operations:1,estimatedHeapBytes:144},'symbol-export')){authoritative=false;break;}image.exports.push({name,address:null,kind,tlsOffset:value,symbolIndex:i,tableIndex:table.index,source:sym.source});}
      else if(address!=null){if(!budget.take({objects:1,operations:1,estimatedHeapBytes:144},'symbol-export')){authoritative=false;break;}image.exports.push({name,address,kind,symbolIndex:i,tableIndex:table.index,source:sym.source});}
    }
    if(defined===true&&(type===2||type===STT_GNU_IFUNC)&&address!=null&&address!==0n){
      const owner=executableELFRange(image,address,size||0n,normal?resolvedShndx:null);
      if(owner){
        const alignmentRejection=elfInstructionStartAlignmentRejection(image,address);
        if(alignmentRejection){budget.partial(`symbols:${table.index}:function-alignment`,`Ignored ELF ${type===STT_GNU_IFUNC?'STT_GNU_IFUNC resolver':'STT_FUNC'} ${name}: ${alignmentRejection}`);continue;}
        const startRejection=elfExactFunctionStartRejection(image,address,{sectionIndex:normal?resolvedShndx:null});
        if(startRejection){budget.partial(`symbols:${table.index}:function-authority`,`Ignored ELF ${type===STT_GNU_IFUNC?'STT_GNU_IFUNC resolver':'STT_FUNC'} ${name}: ${startRejection}`);continue;}
        const extentRejection=elfFunctionExtentRejection(image,address,size);
        if(extentRejection)budget.partial(`symbols:${table.index}:function-extent-authority`,`ELF ${type===STT_GNU_IFUNC?'STT_GNU_IFUNC resolver':'STT_FUNC'} ${name}: ${extentRejection}`);
        if(!budget.take({objects:1,operations:1,estimatedHeapBytes:128},'symbol-function')){authoritative=false;break;}
        image.functions.push(functionSeed(address,{size:extentRejection?null:(size||null),name:type===STT_GNU_IFUNC?`${name}$resolver`:name,source:type===STT_GNU_IFUNC?'ifunc-resolver':'symbol',confidence:0.995,exactFunctionStart:true,functionStartEvidence:(type===STT_GNU_IFUNC?'ELF STT_GNU_IFUNC resolver with validated executable section extent':elfType===ET_REL?'ELF ET_REL STT_FUNC with validated executable section-relative extent':'ELF STT_FUNC with validated executable section extent')+(extentRejection?'; published st_size is not file-backed and is not retained as extent authority':''),callingConvention:aarch64VariantPcs?'aarch64-variant-pcs':riscvVariantCc?'riscv-vector-variant':null,abiMetadata:aarch64VariantPcs?{aarch64VariantPcs:true,stOther:other}:riscvVariantCc?{riscvVariantCc:true,stOther:other}:null}));
        if(riscvVariantCc){if(!Array.isArray(image.metadata.riscvVariantCcFunctions))image.metadata.riscvVariantCcFunctions=[];image.metadata.riscvVariantCcFunctions.push({name,address,symbolIndex:i,tableIndex:table.index,stOther:other,callingConvention:'riscv-vector-variant'});}
        if(aarch64VariantPcs){if(!Array.isArray(image.metadata.aarch64VariantPcsFunctions))image.metadata.aarch64VariantPcsFunctions=[];image.metadata.aarch64VariantPcsFunctions.push({name,address,symbolIndex:i,tableIndex:table.index,stOther:other,callingConvention:'aarch64-variant-pcs'});}}
      else image.warnings.push(`Ignored ELF ${type===STT_GNU_IFUNC?'STT_GNU_IFUNC resolver':'STT_FUNC'} ${name} outside its canonical executable extent`);
    }
  }
  return authoritative;
}

function reconcileDynamicSymbolFallbackEvidence(image) {
  // The reconciliation only ever replaces section-backed `dynsym` records that
  // duplicate a PT_DYNAMIC fallback. A sectionless PT_DYNAMIC image carries no
  // `dynsym`-source symbols (and therefore no `elf-dynsym` imports or dynsym
  // exports), so the pass is a strict no-op there; keying every large aliased
  // `st_name` on such an image would re-materialize the shared name once per
  // record and defeat #8821's interning budget (#8821). Skip it in that case.
  if (!image.symbols.some((symbol) => symbol.source === 'dynsym')) return;
  const scalar = (value) => typeof value === 'bigint' ? value.toString() : value ?? null;
  const key = (values) => JSON.stringify(values.map(scalar));
  const symbolKey = (symbol) => key([
    symbol.index, symbol.name, symbol.address, symbol.tlsOffset, symbol.size,
    symbol.kind, symbol.binding, symbol.defined, symbol.sectionIndex, symbol.stOther,
  ]);
  const dynamicSymbols = new Set(
    image.symbols.filter((symbol) => symbol.source === 'PT_DYNAMIC').map(symbolKey),
  );
  const replacedSymbols = new Set();
  image.symbols = image.symbols.filter((symbol) => {
    if (symbol.source !== 'dynsym' || !dynamicSymbols.has(symbolKey(symbol))) return true;
    replacedSymbols.add(`${symbol.tableIndex}:${symbol.index}`);
    return false;
  });

  // Reconcile only matching DYNSYM records. Independent SYMTAB facts and
  // partial section records without a matching fallback remain available.
  const importKey = (entry) => key([
    entry.symbolIndex, entry.name, entry.weak, entry.version, entry.versionLibrary,
  ]);
  const dynamicImports = new Map(
    image.imports.filter((entry) => entry.source === 'PT_DYNAMIC').map((entry) => [importKey(entry), entry]),
  );
  image.imports = image.imports.filter((entry) => {
    if (entry.source !== 'elf-dynsym' || !replacedSymbols.has(`${entry.tableIndex}:${entry.symbolIndex}`)) return true;
    const replacement = dynamicImports.get(importKey(entry));
    if (!replacement) return true;
    if (entry.sites?.length) replacement.sites = [...(replacement.sites || []), ...entry.sites];
    return false;
  });

  const exportKey = (entry) => key([
    entry.symbolIndex, entry.name, entry.address, entry.tlsOffset, entry.kind, entry.version,
  ]);
  const dynamicExports = new Set(
    image.exports.filter((entry) => entry.source === 'PT_DYNAMIC').map(exportKey),
  );
  image.exports = image.exports.filter((entry) => entry.source !== 'dynsym'
    || !replacedSymbols.has(`${entry.tableIndex}:${entry.symbolIndex}`)
    || !dynamicExports.has(exportKey(entry)));
}


function validateSectionRiscvVariantCcTag(image, sections) {
  if (Number(image?.metadata?.machine) !== EM_RISCV) return;
  if (image?.metadata?.riscvVariantCcTagPresent === true) return;
  const dynamicSymbolTables = new Set(
    (sections || []).filter((section) => section.type === SHT_DYNSYM).map((section) => section.index),
  );
  if (!dynamicSymbolTables.size) return;
  const symbolsByKey = new Map(
    (image.symbols || [])
      .filter((symbol) => dynamicSymbolTables.has(symbol.tableIndex))
      .map((symbol) => [`${symbol.tableIndex}:${symbol.index}`, symbol]),
  );
  const missing = (image.relocations || []).some((relocation) =>
    (relocation.source === 'REL' || relocation.source === 'RELA') &&
    Number(relocation.type) === R_RISCV_JUMP_SLOT &&
    dynamicSymbolTables.has(relocation.symbolTableIndex) &&
    symbolsByKey.get(`${relocation.symbolTableIndex}:${relocation.symbolIndex}`)?.riscvVariantCcFlag === true,
  );
  if (!missing) return;
  const message = 'section-backed RISC-V variant-cc JUMP_SLOT requires DT_RISCV_VARIANT_CC';
  image.metadata.programDynamicPartial = true;
  const diagnostics = image.metadata.programDynamicDiagnostics ||= [];
  if (!diagnostics.includes(message)) diagnostics.push(message);
  const warning = `ELF: ${message}`;
  if (!image.warnings.includes(warning)) image.warnings.push(warning);
}

function prepareRelocationIndexes(image, budget) {
  if (!budget?.checkpoint?.() || budget.stopped) return null;
  const symbols = Array.isArray(image.symbols) ? image.symbols : [];
  const imports = Array.isArray(image.imports) ? image.imports : [];
  // Preflight the complete one-time indexing cost before either table-wide scan.
  // This ensures an already-stopped/exhausted budget never pays hidden O(N) work.
  const entries = symbols.length + imports.length;
  if (!budget.take({
    objects:entries,
    operations:entries,
    estimatedHeapBytes:symbols.length * 56 + imports.length * 64,
  }, 'relocation-lookup-index')) return null;
  const symbolsByTable = new Map();
  for (let i = 0; i < symbols.length; i++) {
    if ((i & 1023) === 0 && !budget.checkpoint()) return null;
    const symbol = symbols[i];
    if (!symbol || !Number.isInteger(symbol.tableIndex) || !Number.isInteger(symbol.index)) continue;
    let table = symbolsByTable.get(symbol.tableIndex);
    if (!table) symbolsByTable.set(symbol.tableIndex, table = new Map());
    if (!table.has(symbol.index)) table.set(symbol.index, symbol);
  }
  const importsByTable = new Map();
  for (let i = 0; i < imports.length; i++) {
    if ((i & 1023) === 0 && !budget.checkpoint()) return null;
    const imp = imports[i];
    if (!imp || imp.library != null || !Number.isInteger(imp.tableIndex) || !Number.isInteger(imp.symbolIndex)) continue;
    let table = importsByTable.get(imp.tableIndex);
    if (!table) importsByTable.set(imp.tableIndex, table = new Map());
    if (!table.has(imp.symbolIndex)) table.set(imp.symbolIndex, imp);
  }
  return { symbolsByTable, importsByTable };
}

function parseRelocations(r, sec, sections, image, bits, elfType, budget, indexes) {
  if (budget.stopped || !budget.checkpoint()) return;
  if(!sec.entsize)return;
  const minEnt=BigInt(bits===64?(sec.type===SHT_RELA?24:16):(sec.type===SHT_RELA?12:8));
  if(sec.entsize<minEnt){budget.partial(`relocations:${sec.index}:entry-size`,`ELF relocation section ${sec.index} entry size ${sec.entsize} is smaller than ${minEnt}`);return;}
  markFixedTableRemainder(sec, sec.entsize, budget, 'relocations');
  const tableStart=safeOffset(sec.offset),ent=safeOffset(sec.entsize);if(tableStart==null||ent==null||tableStart>r.length){budget.partial(`relocations:${sec.index}:file-span`,`ELF relocation section ${sec.index} has an invalid file span`);return;}
  const declaredBig=sec.size/sec.entsize,fileCapacity=Math.floor((r.length-tableStart)/ent),declared=declaredBig>BigInt(Number.MAX_SAFE_INTEGER)?Number.MAX_SAFE_INTEGER:Number(declaredBig),count=Math.min(declared,fileCapacity);
  if(declaredBig>BigInt(fileCapacity))budget.partial(`relocations:${sec.index}:truncated`,`ELF relocation section ${sec.index} exceeds its file-backed capacity`);
  const symbolTable=sections[sec.link];
  const symbolMinEnt=BigInt(bits===64?24:16);
  const linkedSymbolTable=symbolTable&&(symbolTable.type===SHT_SYMTAB||symbolTable.type===SHT_DYNSYM);
  if(!linkedSymbolTable){budget.partial(`relocations:${sec.index}:symbol-table-link`,`ELF relocation section ${sec.index} has invalid sh_link ${sec.link}; expected SHT_SYMTAB or SHT_DYNSYM`);return;}
  let symbolEntryCount=null;
  if(linkedSymbolTable){
    if(symbolTable.entsize<symbolMinEnt){
      budget.partial(`relocations:${sec.index}:symbol-table-entry-size`,`ELF symbol table ${sec.link} entry size ${symbolTable.entsize} is smaller than ${symbolMinEnt}`);
    }else if(symbolTable.size%symbolTable.entsize!==0n){
      budget.partial(`relocations:${sec.index}:symbol-table-span`,`ELF symbol table ${sec.link} size ${symbolTable.size} is not divisible by entry size ${symbolTable.entsize}`);
    }else{
      symbolEntryCount=symbolTable.size/symbolTable.entsize;
    }
  }
  // #567 residual: relocation sections sharing sh_link reuse one parser-owned
  // index. Never filter/materialize image.symbols after the budget has stopped.
  const byIndex=indexes?.symbolsByTable?.get(sec.link) || new Map();
  const importBySymbol=indexes?.importsByTable?.get(sec.link) || new Map();
  const target=elfType===ET_REL?sections[sec.info]:null;
  if(elfType===ET_REL&&!normalSectionIndex(sec.info,sections)){budget.partial(`relocations:${sec.index}:target-section`,`ELF ET_REL relocation section ${sec.index} has invalid sh_info target section ${sec.info}`);return;}
  for(let i=0;i<count;i++){
    if(!budget.take({inputBytes:ent,records:1,objects:1,operations:2,estimatedHeapBytes:144},`relocations-${sec.index}`))break;
    const p=tableStart+i*ent;let offset,addend=null,symIndex,type;
    if(bits===64){offset=r.u64(p);const info=r.u64(p+8);symIndex=Number(info>>32n);type=Number(info&0xffffffffn);if(sec.type===SHT_RELA)addend=r.i64(p+16);}
    else{offset=BigInt(r.u32(p));const raw=r.u32(p+4);symIndex=raw>>>8;type=raw&0xff;if(sec.type===SHT_RELA)addend=BigInt(r.i32(p+8));}
    let address=offset,fileOffset=image.addressToOffset(offset),addressDomain='virtual';
    if(elfType===ET_REL){
      if(target.syntheticAddr==null){budget.partial(`relocations:${sec.index}:target-section-alignment`,`ELF ET_REL relocation target section ${target.index} has no canonical synthetic address because its sh_addralign is invalid`);continue;}
      if(offset>=target.size){budget.partial(`relocations:${sec.index}:offset-range`,`ELF ET_REL relocation offset ${offset} is outside target section ${target.index}`);continue;}
      const fieldWidth=relocationFieldWidth(Number(image.metadata.machine),type,bits);
      if(fieldWidth===null){budget.partial(`relocations:${sec.index}:field-width-unknown`,`ELF ET_REL relocation type ${type} has no supported target-field width for machine ${image.metadata.machine}`);continue;}
      if(fieldWidth!==undefined&&fieldWidth>0n&&fieldWidth>target.size-offset){budget.partial(`relocations:${sec.index}:target-span`,`ELF ET_REL relocation type ${type} has a ${fieldWidth}-byte target field crossing target section ${target.index}`);continue;}
      address=target.syntheticAddr+offset;addressDomain='section-relative-synthetic';fileOffset=target.type===8?null:target.offset+offset;
    }else{
      const owner=image.segmentAt(offset);
      if(!owner){budget.partial(`relocations:${sec.index}:unmapped-target`,`ELF relocation section ${sec.index} has a relocation target outside every loaded PT_LOAD memory span`);continue;}
      const fieldWidth=relocationFieldWidth(Number(image.metadata.machine),type,bits);
      if(fieldWidth===null){budget.partial(`relocations:${sec.index}:field-width-unknown`,`ELF relocation type ${type} has no supported target-field width for machine ${image.metadata.machine}`);continue;}
      if(typeof fieldWidth==='bigint'&&fieldWidth>0n&&offset+fieldWidth>owner.address+owner.size){budget.partial(`relocations:${sec.index}:target-span`,`ELF relocation section ${sec.index} has a relocation target field crossing the end of its loaded PT_LOAD memory span`);continue;}
    }
    if(symIndex!==0&&linkedSymbolTable&&symbolEntryCount==null)continue;
    if(symIndex!==0&&symbolEntryCount!=null&&BigInt(symIndex)>=symbolEntryCount){budget.partial(`relocations:${sec.index}:symbol-index-range`,`ELF relocation section ${sec.index} references symbol index ${symIndex} outside its associated table count ${symbolEntryCount}`);continue;}
    const sym=byIndex.get(symIndex)||null;
    image.relocations.push({address,fileOffset,type,symbol:(sym&&sym.name)?sym.name:null,symbolIndex:symIndex,addend,section:sec.name,source:sec.type===SHT_RELA?'RELA':'REL',symbolTableIndex:sec.link,sectionRelative:elfType===ET_REL?{sectionIndex:sec.info,offset}:null,addressDomain});
    if(sym&&sym.defined===false){const cand=importBySymbol.get(symIndex)||null;const imp=cand&&cand.name===sym.name?cand:null;if(imp){if(!budget.take({objects:1,operations:1,estimatedHeapBytes:96},'relocation-import-site'))break;imp.sites.push({address,offset:fileOffset,kind:'relocation',type,sectionRelative:elfType===ET_REL?{sectionIndex:sec.info,offset}:null});}}
  }
}

function parseDynamic(r, sec, sections, image, bits, budget) {
  const minEnt = BigInt(bits === 64 ? 16 : 8);
  const rawEnt = sec.entsize || minEnt;
  if (rawEnt < minEnt) {
    budget.partial(`dynamic-section:${sec.index}:entry-size`, `ELF SHT_DYNAMIC ${sec.index} entry size ${rawEnt} is smaller than ${minEnt}`);
    return;
  }
  markFixedTableRemainder(sec, rawEnt, budget, 'dynamic-section');
  const ent = safeOffset(rawEnt);
  if (ent == null || !ent) {
    budget.partial(`dynamic-section:${sec.index}:entry-size`, `ELF SHT_DYNAMIC ${sec.index} entry size is not safely representable`);
    return;
  }

  // Processor-specific tags are still authoritative evidence when a section
  // has no usable string-table link. Decode the dynamic table before applying
  // optional string lookups so section-backed DT_RISCV_VARIANT_CC cannot be
  // lost behind an unrelated string-table validation failure.
  const start = safeOffset(sec.offset);
  if (start == null || start > r.length) {
    budget.partial(`dynamic-section:${sec.index}:span`, `ELF SHT_DYNAMIC ${sec.index} has an invalid file span`);
    return;
  }
  const declaredBig = sec.size / rawEnt;
  const fileCapacity = Math.floor((r.length - start) / ent);
  const declared = declaredBig > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(declaredBig);
  const count = Math.min(declared, fileCapacity);
  if (declaredBig > BigInt(fileCapacity)) {
    budget.partial(`dynamic-section:${sec.index}:truncated`, `ELF SHT_DYNAMIC exceeds its file-backed capacity`);
  }

  const str = sections[sec.link];
  if (!str || str.type !== SHT_STRTAB) {
    budget.partial(
      `dynamic-section:${sec.index}:string-table-link`,
      `ELF SHT_DYNAMIC ${sec.index} has invalid sh_link ${sec.link}`,
    );
  }
  const strStart = str?.type === SHT_STRTAB ? safeOffset(str.offset) : null;
  const strSize = str?.type === SHT_STRTAB ? safeOffset(str.size) : null;
  const stringTableValid = str?.type === SHT_STRTAB
    && strStart != null
    && strSize != null
    && strStart <= r.length
    && strSize <= r.length - strStart;
  if (str?.type === SHT_STRTAB && !stringTableValid) {
    budget.partial(`dynamic-section:${sec.index}:span`, `ELF SHT_DYNAMIC/string table exceeds the file`);
  }

  let sawNull = false;
  let dtInitHandled = false;
  for (let i = 0; i < count; i++) {
    if (!budget.take({ inputBytes: ent, records: 1, operations: 1, estimatedHeapBytes: 32 }, 'SHT_DYNAMIC')) break;
    const p = start + i * ent;
    const tag = bits === 64 ? r.i64(p) : BigInt(r.i32(p));
    const val = bits === 64 ? r.u64(p + 8) : BigInt(r.u32(p + 4));

    if (tag === DT_RISCV_VARIANT_CC && Number(image?.metadata?.machine) === EM_RISCV) {
      image.metadata.riscvVariantCcTagPresent = true;
    }
    if (tag === 0n) {
      sawNull = true;
      break;
    }

    if (tag === DT_INIT && val !== 0n && !dtInitHandled && Number(image.metadata.type) !== ET_REL) {
      dtInitHandled = true;
      const rejection = elfInstructionTargetRejection(image, val);
      if (rejection == null) {
        image.functions.push(functionSeed(val, {
          source: 'dt-init',
          confidence: 0.9,
          exactFunctionStart: true,
          functionStartEvidence: 'ELF SHT_DYNAMIC DT_INIT loader-invoked initializer in validated executable mapping with file-backed instruction bytes',
        }));
        image.metadata.dtInit = { address: val, source: 'SHT_DYNAMIC' };
      } else {
        budget.partial(
          `dynamic-section:${sec.index}:dt-init`,
          `ELF SHT_DYNAMIC ${sec.index} DT_INIT 0x${val.toString(16)} ${rejection}`,
        );
      }
    }

    if (tag === DT_NEEDED || tag === DT_SONAME) {
      if (stringTableValid && val >= BigInt(strSize)) {
        budget.partial(
          `dynamic-section:${sec.index}:string-reference-range`,
          `ELF SHT_DYNAMIC ${sec.index} references a string-table offset outside its string table`,
        );
        continue;
      }
      if (stringTableValid && val < BigInt(strSize)) {
        const off = Number(val);
        const max = Math.min(
          strSize - off,
          1 << 20,
          Math.max(1, Math.floor(budget.remainingStringBytes / 2) + 1),
        );
        const name = terminatedStringInTable(r, strStart, strSize, off, max);
        if (name == null && off < strSize) {
          budget.partial(
            `dynamic-section:${sec.index}:unterminated-string`,
            `ELF SHT_DYNAMIC ${sec.index} references a string without a NUL terminator in its string table`,
          );
          continue;
        }
        if (name && !budget.take({
          inputBytes: Math.min(max, name.length + 1),
          stringBytes:name.length * 2,
          estimatedHeapBytes:name.length * 2 + 32,
        }, 'SHT_DYNAMIC-string')) break;
        if (tag === DT_NEEDED && name) image.libraries.push(name);
        else if (tag === DT_SONAME && name) image.metadata.soname = name;
      }
    }
  }

  if (!sawNull) {
    budget.partial(
      `dynamic-section:${sec.index}:unterminated`,
      `ELF SHT_DYNAMIC ${sec.index} has no DT_NULL terminator within its readable entries`,
    );
  }
}
function findImageBase(image) {
  const loads = image.segments.filter((s) => s.address != null);
  if (!loads.length) return 0n;
  let base = loads[0].address - loads[0].fileOffset;
  for (const s of loads) {
    const b = s.address - s.fileOffset;
    if (b < base) base = b;
  }
  return base;
}

/*
 * EM_RISCV does not encode the register width: the same e_machine value is used
 * by RV32 and RV64, and only ELFCLASS separates them. Emitting a bare `riscv`
 * would create an architecture identity that no plugin, ABI, or capability
 * profile can resolve, so the width is folded in here and the canonical ids
 * `riscv32`/`riscv64` are the only ones this loader produces.
 */
function elfMachineName(m, bits) {
  if (m === 243) return bits === 64 ? 'riscv64' : 'riscv32';
  return ({ 3: 'x86', 8: 'mips', 20: 'ppc', 21: 'ppc64', 40: 'arm', 62: 'x86_64', 183: 'arm64' })[m] || `machine-${m}`;
}
function elfOsAbi(v) {
  return ({ 0: 'sysv', 1: 'hpux', 2: 'netbsd', 3: 'linux', 6: 'solaris', 9: 'freebsd', 12: 'openbsd' })[v] || `elf-osabi-${v}`;
}

function safeOffset(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
