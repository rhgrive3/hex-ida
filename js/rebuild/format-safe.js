import { stableDigest } from '../core/identity/index.js';
import { createRebuildTransaction } from './transaction-v2.js';

/**
 * Small, deliberately conservative format-aware rebuild adapter.
 *
 * The transaction engine is intentionally format agnostic.  This adapter is
 * the production contract for conservative format-aware mutations that F6 can
 * prove without relocating code or re-encoding loader state:
 *   - ELF64 .comment contents (a non-allocatable section), and
 *   - appending one non-loaded ELF64 SHT_NOBITS section when the existing
 *     section-name table has exact in-place room for the new name,
 *   - the PE COFF timestamp (a fixed-width file-header field).
 *   - a Mach-O 64 LC_VERSION_MIN_MACOSX version field.
 *
 * It does not claim support for section growth, instruction rewriting,
 * relocation updates, or signatures. Unsupported images fail closed.
 */

export const FORMAT_SAFE_REBUILD_SCHEMA = 'hex-format-safe-rebuild/v1';

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];
const PE_MAGIC = [0x4d, 0x5a];
const PE_SIGNATURE = [0x50, 0x45, 0x00, 0x00];
const MACHO64_MAGIC = 0xfeedfacf;
const MACHO_X86_64_CPU = 0x01000007;
const MACHO_ARM64_CPU = 0x0100000c;
const MACHO64_HEADER_SIZE = 32;
const LC_VERSION_MIN_MACOSX = 0x24;
const ELF_X86_64_MACHINE = 0x3e;
const PE_I386_MACHINE = 0x14c;
const PE_AMD64_MACHINE = 0x8664;
const ELF64_HEADER_SIZE = 64;
const ELF64_SECTION_HEADER_SIZE = 64;
const ELF_SHT_NOBITS = 8;
const PE_SECTION_HEADER_SIZE = 40;
const MAX_FORMAT_IMAGE_BYTES = 128 * 1024 * 1024;

function fail(code) {
  throw new TypeError(code);
}

function bytesOf(value, code = 'format-safe-bytes-required') {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 0xff)) return Uint8Array.from(value);
  fail(code);
}

function digestBytes(value) {
  return `bytes:${stableDigest(Array.from(bytesOf(value)))}`;
}

function sameBytes(left, right) {
  const a = bytesOf(left);
  const b = bytesOf(right);
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

function hasPrefix(value, prefix, offset = 0) {
  const source = bytesOf(value);
  return prefix.every((byte, index) => source[offset + index] === byte);
}

function ensureRange(bytes, offset, length, code = 'format-safe-range-invalid') {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > bytes.length - length) fail(code);
}

function dataView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u16(bytes, offset) {
  ensureRange(bytes, offset, 2);
  return dataView(bytes).getUint16(offset, true);
}

function u32(bytes, offset) {
  ensureRange(bytes, offset, 4);
  return dataView(bytes).getUint32(offset, true);
}

function u64(bytes, offset) {
  ensureRange(bytes, offset, 8);
  return dataView(bytes).getBigUint64(offset, true);
}

function boundedNumber(value, code = 'format-safe-offset-invalid') {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail(code);
  return Number(value);
}

function text(bytes) {
  let result = '';
  for (const byte of bytes) {
    if (byte === 0) break;
    result += String.fromCharCode(byte);
  }
  return result;
}

function bytesDigestMasked(bytes, offset, length) {
  const masked = bytesOf(bytes);
  ensureRange(masked, offset, length);
  masked.fill(0, offset, offset + length);
  return stableDigest(Array.from(masked));
}

