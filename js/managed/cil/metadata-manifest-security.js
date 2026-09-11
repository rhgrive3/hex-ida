import { deepFreeze } from '../../core/identity/index.js';
import { metadataRowSize, validateMetadataTableValidMask, codedIndexSize, cilMetadataToken } from './metadata-layout.js';
import { readCilMetadataStreams } from './metadata-streams.js';
import { readCilDefinitions } from './metadata-definitions.js';
import { readCilMetadataBlob } from './call-signature-metadata.js';
import { CLI_HEADER_SIZE, validateCliHeaderSize } from './cli-header.js';

const CLI_DIRECTORY_INDEX = 14;

function fail(code) { throw new TypeError(code); }
function range(bytes, off, size, code) {
  if (!Number.isSafeInteger(off) || !Number.isSafeInteger(size) || off < 0 || size < 0 || off > bytes.length - size) fail(code);
}
function u16(view, off, code) {
  if (off < 0 || off + 2 > view.byteLength) fail(code);
  return view.getUint16(off, true);
}
function u32(view, off, code) {
  if (off < 0 || off + 4 > view.byteLength) fail(code);
  return view.getUint32(off, true);
}

function peLayout(bytes, view) {
  if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return null;
  const pe = u32(view, 0x3c, 'cil-truncated-pe-header');
  if (pe + 24 > bytes.length || bytes[pe] !== 0x50 || bytes[pe + 1] !== 0x45 || bytes[pe + 2] !== 0 || bytes[pe + 3] !== 0) return null;
  const count = u16(view, pe + 6, 'cil-truncated-pe-coff-header');
  const optSize = u16(view, pe + 20, 'cil-truncated-pe-coff-header');
  const opt = pe + 24;
  if (optSize < 2 || opt + optSize > bytes.length) return null;
  const end = opt + optSize, magic = u16(view, opt, 'cil-truncated-pe-optional-header');
  let nOff, dOff;
  if (magic === 0x10b) { nOff = opt + 92; dOff = opt + 96; }
  else if (magic === 0x20b) { nOff = opt + 108; dOff = opt + 112; }
  else return null;
  if (nOff + 4 > end) return null;
  const n = u32(view, nOff);
  if (n <= CLI_DIRECTORY_INDEX || dOff + (CLI_DIRECTORY_INDEX + 1) * 8 > end) return { cliPresent: false };
  const sections = [];
  for (let i = 0; i < count; i += 1) {
    const p = end + i * 40;
    range(bytes, p, 40, 'cil-truncated-pe-section-table');
    const rawSize = u32(view, p + 16), rawOffset = u32(view, p + 20);
    if (rawSize) range(bytes, rawOffset, rawSize, 'cil-pe-section-out-of-bounds');
    sections.push({ virtualSize: u32(view, p + 8), virtualAddress: u32(view, p + 12), rawSize, rawOffset });
  }
  const mapRva = (rva, size = 1, code = 'cil-rva-unmapped') => {
    if (!Number.isSafeInteger(rva) || !Number.isSafeInteger(size) || rva < 0 || size < 0) fail(code);
    for (const section of sections) {
      const span = Math.max(section.virtualSize, section.rawSize);
      if (rva < section.virtualAddress || rva >= section.virtualAddress + span) continue;
      const delta = rva - section.virtualAddress;
      if (delta > section.rawSize || size > section.rawSize - delta) fail(code);
      const out = section.rawOffset + delta;
      range(bytes, out, size, code);
      return out;
    }
    fail(code);
  };
  const dir = dOff + CLI_DIRECTORY_INDEX * 8;
  const rva = u32(view, dir, 'cil-truncated-cli-directory'), size = u32(view, dir + 4, 'cil-truncated-cli-directory');
  if (!rva || size < CLI_HEADER_SIZE) return { cliPresent: false };
  const cli = mapRva(rva, CLI_HEADER_SIZE, 'cil-cli-header-unmapped');
  const cb = validateCliHeaderSize(u32(view, cli, 'cil-truncated-cli-header'), size);
  mapRva(rva, cb, 'cil-cli-header-unmapped');
  const metaRva = u32(view, cli + 8, 'cil-truncated-cli-header'), metaSize = u32(view, cli + 12, 'cil-truncated-cli-header');
  if (!metaRva || metaSize < 20) fail('cil-cli-metadata-directory-invalid');
  return { cliPresent: true, metadataOffset: mapRva(metaRva, metaSize, 'cil-cli-metadata-unmapped'), metadataSize: metaSize };
}

