// Issue #5940 regression: byte-oriented text search must preserve the exact
// UTF-8 query bytes for non-ASCII text while applying the same ASCII-only fold
// to both sides. This guarantees exact matches for every UTF-8 sequence without
// pretending to implement Unicode case folding without code-point/address maps.
// Driven end-to-end through the platform worker message protocol.
import assert from 'node:assert/strict';

function machoFixture(payloadText) {
  const text = new TextEncoder().encode(payloadText);
  const bytes = new Uint8Array(104 + text.length);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, 0xfeedfacf, true);          // MH_MAGIC_64
  v.setInt32(4, 0x0100000c, true);           // CPU_TYPE_ARM64
  v.setInt32(8, 0, true);
  v.setUint32(12, 2, true);                  // MH_EXECUTE
  v.setUint32(16, 1, true);                  // ncmds
  v.setUint32(20, 72, true);                 // sizeofcmds
  v.setUint32(32, 0x19, true);               // LC_SEGMENT_64
  v.setUint32(36, 72, true);                 // cmdsize
  bytes.set(new TextEncoder().encode('__DATA'), 40);
  v.setBigUint64(56, 0n, true);              // vmaddr
  v.setBigUint64(64, BigInt(bytes.length), true);
  v.setBigUint64(72, 0n, true);              // fileoff
  v.setBigUint64(80, BigInt(bytes.length), true);
  v.setUint32(88, 7, true);
  v.setUint32(92, 7, true);
  bytes.set(text, 104);
  return bytes;
}

const posts = [];
globalThis.self = { postMessage: (message) => posts.push(message) };
await import('../js/platform/worker.js');

const fileBytes = machoFixture('xÄyABCÄ𐐀𐐨');
const file = {
  size: fileBytes.length,
  read: async (offset, length) => fileBytes.subarray(Number(offset), Number(offset) + length),
};

async function request(message) {
  const id = message.id;
  await self.onmessage({ data: { epoch: 1, ...message } });
  const response = posts.filter((m) => m.t === 'ok' && m.id === id).pop();
  assert.ok(response, `no ok response for ${message.t} #${id}`);
  return response.result;
}

const opened = await request({ id: 1, t: 'open', file });
assert.ok(opened, 'open must succeed');
await request({ id: 2, t: 'setRegions', regions: [{ id: 'raw', fileOffset: 0, vmAddr: 0, size: fileBytes.length }] });

// 1. The issue repro: an exact non-ASCII BMP query finds the identical bytes.
{
  const result = await request({ id: 3, t: 'search', regionId: 'raw', kind: 'text', query: 'Ä', from: 0 });
  const offsets = result.results.map((r) => r.byteOff);
  assert.deepEqual(offsets, [105, 111], `exact non-ASCII match must be found, got ${JSON.stringify(offsets)}`);
}

// 2. Byte-oriented search does not claim Unicode case-insensitivity. A
// lowercase non-ASCII query must not be laundered into the uppercase bytes.
{
  const result = await request({ id: 4, t: 'search', regionId: 'raw', kind: 'text', query: 'ä', from: 0 });
  assert.deepEqual(result.results.map((r) => r.byteOff), []);
}

// 3. Supplementary-plane cased characters are encoded as whole code points;
// exact uppercase/lowercase spellings each find only their own UTF-8 sequence.
{
  const upper = await request({ id: 5, t: 'search', regionId: 'raw', kind: 'text', query: '𐐀', from: 0 });
  assert.deepEqual(upper.results.map((r) => r.byteOff), [113]);
  const lowerCase = await request({ id: 6, t: 'search', regionId: 'raw', kind: 'text', query: '𐐨', from: 0 });
  assert.deepEqual(lowerCase.results.map((r) => r.byteOff), [117]);
}

// 4. ASCII case-insensitivity is retained by applying the byte fold to both
// haystack and query bytes.
{
  const result = await request({ id: 7, t: 'search', regionId: 'raw', kind: 'text', query: 'abc', from: 0 });
  assert.deepEqual(result.results.map((r) => r.byteOff), [108]);
  const upper = await request({ id: 8, t: 'search', regionId: 'raw', kind: 'text', query: 'ABC', from: 0 });
  assert.deepEqual(upper.results.map((r) => r.byteOff), [108]);
}

// 5. Hex search is untouched by text folding.
{
  const result = await request({ id: 9, t: 'search', regionId: 'raw', kind: 'hex', hex: { bytes: [0xc3, 0x84], mask: [0xff, 0xff] }, from: 0 });
  assert.deepEqual(result.results.map((r) => r.byteOff), [105, 111]);
}

// 6. No match for a genuinely absent string (sanity).
{
  const result = await request({ id: 10, t: 'search', regionId: 'raw', kind: 'text', query: 'zzz', from: 0 });
  assert.equal(result.results.length, 0);
}

// 7. A multi-byte UTF-8 sequence that straddles the scan block boundary is
//    still matched, with the original byte offset, row, and address preserved.
{
  const boundaryOffset = 256 * 1024 - 1;
  const boundaryBytes = machoFixture(`${'x'.repeat(boundaryOffset - 104)}Ä`);
  const boundaryFile = {
    size: boundaryBytes.length,
    read: async (offset, length) => boundaryBytes.subarray(Number(offset), Number(offset) + length),
  };
  await request({ id: 11, t: 'open', file: boundaryFile });
  await request({ id: 12, t: 'setRegions', regions: [{ id: 'boundary', fileOffset: 0, vmAddr: 0x700000n, size: boundaryBytes.length }] });
  const result = await request({ id: 13, t: 'search', regionId: 'boundary', kind: 'text', query: 'Ä', from: 0 });
  assert.deepEqual(result.results.map((entry) => entry.byteOff), [boundaryOffset]);
  assert.equal(result.results[0].row, Math.floor(boundaryOffset / 4));
  assert.equal(result.results[0].addr, 0x700000n + BigInt(boundaryOffset));
}

// 8. A lowercase non-ASCII haystack/query pair must also match exactly.  A
// separate bounded fixture keeps this positive case independent of the
// uppercase haystack/lowercase query negative control above.
{
  const lowerFileBytes = machoFixture('xäy');
  const lowerFile = {
    size: lowerFileBytes.length,
    read: async (offset, length) => lowerFileBytes.subarray(Number(offset), Number(offset) + length),
  };
  await request({ id: 14, t: 'open', file: lowerFile });
  await request({ id: 15, t: 'setRegions', regions: [{ id: 'lower', fileOffset: 0, vmAddr: 0, size: lowerFileBytes.length }] });
  const lower = await request({ id: 16, t: 'search', regionId: 'lower', kind: 'text', query: 'ä', from: 0 });
  assert.deepEqual(lower.results.map((r) => r.byteOff), [105]);
}

console.log('issue #5940 text search exact UTF-8 / ASCII-fold regressions: PASS');