function elfSections(bytes, header) {
  const sections = [];
  for (let index = 0; index < header.sectionCount; index++) {
    const offset = header.sectionTableOffset + index * ELF64_SECTION_HEADER_SIZE;
    const nameOffset = u32(bytes, offset);
    const type = u32(bytes, offset + 4);
    const flags = u64(bytes, offset + 8);
    const address = u64(bytes, offset + 16);
    const fileOffset = boundedNumber(u64(bytes, offset + 24));
    const size = boundedNumber(u64(bytes, offset + 32));
    const link = u32(bytes, offset + 40);
    const info = u32(bytes, offset + 44);
    const alignment = u64(bytes, offset + 48);
    const entrySize = u64(bytes, offset + 56);
    if (type === 8) {
      // SHT_NOBITS sections (normally .bss) have a memory size but occupy no
      // bytes in the file.  Only the notional file offset is bounded.
      if (fileOffset > bytes.length) fail('format-safe-elf-nobits-file-range-invalid');
    } else ensureRange(bytes, fileOffset, size, 'format-safe-elf-section-range-invalid');
    sections.push({
      index,
      nameOffset,
      name: null,
      type,
      flags: flags.toString(),
      address: address.toString(),
      offset: fileOffset,
      size,
      link,
      info,
      alignment: alignment.toString(),
      entrySize: entrySize.toString(),
      data: type === 8 ? new Uint8Array() : bytes.slice(fileOffset, fileOffset + size),
    });
  }
  if (header.sectionNameIndex >= sections.length) fail('format-safe-elf-section-name-table-invalid');
  const names = sections[header.sectionNameIndex];
  if (names.type !== 3) fail('format-safe-elf-section-name-table-type-invalid');
  for (const section of sections) {
    if (section.nameOffset >= names.size) fail('format-safe-elf-section-name-offset-invalid');
    section.name = text(names.data.slice(section.nameOffset));
  }
  return sections;
}

function parseElf(bytes) {
  if (bytes.length > MAX_FORMAT_IMAGE_BYTES) fail('format-safe-image-budget-exceeded');
  ensureRange(bytes, 0, ELF64_HEADER_SIZE, 'format-safe-elf-header-truncated');
  if (!hasPrefix(bytes, ELF_MAGIC) || bytes[4] !== 2 || bytes[5] !== 1) fail('format-safe-elf64-little-endian-required');
  const header = {
    type: u16(bytes, 16),
    machine: u16(bytes, 18),
    version: u32(bytes, 20),
    entry: u64(bytes, 24).toString(),
    programHeaderOffset: boundedNumber(u64(bytes, 32)),
    sectionTableOffset: boundedNumber(u64(bytes, 40)),
    flags: u32(bytes, 48),
    headerSize: u16(bytes, 52),
    programHeaderSize: u16(bytes, 54),
    programHeaderCount: u16(bytes, 56),
    sectionHeaderSize: u16(bytes, 58),
    sectionCount: u16(bytes, 60),
    sectionNameIndex: u16(bytes, 62),
  };
  if (header.machine !== ELF_X86_64_MACHINE) fail('format-safe-elf-architecture-unsupported');
  if (header.headerSize !== ELF64_HEADER_SIZE || header.sectionHeaderSize !== ELF64_SECTION_HEADER_SIZE) fail('format-safe-elf-header-size-invalid');
  ensureRange(bytes, header.programHeaderOffset, header.programHeaderSize * header.programHeaderCount, 'format-safe-elf-program-table-invalid');
  ensureRange(bytes, header.sectionTableOffset, header.sectionHeaderSize * header.sectionCount, 'format-safe-elf-section-table-invalid');
  const sections = elfSections(bytes, header);
  const comment = sections.find((section) => section.name === '.comment');
  if (!comment || comment.type !== 1 || (BigInt(comment.flags) & 0x2n) !== 0n || comment.size < 2) fail('format-safe-elf-comment-target-unavailable');
  return {
    format: 'elf',
    architecture: 'x86_64',
    header,
    sections,
    target: comment,
    programHeadersDigest: stableDigest(Array.from(bytes.slice(header.programHeaderOffset, header.programHeaderOffset + header.programHeaderSize * header.programHeaderCount))),
    sectionTableDigest: stableDigest(Array.from(bytes.slice(header.sectionTableOffset, header.sectionTableOffset + header.sectionHeaderSize * header.sectionCount))),
    maskedFileDigest: bytesDigestMasked(bytes, comment.offset, comment.size),
  };
}

