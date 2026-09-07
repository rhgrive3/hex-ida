const MAX_ATTRIBUTE_BYTES = 1024 * 1024;

function bytesOf(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return Uint8Array.from(input || []);
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

export function normalizeRiscvIsaString(input) {
  const canonical = String(input ?? '').trim().toLowerCase();
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
  if (!bytes.length || bytes.length > MAX_ATTRIBUTE_BYTES || bytes[0] !== 0x41) return null;
  const littleEndian = options.littleEndian !== false;
  let cursor = 1;
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
            if (normalized) return Object.freeze({ ...normalized, evidence:'elf-attribute' });
            attributeCursor = arch.next;
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
  return null;
}

export function parseRiscvMappingSymbol(name) {
  const text = String(name ?? '');
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
  const containingSection = (metadata.sections || []).find((section) => {
    try { return target >= BigInt(section.start) && target < BigInt(section.end); }
    catch { return false; }
  }) || null;
  for (const mapping of metadata.mappings || []) {
    let mappingAddress;
    try { mappingAddress = BigInt(mapping.address); } catch { continue; }
    if (mappingAddress > target) break;
    if (containingSection && mapping.sectionIndex != null && Number(mapping.sectionIndex) !== Number(containingSection.sectionIndex)) continue;
    if (containingSection && mapping.sectionIndex == null) continue;
    if (!containingSection && Array.isArray(metadata.sections) && metadata.sections.length && mapping.sectionIndex != null) continue;
    selected = mapping;
  }
  if (selected?.kind === 'data') return Object.freeze({ code:false, exact:true, evidence:'mapping-symbol-data' });
  const base = selected?.isa || metadata.file || null;
  if (!base) return options.allowAssumed === false ? null : fallback;
  return Object.freeze({
    canonical:String(base.canonical),
    xlen:Number(base.xlen),
    compressedInstructions:base.compressedInstructions === true,
    instructionAlignment:Number(base.instructionAlignment),
    evidence:selected?.isa ? 'mapping-symbol' : String(base.evidence || metadata.evidence || 'elf-attribute'),
    exact:true,
    code:true,
  });
}
