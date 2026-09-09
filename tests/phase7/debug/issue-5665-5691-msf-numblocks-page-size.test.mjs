import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMsf } from '../../../js/analysis/debug/pdb.js';
import { DwarfDebugInfoProvider } from '../../../js/analysis/debug/dwarf.js';
import { PdbDebugInfoProvider } from '../../../js/analysis/debug/pdb.js';

// Issue #5665: parseMsf accepted a superblock that declares one block more
// than the file actually contains (`numBlocks * blockSize > data.length +
// blockSize` allowed an exact one-block deficit). NumBlocks is the total
// block count of the on-disk file — it must match the file size exactly.
//
// Issue #5691: the paged debug readers returned the same cursor forever for
// `pageSize: 0` (empty slice → next === start → truncated:true with an
// unchanged nextCursor), letting a normal nextCursor consumer loop without
// progress.

const MSF_MAGIC = 'Microsoft C/C++ MSF 7.00\r\n\u001aDS\0\0\0';

function msf({ numBlocks, realBlocks }) {
  const blockSize = 0x200;
  const bytes = new Uint8Array(blockSize * realBlocks);
  bytes.set(new TextEncoder().encode(MSF_MAGIC), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(32, blockSize, true);
  view.setUint32(36, 1, true);
  view.setUint32(40, numBlocks, true);
  view.setUint32(44, 4, true);
  view.setUint32(52, 3, true);
  view.setUint32(blockSize * 3, 4, true);
  view.setUint32(blockSize * 4, 0, true);
  return bytes;
}

test('#5665 a NumBlocks claim above the real file size fails closed', () => {
  const result = parseMsf(msf({ numBlocks: 6, realBlocks: 5 }));
  assert.equal(result.complete, false);
  assert.deepEqual(result.streams, []);
  assert.ok(result.diagnostics.some((d) => d.includes('block count does not match the file size')));
});

test('#5665 a NumBlocks claim below the real file size fails closed', () => {
  const result = parseMsf(msf({ numBlocks: 4, realBlocks: 5 }));
  assert.equal(result.complete, false);
});

test('#5665 an exact NumBlocks/file-size match keeps parsing (control)', () => {
  const result = parseMsf(msf({ numBlocks: 5, realBlocks: 5 }));
  assert.equal(result.complete, true);
  assert.deepEqual(result.diagnostics, []);
});

test('#5691 a zero page size falls back to the default page size instead of stalling', () => {
  const symbol = { segment: 0, offset: 0, offsetInSegment: 0, kind: 'other', name: 'x', recordOffset: 0, isFunction: false, sizeBytes: null };
  const provider = new PdbDebugInfoProvider();
  const result = {
    providerId: 'pdb', providerVersion: 'test', identity: { observed: 'g/1', expected: 'g/1' },
    parsed: { sectionHeaders: [], symbols: { symbols: [symbol] }, tpi: { types: new Map() } },
  };
  const page = provider.symbols(result, { pageSize: 0 });
  assert.ok(page.records.length > 0, 'pageSize 0 must still make progress');
  assert.notEqual(page.nextCursor, '0', 'the same cursor must not repeat');
});

test('#5691 the DWARF reader honors the same page-size floor', () => {
  const die = {
    offset: 0, tag: 0x2e, complete: true,
    attributes: new Map(),
  };
  const provider = new DwarfDebugInfoProvider();
  const result = {
    providerId: 'dwarf', providerVersion: 'test', identity: { observed: 'x', expected: 'x' },
    parsed: { dies: new Map([[0, die]]) },
  };
  const page = provider.symbols(result, { pageSize: 0 });
  assert.ok(page.records.length > 0, 'pageSize 0 must still make progress');
});