function peSections(bytes, header) {
  const sections = [];
  for (let index = 0; index < header.sectionCount; index++) {
    const offset = header.sectionTableOffset + index * PE_SECTION_HEADER_SIZE;
    const name = text(bytes.slice(offset, offset + 8));
    const virtualSize = u32(bytes, offset + 8);
    const virtualAddress = u32(bytes, offset + 12);
    const rawSize = u32(bytes, offset + 16);
    const rawOffset = u32(bytes, offset + 20);
    const characteristics = u32(bytes, offset + 36);
    if (rawSize > 0) ensureRange(bytes, rawOffset, rawSize, 'format-safe-pe-section-range-invalid');
    sections.push({ index, name, virtualSize, virtualAddress, rawSize, rawOffset, characteristics, data: rawSize > 0 ? bytes.slice(rawOffset, rawOffset + rawSize) : new Uint8Array() });
  }
  return sections;
}

function parsePe(bytes) {
  if (bytes.length > MAX_FORMAT_IMAGE_BYTES) fail('format-safe-image-budget-exceeded');
  ensureRange(bytes, 0, 0x40, 'format-safe-pe-dos-header-truncated');
  if (!hasPrefix(bytes, PE_MAGIC)) fail('format-safe-pe-dos-signature-invalid');
  const peOffset = u32(bytes, 0x3c);
  ensureRange(bytes, peOffset, 24, 'format-safe-pe-header-truncated');
  if (!hasPrefix(bytes, PE_SIGNATURE, peOffset)) fail('format-safe-pe-signature-invalid');
  const machine = u16(bytes, peOffset + 4);
  const sectionCount = u16(bytes, peOffset + 6);
  const timestamp = u32(bytes, peOffset + 8);
  const optionalHeaderSize = u16(bytes, peOffset + 20);
  const optionalOffset = peOffset + 24;
  ensureRange(bytes, optionalOffset, optionalHeaderSize, 'format-safe-pe-optional-header-truncated');
  const optionalMagic = u16(bytes, optionalOffset);
  if (machine === PE_I386_MACHINE && optionalMagic !== 0x10b) fail('format-safe-pe32-optional-header-invalid');
  if (machine === PE_AMD64_MACHINE && optionalMagic !== 0x20b) fail('format-safe-pe32plus-optional-header-invalid');
  if (![PE_I386_MACHINE, PE_AMD64_MACHINE].includes(machine)) fail('format-safe-pe-architecture-unsupported');
  if (optionalHeaderSize < (optionalMagic === 0x10b ? 96 : 112)) fail('format-safe-pe-optional-header-too-small');
  const imageBase = optionalMagic === 0x10b ? BigInt(u32(bytes, optionalOffset + 28)) : u64(bytes, optionalOffset + 24);
  const optional = {
    magic: optionalMagic,
    entryRva: u32(bytes, optionalOffset + 16),
    imageBase: imageBase.toString(),
    sectionAlignment: u32(bytes, optionalOffset + 32),
    fileAlignment: u32(bytes, optionalOffset + 36),
    sizeOfImage: u32(bytes, optionalOffset + 56),
    sizeOfHeaders: u32(bytes, optionalOffset + 60),
    subsystem: u16(bytes, optionalOffset + 68),
    numberOfRvaAndSizes: u32(bytes, optionalOffset + (optionalMagic === 0x10b ? 92 : 108)),
  };
  const sectionTableOffset = optionalOffset + optionalHeaderSize;
  ensureRange(bytes, sectionTableOffset, sectionCount * PE_SECTION_HEADER_SIZE, 'format-safe-pe-section-table-invalid');
  const header = { peOffset, machine, sectionCount, timestamp, optionalHeaderSize, optionalOffset, sectionTableOffset, optional };
  const sections = peSections(bytes, header);
  return {
    format: 'pe',
    architecture: machine === PE_I386_MACHINE ? 'x86' : 'x86_64',
    header,
    sections,
    target: { name: 'COFF.TimeDateStamp', offset: peOffset + 8, size: 4, data: bytes.slice(peOffset + 8, peOffset + 12) },
    maskedFileDigest: bytesDigestMasked(bytes, peOffset + 8, 4),
  };
}

