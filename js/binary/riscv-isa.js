const MAX_ATTRIBUTE_BYTES = 1024 * 1024;

// Current public RISC-V attribute tags known to this parser (psABI §Attributes).
// Unknown tags with (tag % 128) < 64 are mandatory and must fail the parse;
// unknown tags with (tag % 128) >= 64 may be skipped by odd/even value shape.
const KNOWN_RISCV_ATTRIBUTE_TAGS = new Set([4, 5, 6, 8, 10, 12, 14, 16]);

function bytesOf(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input == null) return new Uint8Array();

  let iterator;
  try { iterator = input[Symbol.iterator]; } catch { return null; }
  if (typeof iterator !== 'function') return null;

  const values = [];
  try {
    for (const value of input) {
      if (values.length >= MAX_ATTRIBUTE_BYTES
        || typeof value !== 'number'
        || !Number.isInteger(value)
        || value < 0
        || value > 0xff) return null;
      values.push(value);
    }
  } catch { return null; }
  return Uint8Array.from(values);
}

function readU32(bytes, offset, littleEndian) {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(offset, littleEndian);
}

function readUleb(bytes, start, end) {
  let value = 0n, shift = 0n, offset = start;
  while (offset < end && offset - start < 10) {
    const byte = bytes[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      const number = Number(value);
      return Number.isSafeInteger(number) ? { value:number, next:offset } : null;
    }
    shift += 7n;
  }
  return null;
}

function readNtbs(bytes, start, end) {
  if (start < 0 || start >= end) return null;
  let stop = start;
  while (stop < end && bytes[stop] !== 0) stop += 1;
  if (stop >= end) return null;
  const text = new TextDecoder('utf-8', { fatal:false }).decode(bytes.subarray(start, stop));
  return { value:text, next:stop + 1 };
}

function strictAddress(value) {
  if (value == null) return 0n;
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = BigInt(value.trim());
    return parsed >= 0n ? parsed : null;
  } catch { return null; }
}

