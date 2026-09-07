// Issue #5940 regression: platform text search case folding must agree on both
// sides. The query folds with Unicode toLowerCase(); the haystack now folds the
// same characters per byte, so a query containing a non-ASCII cased letter
// finds the exact same string in the region (and keeps ASCII insensitivity).
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

const fileBytes = machoFixture('xÄyABCÄ');
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

// 1. The issue repro: exact 'Ä' in the region is found by the 'Ä' query.
{
  const result = await request({ id: 3, t: 'search', regionId: 'raw', kind: 'text', query: 'Ä', from: 0 });
  const offsets = result.results.map((r) => r.byteOff);
  assert.deepEqual(offsets, [105, 111], `exact non-ASCII match must be found, got ${JSON.stringify(offsets)}`);
}

// 2. Unicode case-insensitivity is retained: 'ä' finds the same hits.
{
  const result = await request({ id: 4, t: 'search', regionId: 'raw', kind: 'text', query: 'ä', from: 0 });
  assert.deepEqual(result.results.map((r) => r.byteOff), [105, 111]);
}

// 3. ASCII case-insensitivity is retained.
{
  const result = await request({ id: 5, t: 'search', regionId: 'raw', kind: 'text', query: 'abc', from: 0 });
  assert.deepEqual(result.results.map((r) => r.byteOff), [108]);
}

// 4. Hex search is untouched by text folding.
{
  const result = await request({ id: 6, t: 'search', regionId: 'raw', kind: 'hex', hex: { bytes: [0xc3, 0x84], mask: [0xff, 0xff] }, from: 0 });
  assert.deepEqual(result.results.map((r) => r.byteOff), [105, 111]);
}

// 5. No match for a genuinely absent string (sanity).
{
  const result = await request({ id: 7, t: 'search', regionId: 'raw', kind: 'text', query: 'zzz', from: 0 });
  assert.equal(result.results.length, 0);
}

console.log('issue #5940 text search case-fold symmetry regressions: PASS');
