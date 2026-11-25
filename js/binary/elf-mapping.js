import { sectionHasMappedAddress } from './model.js';

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const EMPTY_ARRAY = Object.freeze([]);
const EMPTY_MAP = new Map();
const EMPTY_MAPPING_CACHE = Object.freeze({
  sectionsRef: null,
  sectionsLen: 0,
  segmentsRef: null,
  segmentsLen: 0,
  execBuilt: true,
  execSections: EMPTY_ARRAY,
  execSegments: EMPTY_ARRAY,
  sectionByIndex: EMPTY_MAP,
  fileSegmentsBuilt: true,
  fileSegments: EMPTY_ARRAY,
});

const elfImageMappingCache = new WeakMap();

export function safeELFNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'bigint' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function strictELFInteger(value, label) {
  if (typeof value === 'bigint') return value;
  if (Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && value.trim() !== '') {
    try { return BigInt(value); }
    catch {}
  }
  throw new TypeError(`${label} must be a bigint, safe integer, or non-empty integer string`);
}

function getELFMappingCache(image) {
  if (!image || typeof image !== 'object') return EMPTY_MAPPING_CACHE;
  const sectionsRef = image.sections || null;
  const sectionsLen = Array.isArray(sectionsRef) ? sectionsRef.length : 0;
  const segmentsRef = image.segments || null;
  const segmentsLen = Array.isArray(segmentsRef) ? segmentsRef.length : 0;
  let cache = elfImageMappingCache.get(image);
  if (
    cache
    && cache.sectionsRef === sectionsRef
    && cache.sectionsLen === sectionsLen
    && cache.segmentsRef === segmentsRef
    && cache.segmentsLen === segmentsLen
  ) {
    return cache;
  }
  cache = {
    sectionsRef,
    sectionsLen,
    segmentsRef,
    segmentsLen,
    execBuilt: false,
    execSections: null,
    execSegments: null,
    sectionByIndex: null,
    fileSegmentsBuilt: false,
    fileSegments: null,
  };
  elfImageMappingCache.set(image, cache);
  return cache;
}

function ensureExecMappingCache(cache) {
  if (cache.execBuilt) return cache;
  const sections = cache.sectionsRef;
  const segments = cache.segmentsRef;
  const execSections = [];
  const sectionByIndex = new Map();
  if (Array.isArray(sections)) {
    for (let i = 0; i < sections.length; i += 1) {
      const section = sections[i];
      if (!section) continue;
      const isExecMapped = Boolean(section.perms?.execute) && sectionHasMappedAddress(section);
      let entry = null;
      if (isExecMapped) {
        const lo = BigInt(section.address ?? 0);
        const hi = lo + BigInt(section.size ?? 0);
        const fileSize = BigInt(
          Object.prototype.hasOwnProperty.call(section, 'fileSize')
            ? (section.fileSize ?? 0)
            : (section.size ?? 0),
        );
        entry = {
          section,
          lo,
          hi,
          read: Boolean(section.perms?.read),
          fileSize,
        };
        execSections.push(entry);
      }
      if (section.index !== undefined && !sectionByIndex.has(section.index)) {
        sectionByIndex.set(section.index, entry);
      }
    }
  }
  const execSegments = [];
  if (Array.isArray(segments)) {
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (!segment?.perms?.execute) continue;
      const lo = BigInt(segment.address ?? 0);
      const hi = lo + BigInt(segment.size ?? 0);
      execSegments.push({ segment, lo, hi });
    }
  }
  cache.execSections = execSections;
  cache.execSegments = execSegments;
  cache.sectionByIndex = sectionByIndex;
  cache.execBuilt = true;
  return cache;
}

function ensureFileSegmentsCache(cache) {
  if (cache.fileSegmentsBuilt) return cache;
  const segments = cache.segmentsRef;
  const fileSegments = [];
  if (Array.isArray(segments)) {
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      const start = BigInt(segment.address ?? 0);
      const fileSize = BigInt(
        Object.prototype.hasOwnProperty.call(segment, 'fileSize')
          ? (segment.fileSize ?? 0)
          : (segment.size ?? 0),
      );
      if (fileSize <= 0n) continue;
      const fileOffset = BigInt(segment.fileOffset ?? 0);
      fileSegments.push({
        segment,
        start,
        vaEnd: start + fileSize,
        fileOffset,
        fileEnd: fileOffset + fileSize,
      });
    }
  }
  cache.fileSegments = fileSegments;
  cache.fileSegmentsBuilt = true;
  return cache;
}