function tableLayout(bytes, view, stream) {
  range(bytes, stream.offset, stream.size, 'cil-metadata-tables-out-of-bounds');
  if (stream.size < 24) fail('cil-metadata-tables-truncated');
  const start = stream.offset, end = start + stream.size, heapSizes = bytes[start + 6];
  const valid = BigInt(u32(view, start + 8, 'cil-metadata-tables-truncated'))
    | (BigInt(u32(view, start + 12, 'cil-metadata-tables-truncated')) << 32n);
  validateMetadataTableValidMask(valid);
  let pos = start + 24;
  const rowCounts = new Array(64).fill(0), tableOffsets = new Array(64).fill(null), rowSizes = new Array(64).fill(0);
  for (let table = 0; table < 64; table += 1) {
    if ((valid & (1n << BigInt(table))) === 0n) continue;
    if (pos + 4 > end) fail('cil-metadata-row-counts-truncated');
    rowCounts[table] = u32(view, pos, 'cil-metadata-row-counts-truncated');
    pos += 4;
  }
  for (let table = 0; table < 64; table += 1) {
    const rows = rowCounts[table];
    if (!rows) continue;
    const size = metadataRowSize(table, rowCounts, heapSizes);
    if (!Number.isSafeInteger(size) || size < 1 || rows > Math.floor((end - pos) / size)) fail('cil-metadata-table-data-truncated');
    tableOffsets[table] = pos;
    rowSizes[table] = size;
    pos += rows * size;
  }
  return { rowCounts, tableOffsets, rowSizes, heapSizes };
}