function parseMacho(bytes) {
  if (bytes.length > MAX_FORMAT_IMAGE_BYTES) fail('format-safe-image-budget-exceeded');
  ensureRange(bytes, 0, MACHO64_HEADER_SIZE, 'format-safe-macho64-header-truncated');
  if (u32(bytes, 0) !== MACHO64_MAGIC) fail('format-safe-macho64-little-endian-required');
  const cpuType = u32(bytes, 4);
  const architecture = cpuType === MACHO_X86_64_CPU ? 'x86_64' : cpuType === MACHO_ARM64_CPU ? 'arm64' : null;
  if (!architecture) fail('format-safe-macho-architecture-unsupported');
  const header = {
    cpuType,
    cpuSubtype: u32(bytes, 8),
    fileType: u32(bytes, 12),
    loadCommandCount: u32(bytes, 16),
    loadCommandsSize: u32(bytes, 20),
    flags: u32(bytes, 24),
    reserved: u32(bytes, 28),
  };
  ensureRange(bytes, MACHO64_HEADER_SIZE, header.loadCommandsSize, 'format-safe-macho-load-commands-range-invalid');
  const commandsEnd = MACHO64_HEADER_SIZE + header.loadCommandsSize;
  const loadCommands = [];
  let offset = MACHO64_HEADER_SIZE;
  let target = null;
  for (let index = 0; index < header.loadCommandCount; index++) {
    ensureRange(bytes, offset, 8, 'format-safe-macho-load-command-truncated');
    const command = u32(bytes, offset);
    const size = u32(bytes, offset + 4);
    if (size < 8 || size % 8 !== 0 || offset > commandsEnd - size) fail('format-safe-macho-load-command-size-invalid');
    const entry = { index, command, offset, size, digest: stableDigest(Array.from(bytes.slice(offset, offset + size))) };
    if (command === LC_VERSION_MIN_MACOSX) {
      if (size !== 16 || target) fail('format-safe-macho-version-command-invalid');
      target = { name: 'LC_VERSION_MIN_MACOSX.version', command, commandIndex: index, offset: offset + 8, size: 4, data: bytes.slice(offset + 8, offset + 12), originalVersion: u32(bytes, offset + 8), sdkVersion: u32(bytes, offset + 12) };
      entry.digest = bytesDigestMasked(bytes.slice(offset, offset + size), 8, 4);
    }
    loadCommands.push(entry);
    offset += size;
  }
  if (offset !== commandsEnd) fail('format-safe-macho-load-command-count-invalid');
  if (!target) fail('format-safe-macho-version-target-unavailable');
  return {
    format: 'macho', architecture, header, loadCommands, sections: [], target,
    maskedFileDigest: bytesDigestMasked(bytes, target.offset, target.size),
  };
}

function parseImage(value) {
  const bytes = bytesOf(value);
  if (bytes.length >= 4 && u32(bytes, 0) === MACHO64_MAGIC) return parseMacho(bytes);
  if (hasPrefix(bytes, ELF_MAGIC)) return parseElf(bytes);
  if (hasPrefix(bytes, PE_MAGIC)) return parsePe(bytes);
  fail('format-safe-image-format-unrecognized');
}

function snapshot(image) {
  const base = {
    schema: FORMAT_SAFE_REBUILD_SCHEMA,
    format: image.format,
    architecture: image.architecture,
    maskedFileDigest: image.maskedFileDigest,
    sections: image.sections.map((section) => ({
      index: section.index,
      name: section.name,
      type: section.type ?? null,
      flags: section.flags ?? null,
      address: section.address ?? null,
      offset: section.offset ?? section.rawOffset ?? null,
      size: section.size ?? section.rawSize ?? null,
      link: section.link ?? null,
      info: section.info ?? null,
      alignment: section.alignment ?? null,
      entrySize: section.entrySize ?? null,
      virtualSize: section.virtualSize ?? null,
      virtualAddress: section.virtualAddress ?? null,
      characteristics: section.characteristics ?? null,
    })),
  };
  if (image.format === 'elf') {
    return { ...base, header: image.header, programHeadersDigest: image.programHeadersDigest, sectionTableDigest: image.sectionTableDigest };
  }
  if (image.format === 'macho') return { ...base, header: image.header, loadCommands: image.loadCommands };
  return { ...base, header: { ...image.header, timestamp: null } };
}

