import { codedIndexSize, tableIndexSize, cilMetadataToken } from './metadata-layout.js';
import { readCilMetadataBlob } from './call-signature-metadata.js';
import { parseCilMethodSignature, parseCilTypeSpecSignature } from './call-signature-types.js';
import { stableStringify } from '../../core/identity/index.js';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function fail(code) { throw new TypeError(code); }

// ECMA-335 II.23.4 marshalling-descriptor constants (`NATIVE_TYPE_xxx`). The
// value is what actually changes the managed/native call boundary, so it is
// decoded as evidence and never replaced by a name guess.
const MARSHAL_NATIVE_INTRINSICS = new Map([
  [0x02, 'BOOLEAN'], [0x03, 'I1'], [0x04, 'U1'], [0x05, 'I2'], [0x06, 'U2'],
  [0x07, 'I4'], [0x08, 'U4'], [0x09, 'I8'], [0x0a, 'U8'], [0x0b, 'R4'], [0x0c, 'R8'],
  [0x14, 'LPSTR'], [0x15, 'LPWSTR'], [0x1f, 'INT'], [0x20, 'UINT'], [0x26, 'FUNC'],
]);
const MARSHAL_NATIVE_ARRAY = 0x2a;
const MARSHAL_NATIVE_MAX = 0x50;

// ECMA-335 II.23.2 compressed unsigned integer. Bounds-checked; a truncated or
// non-minimal encoding is malformed evidence, not a value to guess at (#7557).
function readCompressedUnsigned(bytes, offset, code) {
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) fail(code);
  const first = bytes[offset];
  if ((first & 0x80) === 0) return { value: first, next: offset + 1 };
  if ((first & 0xc0) === 0x80) {
    if (offset + 1 >= bytes.length) fail(code);
    const value = ((first & 0x3f) << 8) | bytes[offset + 1];
    if (value < 0x80) fail(code);
    return { value, next: offset + 2 };
  }
  if ((first & 0xe0) === 0xc0) {
    if (offset + 3 >= bytes.length) fail(code);
    const value = ((first & 0x1f) * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
    if (value < 0x4000) fail(code);
    return { value, next: offset + 4 };
  }
  fail(code);
}

