import test from 'node:test';
import assert from 'node:assert/strict';
import { machoBytes, workerClient } from '../helpers/performance-worker.mjs';

function naive(payload, pattern, mask, from = 0, fold = false) {
  const lower = (b) => b >= 65 && b <= 90 ? b + 32 : b;
  const out = [];
  for (let i = from; i <= payload.length - pattern.length && out.length < 1000; i++) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) {
      if (fold ? lower(payload[i + j]) !== lower(pattern[j]) : (payload[i + j] & mask[j]) !== pattern[j]) { match = false; break; }
    }
    if (match) out.push(i);
  }
  return out;
}

test('optimized worker search retains masks, overlaps, hit limit, offsets, Unicode and chunk carry', async () => {
  const client = await workerClient();
  try {
    const payload = new Uint8Array(2 * 256 * 1024 + 41).fill(0x78);
    const pattern = [0x11, 0x22, 0x33, 0x44, 0x55];
    for (const at of [7, 256 * 1024 - 3, 2 * 256 * 1024 - 1]) payload.set(pattern, at);
    const text = new TextEncoder().encode('AbC日本語𐐀');
    payload.set(text, 256 * 1024 - 50);
    await client.open(machoBytes(payload));
    for (const [bytes, mask, from] of [[pattern, pattern.map(() => 255), 0],
      [pattern, pattern.map(() => 255), 8], [[0x10, 0x20, 0x30, 0x40, 0x50], pattern.map(() => 240), 0],
      [[0, 0, 0], [0, 0, 0], 0], [[0x78, 0x78, 0x78], [255, 255, 255], 11]]) {
      const result = await client.request({ t: 'search', kind: 'hex', regionId: 'raw', hex: { bytes, mask }, from });
      const expected = naive(payload, bytes, mask, from);
      assert.deepEqual(result.results.map((hit) => hit.byteOff), expected);
      for (const hit of result.results) {
        assert.equal(hit.row, Math.floor(hit.byteOff / 4));
        assert.equal(hit.addr, 0x700000n + BigInt(hit.byteOff));
      }
    }
    for (const query of ['abc日本語𐐀', 'ABC日本語𐐀', 'ABC日本語𐐨', 'absent-needle']) {
      const pattern = [...new TextEncoder().encode(query)];
      const result = await client.request({ t: 'search', kind: 'text', regionId: 'raw', query, from: 0 });
      assert.deepEqual(result.results.map((hit) => hit.byteOff), naive(payload, pattern, null, 0, true));
    }
  } finally { client.close(); }
});