function expectedArchitecture(format, architecture) {
  const normalized = String(architecture || '').toLowerCase();
  if (format === 'elf' && normalized === 'x86_64') return normalized;
  if (format === 'pe' && ['x86', 'x86_64'].includes(normalized)) return normalized;
  if (format === 'macho' && ['x86_64', 'arm64'].includes(normalized)) return normalized;
  fail('format-safe-architecture-unsupported');
}

function utf8(value) {
  const encoder = new TextEncoder();
  return encoder.encode(String(value ?? ''));
}

function changed(left, right) {
  return !sameBytes(left, right);
}

function integerInRange(value, minimum, maximum, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) fail(code);
  return number;
}

function littleEndianBytes(length, write) {
  const result = new Uint8Array(length);
  write(new DataView(result.buffer));
  return result;
}

function elfNobitsLayoutPlan(source, image, mutation) {
  const name = String(mutation.name ?? '.bss');
  if (name !== '.bss') fail('format-safe-elf-nobits-name-unsupported');
  if (image.sections.some((section) => section.name === name)) fail('format-safe-elf-nobits-name-duplicate');
  if (image.header.sectionCount >= 0xffff) fail('format-safe-elf-section-count-exhausted');
  const size = integerInRange(mutation.size, 1, 0x10000000, 'format-safe-elf-nobits-size-invalid');
  const alignment = integerInRange(mutation.alignment ?? 8, 1, 0x100000, 'format-safe-elf-nobits-alignment-invalid');
  if ((alignment & (alignment - 1)) !== 0) fail('format-safe-elf-nobits-alignment-invalid');
  const names = image.sections[image.header.sectionNameIndex];
  if (image.header.sectionNameIndex !== image.header.sectionCount - 1) fail('format-safe-elf-section-name-table-not-terminal');
  const encodedName = utf8(`${name}\0`);
  const nameOffset = names.offset + names.size;
  if (nameOffset + encodedName.length !== image.header.sectionTableOffset) fail('format-safe-elf-section-name-space-unavailable');
  if (source.length !== image.header.sectionTableOffset + image.header.sectionCount * ELF64_SECTION_HEADER_SIZE) fail('format-safe-elf-section-table-not-terminal');
  if ((source.length + ELF64_SECTION_HEADER_SIZE) % alignment !== 0) fail('format-safe-elf-nobits-offset-alignment-invalid');
  if (source.slice(nameOffset, nameOffset + encodedName.length).some((byte) => byte !== 0)) fail('format-safe-elf-section-name-space-not-zero');

  const sectionHeader = new Uint8Array(ELF64_SECTION_HEADER_SIZE);
  const sectionView = new DataView(sectionHeader.buffer);
  sectionView.setUint32(0, names.size, true);
  sectionView.setUint32(4, ELF_SHT_NOBITS, true);
  sectionView.setBigUint64(24, BigInt(source.length + ELF64_SECTION_HEADER_SIZE), true);
  sectionView.setBigUint64(32, BigInt(size), true);
  sectionView.setBigUint64(48, BigInt(alignment), true);

  const namesHeaderOffset = image.header.sectionTableOffset + image.header.sectionNameIndex * ELF64_SECTION_HEADER_SIZE;
  const operations = [
    {
      id: 'format-safe:elf:nobits:section-count',
      offset: 60,
      before: source.slice(60, 62),
      after: littleEndianBytes(2, (view) => view.setUint16(0, image.header.sectionCount + 1, true)),
    },
    {
      id: 'format-safe:elf:nobits:name',
      offset: nameOffset,
      before: source.slice(nameOffset, nameOffset + encodedName.length),
      after: encodedName,
    },
    {
      id: 'format-safe:elf:nobits:string-table-size',
      offset: namesHeaderOffset + 32,
      before: source.slice(namesHeaderOffset + 32, namesHeaderOffset + 40),
      after: littleEndianBytes(8, (view) => view.setBigUint64(0, BigInt(names.size + encodedName.length), true)),
    },
    {
      id: 'format-safe:elf:nobits:section-header',
      offset: source.length,
      before: new Uint8Array(),
      after: sectionHeader,
    },
  ].map((operation) => ({
    ...operation,
    provenance: {
      source: 'format-safe-rebuild-adapter',
      schema: FORMAT_SAFE_REBUILD_SCHEMA,
      mutationKind: mutation.kind,
      section: name,
    },
  }));
  return {
    operations,
    safeState: {
      schema: FORMAT_SAFE_REBUILD_SCHEMA,
      kind: mutation.kind,
      section: name,
      type: 'SHT_NOBITS',
      size,
      alignment,
      sourceSectionCount: image.header.sectionCount,
      outputSectionCount: image.header.sectionCount + 1,
      sectionNameOffset: names.size,
      sectionHeaderOffset: source.length,
    },
  };
}

