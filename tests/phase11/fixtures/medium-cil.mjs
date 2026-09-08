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
    mv.setUint16(i * 14 + 10, 1, true); // #Blob: static ()void
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
    fv.setUint16(i * 6 + 4, 5, true); // #Blob: field int32
  });
  const rows = new Map();
  if (typeDefs.length) rows.set(2, { count: typeDefs.length, bytes: types });
  if (fieldDefs.length) rows.set(4, { count: fieldDefs.length, bytes: fields });
  if (definitions.length) rows.set(6, { count: definitions.length, bytes: methods });
  for (const [k, val] of options.extraRows ?? []) rows.set(k, val);
  const tables = cilTables(rows);
  const pad = b => { const p = new Uint8Array(align(b.length)); p.set(b); return p; };
  const streams = options.streams ?? [
    { name: options.tableName ?? '#~', bytes: tables.bytes },
    { name: '#Strings', bytes: pad(Uint8Array.from(strings)) },
    { name: '#Blob', bytes: Uint8Array.of(0, 3, 0, 0, 1, 2, 6, 8) },
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
    bytes[bodyOffsets[i]] = (m.body.length << 2) | 2;
    bytes.set(m.body, bodyOffsets[i] + 1);
  });
  return { bytes, layout: { root, flags, streams: streamLayout, bodyOffsets, tables } };
}
export async function collect(iterator) { const result = []; for await (const value of iterator) result.push(value); return result; }
