import assert from 'node:assert/strict';
import test from 'node:test';

import { machoBytes, workerClient } from '../../helpers/performance-worker.mjs';

test('#5381 platform scanStrings preserves raw extent when display text is clipped', async () => {
  const payload = new TextEncoder().encode(`${'A'.repeat(1600)}UNIQUE_SUFFIX\0`);
  const client = await workerClient(new URL('../../../js/platform/worker.js?issue5381-platform', import.meta.url));
  try {
    await client.open(machoBytes(payload));
    const scan = await client.request({ t: 'strings', regionId: 'raw', min: 2, limit: 8 });
    assert.equal(scan.results.length, 1);
    const [entry] = scan.results;
    assert.equal(entry.text, 'A'.repeat(1600), 'stored display prefix remains unchanged');
    assert.equal(entry.byteLength, 1613, 'byteLength retains the full raw run extent');
    assert.equal(entry.truncated, true, 'clipped display text is explicitly marked truncated');
    assert.equal(scan.capped, false, 'per-string clipping is not the result-count cap');
  } finally {
    client.close();
  }
});

test('#5381 platform scanStrings keeps a contiguous prefix after a clipped multibyte character', async () => {
  const prefix = 'A'.repeat(1599);
  const runs = ['é', 'あ', '😀'].map((character) => prefix + character + 'B');
  const payload = new TextEncoder().encode([...runs, 'NEXT', ''].join('\0'));
  const client = await workerClient(new URL('../../../js/platform/worker.js?issue5381-platform-prefix', import.meta.url));
  try {
    await client.open(machoBytes(payload));
    const scan = await client.request({ t: 'strings', regionId: 'raw', min: 2, limit: 8 });
    assert.equal(scan.results.length, 4);
    for (const [index, source] of runs.entries()) {
      const entry = scan.results[index];
      assert.equal(entry.text, prefix, 'later ASCII must not be appended after a clipped code point');
      assert.equal(entry.byteLength, new TextEncoder().encode(source).length);
      assert.equal(entry.truncated, true);
    }
    const last = scan.results[3];
    assert.equal(last.text, 'NEXT', 'clipping state resets for the next run');
    assert.equal(last.byteLength, 4);
    assert.equal(last.truncated, undefined);
    assert.equal(scan.capped, false);
  } finally {
    client.close();
  }
});
