import { codedIndexSize, tableIndexSize, cilMetadataToken } from './metadata-layout.js';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function fail(code) { throw new TypeError(code); }

// Decode the GenericParam / GenericParamConstraint authority after the shared
// metadata layout has been validated. Raw table row order stays lossless;
// bound TypeDef/MethodDef semantic views are canonicalized by Number/token.
export function readCilGenericMetadata(bytes, view, layout, stringsStream, defs) {
  const { rowCounts: counts, tableOffsets: offsets, rowSizes, heapSizes } = layout;
  const s = heapSizes & 1 ? 4 : 2;
  const index = (pos, width) => width === 2 ? view.getUint16(pos, true) : view.getUint32(pos, true);
  const requiredText = (value) => {
    if (value === 0 || !stringsStream || value >= stringsStream.size) fail('cil-generic-param-name-required');
    const start = stringsStream.offset + value, end = stringsStream.offset + stringsStream.size;
    let pos = start;
    while (pos < end && bytes[pos] !== 0) pos++;
    if (pos === end) fail('cil-definition-string-unterminated');
    let valueText;
    try { valueText = utf8.decode(bytes.subarray(start, pos)); }
    catch { fail('cil-invalid-strings-utf8'); }
    if (valueText.length === 0) fail('cil-generic-param-name-required');
    return valueText;
  };
  const readRows = (table, decode) => Array.from({ length: counts[table] }, (_, i) => {
    const rid = i + 1, pos = offsets[table] + i * rowSizes[table];
    return { rid, token: cilMetadataToken(table, rid), ...decode(pos) };
  });

  const ownerSize = codedIndexSize(counts, [0x02, 0x06], 1);
  const genericParams = readRows(0x2a, pos => {
    const number = view.getUint16(pos, true);
    const flags = view.getUint16(pos + 2, true);
    const ownerBase = index(pos + 4, ownerSize);
    const ownerTable = [0x02, 0x06][ownerBase & 1];
    const ownerRid = Math.floor(ownerBase / 2);
    if (ownerBase === 0 || ownerTable == null || ownerRid < 1 || ownerRid > counts[ownerTable]) {
      fail('cil-generic-param-owner-invalid');
    }
    if ((flags & ~0x001f) !== 0 || (flags & 0x0003) === 0x0003) fail('cil-generic-param-flags-invalid');
    return {
      number,
      flags,
      ownerToken: cilMetadataToken(ownerTable, ownerRid),
      name: requiredText(index(pos + 4 + ownerSize, s)),
      constraintTokens: [],
    };
  });

  const numbersByOwner = new Map();
  for (const row of genericParams) {
    const numbers = numbersByOwner.get(row.ownerToken) ?? [];
    if (numbers.includes(row.number)) fail('cil-generic-param-number-duplicate');
    numbers.push(row.number);
    numbersByOwner.set(row.ownerToken, numbers);
  }
  for (const numbers of numbersByOwner.values()) {
    const ordered = [...numbers].sort((a, b) => a - b);
    if (ordered.some((value, i) => value !== i)) fail('cil-generic-param-number-invalid');
  }

  const targetSize = codedIndexSize(counts, [0x02, 0x01, 0x1b], 2);
  const constraintOwnerSize = tableIndexSize(counts, 0x2a);
  const genericParamConstraints = readRows(0x2c, pos => {
    const ownerRid = index(pos, constraintOwnerSize);
    if (ownerRid < 1 || ownerRid > counts[0x2a]) fail('cil-generic-param-constraint-owner-invalid');
    const targetBase = index(pos + constraintOwnerSize, targetSize);
    const targetTable = [0x02, 0x01, 0x1b][targetBase & 3];
    const targetRid = Math.floor(targetBase / 4);
    if (targetBase === 0 || targetTable == null || targetRid < 1 || targetRid > counts[targetTable]) {
      fail('cil-generic-param-constraint-target-invalid');
    }
    return {
      ownerToken: cilMetadataToken(0x2a, ownerRid),
      constraintToken: cilMetadataToken(targetTable, targetRid),
    };
  });

  const byToken = new Map(genericParams.map(row => [row.token, row]));
  const seenEdges = new Set();
  for (const row of genericParamConstraints) {
    const param = byToken.get(row.ownerToken);
    if (param == null) fail('cil-generic-param-constraint-owner-invalid');
    const edge = `${row.ownerToken}\u0000${row.constraintToken}`;
    if (seenEdges.has(edge)) fail('cil-generic-param-constraint-duplicate');
    seenEdges.add(edge);
    param.constraintTokens.push(row.constraintToken);
  }
  for (const param of genericParams) param.constraintTokens.sort();

  const byOwner = new Map();
  for (const row of genericParams) {
    const list = byOwner.get(row.ownerToken) ?? [];
    list.push(row);
    byOwner.set(row.ownerToken, list);
  }
  for (const [ownerToken, list] of byOwner) {
    const owner = parseInt(ownerToken, 16);
    const ownerRow = (owner >>> 24) === 2
      ? defs.types[(owner & 0xffffff) - 1]
      : defs.methods[(owner & 0xffffff) - 1];
    if (ownerRow == null) fail('cil-generic-param-owner-invalid');
    ownerRow.genericParams = Object.freeze([...list].sort((a, b) => a.number - b.number));
  }

  return { genericParams, genericParamConstraints };
}
