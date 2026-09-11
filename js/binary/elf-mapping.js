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
    const fileSize = BigInt(segment.fileSize ?? 0);
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
export function elfSectionFileSpanConsistentWithLoads(image, address, size, fileOffset, noBits = false) {
  const start = strictELFInteger(address, 'address');
  const length = strictELFInteger(size ?? 0n, 'size');
  const off = strictELFInteger(fileOffset ?? 0n, 'fileOffset');
  if (length < 0n || off < 0n) return false;
  if (length === 0n) return true;
  const end = start + length;
  const loads = image?.segments || [];

  if (noBits) {
    let owner = null;
    for (const segment of loads) {
      const segStart = BigInt(segment.address ?? 0);
      const segSize = BigInt(segment.size ?? 0);
      const segFileSize = BigInt(segment.fileSize ?? 0);
      if (segSize <= 0n || segFileSize < 0n || segFileSize > segSize) return false;
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
  for (const segment of loads) {
    const segStart = BigInt(segment.address ?? 0);
    const segSize = BigInt(segment.size ?? 0);
    const segFileSize = BigInt(segment.fileSize ?? 0);
    const segOffset = BigInt(segment.fileOffset ?? 0);
    if (segSize <= 0n || segFileSize < 0n || segFileSize > segSize || segOffset < 0n) return false;
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
