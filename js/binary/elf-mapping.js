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