function rangeContains(lo, hi, start, extent) {
  if (start < lo || start >= hi) return false;
  return extent === 0n || extent <= hi - start;
}

function hasExecutableSegmentCovering(execSegments, start, extent) {
  for (let i = 0; i < execSegments.length; i += 1) {
    const entry = execSegments[i];
    if (rangeContains(entry.lo, entry.hi, start, extent)) return true;
  }
  return false;
}

function findExecutableSegmentCovering(execSegments, start, extent) {
  for (let i = 0; i < execSegments.length; i += 1) {
    const entry = execSegments[i];
    if (rangeContains(entry.lo, entry.hi, start, extent)) return entry.segment;
  }
  return null;
}

function isExecutableSectionEntryValid(entry, relocatable, execSegments, start, extent) {
  if (!entry || !rangeContains(entry.lo, entry.hi, start, extent)) return false;
  if (relocatable) return true;
  if (!entry.read) return false;
  return hasExecutableSegmentCovering(execSegments, start, extent);
}

/** Return the file-backed suffix of the PT_LOAD that owns `va`. */
export function mappedELFFileRangeForVa(image, va) {
  const address = typeof va === 'bigint' ? va : strictELFInteger(va, 'va');
  const fileSegments = ensureFileSegmentsCache(getELFMappingCache(image)).fileSegments;
  for (let i = 0; i < fileSegments.length; i += 1) {
    const entry = fileSegments[i];
    if (address < entry.start || address >= entry.vaEnd) continue;
    const fileStart = entry.fileOffset + (address - entry.start);
    const fileEnd = entry.fileEnd;
    if (fileStart > MAX_SAFE_INTEGER_BIGINT || fileEnd > MAX_SAFE_INTEGER_BIGINT) return null;
    return { start: Number(fileStart), end: Number(fileEnd), segment: entry.segment, address };
  }
  return null;
}

/**
 * Decide whether a runtime SHF_ALLOC section can safely participate in virtual
 * mapping authority. PT_LOAD is the runtime byte authority (#7611). A
 * file-backed section therefore has to be covered for its entire VA span by
 * PT_LOAD file bytes, and every PT_LOAD intersecting that span must reproduce
 * the section's VA→file relation. SHT_NOBITS has no file bytes and is accepted
 * only when its entire span belongs to one unambiguous PT_LOAD zero-fill tail.
 */
// #8665 — every runtime SHF_ALLOC section re-proved its file/span authority by
// scanning the entire PT_LOAD set, so S alloc sections over N loads cost
// Θ(S·N) before the ELF metadata wall-clock/operation budget was even created.
// The loads are fixed for the duration of the section pass, so cache a
// start-sorted index (with a monotone running max-end used as a safe lower
// bound on overlap) once per array and enumerate only the loads that can
// actually intersect a queried VA span. Exact overlap semantics and the #7611
// every-intersecting-owner rule are preserved: the window bounds are
// conservative, and each candidate still runs the original per-segment test.
const elfLoadSpanIndexCache = new WeakMap();

function elfLoadSpanFields(segment) {
  const start = BigInt(segment.address ?? 0);
  const size = BigInt(segment.size ?? 0);
  const fileSize = BigInt(segment.fileSize ?? 0);
  const fileOffset = BigInt(segment.fileOffset ?? 0);
  return { segment, start, size, fileSize, fileOffset, end: start + size };
}

function elfLoadSpanBase(state, start) {
  // First index whose max-end exceeds `start`; every earlier load provably ends
  // at or below `start`, so it cannot intersect [start, end).
  let lo = 0;
  let hi = state.sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (state.maxEnd[mid] > start) hi = mid; else lo = mid + 1;
  }
  return lo;
}

