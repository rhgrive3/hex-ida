// Byte-level fixture builder. It intentionally does not reuse production layout code.
const align = n => Math.ceil(n / 4) * 4;
const utf8 = s => new TextEncoder().encode(s);
export function cilTables(rows = new Map()) {
  const entries = [...rows].sort(([a], [b]) => a - b);
  const length = 24 + entries.length * 4 + entries.reduce((n, [, r]) => n + r.bytes.length, 0);
  const bytes = new Uint8Array(align(length)), v = new DataView(bytes.buffer);
  bytes[4] = 2; bytes[7] = 1;
  let valid = 0n, pos = 24;
  for (const [table, r] of entries) { valid |= 1n << BigInt(table); v.setUint32(pos, r.count, true); pos += 4; }
  v.setBigUint64(8, valid, true);
  const offsets = new Map();
  for (const [table, r] of entries) { offsets.set(table, pos); bytes.set(r.bytes, pos); pos += r.bytes.length; }
  return { bytes, offsets, logicalLength: length };
}
export function buildCil(options = {}) {
  const definitions = options.methods ?? [{ name: 'Run', owner: 0, body: [0x2a] }];
  const typeDefs = options.types ?? [{ name: 'Widget', namespace: 'Example', methodList: 1, fieldList: 1 }];
  const fieldDefs = options.fields ?? [];
  const strings = [0], stringIndex = s => {
    if (!s) return 0;
    const i = strings.length; strings.push(...utf8(s), 0); return i;
  };
  // Names needed by opaque extra rows (e.g. ManifestResource) must be in the
  // heap before rows are built; leading strings get deterministic low indexes.
  const leadingStringIndex = {};
  for (const s of options.leadingStrings ?? []) {
    leadingStringIndex[s] = stringIndex(s);
  }
  // Additive heap extension: per-method/per-table signature blobs appended after
  // the legacy 8-byte heap so existing fixtures stay byte-identical.
  // options.blobBytes (when given) replaces the legacy heap wholesale — used by
  // fixtures that need exact #Blob control (e.g. assembly PublicKey authority);
  // without it the default heap keeps every pre-existing fixture byte-identical.
  const blobBytes = options.blobBytes ? [...options.blobBytes] : [0, 3, 0, 0, 1, 2, 6, 8];
  const addBlob = bytes => {
    const index = blobBytes.length;
    blobBytes.push(bytes.length, ...bytes);
    return index;
  };
  const blobIndexes = (options.blobs ?? []).map(addBlob);
  const methods = new Uint8Array(definitions.length * 14), mv = new DataView(methods.buffer);
  const types = new Uint8Array(typeDefs.length * 14), tv = new DataView(types.buffer);
  const fields = new Uint8Array(fieldDefs.length * 6), fv = new DataView(fields.buffer);
  const bodyOffsets = [];
  definitions.forEach((m, i) => {
    const bodyOffset = m.body == null ? null : m.shareWith != null ? bodyOffsets[m.shareWith] : 0x1800 + i * 0x40;
    bodyOffsets.push(bodyOffset);
    mv.setUint32(i * 14, bodyOffset == null ? 0 : 0x2000 + bodyOffset - 0x200, true);
    mv.setUint16(i * 14 + 6, m.flags ?? (bodyOffset == null ? 0x416 : 0x16), true);
    mv.setUint16(i * 14 + 8, stringIndex(m.name), true);
    mv.setUint16(i * 14 + 10, m.signature == null ? 1 : addBlob(m.signature), true);
    mv.setUint16(i * 14 + 12, 1, true);
  });
  typeDefs.forEach((t, i) => {
    tv.setUint32(i * 14, t.flags ?? 1, true);
    tv.setUint16(i * 14 + 4, stringIndex(t.name), true);
    tv.setUint16(i * 14 + 6, stringIndex(t.namespace), true);
    tv.setUint16(i * 14 + 8, t.extends ?? 0, true);
    tv.setUint16(i * 14 + 10, t.fieldList ?? 1, true);
    tv.setUint16(i * 14 + 12, t.methodList ?? 1, true);
  });
  fieldDefs.forEach((f, i) => {
    fv.setUint16(i * 6, f.flags ?? 6, true);
    fv.setUint16(i * 6 + 2, stringIndex(f.name), true);
    fv.setUint16(i * 6 + 4, f.signature == null ? 5 : addBlob(f.signature), true);
  });
  // Optional StandAloneSig rows (locals signatures) for fat bodies.
  const standaloneSig = options.standAloneSigs ?? [];
  const saSig = new Uint8Array(standaloneSig.length * 2), sv = new DataView(saSig.buffer);
  standaloneSig.forEach((sig, i) => { sv.setUint16(i * 2, addBlob(sig), true); });
  const extraRows = [...(options.extraRows ?? [])];
  if (standaloneSig.length) extraRows.push([0x11, { count: standaloneSig.length, bytes: saSig }]);
  const rows = new Map();
  if (typeDefs.length) rows.set(2, { count: typeDefs.length, bytes: types });
  if (fieldDefs.length) rows.set(4, { count: fieldDefs.length, bytes: fields });
  if (definitions.length) rows.set(6, { count: definitions.length, bytes: methods });
  for (const [k, val] of extraRows) rows.set(k, val);
  const tables = cilTables(rows);
  const pad = b => { const p = new Uint8Array(align(b.length)); p.set(b); return p; };
  const streams = options.streams ?? [
    { name: options.tableName ?? '#~', bytes: tables.bytes },
    { name: '#Strings', bytes: pad(Uint8Array.from(strings)) },
    { name: '#Blob', bytes: pad(Uint8Array.from(blobBytes)) },
    ...(options.extraStreams ?? []),
  ];
  const bytes = new Uint8Array(0x3000), v = new DataView(bytes.buffer);
  bytes.set([0x4d, 0x5a]); v.setUint32(0x3c, 0x80, true); bytes.set([0x50, 0x45, 0, 0], 0x80);
  v.setUint16(0x84, 0x14c, true); v.setUint16(0x86, 1, true); v.setUint16(0x94, 0xe0, true);
  const opt = 0x98; v.setUint16(opt, 0x10b, true); v.setUint32(opt + 92, 16, true);
  v.setUint32(opt + 96 + 14 * 8, 0x2000, true); v.setUint32(opt + 100 + 14 * 8, 72, true);
  const section = opt + 0xe0;
  v.setUint32(section + 8, bytes.length - 0x200, true); v.setUint32(section + 12, 0x2000, true);
  v.setUint32(section + 16, bytes.length - 0x200, true); v.setUint32(section + 20, 0x200, true);
  v.setUint32(0x200, 72, true); v.setUint32(0x208, 0x2100, true); v.setUint32(0x20c, 0x1400, true);
  // Optional CLI header extensions (#7735 entrypoint, #7753 resources).
  if (options.cliFlags != null) v.setUint32(0x210, options.cliFlags, true);
  if (options.entryPointToken != null) v.setUint32(0x214, options.entryPointToken, true);
  if (options.resourcesRva != null) v.setUint32(0x218, options.resourcesRva, true);
  if (options.resourcesSize != null) v.setUint32(0x21c, options.resourcesSize, true);
  const root = 0x300; v.setUint32(root, 0x424a5342, true);
  const version = options.versionBytes ?? Uint8Array.from([...utf8('v4.0.30319'), 0, 0]);
  v.setUint32(root + 12, options.versionLength ?? version.length, true); bytes.set(version, root + 16);
  const flags = root + 16 + align(options.versionLength ?? version.length);
  v.setUint16(flags + 2, streams.length, true);
  let header = flags + 4, data = root + 0x400;
  const streamLayout = [];
  for (const stream of streams) {
    const name = typeof stream.name === 'string' ? utf8(stream.name) : stream.name;
    const relative = stream.relativeOffset ?? data - root;
    const size = stream.size ?? stream.bytes.length;
    v.setUint32(header, relative, true); v.setUint32(header + 4, size, true);
    bytes.set(name, header + 8); bytes[header + 8 + name.length] = 0;
    streamLayout.push({ header, offset: root + relative, size, name: stream.name });
    bytes.set(stream.bytes, root + relative);
    header += 8 + align(name.length + 1); data += align(stream.bytes.length);
  }
  definitions.forEach((m, i) => {
    if (bodyOffsets[i] == null || m.shareWith != null) return;
    if (m.fat) {
      // Fat header: 12 bytes, flags 0x03, LocalVarSigTok from m.localVarSigTok.
      const v2 = new DataView(bytes.buffer);
      v2.setUint16(bodyOffsets[i], 0x0003 | (3 << 12), true);
      v2.setUint16(bodyOffsets[i] + 2, m.maxStack ?? 8, true);
      v2.setUint32(bodyOffsets[i] + 4, m.body.length, true);
      v2.setUint32(bodyOffsets[i] + 8, m.localVarSigTok ?? 0, true);
      bytes.set(m.body, bodyOffsets[i] + 12);
      return;
    }
    bytes[bodyOffsets[i]] = (m.body.length << 2) | 2;
    bytes.set(m.body, bodyOffsets[i] + 1);
  });
  if (options.resources) {
    // Embedded CLI resource payloads. The single section maps RVA 0x2000 → file
    // 0x200; RVA 0x2c00 → file 0xc00 (free space between the stream area and the
    // method bodies at 0x1800).
    const v2 = new DataView(bytes.buffer);
    for (const resource of options.resources) {
      const fileOffset = 0x200 + (resource.rva - 0x2000);
      v2.setUint32(fileOffset, resource.payload.length, true);
      bytes.set(resource.payload, fileOffset + 4);
    }
  }
  return { bytes, layout: { root, flags, streams: streamLayout, bodyOffsets, tables, leadingStringIndex } };
}
export async function collect(iterator) { const result = []; for await (const value of iterator) result.push(value); return result; }