function reject(reason, detail = null) {
  return Object.freeze({ ok: false, status: 'rejected', reason, ...(detail == null ? {} : { detail: String(detail) }) });
}

/**
 * Create a transaction for a supported conservative format mutation.
 *
 * The source is inspected before the transaction is created, so a synthetic
 * byte array or a wrong format cannot be promoted by merely labelling it.
 */
export function createFormatSafeRebuildTransaction(input = {}) {
  const source = bytesOf(input.source);
  if (source.length === 0 || source.length > MAX_FORMAT_IMAGE_BYTES) fail('format-safe-source-budget-invalid');
  const format = String(input.format || '').toLowerCase();
  if (!['elf', 'macho', 'pe'].includes(format)) fail('format-safe-format-unsupported');
  const architecture = expectedArchitecture(format, input.architecture);
  const image = parseImage(source);
  if (image.format !== format || image.architecture !== architecture) fail('format-safe-source-identity-mismatch');
  const mutation = input.mutation;
  if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) fail('format-safe-mutation-required');
  let operations;
  let safeState;
  if (mutation.kind === 'elf-comment') {
    if (format !== 'elf') fail('format-safe-mutation-format-mismatch');
    const tag = String(mutation.tag ?? '');
    const encoded = utf8(tag);
    if (encoded.length === 0 || encoded.length >= image.target.size) fail('format-safe-elf-comment-tag-too-large');
    const after = new Uint8Array(image.target.size);
    after.set(encoded);
    const before = image.target.data;
    if (!changed(before, after)) fail('format-safe-mutation-no-change');
    operations = [{ id: 'format-safe:elf:.comment', offset: image.target.offset, before, after, provenance: { source: 'format-safe-rebuild-adapter', schema: FORMAT_SAFE_REBUILD_SCHEMA, mutationKind: mutation.kind, section: '.comment', tag } }];
    safeState = { schema: FORMAT_SAFE_REBUILD_SCHEMA, kind: mutation.kind, section: '.comment', offset: image.target.offset, size: image.target.size, replacementDigest: digestBytes(after) };
  } else if (mutation.kind === 'elf-add-nobits-section') {
    if (format !== 'elf') fail('format-safe-mutation-format-mismatch');
    ({ operations, safeState } = elfNobitsLayoutPlan(source, image, mutation));
  } else if (mutation.kind === 'macho-min-version') {
    if (format !== 'macho') fail('format-safe-mutation-format-mismatch');
    const version = Number(mutation.version);
    if (!Number.isSafeInteger(version) || version < 0 || version > 0xffffffff) fail('format-safe-macho-version-invalid');
    const before = image.target.data;
    const after = new Uint8Array(4);
    new DataView(after.buffer).setUint32(0, version, true);
    if (!changed(before, after)) fail('format-safe-mutation-no-change');
    operations = [{ id: 'format-safe:macho:min-version', offset: image.target.offset, before, after, provenance: { source: 'format-safe-rebuild-adapter', schema: FORMAT_SAFE_REBUILD_SCHEMA, mutationKind: mutation.kind, command: image.target.name, version } }];
    safeState = { schema: FORMAT_SAFE_REBUILD_SCHEMA, kind: mutation.kind, command: image.target.name, commandIndex: image.target.commandIndex, offset: image.target.offset, size: 4, originalVersion: image.target.originalVersion, replacementVersion: version, sdkVersion: image.target.sdkVersion };
  } else if (mutation.kind === 'pe-timestamp') {
    if (format !== 'pe') fail('format-safe-mutation-format-mismatch');
    const timestamp = Number(mutation.timestamp);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff) fail('format-safe-pe-timestamp-invalid');
    const before = image.target.data;
    const after = new Uint8Array(4);
    new DataView(after.buffer).setUint32(0, timestamp, true);
    if (!changed(before, after)) fail('format-safe-mutation-no-change');
    operations = [{ id: 'format-safe:pe:timestamp', offset: image.target.offset, before, after, provenance: { source: 'format-safe-rebuild-adapter', schema: FORMAT_SAFE_REBUILD_SCHEMA, mutationKind: mutation.kind, field: 'COFF.TimeDateStamp', timestamp } }];
    safeState = { schema: FORMAT_SAFE_REBUILD_SCHEMA, kind: mutation.kind, field: 'COFF.TimeDateStamp', offset: image.target.offset, size: 4, originalTimestamp: image.header.timestamp, replacementTimestamp: timestamp };
  } else fail('format-safe-mutation-kind-unsupported');
  const sourceHash = input.sourceHash == null ? digestBytes(source) : String(input.sourceHash);
  if (sourceHash !== digestBytes(source)) fail('format-safe-source-hash-mismatch');
  return createRebuildTransaction({
    binaryId: input.binaryId,
    sourceHash,
    format,
    architecture,
    loaderVersion: input.loaderVersion,
    operations,
    impact: { layoutMoving: mutation.kind === 'elf-add-nobits-section', sections: [safeState.section || safeState.field], relocationBindings: [] },
    expectedOriginalState: { sourceHash, formatSafe: safeState },
    additionalValidators: ['format-invariants'],
    requireIndependentOracle: true,
  });
}