// II.23.4 MarshalSpec ::= NativeIntrinsic | ARRAY ArrayElemType [ParamNum [NumElem]].
// A recognised intrinsic carries no payload, so trailing bytes are malformed; an
// unrecognised (future/extension) native type keeps its raw authority instead of
// being dropped or guessed.
function decodeMarshalSpec(raw) {
  const code = 'cil-fieldmarshal-marshal-spec-invalid';
  if (!(raw instanceof Uint8Array) || raw.length < 1) fail(code);
  // NativeType and ArrayElemType are fixed single-byte enum values. Only
  // ParamNum and NumElem use compressed unsigned integers (II.23.4).
  const nativeType = raw[0];
  if (nativeType === MARSHAL_NATIVE_ARRAY) {
    if (raw.length < 2) fail(code);
    const arrayElementType = raw[1];
    if (arrayElementType !== MARSHAL_NATIVE_MAX && !MARSHAL_NATIVE_INTRINSICS.has(arrayElementType)) fail(code);
    let paramNum = null, numElem = null, pos = 2;
    if (pos < raw.length) { const read = readCompressedUnsigned(raw, pos, code); paramNum = read.value; pos = read.next; }
    if (pos < raw.length) { const read = readCompressedUnsigned(raw, pos, code); numElem = read.value; pos = read.next; }
    if (pos !== raw.length) fail(code);
    return { nativeType, nativeTypeName: 'ARRAY', arrayElementType,
      arrayElementTypeName: MARSHAL_NATIVE_INTRINSICS.get(arrayElementType) ?? 'MAX', paramNum, numElem };
  }
  const name = MARSHAL_NATIVE_INTRINSICS.get(nativeType);
  if (name == null) {
    return { nativeType, nativeTypeName: null, payload: raw.subarray(1) };
  }
  if (raw.length !== 1) fail(code);
  return { nativeType, nativeTypeName: name };
}

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
  const requiredText = (value, code) => {
    const valueText = text(value);
    if (valueText == null || valueText.length === 0) fail(code);
    return valueText;
  };
  const readRows = (table, decode) => Array.from({ length: counts[table] }, (_, i) => {
    const rid = i + 1, pos = offsets[table] + i * rowSizes[table];
    return { rid, token: cilMetadataToken(table, rid), ...decode(pos) };
  });
  const methods = readRows(6, pos => ({
    rva: view.getUint32(pos, true), implFlags: view.getUint16(pos + 4, true),
    accessFlags: view.getUint16(pos + 6, true), name: text(index(pos + 8, s)),
    signatureBlobIndex: index(pos + 8 + s, b),
    paramList: index(pos + 8 + s + b, tableIndexSize(counts, counts[7] ? 7 : 8)),
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
  const resolutionScopeSize = codedIndexSize(counts, [0x00, 0x1a, 0x23, 0x01], 2);
  const resolutionScopeTables = [0x00, 0x1a, 0x23, 0x01];
  const typeRefs = readRows(0x01, pos => {
    const scope = index(pos, resolutionScopeSize);
    let resolutionScope = null;
    if (scope !== 0) {
      const table = resolutionScopeTables[scope & 3], rid = Math.floor(scope / 4);
      if (table == null || rid < 1 || rid > counts[table]) fail('cil-typeref-resolution-scope-invalid');
      resolutionScope = { table, rid, token: cilMetadataToken(table, rid) };
    }
    return {
      resolutionScope,
      name: requiredText(index(pos + resolutionScopeSize, s), 'cil-typeref-name-required'),
      namespace: text(index(pos + resolutionScopeSize + s, s)) ?? '',
    };
  });
  const assemblyRefs = readRows(0x23, pos => {
    const publicKeyOrTokenBlobIndex = index(pos + 12, b);
    const hashValueBlobIndex = index(pos + 12 + b + s * 2, b);
    let publicKeyOrToken = null;
    if (publicKeyOrTokenBlobIndex !== 0) {
      if (!blobHeap) fail('cil-assembly-ref-public-key-blob-missing');
      publicKeyOrToken = readCilMetadataBlob(blobHeap, publicKeyOrTokenBlobIndex, 'cil-assembly-ref-public-key-blob-invalid');
    }
    let hashValue = null;
    if (hashValueBlobIndex !== 0) {
      if (!blobHeap) fail('cil-assembly-ref-hash-value-blob-missing');
      hashValue = readCilMetadataBlob(blobHeap, hashValueBlobIndex, 'cil-assembly-ref-hash-value-blob-invalid');
    }
    return {
      majorVersion: view.getUint16(pos, true),
      minorVersion: view.getUint16(pos + 2, true),
      buildNumber: view.getUint16(pos + 4, true),
      revisionNumber: view.getUint16(pos + 6, true),
      flags: view.getUint32(pos + 8, true),
      publicKeyOrTokenBlobIndex,
      publicKeyOrToken,
      name: requiredText(index(pos + 12 + b, s), 'cil-assembly-ref-name-required'),
      culture: text(index(pos + 12 + b + s, s)),
      hashValueBlobIndex,
      hashValue,
    };
  });
  const types = readRows(2, pos => {
    const base = index(pos + 4 + s * 2, extendsSize), table = [2, 1, 0x1b][base & 3], rid = Math.floor(base / 4);
    if (base !== 0 && (table == null || rid < 1 || rid > counts[table])) fail('cil-typedef-extends-invalid');
    return {
      accessFlags: view.getUint32(pos, true), name: text(index(pos + 4, s)),
      namespace: text(index(pos + 4 + s, s)) ?? '',
      extendsToken: base === 0 ? null : cilMetadataToken(table, rid),
      extendsTypeSpecRid: base !== 0 && table === 0x1b ? rid : null,
      extendsTypeRefRid: base !== 0 && table === 0x01 ? rid : null,
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
    if (type.extendsTypeRefRid != null) {
      type.extendsTypeRef = typeRefs[type.extendsTypeRefRid - 1];
      delete type.extendsTypeRefRid;
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
  // Param/ParamPtr authority. In an unoptimized #- stream MethodDef.ParamList
  // indexes ParamPtr when that table exists; the pointer target is the Param RID.
  const params = readRows(0x08, pos => ({
    flags: view.getUint16(pos, true),
    sequence: view.getUint16(pos + 2, true),
    name: text(index(pos + 4, s)),
  }));
  const paramSlots = counts[0x07]
    ? readRows(0x07, pos => ({ target:index(pos, tableIndexSize(counts, 0x08)) })).map(row => row.target)
    : params.map(row => row.rid);
  if (counts[0x07] && (paramSlots.length !== params.length
      || new Set(paramSlots).size !== paramSlots.length
      || paramSlots.some(rid => rid < 1 || rid > params.length))) fail('cil-param-pointer-table-invalid');
  const paramOwners = new Map();
  for (let i = 0; i < methods.length; i++) {
    const first = methods[i].paramList || paramSlots.length + 1;
    const last = methods[i + 1]?.paramList || paramSlots.length + 1;
    if (first < 1 || last < first || last > paramSlots.length + 1 || (i === 0 && first !== 1)) {
      fail('cil-param-list-invalid');
    }
    methods[i].params = [];
    for (let slot = first; slot < last; slot++) {
      const rid = paramSlots[slot - 1];
      if (paramOwners.has(rid)) fail('cil-param-owner-duplicate');
      paramOwners.set(rid, methods[i].token);
      methods[i].params.push(cilMetadataToken(0x08, rid));
    }
  }
  for (const param of params) {
    if (!paramOwners.has(param.rid)) fail('cil-param-owner-missing');
    if ((param.flags & ~0x301f) !== 0) fail('cil-param-flags-invalid');
    if (param.sequence === 0 && (param.flags & 0x0003) !== 0) fail('cil-param-return-direction-invalid');
    param.ownerToken = paramOwners.get(param.rid);
  }

  // Property/PropertyPtr + PropertyMap.
  const properties = readRows(0x17, pos => ({
    flags: view.getUint16(pos, true),
    name: text(index(pos + 2, s)),
    typeBlobIndex: index(pos + 2 + s, b),
  }));
  const propertySlots = counts[0x16]
    ? readRows(0x16, pos => ({ target:index(pos, tableIndexSize(counts, 0x17)) })).map(row => row.target)
    : properties.map(row => row.rid);
  if (counts[0x16] && (propertySlots.length !== properties.length || new Set(propertySlots).size !== propertySlots.length
      || propertySlots.some(rid => rid < 1 || rid > properties.length))) fail('cil-property-pointer-table-invalid');
  const propertyListTable = counts[0x16] ? 0x16 : 0x17;
  const propertyMaps = readRows(0x15, pos => ({
    parent: index(pos, tableIndexSize(counts, 0x02)),
    propertyList: index(pos + tableIndexSize(counts, 0x02), tableIndexSize(counts, propertyListTable)),
  }));
  const propertyOwners = new Map();
  for (let i = 0; i < propertyMaps.length; i++) {
    const { parent, propertyList } = propertyMaps[i];
    if (parent < 1 || parent > types.length) fail('cil-property-map-parent-invalid');
    const next = propertyMaps[i + 1]?.propertyList ?? propertySlots.length + 1;
    if (propertyList < 1 || next < propertyList || next > propertySlots.length + 1
        || (i === 0 && propertyList !== 1)) fail('cil-property-map-list-invalid');
    for (let slot = propertyList; slot < next; slot++) {
      const rid = propertySlots[slot - 1];
      if (propertyOwners.has(rid)) fail('cil-property-map-overlap');
      propertyOwners.set(rid, types[parent - 1].token);
    }
  }
  for (const property of properties) {
    if (property.name == null || !property.name.length) fail('cil-property-name-required');
    if (!propertyOwners.has(property.rid)) fail('cil-property-owner-missing');
    property.ownerToken = propertyOwners.get(property.rid);
  }

  // Event/EventPtr + EventMap.
  const events = readRows(0x14, pos => {
    const flags = view.getUint16(pos, true);
    const eventType = index(pos + 2 + s, codedIndexSize(counts, [0x02, 0x01, 0x1b], 2));
    if (eventType === 0) fail('cil-event-type-required');
    const table = [0x02, 0x01, 0x1b][eventType & 3];
    const rid = Math.floor(eventType / 4);
    if (table == null || rid < 1 || rid > counts[table]) fail('cil-event-type-invalid');
    return { flags, name:text(index(pos + 2, s)), eventTypeToken:cilMetadataToken(table, rid) };
  });
  const eventSlots = counts[0x13]
    ? readRows(0x13, pos => ({ target:index(pos, tableIndexSize(counts, 0x14)) })).map(row => row.target)
    : events.map(row => row.rid);
  if (counts[0x13] && (eventSlots.length !== events.length || new Set(eventSlots).size !== eventSlots.length
      || eventSlots.some(rid => rid < 1 || rid > events.length))) fail('cil-event-pointer-table-invalid');
  const eventListTable = counts[0x13] ? 0x13 : 0x14;
  const eventMaps = readRows(0x12, pos => ({
    parent: index(pos, tableIndexSize(counts, 0x02)),
    eventList: index(pos + tableIndexSize(counts, 0x02), tableIndexSize(counts, eventListTable)),
  }));
  const eventOwners = new Map();
  for (let i = 0; i < eventMaps.length; i++) {
    const { parent, eventList } = eventMaps[i];
    if (parent < 1 || parent > types.length) fail('cil-event-map-parent-invalid');
    const next = eventMaps[i + 1]?.eventList ?? eventSlots.length + 1;
    if (eventList < 1 || next < eventList || next > eventSlots.length + 1
        || (i === 0 && eventList !== 1)) fail('cil-event-map-list-invalid');
    for (let slot = eventList; slot < next; slot++) {
      const rid = eventSlots[slot - 1];
      if (eventOwners.has(rid)) fail('cil-event-map-overlap');
      eventOwners.set(rid, types[parent - 1].token);
    }
  }
  for (const event of events) {
    if (event.name == null || !event.name.length) fail('cil-event-name-required');
    if (!eventOwners.has(event.rid)) fail('cil-event-owner-missing');
    event.ownerToken = eventOwners.get(event.rid);
  }

  // MethodSemantics.Method is a plain MethodDef RID. Association is HasSemantics:
  // tag 0 Event, tag 1 Property. Semantic kind must match that association.
  const semanticKinds = new Map([[0x0001, 'setter'], [0x0002, 'getter'], [0x0004, 'other'],
    [0x0008, 'addOn'], [0x0010, 'removeOn'], [0x0020, 'fire']]);
  const methodIndexSize = tableIndexSize(counts, 0x06);
  const associationSize = codedIndexSize(counts, [0x14, 0x17], 1);
  const methodSemantics = readRows(0x18, pos => {
    const semantics = view.getUint16(pos, true);
    const kind = semanticKinds.get(semantics);
    if (!kind) fail('cil-method-semantics-kind-invalid');
    const methodRid = index(pos + 2, methodIndexSize);
    if (methodRid < 1 || methodRid > counts[0x06]) fail('cil-method-semantics-method-invalid');
    const encodedAssociation = index(pos + 2 + methodIndexSize, associationSize);
    const table = [0x14, 0x17][encodedAssociation & 1];
    const rid = Math.floor(encodedAssociation / 2);
    if (table == null || rid < 1 || rid > counts[table]) fail('cil-method-semantics-association-invalid');
    if ((table === 0x17 && !['setter', 'getter', 'other'].includes(kind))
        || (table === 0x14 && !['addOn', 'removeOn', 'fire', 'other'].includes(kind))) {
      fail('cil-method-semantics-association-kind-invalid');
    }
    return { semantics, kind, methodToken:cilMetadataToken(0x06, methodRid),
      association:{ table, rid, token:cilMetadataToken(table, rid) } };
  });

  for (const type of types) { type.propertyTokens = []; type.eventTokens = []; }
  for (const [rid, ownerToken] of propertyOwners) {
    types[(parseInt(ownerToken, 16) & 0xffffff) - 1].propertyTokens.push(cilMetadataToken(0x17, rid));
  }
  for (const [rid, ownerToken] of eventOwners) {
    types[(parseInt(ownerToken, 16) & 0xffffff) - 1].eventTokens.push(cilMetadataToken(0x14, rid));
  }

  const accessorSingletons = new Set(['setter', 'getter', 'addOn', 'removeOn', 'fire']);
  const seenSingleton = new Set(), seenRows = new Set(), seenAccessorMethod = new Set();
  const methodByToken = new Map(methods.map(method => [method.token, method]));
  for (const row of methodSemantics) {
    const { table, rid } = row.association;
    const owner = table === 0x17 ? properties[rid - 1] : events[rid - 1];
    if (methodByToken.get(row.methodToken)?.declaringTypeToken !== owner.ownerToken) {
      fail('cil-method-semantics-owner-mismatch');
    }
    const tuple = `${table}:${rid}:${row.kind}:${row.methodToken}`;
    if (seenRows.has(tuple)) fail('cil-method-semantics-duplicate');
    seenRows.add(tuple);
    if (accessorSingletons.has(row.kind)) {
      const key = `${table}:${rid}:${row.kind}`;
      if (seenSingleton.has(key)) fail('cil-method-semantics-accessor-duplicate');
      seenSingleton.add(key);
      const methodKey = `${table}:${rid}:${row.methodToken}`;
      if (seenAccessorMethod.has(methodKey)) fail('cil-method-semantics-method-conflict');
      seenAccessorMethod.add(methodKey);
    }
    (owner.accessors ??= []).push({ kind:row.kind, methodToken:row.methodToken });
  }

  // ECMA-335 II.22 tables that carry type-system relationships must reach the
  // canonical image: their rows are dispatch/inheritance authority, not
  // structural padding. Leaving them undecoded made the projection identical
  // with and without the rows — irreversible metadata data loss (#7491,
  // #7506, #7522).
  const resolveCoded = (base, tables, tagBits) => {
    const table = tables[base & ((1 << tagBits) - 1)];
    const rid = Math.floor(base >> tagBits);
    if (base === 0 || table == null || rid < 1 || rid > counts[table]) return null;
    return cilMetadataToken(table, rid);
  };
  const failIf = (condition, code) => { if (condition) fail(code); };

  // II.22.23 InterfaceImpl: Class implements Interface (TypeOrTypeDefOrRef
  // coded index, 2 tag bits). Class is a plain TypeDef index; Interface
  // inheritance uses the same table.
  const interfaceImplSize = codedIndexSize(counts, [0x02, 0x01, 0x1b], 2);
  const classIndexSize = tableIndexSize(counts, 2);
  const interfaceImpls = readRows(0x09, pos => {
    const classRid = index(pos, classIndexSize);
    const interfaceBase = index(pos + classIndexSize, interfaceImplSize);
    failIf(classRid < 1 || classRid > counts[2], 'cil-interfaceimpl-class-invalid');
    const interfaceToken = resolveCoded(interfaceBase, [0x02, 0x01, 0x1b], 2);
    failIf(interfaceToken == null, 'cil-interfaceimpl-interface-invalid');
    return { classToken: cilMetadataToken(2, classRid), interfaceToken };
  });
  const typeByToken = new Map(types.map(type => [type.token, type]));
  const interfaceEdges = new Map();
  for (const row of interfaceImpls) {
    const owner = typeByToken.get(row.classToken);
    if (owner == null) fail('cil-interfaceimpl-class-invalid');
    const list = interfaceEdges.get(row.classToken) ?? [];
    if (list.includes(row.interfaceToken)) fail('cil-interfaceimpl-duplicate');
    list.push(row.interfaceToken);
    interfaceEdges.set(row.classToken, list);
  }
  for (const type of types) type.interfaceTokens = Object.freeze(interfaceEdges.get(type.token) ?? []);

  // II.22.27 MethodImpl: Class implements MethodDeclaration with MethodBody.
  // MethodBody/MethodDeclaration share the MethodDefOrRef coded index
  // (MethodDef | MemberRef, 1 tag bit).
  const methodDefOrRefSize = codedIndexSize(counts, [0x06, 0x0a], 1);
  const methodImpls = readRows(0x19, pos => {
    const classRid = index(pos, classIndexSize);
    const bodyBase = index(pos + classIndexSize, methodDefOrRefSize);
    const declarationBase = index(pos + classIndexSize + methodDefOrRefSize, methodDefOrRefSize);
    failIf(classRid < 1 || classRid > counts[2], 'cil-methodimpl-class-invalid');
    const bodyToken = resolveCoded(bodyBase, [0x06, 0x0a], 1);
    const declarationToken = resolveCoded(declarationBase, [0x06, 0x0a], 1);
    failIf(bodyToken == null || declarationToken == null, 'cil-methodimpl-method-invalid');
    return { classToken: cilMetadataToken(2, classRid), methodBodyToken: bodyToken, methodDeclarationToken: declarationToken };
  });
  const overridesByClass = new Map();
  const seenImplDeclarations = new Set();
  // ECMA-335 II.22.27: an explicit override must be a virtual method pair
  // owned consistently by the Class, must not declare the same target twice,
  // and — where both signatures decode from the #Blob heap — must agree on
  // shape. Only the checks derivable from existing rows run here; MemberRef
  // targets keep their token-level binding (#7506).
  const CIL_METHOD_VIRTUAL = 0x0040;
  const typeDefOrRefRows = [counts[0x02] ?? 0, counts[0x01] ?? 0, counts[0x1b] ?? 0];
  for (const row of methodImpls) {
    const body = methodByToken.get(row.methodBodyToken);
    const declaration = methodByToken.get(row.methodDeclarationToken);
    if (body != null) {
      failIf((body.accessFlags & CIL_METHOD_VIRTUAL) === 0, 'cil-methodimpl-body-not-virtual');
      failIf(body.declaringTypeToken !== row.classToken, 'cil-methodimpl-body-owner-mismatch');
    }
    if (declaration != null) {
      failIf((declaration.accessFlags & CIL_METHOD_VIRTUAL) === 0, 'cil-methodimpl-declaration-not-virtual');
    }
    let decodedBodySig = null;
    let decodedDeclarationSig = null;
    if (body != null && declaration != null && blobHeap != null
        && Number.isSafeInteger(body.signatureBlobIndex) && Number.isSafeInteger(declaration.signatureBlobIndex)) {
      try {
        // Only blob/parse failures degrade (#7603/#7604); a decoded but
        // unequal pair is enforced below, outside this catch.
        decodedBodySig = parseCilMethodSignature(readCilMetadataBlob(blobHeap, body.signatureBlobIndex, 'cil-methodimpl-signature-invalid'), typeDefOrRefRows);
        decodedDeclarationSig = parseCilMethodSignature(readCilMetadataBlob(blobHeap, declaration.signatureBlobIndex, 'cil-methodimpl-signature-invalid'), typeDefOrRefRows);
      } catch {
        // Undecodable signatures keep the pinned degradation behavior
        // (#7603/#7604): the token-level binding stays, no extra authority.
      }
    }
    if (decodedBodySig != null && decodedDeclarationSig != null) {
      const canonicalSig = (sig) => ({
        callConvention: sig.callConvention,
        kind: sig.kind,
        hasThis: sig.hasThis,
        explicitThis: sig.explicitThis,
        genericParameterCount: sig.genericParameterCount ?? 0,
        sentinelIndex: sig.sentinelIndex ?? null,
        parameters: sig.parameters,
        returnValue: sig.returnValue,
      });
      failIf(stableStringify(canonicalSig(decodedBodySig))
        !== stableStringify(canonicalSig(decodedDeclarationSig)),
        'cil-methodimpl-signature-mismatch');
    }
    failIf(seenImplDeclarations.has(`${row.classToken}\u0000${row.methodDeclarationToken}`), 'cil-methodimpl-declaration-duplicate');
    seenImplDeclarations.add(`${row.classToken}\u0000${row.methodDeclarationToken}`);
    if (body != null) body.explicitOverrideTokens = Object.freeze([...(body.explicitOverrideTokens ?? []), row.methodDeclarationToken]);
    const list = overridesByClass.get(row.classToken) ?? [];
    if (list.some(entry => entry.methodDeclarationToken === row.methodDeclarationToken && entry.methodBodyToken === row.methodBodyToken)) {
      fail('cil-methodimpl-duplicate');
    }
    list.push(row);
    overridesByClass.set(row.classToken, list);
  }
  for (const type of types) type.methodImpls = Object.freeze(overridesByClass.get(type.token) ?? []);

  // II.22.22 ImplMap + II.22.30 ModuleRef: P/Invoke dispatch authority. A
  // mapped method must keep its unmanaged DLL, entrypoint and flags.
  const memberForwardedSize = codedIndexSize(counts, [0x04, 0x06], 1);
  const moduleRefs = readRows(0x1a, pos => ({ name: text(index(pos, s)) }));
  const implMaps = readRows(0x1c, pos => {
    const flags = view.getUint16(pos, true);
    const forwardedBase = index(pos + 2, memberForwardedSize);
    const importName = text(index(pos + 2 + memberForwardedSize, s));
    const scopeRid = index(pos + 2 + memberForwardedSize + s, tableIndexSize(counts, 0x1a));
    if ((forwardedBase & 1) !== 1) fail('cil-implmap-memberforwarded-not-methoddef');
    const methodRid = forwardedBase >> 1;
    failIf(methodRid < 1 || methodRid > counts[6], 'cil-implmap-memberforwarded-invalid');
    failIf(importName == null, 'cil-implmap-import-name-invalid');
    failIf(scopeRid < 1 || scopeRid > moduleRefs.length, 'cil-implmap-import-scope-invalid');
    return { mappingFlags: flags, memberForwardedToken: cilMetadataToken(6, methodRid), importName, importScope: moduleRefs[scopeRid - 1]?.name ?? null };
  });
  const pinvokeByMethod = new Map();
  for (const row of implMaps) {
    if (pinvokeByMethod.has(row.memberForwardedToken)) fail('cil-implmap-duplicate');
    pinvokeByMethod.set(row.memberForwardedToken, row);
  }
  for (const method of methods) {
    const mapping = pinvokeByMethod.get(method.token);
    if (mapping == null) {
      // II.22.22 rule 4: a MethodDef without an ImplMap row must not claim
      // pinvokeimpl.
      failIf((method.accessFlags & 0x2000) !== 0, 'cil-implmap-flag-without-row');
    } else {
      method.pinvoke = Object.freeze(mapping);
      if ((method.accessFlags & 0x2000) === 0) fail('cil-implmap-row-without-flag');
    }
  }
  // II.22.18 FieldRVA: a static field's initial data lives at an RVA in the
  // PE image. Without decoding it, changing the mapping or the backing bytes
  // never reaches the canonical image (#7545). Validation is fail-closed:
  // RVA != 0, the RVA must map inside the loaded PE image (it may not alias
  // the metadata root), and one Field binds at most one FieldRVA row.
  const fieldRvas = readRows(0x1d, pos => {
    const rva = view.getUint32(pos, true);
    const fieldRid = index(pos + 4, tableIndexSize(counts, 4));
    failIf(fieldRid < 1 || fieldRid > counts[4], 'cil-fieldrva-field-invalid');
    if (rva === 0) fail('cil-fieldrva-rva-required');
    return { rva, fieldToken: cilMetadataToken(4, fieldRid) };
  });
  if (new Set(fieldRvas.map(row => row.fieldToken)).size !== fieldRvas.length) {
    fail('cil-fieldrva-field-duplicate');
  }
  const fieldByToken = new Map(fields.map(field => [field.token, field]));
  for (const row of fieldRvas) {
    const field = fieldByToken.get(row.fieldToken);
    if (field == null) fail('cil-fieldrva-field-invalid');
    // II.23.1.5: a FieldRVA row targets a field carrying HasFieldRVA (0x0100);
    // binding initial data to a plain field contradicts its own attributes.
    if ((field.accessFlags & 0x0100) === 0) fail('cil-fieldrva-field-flag-missing');
    field.rva = row.rva;
  }

  // II.22.17 FieldMarshal: the managed -> native marshalling descriptor for a
  // Field or Param. The HasFieldMarshal flag alone only proves a descriptor
  // exists; without decoding it, two images whose native call boundary differs
  // (LPSTR vs LPWSTR) collapse into one canonical projection (#7557).
  const fieldMarshalTables = [0x04, 0x08];
  const hasFieldMarshalSize = codedIndexSize(counts, fieldMarshalTables, 1);
  // One truth: the semantic decode must agree with the physical row layout.
  if (counts[0x0d] && hasFieldMarshalSize + b !== rowSizes[0x0d]) fail('cil-fieldmarshal-row-layout-mismatch');
  const fieldMarshals = readRows(0x0d, pos => {
    const parentBase = index(pos, hasFieldMarshalSize);
    const nativeTypeBlobIndex = index(pos + hasFieldMarshalSize, b);
    const tag = parentBase & 0x1, rid = parentBase >>> 1, table = fieldMarshalTables[tag];
    failIf(table == null || rid < 1 || rid > counts[table], 'cil-fieldmarshal-parent-invalid');
    if (!blobHeap) fail('cil-fieldmarshal-blob-missing');
    const rawMarshalSpec = readCilMetadataBlob(blobHeap, nativeTypeBlobIndex, 'cil-fieldmarshal-native-type-blob-invalid');
    return {
      parentToken: cilMetadataToken(table, rid),
      parent: { table, rid, kind: table === 0x04 ? 'field' : 'param' },
      nativeTypeBlobIndex,
      rawMarshalSpec,
      marshalSpec: decodeMarshalSpec(rawMarshalSpec),
    };
  });
  if (new Set(fieldMarshals.map(row => row.parentToken)).size !== fieldMarshals.length) {
    fail('cil-fieldmarshal-parent-duplicate');
  }
  // A row and its HasFieldMarshal flag are one authority: neither direction of
  // the contradiction may survive into the canonical image (II.22.17).
  for (const row of fieldMarshals) {
    if (row.parent.table === 0x04) {
      const field = fields[row.parent.rid - 1];
      if (field == null) fail('cil-fieldmarshal-parent-invalid');
      if ((field.accessFlags & 0x1000) === 0) fail('cil-fieldmarshal-field-flag-missing');
      field.marshalSpec = row.marshalSpec;
      field.rawMarshalSpec = row.rawMarshalSpec;
      field.fieldMarshalToken = row.token;
    } else {
      const param = params[row.parent.rid - 1];
      if (param == null) fail('cil-fieldmarshal-parent-invalid');
      if ((param.flags & 0x2000) === 0) fail('cil-fieldmarshal-param-flag-missing');
      param.marshalSpec = row.marshalSpec;
      param.rawMarshalSpec = row.rawMarshalSpec;
      param.fieldMarshalToken = row.token;
    }
  }
  for (const field of fields) {
    if ((field.accessFlags & 0x1000) !== 0 && field.marshalSpec == null) fail('cil-fieldmarshal-row-missing');
  }
  for (const param of params) {
    if ((param.flags & 0x2000) !== 0 && param.marshalSpec == null) fail('cil-fieldmarshal-row-missing');
  }

  // II.22.21 MemberRef: the constructor authority a CustomAttribute row points
  // at, and the declaring-type identity needed to recognise CLI-defined
  // attributes such as System.ThreadStaticAttribute (#7556).
  const memberRefParentTables = [0x02, 0x01, 0x1a, 0x06, 0x1b];
  const memberRefParentSize = codedIndexSize(counts, memberRefParentTables, 3);
  if (counts[0x0a] && memberRefParentSize + s + b !== rowSizes[0x0a]) fail('cil-memberref-row-layout-mismatch');
  const methodOwner = new Map();
  for (let i = 0; i < types.length; i++) {
    const first = types[i].methodList || 1;
    const last = types[i + 1]?.methodList ?? methods.length + 1;
    for (let rid = first; rid < last && rid <= methods.length; rid++) methodOwner.set(rid, types[i]);
  }
  const declaringTypeName = (table, rid) => {
    let name = null, namespace = '';
    if (table === 0x01) { const row = typeRefs[rid - 1]; name = row?.name ?? null; namespace = row?.namespace ?? ''; }
    else if (table === 0x02) { const row = types[rid - 1]; name = row?.name ?? null; namespace = row?.namespace ?? ''; }
    else if (table === 0x1a) { name = moduleRefs[rid - 1]?.name ?? null; }
    else if (table === 0x06) { const row = methodOwner.get(rid); name = row?.name ?? null; namespace = row?.namespace ?? ''; }
    if (name == null) return null;
    return [namespace, name].filter(part => part != null && part !== '').join('.') || null;
  };
  const memberRefs = readRows(0x0a, pos => {
    const parentBase = index(pos, memberRefParentSize);
    const tag = parentBase & 0x7, rid = parentBase >>> 3, table = memberRefParentTables[tag];
    failIf(table == null || rid < 1 || rid > counts[table], 'cil-memberref-parent-invalid');
    const name = text(index(pos + memberRefParentSize, s));
    failIf(name == null || name.length === 0, 'cil-memberref-name-required');
    return {
      parentToken: cilMetadataToken(table, rid),
      parent: { table, rid },
      declaringTypeName: declaringTypeName(table, rid),
      name,
      signatureBlobIndex: index(pos + memberRefParentSize + s, b),
    };
  });

  // II.22.10 CustomAttribute: Parent + constructor + opaque value payload. A
  // runtime-affecting CLI-defined attribute is unrecoverable without all three,
  // so nothing here may be silently defaulted (#7556).
  const hasCustomAttributeTables = [0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x00, 0x0e, 0x17, 0x14,
    0x11, 0x1a, 0x1b, 0x20, 0x23, 0x26, 0x27, 0x28, 0x2a, 0x2c, 0x2b];
  const hasCustomAttributeSize = codedIndexSize(counts, hasCustomAttributeTables, 5);
  // CustomAttributeType tags: 2 = MethodDef, 3 = MemberRef (II.24.2.6).
  const customAttributeTypeSize = codedIndexSize(counts, [0x06, 0x0a], 3);
  if (counts[0x0c] && hasCustomAttributeSize + customAttributeTypeSize + b !== rowSizes[0x0c]) {
    fail('cil-customattribute-row-layout-mismatch');
  }
  const customAttributeTypeTables = new Map([[2, 0x06], [3, 0x0a]]);
  const memberRefByToken = new Map(memberRefs.map(row => [row.token, row]));
  const customAttributes = readRows(0x0c, pos => {
    const parentBase = index(pos, hasCustomAttributeSize);
    const typeBase = index(pos + hasCustomAttributeSize, customAttributeTypeSize);
    const valueBlobIndex = index(pos + hasCustomAttributeSize + customAttributeTypeSize, b);
    const parentTag = parentBase & 0x1f, parentRid = parentBase >>> 5;
    const parentTable = hasCustomAttributeTables[parentTag];
    failIf(parentTable == null || parentRid < 1 || parentRid > counts[parentTable], 'cil-customattribute-parent-invalid');
    const constructorTag = typeBase & 0x7, constructorRid = typeBase >>> 3;
    const constructorTable = customAttributeTypeTables.get(constructorTag);
    failIf(constructorTable == null || constructorRid < 1 || constructorRid > counts[constructorTable], 'cil-customattribute-constructor-invalid');
    const constructorToken = cilMetadataToken(constructorTable, constructorRid);
    let constructorName = null, ownerName = null;
    if (constructorTable === 0x0a) {
      const memberRef = memberRefByToken.get(constructorToken);
      failIf(memberRef == null, 'cil-customattribute-constructor-invalid');
      constructorName = memberRef.name;
      ownerName = memberRef.declaringTypeName;
    } else {
      const method = methods[constructorRid - 1];
      failIf(method == null, 'cil-customattribute-constructor-invalid');
      constructorName = method.name;
      ownerName = declaringTypeName(0x06, constructorRid);
    }
    let rawValue = null, prolog = null, numNamed = null;
    if (valueBlobIndex !== 0) {
      if (!blobHeap) fail('cil-customattribute-value-blob-missing');
      rawValue = readCilMetadataBlob(blobHeap, valueBlobIndex, 'cil-customattribute-value-blob-invalid');
      // II.23.3 custom attribute values start with the 0x0001 prolog followed by
      // the named-argument count; a shorter payload cannot be a valid value.
      if (rawValue.length < 4 || rawValue[0] !== 0x01 || rawValue[1] !== 0x00) fail('cil-customattribute-value-invalid');
      prolog = 0x0001;
      numNamed = rawValue[2] | (rawValue[3] << 8);
    }
    return {
      parentToken: cilMetadataToken(parentTable, parentRid),
      parent: { table: parentTable, rid: parentRid },
      constructorToken,
      constructor: { table: constructorTable, rid: constructorRid, name: constructorName, declaringType: ownerName },
      attributeTypeName: ownerName != null && constructorName != null ? `${ownerName}::${constructorName}` : null,
      valueBlobIndex,
      prolog,
      numNamed,
      rawValue,
    };
  });

  // An attribute is authority for its Parent, so the owning canonical row also
  // carries it (the same way a Field carries its FieldRVA). Parent kinds without
  // a decoded row array stay represented by the canonical table alone.
  const customAttributeParents = {
    0x01: typeRefs, 0x02: types, 0x04: fields, 0x06: methods, 0x08: params,
    0x0a: memberRefs, 0x14: events, 0x17: properties, 0x1a: moduleRefs,
    0x1b: typeSpecs, 0x23: assemblyRefs, 0x28: manifestResources,
  };
  for (const attribute of customAttributes) {
    const owner = customAttributeParents[attribute.parent.table]?.[attribute.parent.rid - 1];
    if (owner == null) continue;
    owner.attributes = [...(owner.attributes ?? []), attribute];
  }

  return { types, methods, fields, manifestResources, typeSpecs, typeRefs, memberRefs, assemblyRefs, assembly, params, properties, events, methodSemantics, interfaceImpls, methodImpls, implMaps, moduleRefs, fieldRvas, fieldMarshals, customAttributes };
}
