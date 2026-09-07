import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverSchemas } from '../js/schema.js';

test('#5803 an open-ended functionRange is never read', async () => {
  let reads = 0;
  const program = {
    unsupported: false,
    architecture: 'arm64',
    functionsReferencing() { return [{ addr: 0x1000n }]; },
    functionRange() { return { start: 0x1000n, end: null, region: null }; },
  };
  const out = await recoverSchemas({
    architecture: 'arm64',
    strings: [{ addr: 0x3000n, text: 'data.csv' }],
    program,
    read: async () => { reads++; return new Uint8Array(); },
  });
  assert.equal(out.complete, true);
  assert.equal(reads, 0, 'unknown range must not authorize a read');
  assert.equal(out.length, 0, 'open-ended candidates yield no schema');
});

test('#5803 closed candidates still recover tables when another range is open-ended', async () => {
  // Real decoder path: BL; STR W0,[X19,#off], repeated for three columns.
  const str = (offset) => (0xb9000000 | ((offset / 4) << 10) | (19 << 5)) >>> 0;
  const words = [0x94000000, str(0), 0x94000000, str(4), 0x94000000, str(8)];
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => view.setUint32(index * 4, word, true));
  const reads = [];
  const program = {
    unsupported: false,
    architecture: 'arm64',
    functionsReferencing() { return [{ addr: 0x1000n }, { addr: 0x2000n }]; },
    functionRange(addr) { return { start: addr, end: addr === 0x1000n ? null : addr + BigInt(bytes.length), region: null }; },
  };
  const out = await recoverSchemas({
    architecture: 'arm64',
    strings: [{ addr: 0x3000n, text: 'data.csv' }],
    program,
    read: async (addr, length) => { reads.push([addr, length]); return bytes; },
  });
  assert.deepEqual(reads, [[0x2000n, bytes.length]]);
  assert.equal(out.length, 1);
  assert.equal(out[0].loader, 0x2000n);
  assert.equal(out[0].loaderSize, bytes.length);
  assert.deepEqual(out[0].tables.find((table) => table.kind === 'unrolled').offsets, [0, 4, 8]);
});