/**
 * Validator callback for validateRebuildTransaction.  It checks the exact
 * operation, re-parses both images, and compares a whole-file digest masked
 * only at the supported metadata field.  Any header/table/section mutation or
 * format change therefore fails closed.
 */
export function validateFormatSafeMutation({ transaction, original, output } = {}) {
  try {
    const source = bytesOf(original);
    const candidate = bytesOf(output);
    if (!transaction || transaction.schemaVersion !== 'hex-rebuild-transaction-v2') return reject('format-safe-transaction-invalid');
    const format = String(transaction.format || '').toLowerCase();
    const architecture = expectedArchitecture(format, transaction.architecture);
    const sourceImage = parseImage(source);
    const outputImage = parseImage(candidate);
    if (sourceImage.format !== format || outputImage.format !== format || sourceImage.architecture !== architecture || outputImage.architecture !== architecture) return reject('format-safe-format-identity-mismatch');
    const safeState = transaction.expectedOriginalState?.formatSafe;
    if (!safeState || safeState.schema !== FORMAT_SAFE_REBUILD_SCHEMA) return reject('format-safe-state-missing');
    if (safeState.kind === 'elf-add-nobits-section') {
      if (format !== 'elf' || transaction.operations?.length !== 4 || transaction.impact?.layoutMoving !== true) return reject('format-safe-elf-layout-operation-invalid');
      const expected = elfNobitsLayoutPlan(source, sourceImage, safeState);
      const canonicalExpectedOperations = expected.operations.map((operation) => ({
        ...operation,
        offset: String(operation.offset),
        before: Array.from(operation.before),
        after: Array.from(operation.after),
        address: null,
      }));
      if (stableDigest(transaction.operations) !== stableDigest(canonicalExpectedOperations)) return reject('format-safe-operation-bytes-mismatch');
      if (candidate.length !== source.length + ELF64_SECTION_HEADER_SIZE) return reject('format-safe-elf-layout-size-mismatch');
      if (outputImage.header.sectionCount !== safeState.outputSectionCount || sourceImage.header.sectionCount !== safeState.sourceSectionCount) return reject('format-safe-elf-section-count-mismatch');
      const appended = outputImage.sections.at(-1);
      if (!appended || appended.name !== safeState.section || appended.type !== ELF_SHT_NOBITS || appended.size !== safeState.size
        || appended.alignment !== String(safeState.alignment) || appended.flags !== '0' || appended.address !== '0'
        || appended.offset !== candidate.length) return reject('format-safe-elf-nobits-section-mismatch');
      if (stableDigest(sourceImage.sections.slice(0, -1)) !== stableDigest(outputImage.sections.slice(0, -2))) return reject('format-safe-elf-existing-sections-changed');
      const sourceNames = sourceImage.sections[sourceImage.header.sectionNameIndex];
      const outputNames = outputImage.sections[outputImage.header.sectionNameIndex];
      const comparableSourceNames = { ...sourceNames, size: outputNames.size, data: outputNames.data };
      if (stableDigest(comparableSourceNames) !== stableDigest(outputNames)) return reject('format-safe-elf-name-table-mismatch');
      if (digestBytes(source) !== transaction.sourceHash) return reject('format-safe-source-hash-mismatch');
      return Object.freeze({
        ok: true,
        status: 'passed',
        format,
        architecture,
        mutationKind: safeState.kind,
        changed: true,
        sourceDigest: digestBytes(source),
        outputDigest: digestBytes(candidate),
        layoutEvidence: Object.freeze({ sectionCount: outputImage.header.sectionCount, section: Object.freeze({ name: appended.name, type: 'SHT_NOBITS', size: appended.size, alignment: Number(appended.alignment) }) }),
      });
    }
    if (transaction.operations?.length !== 1) return reject('format-safe-operation-count-invalid');
    const operation = transaction.operations[0];
    const offset = Number(BigInt(operation.offset));
    if (offset !== sourceImage.target.offset || operation.before.length !== sourceImage.target.size || operation.after.length !== sourceImage.target.size) return reject('format-safe-operation-target-mismatch');
    if (!sameBytes(operation.before, sourceImage.target.data) || !sameBytes(operation.after, candidate.slice(offset, offset + operation.after.length))) return reject('format-safe-operation-bytes-mismatch');
    if (!changed(operation.before, operation.after)) return reject('format-safe-mutation-no-change');
    if (digestBytes(source) !== transaction.sourceHash) return reject('format-safe-source-hash-mismatch');
    if (sourceImage.maskedFileDigest !== outputImage.maskedFileDigest) return reject('format-safe-unchanged-bytes-differ');
    if (stableDigest(snapshot(sourceImage)) !== stableDigest(snapshot(outputImage))) return reject('format-safe-structure-invariant-mismatch');
    if (safeState.offset !== offset || safeState.size !== operation.after.length) return reject('format-safe-state-missing');
    if (safeState.kind === 'elf-comment') {
      if (format !== 'elf' || safeState.section !== '.comment' || sourceImage.target.name !== '.comment' || digestBytes(operation.after) !== safeState.replacementDigest) return reject('format-safe-elf-state-mismatch');
    } else if (safeState.kind === 'macho-min-version') {
      if (format !== 'macho' || safeState.command !== 'LC_VERSION_MIN_MACOSX.version' || sourceImage.target.commandIndex !== safeState.commandIndex || sourceImage.target.originalVersion !== safeState.originalVersion || outputImage.target.originalVersion !== safeState.replacementVersion || sourceImage.target.sdkVersion !== safeState.sdkVersion || outputImage.target.sdkVersion !== safeState.sdkVersion) return reject('format-safe-macho-state-mismatch');
    } else if (safeState.kind === 'pe-timestamp') {
      if (format !== 'pe' || safeState.field !== 'COFF.TimeDateStamp' || sourceImage.header.timestamp !== safeState.originalTimestamp || outputImage.header.timestamp !== safeState.replacementTimestamp) return reject('format-safe-pe-state-mismatch');
    } else return reject('format-safe-state-kind-unsupported');
    return Object.freeze({ ok: true, status: 'passed', format, architecture, mutationKind: safeState.kind, changed: true, sourceDigest: digestBytes(source), outputDigest: digestBytes(candidate) });
  } catch (error) {
    return reject('format-safe-parse-or-invariant-failure', error?.message || error);
  }
}

export function inspectFormatSafeImage(value) {
  const image = parseImage(bytesOf(value));
  return Object.freeze({ format: image.format, architecture: image.architecture, target: Object.freeze({ name: image.target.name || image.target.field, offset: image.target.offset, size: image.target.size }), snapshot: Object.freeze(snapshot(image)) });
}