function readManifestSecurity(bytes, view, layout, stringsStream, blobStream, defs) {
  const { rowCounts: counts, tableOffsets: offsets, rowSizes, heapSizes } = layout;
  const s = heapSizes & 1 ? 4 : 2;
  const b = heapSizes & 4 ? 4 : 2;
  const index = (pos, width) => width === 2 ? view.getUint16(pos, true) : view.getUint32(pos, true);
  const text = value => {
    if (value === 0) return null;
    if (!stringsStream || value >= stringsStream.size) fail('cil-definition-string-index-invalid');
    const start = stringsStream.offset + value, end = stringsStream.offset + stringsStream.size;
    let pos = start;
    while (pos < end && bytes[pos] !== 0) pos += 1;
    if (pos === end) fail('cil-definition-string-unterminated');
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start, pos)); }
    catch { fail('cil-invalid-strings-utf8'); }
  };
  const readRows = (table, decode) => Array.from({ length: counts[table] || 0 }, (_, i) => {
    const rid = i + 1, pos = offsets[table] + i * rowSizes[table];
    return { rid, token: cilMetadataToken(table, rid), ...decode(pos) };
  });
  const blobHeap = blobStream?.size ? bytes.subarray(blobStream.offset, blobStream.offset + blobStream.size) : null;

  const validManifestFileName = name => {
    const dot = name.lastIndexOf('.');
    return dot > 0 && dot < name.length - 1 && !/[\\/:]/.test(name);
  };
  const files = readRows(0x26, pos => {
    const flags = view.getUint32(pos, true);
    if (flags !== 0 && flags !== 1) fail('cil-file-flags-invalid');
    const name = text(index(pos + 4, s));
    if (name == null || !name.length) fail('cil-file-name-required');
    if (!validManifestFileName(name)) fail('cil-file-name-invalid');
    const hashValueBlobIndex = index(pos + 4 + s, b);
    if (hashValueBlobIndex === 0) fail('cil-file-hash-required');
    if (!blobHeap) fail('cil-file-hash-blob-missing');
    const hashValue = readCilMetadataBlob(blobHeap, hashValueBlobIndex, 'cil-file-hash-blob-invalid');
    if (hashValue.length === 0) fail('cil-file-hash-empty');
    return { flags, name, hashValueBlobIndex, hashValue };
  });
  const fileNames = new Set();
  for (const file of files) {
    if (fileNames.has(file.name)) fail('cil-file-name-duplicate');
    fileNames.add(file.name);
  }
  if ((counts[0x20] || 0) > 0 && (counts[0x00] || 0) > 0) {
    const moduleName = text(index(offsets[0x00] + 2, s));
    if (moduleName != null && files.some(file => file.name === moduleName)) fail('cil-file-self-reference');
  }

  const implementationSize = codedIndexSize(counts, [0x26, 0x23, 0x27], 2);
  const implementationTables = [0x26, 0x23, 0x27];
  const TYPE_VISIBILITY_MASK = 0x00000007, TYPE_PUBLIC = 0x00000001, TYPE_NESTED_PUBLIC = 0x00000002, TYPE_FORWARDER = 0x00200000;
  const exportedTypes = readRows(0x27, pos => {
    const flags = view.getUint32(pos, true), typeDefId = view.getUint32(pos + 4, true);
    const typeName = text(index(pos + 8, s));
    if (typeName == null || !typeName.length) fail('cil-exported-type-name-required');
    const typeNamespace = text(index(pos + 8 + s, s)) ?? '';
    const implementation = index(pos + 8 + s * 2, implementationSize);
    if (implementation === 0) fail('cil-exported-type-implementation-required');
    const table = implementationTables[implementation & 0x3], rid = Math.floor(implementation / 4);
    if (table == null || rid < 1 || rid > counts[table]) fail('cil-exported-type-implementation-invalid');
    const isForwarder = (flags & TYPE_FORWARDER) !== 0;
    if (isForwarder && typeDefId !== 0) fail('cil-exported-type-forwarder-typedefid-invalid');
    if (isForwarder && table !== 0x23) fail('cil-exported-type-forwarder-implementation-invalid');
    if (table === 0x23 && !isForwarder) fail('cil-exported-type-assemblyref-forwarder-required');
    const visibility = flags & TYPE_VISIBILITY_MASK;
    if (table === 0x26 && visibility !== TYPE_PUBLIC) fail('cil-exported-type-file-visibility-invalid');
    if (table === 0x27 && visibility !== TYPE_NESTED_PUBLIC) fail('cil-exported-type-nested-visibility-invalid');
    if (table === 0x27 && typeNamespace.length !== 0) fail('cil-exported-type-nested-namespace-invalid');
    return { flags, typeDefId, typeName, typeNamespace, implementation: { table, rid, token: cilMetadataToken(table, rid) }, isForwarder };
  });
  for (const row of exportedTypes) {
    const seen = new Set([row.rid]);
    let implementation = row.implementation;
    while (implementation.table === 0x27) {
      if (seen.has(implementation.rid)) fail('cil-exported-type-implementation-cycle');
      seen.add(implementation.rid);
      const target = exportedTypes[implementation.rid - 1];
      if (!target) fail('cil-exported-type-implementation-invalid');
      implementation = target.implementation;
    }
    row.resolvedImplementation = { ...implementation };
  }

  const parentSize = codedIndexSize(counts, [0x02, 0x06, 0x20], 2), parentTables = [0x02, 0x06, 0x20];
  const TYPE_HAS_SECURITY = 0x00040000, METHOD_HAS_SECURITY = 0x4000;
  const ASSEMBLY_ONLY = new Set([0x0008, 0x0009, 0x000a, 0x000b, 0x000c]);
  const TYPE_OR_METHOD_ONLY = new Set([0x0002, 0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x000d, 0x000e, 0x000f]);
  const declSecurity = readRows(0x0e, pos => {
    const action = view.getUint16(pos, true);
    if (action < 0x0001 || action > 0x0012) fail('cil-declsecurity-action-invalid');
    const parent = index(pos + 2, parentSize), parentTable = parentTables[parent & 0x3], parentRid = Math.floor(parent / 4);
    if (parentTable == null || parentRid < 1 || parentRid > counts[parentTable]) fail('cil-declsecurity-parent-invalid');
    if (ASSEMBLY_ONLY.has(action) && parentTable !== 0x20) fail('cil-declsecurity-parent-scope-invalid');
    if (TYPE_OR_METHOD_ONLY.has(action) && parentTable === 0x20) fail('cil-declsecurity-parent-scope-invalid');
    if (parentTable === 0x02 && (defs.types[parentRid - 1].accessFlags & TYPE_HAS_SECURITY) === 0) fail('cil-declsecurity-parent-security-flag-missing');
    if (parentTable === 0x06 && (defs.methods[parentRid - 1].accessFlags & METHOD_HAS_SECURITY) === 0) fail('cil-declsecurity-parent-security-flag-missing');
    const permissionSetBlobIndex = index(pos + 2 + parentSize, b);
    if (permissionSetBlobIndex === 0) fail('cil-declsecurity-permission-set-required');
    if (!blobHeap) fail('cil-declsecurity-permission-set-blob-missing');
    const permissionSet = readCilMetadataBlob(blobHeap, permissionSetBlobIndex, 'cil-declsecurity-permission-set-blob-invalid');
    return { action, parent: { table: parentTable, rid: parentRid, token: cilMetadataToken(parentTable, parentRid) }, permissionSetBlobIndex, permissionSet };
  });
  return { files, exportedTypes, declSecurity };
}

export function overlayCilManifestSecurity(bytes, parsed) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const pe = peLayout(u8, view);
  if (!pe?.cliPresent) return parsed;
  const meta = readCilMetadataStreams(u8, pe.metadataOffset, pe.metadataSize);
  const tablesStream = meta.streams.find(s => s.name === '#~' || s.name === '#-');
  const stringsStream = meta.streams.find(s => s.name === '#Strings');
  const blobStream = meta.streams.find(s => s.name === '#Blob');
  if (!tablesStream) fail('cil-metadata-tables-missing');
  const layout = tableLayout(u8, view, tablesStream);
  const defs = readCilDefinitions(u8, view, layout, stringsStream, blobStream);
  const extra = readManifestSecurity(u8, view, layout, stringsStream, blobStream, defs);
  return deepFreeze({ ...parsed, files: extra.files, exportedTypes: extra.exportedTypes, declSecurity: extra.declSecurity });
}

export function readCilManifestSecurityDefinitions(bytes, view, layout, stringsStream, blobStream, defs) {
  return readManifestSecurity(bytes, view, layout, stringsStream, blobStream, defs);
}
