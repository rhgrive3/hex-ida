import { sectionHasMappedAddress } from './model.js';

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

/** Return the file-backed suffix of the PT_LOAD that owns `va`. */
export function mappedELFFileRangeForVa(image, va) {
  const address = strictELFInteger(va, 'va');
  for (const segment of image?.segments || []) {
    const start = BigInt(segment.address ?? 0);
    const fileSize = BigInt(Object.prototype.hasOwnProperty.call(segment, "fileSize") ? (segment.fileSize ?? 0) : (segment.size ?? 0));
    if (fileSize <= 0n || address < start || address >= start + fileSize) continue;
    const delta = address - start;
    const fileStart = BigInt(segment.fileOffset ?? 0) + delta;
    const fileEnd = BigInt(segment.fileOffset ?? 0) + fileSize;
    if (fileStart > BigInt(Number.MAX_SAFE_INTEGER) || fileEnd > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return { start:Number(fileStart), end:Number(fileEnd), segment, address };
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

/** Require the entire VA span to remain in one file-backed PT_LOAD mapping. */
export function mappedELFFileSpanForVa(image, va, size) {
  const n = strictELFInteger(size, 'size');
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const range = mappedELFFileRangeForVa(image, va);
  if (!range) return null;
  const bytes = Number(n);
  if (bytes > range.end - range.start) return null;
  return { ...range, spanEnd:range.start + bytes, size:bytes };
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
  const start = strictELFInteger(address, 'address');
  const extent = strictELFInteger(size ?? 0n, 'size');
  if (extent < 0n) return null;
  const relocatable = image?.metadata?.type === 1;
  const contains = (owner) => {
    const lo = BigInt(owner?.address ?? 0), hi = lo + BigInt(owner?.size ?? 0);
    if (start < lo || start >= hi) return false;
    return extent === 0n || extent <= hi - start;
  };
  const executableSegment = (segment) => !!segment?.perms?.execute && contains(segment);
  const executableSection = (section) => {
    if (!section?.perms?.execute || !contains(section)) return false;
    if (!sectionHasMappedAddress(section)) return false;
    if (relocatable) return true;
    if (!section?.perms?.read) return false;
    return (image.segments || []).some(executableSegment);
  };
  if (Number.isInteger(sectionIndex)) {
    const section = (image.sections || []).find((candidate) => candidate.index === sectionIndex) || null;
    return executableSection(section) ? section : null;
  }
  const section = (image.sections || []).find(executableSection) || null;
  if (section) return section;
  return (image.segments || []).find(executableSegment) || null;
}

export function elfInstructionTargetRejection(image, address) {
  const instructionBytes = image?.arch === 'arm64' ? 4n : 1n;
  if (!executableELFRange(image, address, 0n)) return 'outside a canonical executable mapping';
  const alignmentRejection = elfInstructionStartAlignmentRejection(image, address);
  if (alignmentRejection) return alignmentRejection;
  if (!executableELFRange(image, address, instructionBytes)) return 'instruction bytes cross the canonical executable extent';
  if (!mappedELFFileSpanForVa(image, address, instructionBytes)) return 'instruction bytes are not fully file-backed';
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
  const instructionBytes = image?.arch === 'arm64' ? 4n : 1n;
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
  const start = strictELFInteger(address, 'address');
  const extent = strictELFInteger(bytes ?? 0n, 'bytes');
  if (extent < 0n) return null;
  for (const section of image?.sections || []) {
    if (!section?.perms?.execute || !sectionHasMappedAddress(section)) continue;
    const lo = BigInt(section.address ?? 0n);
    const hi = lo + BigInt(section.size ?? 0n);
    if (start < lo || start >= hi) continue;
    if (extent !== 0n && start + extent > hi) continue;
    return section;
  }
  return null;
}

/** Prove that `bytes` at `address` are input bytes, not synthesized zero-fill. */
export function elfFunctionBytesFileBacked(image, address, bytes) {
  if (mappedELFFileSpanForVa(image, address, bytes)) return true;
  const length = strictELFInteger(bytes ?? 0n, 'bytes');
  if (length <= 0n) return true;
  const start = strictELFInteger(address, 'address');
  for (const section of image?.sections || []) {
    if (!section?.perms?.execute || !sectionHasMappedAddress(section)) continue;
    const fileSize = BigInt(Object.prototype.hasOwnProperty.call(section, "fileSize") ? (section.fileSize ?? 0n) : (section.size ?? 0n));
    if (fileSize <= 0n) continue;
    const delta = start - BigInt(section.address ?? 0n);
    if (delta < 0n || delta + length > fileSize) continue;
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
  const length = strictELFInteger(size ?? 0n, 'size');
  if (length <= 0n) return null;
  if (elfFunctionBytesFileBacked(image, address, length)) return null;
  return 'published function extent is not fully file-backed';
}
