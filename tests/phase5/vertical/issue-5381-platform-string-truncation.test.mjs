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
