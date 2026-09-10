import { codedIndexSize, tableIndexSize, cilMetadataToken } from './metadata-layout.js';
import { readCilMetadataBlob } from './call-signature-metadata.js';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function fail(code) { throw new TypeError(code); }

// Read only definitions, but use the complete, already-bounds-checked table layout.
export function readCilDefinitions(bytes, view, layout, stringsStream, blobHeap = null) {
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
    paramList: index(pos + 8 + s + b, tableIndexSize(counts, counts[7] ? 7 : 8)),
  }));
  const fields = readRows(4, pos => ({
    accessFlags: view.getUint16(pos, true), name: text(index(pos + 2, s)),
    signatureBlobIndex: index(pos + 2 + s, b),
  }));
  const extendsSize = codedIndexSize(counts, [2, 1, 0x1b], 2);
  const types = readRows(2, pos => {
    const base = index(pos + 4 + s * 2, extendsSize), table = [2, 1, 0x1b][base & 3], rid = Math.floor(base / 4);
    if (base !== 0 && (table == null || rid < 1 || rid > counts[table])) fail('cil-typedef-extends-invalid');
    return {
      accessFlags: view.getUint32(pos, true), name: text(index(pos + 4, s)),
      namespace: text(index(pos + 4 + s, s)) ?? '',
      extendsToken: base === 0 ? null : cilMetadataToken(table, rid),
      fieldList: index(pos + 4 + s * 2 + extendsSize, tableIndexSize(counts, 4)),
      methodList: index(pos + 4 + s * 2 + extendsSize + tableIndexSize(counts, 4), tableIndexSize(counts, 6)),
    };
  });
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
  // ECMA-335 II.22.19 File (0x26): the assembly manifest's external file /
  // netmodule authority — Flags, Name, HashValue (#Blob). Only the physical
  // row size was known, so multi-module file identity and its manifest hash
  // authority vanished from the canonical image (#7803).
  const validManifestFileName = name => {
    const dot = name.lastIndexOf('.');
    return dot > 0 && dot < name.length - 1 && !/[\\/:]/.test(name);
  };
  const files = readRows(0x26, pos => {
    const flags = view.getUint32(pos, true);
    // II.22.19: Flags is 0x0000 (ContainsMetaData) or 0x0001
    // (ContainsNoMetaData); every other bit is reserved.
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
  // A manifest module must not list itself in File. The Module row's Name is
  // the exact identity available at this layer; if either table is absent,
  // leave legacy/minimal metadata behavior untouched.
  if ((counts[0x20] || 0) > 0 && (counts[0x00] || 0) > 0) {
    const moduleName = text(index(offsets[0x00] + 2, s));
    if (moduleName != null && files.some(file => file.name === moduleName)) {
      fail('cil-file-self-reference');
    }
  }
  // ECMA-335 II.22.14 ExportedType (0x27): exported type / type-forwarder
  // declarations — Flags, TypeDefId, TypeName, TypeNamespace, Implementation
  // (File | AssemblyRef | ExportedType coded index, never null). Dropping
  // this table erased type-forwarding edges, collapsing assemblies with
  // different public type surfaces into one canonical image (#7800).
  const exportedImplementationSize = codedIndexSize(counts, [0x26, 0x23, 0x27], 2);
  const exportedImplementationTables = [0x26, 0x23, 0x27];
  const TYPE_VISIBILITY_MASK = 0x00000007;
  const TYPE_PUBLIC = 0x00000001;
  const TYPE_NESTED_PUBLIC = 0x00000002;
  const TYPE_FORWARDER = 0x00200000;
  const exportedTypes = readRows(0x27, pos => {
    const flags = view.getUint32(pos, true);
    const typeDefId = view.getUint32(pos + 4, true);
    const typeName = text(index(pos + 8, s));
    if (typeName == null || !typeName.length) fail('cil-exported-type-name-required');
    const typeNamespace = text(index(pos + 8 + s, s)) ?? '';
    const implementation = index(pos + 8 + s * 2, exportedImplementationSize);
    if (implementation === 0) fail('cil-exported-type-implementation-required');
    const table = exportedImplementationTables[implementation & 0x3];
    const rid = Math.floor(implementation / 4);
    if (table == null || rid < 1 || rid > counts[table]) fail('cil-exported-type-implementation-invalid');
    const isForwarder = (flags & TYPE_FORWARDER) !== 0;
    if (isForwarder && typeDefId !== 0) fail('cil-exported-type-forwarder-typedefid-invalid');
    if (isForwarder && table !== 0x23) fail('cil-exported-type-forwarder-implementation-invalid');
    if (table === 0x23 && !isForwarder) fail('cil-exported-type-assemblyref-forwarder-required');
    const visibility = flags & TYPE_VISIBILITY_MASK;
    if (table === 0x26 && visibility !== TYPE_PUBLIC) fail('cil-exported-type-file-visibility-invalid');
    if (table === 0x27 && visibility !== TYPE_NESTED_PUBLIC) fail('cil-exported-type-nested-visibility-invalid');
    if (table === 0x27 && typeNamespace.length !== 0) fail('cil-exported-type-nested-namespace-invalid');
    return {
      flags, typeDefId, typeName, typeNamespace,
      implementation: { table, rid, token: cilMetadataToken(table, rid) },
      isForwarder,
    };
  });
  const resolveExportedImplementation = row => {
    const seen = new Set([row.rid]);
    let implementation = row.implementation;
    while (implementation.table === 0x27) {
      if (seen.has(implementation.rid)) fail('cil-exported-type-implementation-cycle');
      seen.add(implementation.rid);
      const target = exportedTypes[implementation.rid - 1];
      if (!target) fail('cil-exported-type-implementation-invalid');
      implementation = target.implementation;
    }
    return { ...implementation };
  };
  for (const row of exportedTypes) {
    row.resolvedImplementation = resolveExportedImplementation(row);
  }
  // ECMA-335 II.22.11 DeclSecurity (0x0E): declarative security authority —
  // Action + Parent (HasDeclSecurity coded: TypeDef | MethodDef | Assembly) +
  // PermissionSet (#Blob). Only the physical row size was known, so Demand /
  // Assert / Deny / PermitOnly semantics vanished from the canonical image
  // and Action-only deltas collapsed (#7632).
  const declSecurityParentSize = codedIndexSize(counts, [0x02, 0x06, 0x20], 2);
  const declSecurityParentTables = [0x02, 0x06, 0x20];
  // CorDeclSecurity defines the metadata action domain from Request (0x0001)
  // through DemandChoice (0x0012), including the Prejit, NonCAS, and Choice
  // actions. Preserve every defined raw action; reject nil/out-of-domain values.
  const DECL_SECURITY_ACTION_MIN = 0x0001;
  const DECL_SECURITY_ACTION_MAX = 0x0012;
  const TYPE_HAS_SECURITY = 0x00040000;
  const METHOD_HAS_SECURITY = 0x4000;
  const declSecurity = readRows(0x0e, pos => {
    const action = view.getUint16(pos, true);
    if (action < DECL_SECURITY_ACTION_MIN || action > DECL_SECURITY_ACTION_MAX) {
      fail('cil-declsecurity-action-invalid');
    }
    const parent = index(pos + 2, declSecurityParentSize);
    const parentTable = declSecurityParentTables[parent & 0x3];
    const parentRid = Math.floor(parent / 4);
    if (parentTable == null || parentRid < 1 || parentRid > counts[parentTable]) {
      fail('cil-declsecurity-parent-invalid');
    }
    if (parentTable === 0x02 && (types[parentRid - 1].accessFlags & TYPE_HAS_SECURITY) === 0) {
      fail('cil-declsecurity-parent-security-flag-missing');
    }
    if (parentTable === 0x06 && (methods[parentRid - 1].accessFlags & METHOD_HAS_SECURITY) === 0) {
      fail('cil-declsecurity-parent-security-flag-missing');
    }
    const permissionSetBlobIndex = index(pos + 2 + declSecurityParentSize, b);
    if (permissionSetBlobIndex === 0) fail('cil-declsecurity-permission-set-required');
    if (!blobHeap) fail('cil-declsecurity-permission-set-blob-missing');
    const permissionSet = readCilMetadataBlob(blobHeap, permissionSetBlobIndex,
      'cil-declsecurity-permission-set-blob-invalid');
    return {
      action,
      parent: { table: parentTable, rid: parentRid, token: cilMetadataToken(parentTable, parentRid) },
      permissionSetBlobIndex,
      permissionSet,
    };
  });
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

  return { types, methods, fields, manifestResources, files, exportedTypes, declSecurity, params, properties, events, methodSemantics };
}