import { codedIndexSize, tableIndexSize, cilMetadataToken } from './metadata-layout.js';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function fail(code) { throw new TypeError(code); }

// Read only definitions, but use the complete, already-bounds-checked table layout.
export function readCilDefinitions(bytes, view, layout, stringsStream) {
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
  // ECMA-335 II.22.33 Param (0x08): Flags / Sequence / Name. MethodDef rows
  // keep only the ParamList start RID; without decoding the rows the
  // In/Out marshalling-direction authority vanished from the image (#7623).
  const paramRowCount = counts[8];
  const paramOwners = new Map();
  for (let i = 0; i < methods.length; i++) {
    // A 0 ParamList (legacy sparse rows) carries no parameters.
    const first = methods[i].paramList || paramRowCount + 1;
    const last = methods[i + 1]?.paramList || paramRowCount + 1;
    if (first < 1 || last < first || last > paramRowCount + 1 || (i === 0 && first !== 1)) {
      fail('cil-param-list-invalid');
    }
    for (let slot = first; slot < last; slot++) {
      if (paramOwners.has(slot)) fail('cil-param-owner-duplicate');
      paramOwners.set(slot, methods[i].token);
    }
  }
  const params = readRows(8, pos => ({
    flags: view.getUint16(pos, true),
    sequence: view.getUint16(pos + 2, true),
    name: text(index(pos + 4, s)),
  }));
  for (const param of params) {
    if (!paramOwners.has(param.rid)) fail('cil-param-owner-missing');
    // II.23.1.13 ParamAttributes: defined bits are In 0x0001, Out 0x0002,
    // Lcid 0x0004, Retval 0x0008, Optional 0x0010, HasDefault 0x1000,
    // HasFieldMarshal 0x2000. Reserved bits must not pass.
    if (param.flags & ~0x3013) fail('cil-param-flags-invalid');
    // The return parameter (Sequence 0) carries no direction authority.
    if (param.sequence === 0 && (param.flags & 0x0003) !== 0) fail('cil-param-return-direction-invalid');
  }
  // Bind param tokens onto their owning MethodDef row (position-ordered).
  for (let i = 0; i < methods.length; i++) {
    const first = methods[i].paramList || paramRowCount + 1;
    const last = methods[i + 1]?.paramList || paramRowCount + 1;
    methods[i].params = Array.from({ length: last - first }, (_, offset) => cilMetadataToken(8, first + offset));
  }
  for (const param of params) param.ownerToken = paramOwners.get(param.rid) ?? null;
  // ECMA-335 II.22.35 PropertyMap (0x15): Parent TypeDef / PropertyList.
  // Dropping these rows discarded property identity and its accessor binding
  // from the canonical image (#7637).
  const propertyRowCount = counts[0x17];
  const properties = readRows(0x17, pos => ({
    flags: view.getUint16(pos, true),
    name: text(index(pos + 2, s)),
    typeBlobIndex: index(pos + 2 + s, b),
  }));
  const propertyMaps = readRows(0x15, pos => ({
    parent: index(pos, tableIndexSize(counts, 2)),
    propertyList: index(pos + tableIndexSize(counts, 2), tableIndexSize(counts, 0x17)),
  }));
  const propertyOwners = new Map();
  for (let i = 0; i < propertyMaps.length; i++) {
    const { parent, propertyList } = propertyMaps[i];
    if (parent < 1 || parent > types.length) fail('cil-property-map-parent-invalid');
    const next = propertyMaps[i + 1]?.propertyList ?? propertyRowCount + 1;
    if (propertyList < 1 || next < propertyList || next > propertyRowCount + 1
        || (i === 0 && propertyList !== 1)) fail('cil-property-map-list-invalid');
    for (let rid = propertyList; rid < next; rid++) {
      if (propertyOwners.has(rid)) fail('cil-property-map-overlap');
      propertyOwners.set(rid, types[parent - 1].token);
    }
  }
  for (const property of properties) {
    if (!propertyOwners.has(property.rid)) fail('cil-property-owner-missing');
    property.ownerToken = propertyOwners.get(property.rid);
  }
  // ECMA-335 II.22.28 MethodSemantics (0x18): Semantics / Method / Association.
  // MethodDef ↔ getter/setter/other accessor binding for properties (#7637)
  // and events (#7659).
  const semanticKinds = new Map([[0x0001, 'setter'], [0x0002, 'getter'], [0x0004, 'other'],
    [0x0008, 'addOn'], [0x0010, 'removeOn'], [0x0020, 'fire']]);
  const hasSemanticsSize = codedIndexSize(counts, [0x14, 0x17], 1);
  const hasSemanticsTables = [0x14, 0x17];
  const methodSemantics = readRows(0x18, pos => {
    const semantics = view.getUint16(pos, true);
    // II.22.28: the Method column is a plain MethodDef table index — NOT a
    // MethodDefOrRef coded index. Reading it as coded shifted every rid by the
    // tag bit and widened the row when MemberRef grew past the 1-byte coded
    // threshold, corrupting both the Method binding and the Association
    // offset (#7637 review).
    const methodIndexSize = tableIndexSize(counts, 6);
    const methodRid = index(pos + 2, methodIndexSize);
    const association = index(pos + 2 + methodIndexSize, hasSemanticsSize);
    if (!semanticKinds.has(semantics)) fail('cil-method-semantics-kind-invalid');
    if (methodRid < 1 || methodRid > counts[6]) fail('cil-method-semantics-method-invalid');
    const assocTable = hasSemanticsTables[association & 1];
    const assocRid = Math.floor(association / 2);
    if (assocTable == null || assocRid < 1 || assocRid > counts[assocTable]) fail('cil-method-semantics-association-invalid');
    return { semantics, methodToken: cilMetadataToken(6, methodRid), association: { table: assocTable, rid: assocRid, token: cilMetadataToken(assocTable, assocRid) } };
  });
  // ECMA-335 II.22.13 EventMap (0x12): Parent TypeDef / EventList; II.22.12
  // Event (0x14): Flags / Name / EventType. Dropping these rows discarded the
  // event identity and its add/remove/fire accessor binding (#7659).
  const eventRowCount = counts[0x14];
  const events = readRows(0x14, pos => {
    const flags = view.getUint16(pos, true);
    const eventType = index(pos + 2 + s, codedIndexSize(counts, [0x02, 0x01, 0x1b], 2));
    let typeToken = null;
    if (eventType !== 0) {
      const table = [0x02, 0x01, 0x1b][eventType & 3];
      const rid = Math.floor(eventType / 4);
      if (table == null || rid < 1 || rid > counts[table]) fail('cil-event-type-invalid');
      typeToken = cilMetadataToken(table, rid);
    }
    return { flags, name: text(index(pos + 2, s)), ...(typeToken ? { eventTypeToken: typeToken } : {}) };
  });
  const eventMaps = readRows(0x12, pos => ({
    parent: index(pos, tableIndexSize(counts, 2)),
    eventList: index(pos + tableIndexSize(counts, 2), tableIndexSize(counts, 0x14)),
  }));
  const eventOwners = new Map();
  for (let i = 0; i < eventMaps.length; i++) {
    const { parent, eventList } = eventMaps[i];
    if (parent < 1 || parent > types.length) fail('cil-event-map-parent-invalid');
    const next = eventMaps[i + 1]?.eventList ?? eventRowCount + 1;
    if (eventList < 1 || next < eventList || next > eventRowCount + 1
        || (i === 0 && eventList !== 1)) fail('cil-event-map-list-invalid');
    for (let rid = eventList; rid < next; rid++) {
      if (eventOwners.has(rid)) fail('cil-event-map-overlap');
      eventOwners.set(rid, types[parent - 1].token);
    }
  }
  for (const event of events) {
    if (!eventOwners.has(event.rid)) fail('cil-event-owner-missing');
    event.ownerToken = eventOwners.get(event.rid);
  }
  // Bind accessors + member lists onto TypeDef rows, then publish.
  for (const type of types) { type.propertyTokens = []; type.eventTokens = []; }
  for (const [rid, ownerToken] of propertyOwners) {
    const type = types[(parseInt(ownerToken, 16) & 0xffffff) - 1];
    type.propertyTokens.push(cilMetadataToken(0x17, rid));
  }
  for (const [rid, ownerToken] of eventOwners) {
    const type = types[(parseInt(ownerToken, 16) & 0xffffff) - 1];
    type.eventTokens.push(cilMetadataToken(0x14, rid));
  }
  for (const row of methodSemantics) {
    const { table, rid } = row.association;
    if (table === 0x17) {
      const property = properties[rid - 1];
      (property.accessors ??= []).push({ kind: semanticKinds.get(row.semantics), methodToken: row.methodToken });
    } else {
      const event = events[rid - 1];
      (event.accessors ??= []).push({ kind: semanticKinds.get(row.semantics), methodToken: row.methodToken });
    }
  }
  // Publish param/property/event surfaces on the image.
  return { types, methods, fields, manifestResources, params, properties, events, methodSemantics };
}
