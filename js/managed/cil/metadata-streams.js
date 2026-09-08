// ECMA-335 II.24.2.1–2. Do not let malformed redundant headers choose an authority.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const align4 = n => Math.ceil(n / 4) * 4;
function fail(code) { throw new TypeError(code); }
export function readCilMetadataStreams(bytes, offset, size) {
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(size)
      || offset < 0 || size < 20 || offset > bytes.length - size) fail('cil-metadata-root-out-of-bounds');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), end = offset + size;
  const need = (pos, count, code) => { if (pos < offset || pos > end - count) fail(code); };
  if (view.getUint32(offset, true) !== 0x424a5342) fail('cil-metadata-signature-invalid');
  const length = view.getUint32(offset + 12, true), start = offset + 16;
  if (length > end - start) fail('cil-metadata-version-truncated');
  if (length < 4 || length > 256 || length % 4 !== 0) fail('cil-metadata-version-length-invalid');
  let terminator = start;
  while (terminator < start + length && bytes[terminator] !== 0) terminator++;
  const stringLength = terminator - start + 1;
  if (terminator === start + length || stringLength > 255 || align4(stringLength) !== length) {
    fail('cil-metadata-version-length-invalid');
  }
  let runtimeVersion;
  try { runtimeVersion = utf8.decode(bytes.subarray(start, terminator)); }
  catch { fail('cil-metadata-version-utf8-invalid'); }
  // The version's alignment padding is not text. Its value is not interpreted.
  const flags = start + length;
  need(flags, 4, 'cil-metadata-stream-header-truncated');
  const count = view.getUint16(flags + 2, true), streams = [], seen = new Set();
  let pos = flags + 4;
  for (let i = 0; i < count; i++) {
    need(pos, 8, 'cil-metadata-stream-header-truncated');
    const relative = view.getUint32(pos, true), streamSize = view.getUint32(pos + 4, true);
    pos += 8;
    const nameStart = pos;
    while (pos < end && pos - nameStart < 32 && bytes[pos] !== 0) {
      if (bytes[pos] > 0x7f) fail('cil-metadata-stream-name-invalid');
      pos++;
    }
    if (pos >= end) fail('cil-metadata-stream-name-truncated');
    if (pos === nameStart || pos - nameStart >= 32) fail('cil-metadata-stream-name-invalid');
    const name = String.fromCharCode(...bytes.subarray(nameStart, pos));
    const next = offset + align4(pos + 1 - offset);
    need(pos, next - pos, 'cil-metadata-stream-header-truncated');
    while (pos < next) if (bytes[pos++] !== 0) fail('cil-metadata-stream-name-padding-invalid');
    const key = name === '#-' ? '#~' : name;
    if (seen.has(key)) fail('cil-metadata-stream-duplicate');
    seen.add(key);
    if (streamSize % 4 !== 0) fail('cil-metadata-stream-size-invalid');
    if (relative > size || streamSize > size - relative) fail('cil-metadata-stream-out-of-bounds');
    streams.push(Object.freeze({ name, offset: offset + relative, size: streamSize }));
  }
  // Streams cannot own metadata headers or overlap another nonempty stream.
  let previousEnd = pos;
  for (const stream of streams.filter(s => s.size > 0).sort((a, b) => a.offset - b.offset)) {
    if (stream.offset < previousEnd) fail('cil-metadata-stream-overlap');
    previousEnd = stream.offset + stream.size;
  }
  return Object.freeze({ runtimeVersion, streams: Object.freeze(streams) });
}