function strictIndex(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function strictRiscvProfile(value) {
  if (!value || typeof value !== 'object'
    || typeof value.canonical !== 'string'
    || value.canonical.trim() === ''
    || !Number.isSafeInteger(value.xlen)
    || (value.xlen !== 32 && value.xlen !== 64)
    || typeof value.compressedInstructions !== 'boolean'
    || !Number.isSafeInteger(value.instructionAlignment)
    || (value.instructionAlignment !== 2 && value.instructionAlignment !== 4)
    || (value.evidence != null && typeof value.evidence !== 'string')) return null;
  return {
    canonical:value.canonical,
    xlen:value.xlen,
    compressedInstructions:value.compressedInstructions,
    instructionAlignment:value.instructionAlignment,
  };
}

export function normalizeRiscvIsaString(input) {
  if (typeof input !== 'string') return null;
  const canonical = input.trim().toLowerCase();
  const match = /^rv(32|64)([a-z0-9]+(?:_[a-z0-9]+)*)$/.exec(canonical);
  if (!match) return null;
  const xlen = Number(match[1]);
  const suffix = match[2];
  const tokens = suffix.split('_').filter(Boolean);
  const firstToken = tokens[0] || '';
  // RISC-V ISA strings require an integer base. Preserve the standard G
  // abbreviation supported here, but never infer I from a multi-letter
  // Z*/S*/X* extension such as `rv64zicsr`.
  if (!/^[ieg]/.test(firstToken)) return null;
  // The first token may use the compact single-letter extension sequence,
  // including the standard G abbreviation (for example rv64gc/rv64gcv).
  // Stop before multi-letter Z*/S*/X* extensions so a 'c' inside zicsr etc.
  // cannot masquerade as the compressed C extension.
  const compactRun = /^([ieg](?:(?![zsx])[a-z])*)/.exec(firstToken)?.[1] || '';
  const compressedInstructions = compactRun.includes('c')
    || tokens.some((token) => /^c(?:\d|$)/.test(token) || /^zca(?:\d|$)/.test(token));
  return Object.freeze({
    canonical,
    xlen,
    compressedInstructions,
    instructionAlignment:compressedInstructions ? 2 : 4,
  });
}

export function parseRiscvAttributes(input, options = {}) {
  const bytes = bytesOf(input);
  if (!bytes || !bytes.length || bytes.length > MAX_ATTRIBUTE_BYTES || bytes[0] !== 0x41) return null;
  const littleEndian = options.littleEndian !== false;
  let cursor = 1;
  let found = null;
  while (cursor + 4 <= bytes.length) {
    const subsectionStart = cursor;
    const subsectionLength = readU32(bytes, cursor, littleEndian);
    if (subsectionLength == null || subsectionLength < 5 || subsectionStart + subsectionLength > bytes.length) return null;
    const subsectionEnd = subsectionStart + subsectionLength;
    const vendor = readNtbs(bytes, cursor + 4, subsectionEnd);
    if (!vendor) return null;
    cursor = vendor.next;
    if (vendor.value !== 'riscv') { cursor = subsectionEnd; continue; }

    while (cursor < subsectionEnd) {
      const subsubStart = cursor;
      const tag = readUleb(bytes, cursor, subsectionEnd);
      if (!tag || tag.next + 4 > subsectionEnd) return null;
      const subsubLength = readU32(bytes, tag.next, littleEndian);
      if (subsubLength == null || subsubLength < (tag.next - subsubStart) + 4 || subsubStart + subsubLength > subsectionEnd) return null;
      const subsubEnd = subsubStart + subsubLength;
      let attributeCursor = tag.next + 4;
      if (tag.value === 1) {
        while (attributeCursor < subsubEnd) {
          const attr = readUleb(bytes, attributeCursor, subsubEnd);
          if (!attr) return null;
          attributeCursor = attr.next;
          if (attr.value === 5) {
            const arch = readNtbs(bytes, attributeCursor, subsubEnd);
            if (!arch) return null;
            const normalized = normalizeRiscvIsaString(arch.value);
            if (normalized && !found) found = Object.freeze({ ...normalized, evidence:'elf-attribute' });
            attributeCursor = arch.next;
          } else if (!KNOWN_RISCV_ATTRIBUTE_TAGS.has(attr.value) && (attr.value % 128) < 64) {
            return null;
          } else if ((attr.value & 1) === 1) {
            const stringValue = readNtbs(bytes, attributeCursor, subsubEnd);
            if (!stringValue) return null;
            attributeCursor = stringValue.next;
          } else {
            const integerValue = readUleb(bytes, attributeCursor, subsubEnd);
            if (!integerValue) return null;
            attributeCursor = integerValue.next;
          }
        }
      }
      cursor = subsubEnd;
    }
    cursor = subsectionEnd;
  }
  // A valid section is fully consumed: 1-3 trailing bytes after the last
  // subsection are garbage, not evidence, and must fail the parse instead of
  // returning a prefix match.
  if (cursor !== bytes.length) return null;
  return found;
}

export function parseRiscvMappingSymbol(name) {
  if (typeof name !== 'string') return null;
  const text = name;
  const base = text.replace(/\.[^.]*$/, '');
  if (base === '$d') return Object.freeze({ kind:'data', isa:null });
  if (base === '$x') return Object.freeze({ kind:'instruction', isa:null });
  if (!base.startsWith('$xrv')) return null;
  const isa = normalizeRiscvIsaString(base.slice(2));
  return isa ? Object.freeze({ kind:'instruction', isa:Object.freeze({ ...isa, evidence:'mapping-symbol' }) }) : null;
}

export function resolveRiscvIsaProfile(metadata, address, options = {}) {
  const fallback = Object.freeze({
    canonical:'rv64imc-assumed', xlen:64, compressedInstructions:true, instructionAlignment:2,
    evidence:'assumed-rv64imc', exact:false, code:true,
  });
  if (!metadata || typeof metadata !== 'object') return options.allowAssumed === false ? null : fallback;
  let selected = null;
  const target = strictAddress(address);
  if (target === null) return options.allowAssumed === false ? null : fallback;
  const sections = Array.isArray(metadata.sections) ? metadata.sections : [];
  const containingSection = sections.find((section) => {
    const start = section?.start == null ? null : strictAddress(section.start);
    const end = section?.end == null ? null : strictAddress(section.end);
    return start !== null && end !== null && target >= start && target < end;
  }) || null;
  const mappings = Array.isArray(metadata.mappings) ? metadata.mappings : [];
  for (const mapping of mappings) {
    if (!mapping || typeof mapping !== 'object') continue;
    const mappingAddress = mapping.address == null ? null : strictAddress(mapping.address);
    if (mappingAddress === null) continue;
    if (mappingAddress > target) break;
    const mappingSectionIndex = mapping.sectionIndex == null ? null : strictIndex(mapping.sectionIndex);
    if (mapping.sectionIndex != null && mappingSectionIndex === null) continue;
    const containingSectionIndex = containingSection?.sectionIndex == null ? null : strictIndex(containingSection.sectionIndex);
    if (containingSection && mappingSectionIndex != null && mappingSectionIndex !== containingSectionIndex) continue;
    if (containingSection && mapping.sectionIndex == null) continue;
    if (!containingSection && Array.isArray(metadata.sections) && metadata.sections.length && mapping.sectionIndex != null) continue;
    selected = mapping;
  }
  if (selected?.kind === 'data') return Object.freeze({ code:false, exact:true, evidence:'mapping-symbol-data' });
  if (selected && selected.kind !== 'instruction') return options.allowAssumed === false ? null : fallback;
  const base = selected?.isa || metadata.file || null;
  if (!base) return options.allowAssumed === false ? null : fallback;
  const normalized = strictRiscvProfile(base);
  if (!normalized) return options.allowAssumed === false ? null : fallback;
  const evidence = selected?.isa ? 'mapping-symbol' : (base.evidence ?? metadata.evidence ?? 'elf-attribute');
  if (typeof evidence !== 'string' || evidence.trim() === '') return options.allowAssumed === false ? null : fallback;
  return Object.freeze({
    ...normalized,
    evidence,
    exact:true,
    code:true,
  });
}