function elfLoadSpanBound(state, end) {
  // Last index whose start is below `end`; every later load starts at or above
  // `end`, so it cannot intersect [start, end).
  let lo = 0;
  let hi = state.sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (state.sorted[mid].start < end) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function elfLoadSpanState(loads) {
  let state = elfLoadSpanIndexCache.get(loads);
  if (state && state.built === loads.length) return state;
  const fields = loads.map(elfLoadSpanFields);
  const sorted = fields.slice().sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
  const maxEnd = [];
  let run = null;
  for (const entry of sorted) {
    run = run === null || entry.end > run ? entry.end : run;
    maxEnd.push(run);
  }
  let malformed = false;
  let malformedOffset = false;
  for (const f of fields) {
    if (f.size <= 0n || f.fileSize < 0n || f.fileSize > f.size) { malformed = true; malformedOffset = true; }
    else if (f.fileOffset < 0n) malformedOffset = true;
  }
  state = { sorted, maxEnd, malformed, malformedOffset, built: loads.length };
  elfLoadSpanIndexCache.set(loads, state);
  return state;
}

export function elfSectionFileSpanConsistentWithLoads(image, address, size, fileOffset, noBits = false) {
  const start = strictELFInteger(address, 'address');
  const length = strictELFInteger(size ?? 0n, 'size');
  const off = strictELFInteger(fileOffset ?? 0n, 'fileOffset');
  if (length < 0n || off < 0n) return false;
  if (length === 0n) return true;
  const end = start + length;
  const loads = image?.segments || [];
  // Preserve the original "any malformed segment fails closed" behaviour, which
  // scans the whole set, without revisiting it per overlapping candidate.
  const state = elfLoadSpanState(loads);
  if (noBits ? state.malformed : state.malformedOffset) return false;
  const from = elfLoadSpanBase(state, start);
  const to = elfLoadSpanBound(state, end);

  if (noBits) {
    let owner = null;
    for (let i = from; i < to; i++) {
      const { segment, start: segStart, size: segSize, fileSize: segFileSize } = state.sorted[i];
      const segEnd = segStart + segSize;
      const overlapStart = start > segStart ? start : segStart;
      const overlapEnd = end < segEnd ? end : segEnd;
      if (overlapStart >= overlapEnd) continue;

      // Any intersecting PT_LOAD must see these bytes as zero-fill. Partial
      // owners are rejected too: NOBITS authority is intentionally bound to a
      // single complete PT_LOAD tail rather than stitched across loaders.
      const zeroStart = segStart + segFileSize;
      if (overlapStart < zeroStart || start < segStart || end > segEnd) return false;
      if (owner != null) return false;
      owner = segment;
    }
    return owner != null;
  }

  const coverage = [];
  for (let i = from; i < to; i++) {
    const { segment, start: segStart, size: segSize, fileSize: segFileSize, fileOffset: segOffset } = state.sorted[i];
    const segEnd = segStart + segSize;
    const overlapStart = start > segStart ? start : segStart;
    const overlapEnd = end < segEnd ? end : segEnd;
    if (overlapStart >= overlapEnd) continue;

    // A file-backed section must never provide bytes where an intersecting
    // loader segment provides zero-fill. This also closes file→zero straddles.
    const fileEnd = segStart + segFileSize;
    if (overlapEnd > fileEnd) return false;

    const expectedOffset = off + (overlapStart - start);
    const actualOffset = segOffset + (overlapStart - segStart);
    if (actualOffset !== expectedOffset) return false;
    coverage.push({ begin: overlapStart, end: overlapEnd });
    void segment;
  }

  // Validate provenance above against every overlapping PT_LOAD first; only
  // then prove that their union covers the whole section. This makes the
  // decision independent of segment order and rejects a later conflicting
  // owner even when an earlier one already covers the complete span.
  coverage.sort((a, b) => a.begin < b.begin ? -1 : a.begin > b.begin ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0);
  let cursor = start;
  for (const region of coverage) {
    if (region.end <= cursor) continue;
    if (region.begin > cursor) return false;
    if (region.end > cursor) cursor = region.end;
  }
  return cursor >= end;
}

/**
 * Return the bounded analysis window authorized by an ELF loader-entry contract.
 *
 * DT_INIT/DT_FINI prove that the loader invokes `address`; they do not prove the
 * precise function extent.  When that entry is exactly the start of one
 * canonical, allocated executable section whose complete bytes are file-backed,
 * the section end is safe as a decode/analysis ceiling.  This is deliberately
 * not an extent API: callers must keep the function end unknown.
 */
export function elfLoaderEntrySectionAnalysisWindow(image, address) {
  if (image?.arch !== 'arm64') return null;
  if (image?.metadata?.type === 1) return null; // ET_REL has no runtime loader contract.
  let start;
  try { start = strictELFInteger(address, 'address'); } catch { return null; }
  const candidates = (image?.sections || []).filter((section) => {
    if (!section || section.source !== 'section-header') return false;
    if (section.address !== start) return false;
    if (section.perms?.execute !== true || section.perms?.read !== true) return false;
    if (!sectionHasMappedAddress(section)) return false;
    let size, fileSize, fileOffset;
    try {
      size = BigInt(section.size);
      fileSize = BigInt(section.fileSize);
      fileOffset = BigInt(section.fileOffset);
    } catch { return false; }
    if (size <= 0n || fileSize < size || fileOffset < 0n) return false;
    // Prove the section header's own VA -> file relation against every
    // overlapping PT_LOAD, not merely that the VA bytes are file-backed by
    // some load. A conflicting section offset or overlapping owner therefore
    // fails closed instead of authorizing a decode window over unrelated bytes.
    return elfSectionFileSpanConsistentWithLoads(image, start, size, fileOffset, false);
  });
  // Ambiguous section ownership is not sufficient authority for a loader window.
  if (candidates.length !== 1) return null;
  const section = candidates[0];
  const size = BigInt(section.size);
  const end = start + size;
  if (end <= start) return null;
  return Object.freeze({
    kind:'elf-loader-entry-section',
    start, end,
    sectionIndex:Number.isInteger(section.index) ? section.index : null,
    provenance:'ELF loader entry at canonical executable file-backed section start',
  });
}

function hasMappedELFFileSpanForVa(image, address, n) {
  const fileSegments = ensureFileSegmentsCache(getELFMappingCache(image)).fileSegments;
  for (let i = 0; i < fileSegments.length; i += 1) {
    const entry = fileSegments[i];
    if (address < entry.start || address >= entry.vaEnd) continue;
    const fileStart = entry.fileOffset + (address - entry.start);
    const fileEnd = entry.fileEnd;
    if (fileStart > MAX_SAFE_INTEGER_BIGINT || fileEnd > MAX_SAFE_INTEGER_BIGINT) return false;
    return Number(n) <= Number(fileEnd) - Number(fileStart);
  }
  return false;
}

/** Require the entire VA span to remain in one file-backed PT_LOAD mapping. */
export function mappedELFFileSpanForVa(image, va, size) {
  const n = typeof size === 'bigint' ? size : strictELFInteger(size, 'size');
  if (n < 0n || n > MAX_SAFE_INTEGER_BIGINT) return null;
  const address = typeof va === 'bigint' ? va : strictELFInteger(va, 'va');
  const fileSegments = ensureFileSegmentsCache(getELFMappingCache(image)).fileSegments;
  for (let i = 0; i < fileSegments.length; i += 1) {
    const entry = fileSegments[i];
    if (address < entry.start || address >= entry.vaEnd) continue;
    const fileStart = entry.fileOffset + (address - entry.start);
    const fileEnd = entry.fileEnd;
    if (fileStart > MAX_SAFE_INTEGER_BIGINT || fileEnd > MAX_SAFE_INTEGER_BIGINT) return null;
    const startNum = Number(fileStart);
    const endNum = Number(fileEnd);
    const bytes = Number(n);
    if (bytes > endNum - startNum) return null;
    return {
      start: startNum,
      end: endNum,
      segment: entry.segment,
      address,
      spanEnd: startNum + bytes,
      size: bytes,
    };
  }
  return null;
}

/** Architecture-specific alignment gate for exact ELF instruction starts. */
export function elfInstructionStartAlignmentRejection(image, address) {
  if (image?.arch === 'arm64' && address % 4n !== 0n) return 'does not satisfy arm64 4-byte alignment';
  const isRiscv = image?.arch === 'riscv64' || image?.arch === 'riscv32' || image?.arch === 'riscv' || Number(image?.metadata?.machine) === 243;
  if (isRiscv) {
    if (address % 2n !== 0n) return 'does not satisfy riscv minimum 2-byte alignment';
    const align = image?.metadata?.riscvIsa?.file?.instructionAlignment ?? image?.metadata?.riscvFileIsa?.instructionAlignment;
    if (align === 4 && address % 4n !== 0n) return 'does not satisfy riscv 4-byte instruction alignment';
  }
  const isArm32 = image?.arch === 'arm' || Number(image?.metadata?.machine) === 40;
  if (isArm32) {
    if (address % 2n !== 0n) return 'does not satisfy arm 2-byte instruction alignment';
  }
  return null;
}

/**
 * Validate a function extent inside one canonical executable mapping.
 * Sections are preferred when present because they provide the strongest ELF
 * provenance; sectionless images fall back to executable PT_LOAD segments.
 *
 * For runtime image types (ET_EXEC/ET_DYN) an executable section must also be
 * allocated (the section model exposes SHF_ALLOC as `perms.read`) and the full
 * address extent must live inside an executable PT_LOAD. ET_REL retains its
 * section-relative synthetic contract and does not require a program header.
 * A section that already lost canonical virtual mapping authority (an
 * 'unmapped-section', e.g. one whose sh_offset/sh_size crosses EOF) cannot
 * authorize an executable extent either, or its phantom tail would seed bytes
 * that do not exist in the file (#4223).
 */
export function executableELFRange(image, address, size = 0n, sectionIndex = null) {
  const start = typeof address === 'bigint' ? address : strictELFInteger(address, 'address');
  const extent = typeof size === 'bigint' ? size : strictELFInteger(size ?? 0n, 'size');
  if (extent < 0n) return null;
  const relocatable = image?.metadata?.type === 1;
  const cache = ensureExecMappingCache(getELFMappingCache(image));
  const execSegments = cache.execSegments;
  if (Number.isInteger(sectionIndex)) {
    const entry = cache.sectionByIndex.get(sectionIndex) ?? null;
    return isExecutableSectionEntryValid(entry, relocatable, execSegments, start, extent)
      ? entry.section
      : null;
  }
  const execSections = cache.execSections;
  for (let i = 0; i < execSections.length; i += 1) {
    const entry = execSections[i];
    if (isExecutableSectionEntryValid(entry, relocatable, execSegments, start, extent)) {
      return entry.section;
    }
  }
  return findExecutableSegmentCovering(execSegments, start, extent);
}

function minimumElfInstructionBytes(image) {
  if (image?.arch === 'arm64') return 4n;
  if (image?.arch === 'riscv64' || image?.arch === 'riscv32' || Number(image?.metadata?.machine) === 243) {
    const align = image?.metadata?.riscvIsa?.file?.instructionAlignment ?? image?.metadata?.riscvFileIsa?.instructionAlignment;
    return align === 4 ? 4n : 2n;
  }
  if (image?.arch === 'arm' || Number(image?.metadata?.machine) === 40) return 2n;
  return 1n;
}

export function elfInstructionTargetRejection(image, address) {
  const instructionBytes = minimumElfInstructionBytes(image);
  if (typeof image?.isDataInCode === 'function' && image.isDataInCode(address)) return 'inside an authoritative data-in-code interval';
  if (!executableELFRange(image, address, 0n)) return 'outside a canonical executable mapping';
  const alignmentRejection = elfInstructionStartAlignmentRejection(image, address);
  if (alignmentRejection) return alignmentRejection;
  if (!executableELFRange(image, address, instructionBytes)) return 'instruction bytes cross the canonical executable extent';
  const start = typeof address === 'bigint' ? address : strictELFInteger(address, 'address');
  if (!hasMappedELFFileSpanForVa(image, start, instructionBytes)) return 'instruction bytes are not fully file-backed';
  return null;
}

/**
 * One shared exact-function-start policy for every ELF code-authority producer
 * (#8803). It adds the two dimensions symbol/dynsym/unwind promotion was missing:
 * the complete minimum instruction span must stay inside the executable extent,
 * and those bytes must come from the file rather than loader zero-fill.
 *
 * The entrypoint/`DT_INIT` policy above stays byte-authoritative on `PT_LOAD`
 * (#7611) because that is a runtime-mapping concern. Promotion producers have
 * already proved their own executable owner, and an `ET_REL` image — or an image
 * whose code is owned only by a validated executable section — has no RX
 * `PT_LOAD` to prove against, so this policy accepts a mapping-authoritative
 * executable section span as the equivalent proof and still rejects a
 * `SHT_NOBITS` body, whose canonical `fileSize` is 0.
 */
export function elfExactFunctionStartRejection(image, address, options = {}) {
  const sectionIndex = options.sectionIndex ?? null;
  const instructionBytes = minimumElfInstructionBytes(image);
  if (!elfExecutableFunctionExtent(image, address, 0n, sectionIndex)) return 'outside a canonical executable mapping';
  const alignmentRejection = elfInstructionStartAlignmentRejection(image, address);
  if (alignmentRejection) return alignmentRejection;
  if (!elfExecutableFunctionExtent(image, address, instructionBytes, sectionIndex)) return 'instruction bytes cross the canonical executable extent';
  if (!elfFunctionBytesFileBacked(image, address, instructionBytes)) return 'instruction bytes are not fully file-backed';
  return null;
}

function elfExecutableFunctionExtent(image, address, bytes, sectionIndex) {
  const canonical = executableELFRange(image, address, bytes, sectionIndex);
  if (canonical) return canonical;
  const start = typeof address === 'bigint' ? address : strictELFInteger(address, 'address');
  const extent = typeof bytes === 'bigint' ? bytes : strictELFInteger(bytes ?? 0n, 'bytes');
  if (extent < 0n) return null;
  const execSections = ensureExecMappingCache(getELFMappingCache(image)).execSections;
  for (let i = 0; i < execSections.length; i += 1) {
    const entry = execSections[i];
    if (start < entry.lo || start >= entry.hi) continue;
    if (extent !== 0n && start + extent > entry.hi) continue;
    return entry.section;
  }
  return null;
}

/** Prove that `bytes` at `address` are input bytes, not synthesized zero-fill. */
export function elfFunctionBytesFileBacked(image, address, bytes) {
  const n = typeof bytes === 'bigint' ? bytes : strictELFInteger(bytes, 'size');
  let start;
  if (n >= 0n && n <= MAX_SAFE_INTEGER_BIGINT) {
    start = typeof address === 'bigint' ? address : strictELFInteger(address, 'va');
    if (hasMappedELFFileSpanForVa(image, start, n)) return true;
    if (n <= 0n) return true;
  } else {
    if (n <= 0n) return true;
    start = typeof address === 'bigint' ? address : strictELFInteger(address, 'address');
  }
  const execSections = ensureExecMappingCache(getELFMappingCache(image)).execSections;
  for (let i = 0; i < execSections.length; i += 1) {
    const entry = execSections[i];
    if (entry.fileSize <= 0n) continue;
    const delta = start - entry.lo;
    if (delta < 0n || delta + n > entry.fileSize) continue;
    return true;
  }
  return false;
}

/**
 * Extent authority is separate from instruction-start authority: a published
 * `st_size` that crosses into loader zero-fill must not be described as a
 * validated function body, even when its first instruction is file-backed.
 */
export function elfFunctionExtentRejection(image, address, size) {
  const length = typeof size === 'bigint' ? size : strictELFInteger(size ?? 0n, 'size');
  if (length <= 0n) return null;
  if (elfFunctionBytesFileBacked(image, address, length)) return null;
  return 'published function extent is not fully file-backed';
}
