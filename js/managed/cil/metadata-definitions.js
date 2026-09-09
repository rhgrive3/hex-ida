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
  const methodByToken = new Map(methods.map(method => [method.token, method]));
  const overridesByClass = new Map();
  for (const row of methodImpls) {
    const body = methodByToken.get(row.methodBodyToken);
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

  return { types, methods, fields, interfaceImpls, methodImpls, implMaps, moduleRefs, fieldRvas };
}
