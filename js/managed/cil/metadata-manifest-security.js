import { deepFreeze } from '../../core/identity/index.js';
import { codedIndexSize, cilMetadataToken } from './metadata-layout.js';
import { readCilMetadataContext } from './metadata-context.js';
import { readCilMetadataBlob } from './call-signature-metadata.js';

function fail(code) { throw new TypeError(code); }

function readManifestSecurity(bytes, view, layout, stringsStream, blobStream, defs, admission = null) {
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
    admission?.chargeStringBytes(pos - start);
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start, pos)); }
    catch { fail('cil-invalid-strings-utf8'); }
  };
  const readRows = (table, decode) => {
    // Manifest/security tables share the definitions admission budget (#8704):
    // an unbounded File/ExportedType/DeclSecurity table must not materialize
    // rows the canonical decode already refused to admit.
    if (counts[table]) admission?.chargeObjects(counts[table]);
    return Array.from({ length: counts[table] || 0 }, (_, i) => {
      const rid = i + 1, pos = offsets[table] + i * rowSizes[table];
      admission?.chargeOperations(1);
      return { rid, token: cilMetadataToken(table, rid), ...decode(pos) };
    });
  };
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
      admission?.chargeOperations(1);
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

// `context` is the shared validated layout/definition graph (#8704). Omitting it
// (undefined) builds exactly one such graph here; it never decodes a second copy
// of definitions that the caller already validated.
export function overlayCilManifestSecurity(bytes, parsed, context, options = {}) {
  const ctx = context === undefined ? readCilMetadataContext(bytes, options) : context;
  if (!ctx) return parsed;
  const extra = readManifestSecurity(ctx.bytes, ctx.view, ctx.layout, ctx.stringsStream, ctx.blobStream, ctx.defs, ctx.admission);
  return deepFreeze({ ...parsed, files: extra.files, exportedTypes: extra.exportedTypes, declSecurity: extra.declSecurity });
}

export function readCilManifestSecurityDefinitions(bytes, view, layout, stringsStream, blobStream, defs, admission = null) {
  return readManifestSecurity(bytes, view, layout, stringsStream, blobStream, defs, admission);
}
