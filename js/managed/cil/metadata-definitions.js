import { codedIndexSize, tableIndexSize, cilMetadataToken } from './metadata-layout.js';
import { readCilMetadataBlob } from './call-signature-metadata.js';
import { parseCilTypeSpecSignature } from './call-signature-types.js';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function fail(code) { throw new TypeError(code); }

// Read only definitions, but use the complete, already-bounds-checked table layout.
export function readCilDefinitions(bytes, view, layout, stringsStream, blobStream = null) {
  const { rowCounts: counts, tableOffsets: offsets, rowSizes, heapSizes } = layout;
  const s = heapSizes & 1 ? 4 : 2, b = heapSizes & 4 ? 4 : 2;
  const index = (pos, width) => width === 2 ? view.getUint16(pos, true) : view.getUint32(pos, true);
  const text = value => {
    // Preserve legacy minimal metadata with an absent optional heap and null names.
    if (value === 0) return null;
    if (!stringsStream || value >= stringsStream.size) fail('cil-definition-string-index-invalid');
    const start = stringsStream.offset + value, end = stringsStream.offset + stringsStream.size;
    let pos = start;
    while (pos < end && bytes[pos] !== 0) pos++;
    if (pos === end) fail('cil-definition-string-unterminated');
    try { return utf8.decode(bytes.subarray(start, pos)); }
    catch { fail('cil-invalid-strings-utf8'); }
  };
  const readRows = (table, decode) => Array.from({ length: counts[table] }, (_, i) => {
    const rid = i + 1, pos = offsets[table] + i * rowSizes[table];
    return { rid, token: cilMetadataToken(table, rid), ...decode(pos) };
  });
  const methods = readRows(6, pos => ({
    rva: view.getUint32(pos, true), implFlags: view.getUint16(pos + 4, true),
    accessFlags: view.getUint16(pos + 6, true), name: text(index(pos + 8, s)),
    signatureBlobIndex: index(pos + 8 + s, b),
    paramList: index(pos + 8 + s + b, tableIndexSize(counts, 8)),
  }));
  const fields = readRows(4, pos => ({
    accessFlags: view.getUint16(pos, true), name: text(index(pos + 2, s)),
    signatureBlobIndex: index(pos + 2 + s, b),
  }));
  const extendsSize = codedIndexSize(counts, [2, 1, 0x1b], 2);
  // #Blob heap for signature-bearing rows: a row referencing an out-of-range
  // or malformed blob fails closed rather than silently dropping identity.
  const blobHeap = blobStream && blobStream.size
    ? bytes.subarray(blobStream.offset, blobStream.offset + blobStream.size)
    : null;
  const typeSpecRowCounts = () => [counts[2], counts[1], counts[0x1b]];
  // TypeSpec (0x1b) rows are the constructed-type authority (#7673): each row
  // keeps its Signature blob index, the raw blob bytes, and the decoded exact
  // type specification. A grammar this decoder cannot represent keeps the raw
  // blob authority (signature stays null) instead of collapsing two distinct
  // constructed types into one opaque token; structural blob violations fail
  // closed.
  const typeSpecs = counts[0x1b] ? Array.from({ length: counts[0x1b] }, (_, i) => {
    const rid = i + 1, pos = offsets[0x1b] + i * rowSizes[0x1b];
    const signatureBlobIndex = index(pos, b);
    if (!blobHeap) fail('cil-type-spec-blob-missing');
    const rawSignature = readCilMetadataBlob(blobHeap, signatureBlobIndex, 'cil-type-spec-blob-index-invalid');
    let signature = null;
    try {
      signature = parseCilTypeSpecSignature(rawSignature, typeSpecRowCounts());
    } catch (error) {
      if (!(error instanceof TypeError)
        || !String(error.message ?? error).startsWith('cil-type-spec-signature-invalid')) throw error;
    }
    return {
      rid, token: cilMetadataToken(0x1b, rid), signatureBlobIndex,
      rawSignature, signature,
    };
  }) : [];
  const types = readRows(2, pos => {
    const base = index(pos + 4 + s * 2, extendsSize), table = [2, 1, 0x1b][base & 3], rid = Math.floor(base / 4);
    if (base !== 0 && (table == null || rid < 1 || rid > counts[table])) fail('cil-typedef-extends-invalid');
    return {
      accessFlags: view.getUint32(pos, true), name: text(index(pos + 4, s)),
      namespace: text(index(pos + 4 + s, s)) ?? '',
      extendsToken: base === 0 ? null : cilMetadataToken(table, rid),
      extendsTypeSpecRid: base !== 0 && table === 0x1b ? rid : null,
      fieldList: index(pos + 4 + s * 2 + extendsSize, tableIndexSize(counts, 4)),
      methodList: index(pos + 4 + s * 2 + extendsSize + tableIndexSize(counts, 4), tableIndexSize(counts, 6)),
    };
  });
  // TypeDefOrRef consumers resolve a TypeSpec extends token to the canonical
  // TypeSpec row authority instead of an opaque token (#7673).
  for (const type of types) {
    if (type.extendsTypeSpecRid != null) {
      type.extendsTypeSpec = typeSpecs[type.extendsTypeSpecRid - 1];
      delete type.extendsTypeSpecRid;
    }
  }
  // Manifest assembly (0x20): this row is the defining assembly's identity
  // authority (ECMA-335 II.22.2, at most one row) (#7677). Unknown flag or
  // key encodings keep their raw values; no identity is fabricated.
  if (counts[0x20] > 1) fail('cil-assembly-table-multi-row');
  const assembly = counts[0x20] ? (() => {
    const pos = offsets[0x20], publicKeyBlobIndex = index(pos + 16, b);
    let publicKey = null;
    if (publicKeyBlobIndex !== 0) {
      if (!blobHeap) fail('cil-assembly-public-key-blob-missing');
      publicKey = readCilMetadataBlob(blobHeap, publicKeyBlobIndex, 'cil-assembly-public-key-blob-invalid');
    }
    return {
      rid: 1, token: cilMetadataToken(0x20, 1),
      hashAlgId: view.getUint32(pos, true),
      majorVersion: view.getUint16(pos + 4, true),
      minorVersion: view.getUint16(pos + 6, true),
      buildNumber: view.getUint16(pos + 8, true),
      revisionNumber: view.getUint16(pos + 10, true),
      flags: view.getUint32(pos + 12, true),
      publicKeyBlobIndex, publicKey,
      name: text(index(pos + 16 + b, s)),
      culture: text(index(pos + 16 + b + s, s)),
    };
  })() : null;
  const bindOwners = (table, pointerTable, values, listKey, tokensKey) => {
    const pointers = counts[pointerTable] ? readRows(pointerTable, pos => ({
      target: index(pos, tableIndexSize(counts, table)),
    })).map(row => row.target) : values.map(row => row.rid);
    if (new Set(pointers).size !== pointers.length || pointers.length !== values.length
        || pointers.some(rid => rid < 1 || rid > values.length)) fail('cil-definition-pointer-table-invalid');
    for (let i = 0; i < types.length; i++) {
      const first = types[i][listKey], last = types[i + 1]?.[listKey] ?? pointers.length + 1;
      if (first < 1 || last < first || last > pointers.length + 1 || (i === 0 && first !== 1)) {
        fail('cil-typedef-member-list-invalid');
      }
      types[i][tokensKey] = [];
      for (let slot = first; slot < last; slot++) {
        const member = values[pointers[slot - 1] - 1];
        member.declaringTypeToken = types[i].token;
        types[i][tokensKey].push(member.token);
      }
    }
    // ECMA-335 II.22.26 rule 2 (MethodDef) / II.22.24 rule 2 (Field): every
    // definition row is owned by exactly one TypeDef. An ownerless row is
    // invalid metadata and must never surface as a spec-valid member (#7301).
    if (values.some(member => member.declaringTypeToken == null)) {
      fail(table === 6 ? 'cil-methoddef-owner-missing' : 'cil-fielddef-owner-missing');
    }
  };
  bindOwners(4, 3, fields, 'fieldList', 'fieldTokens');
  bindOwners(6, 5, methods, 'methodList', 'methodTokens');
  // ECMA-335 II.22.28 ManifestResource (0x28): Offset / Flags / Name /
  // Implementation (File | AssemblyRef | ExportedType coded index). Skipping
  // this table discarded every named embedded resource from the canonical
  // image, so payload-only changes were semantically invisible (#7753).
  const implementationSize = codedIndexSize(counts, [0x26, 0x23, 0x27], 2);
  const implementationTables = [0x26, 0x23, 0x27];
  const manifestResources = readRows(0x28, pos => {
    const offset = view.getUint32(pos, true);
    const flags = view.getUint32(pos + 4, true);
    const name = text(index(pos + 8, s));
    if (name == null || !name.length) fail('cil-manifest-resource-name-required');
    const implementation = index(pos + 8 + s, implementationSize);
    if ((flags & ~0x3) !== 0 || (flags & 0x3) === 0 || (flags & 0x3) === 0x3) {
      // II.23.1.5: Visibility mask 0x0003 — Public (1) or Private (2); all
      // other bits are reserved and must be zero.
      fail('cil-manifest-resource-flags-invalid');
    }
    let target = null;
    if (implementation !== 0) {
      const table = implementationTables[implementation & 0x3];
      const rid = Math.floor(implementation / 4);
      if (table == null || rid < 1 || rid > counts[table]) {
        fail('cil-manifest-resource-implementation-invalid');
      }
      target = { table, rid, token: cilMetadataToken(table, rid) };
    }
    return { offset, flags, visibility: flags & 0x3, name, ...(target ? { implementation: target } : {}) };
  });
  if (new Set(manifestResources.map(row => row.name)).size !== manifestResources.length) {
    fail('cil-manifest-resource-name-duplicate');
  }
  return { types, methods, fields, manifestResources, typeSpecs, assembly };
}
