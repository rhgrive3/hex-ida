import test from 'node:test';
import assert from 'node:assert/strict';

import { PdbDebugInfoProvider } from '../../../js/analysis/debug/pdb.js';

const GUID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

function buildMinimalPdb(guid = GUID, age = 1) {
  const blockSize = 64;
  const blockCount = 6;
  const bytes = new Uint8Array(blockSize * blockCount);
  const view = new DataView(bytes.buffer);
  const magic = new TextEncoder().encode('Microsoft C/C++ MSF 7.00\r\n\u001aDS\0\0\0');
  bytes.set(magic, 0);
  view.setUint32(32, blockSize, true);
  view.setUint32(40, blockCount, true);
  view.setUint32(44, 32, true); // stream-directory bytes
  view.setUint32(52, 1, true);  // block-map block

  view.setUint32(blockSize, 2, true); // directory is block 2
  let cursor = blockSize * 2;
  view.setUint32(cursor, 4, true); cursor += 4;
  for (const size of [0, 28, 56, 64]) {
    view.setUint32(cursor, size, true);
    cursor += 4;
  }
  for (const block of [3, 4, 5]) {
    view.setUint32(cursor, block, true);
    cursor += 4;
  }

  // PDB info stream (stream 1 / block 3).
  cursor = blockSize * 3;
  view.setUint32(cursor, 20000404, true);
  view.setUint32(cursor + 4, 0, true);
  view.setUint32(cursor + 8, age, true);
  const match = /^([0-9A-Fa-f]{8})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{12})$/.exec(guid);
  assert.ok(match, 'test GUID must be canonical');
  view.setUint32(cursor + 12, Number.parseInt(match[1], 16), true);
  view.setUint16(cursor + 16, Number.parseInt(match[2], 16), true);
  view.setUint16(cursor + 18, Number.parseInt(match[3], 16), true);
  const rest = match[4] + match[5];
  for (let index = 0; index < 8; index += 1) {
    bytes[cursor + 20 + index] = Number.parseInt(rest.slice(index * 2, index * 2 + 2), 16);
  }

  // Empty but structurally valid TPI stream (stream 2 / block 4).
  cursor = blockSize * 4;
  view.setUint32(cursor + 4, 56, true);
  view.setUint32(cursor + 8, 0x1000, true);
  // Stream 3 / block 5 is a zeroed 64-byte DBI header.
  return bytes;
}

function probe(codeView, { withPdb = true } = {}) {
  const provider = new PdbDebugInfoProvider();
  return provider.probe({
    snapshotId: 'snapshot-A',
    identity: { codeView },
    ...(withPdb ? { pdbBytes: buildMinimalPdb() } : {}),
  });
}

test('#3433 canonical primitive CodeView identity remains authoritative', () => {
  const result = probe({ guid: GUID.toLowerCase(), age: 1, path: 'app.pdb' });
  assert.equal(result.identity.verdict, 'matched-authoritative');
  assert.equal(result.identity.expected, `${GUID}/1`);
  assert.equal(result.identity.observed, `${GUID}/1`);
});

test('#3433 malformed CodeView components cannot be laundered into an authoritative match', () => {
  const malformed = [
    { guid: [GUID], age: 1 },
    { guid: GUID, age: [1] },
    { guid: { toString: () => GUID }, age: 1 },
    { guid: GUID, age: { toString: () => '1' } },
    { guid: true, age: 1 },
    { guid: GUID, age: true },
    { guid: GUID, age: -1 },
    { guid: GUID, age: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const codeView of malformed) {
    const result = probe(codeView);
    assert.notEqual(result.identity.verdict, 'matched-authoritative');
    assert.equal(result.identity.expected, null);
  }
});

test('#3433 missing-PDB diagnostics use the same strict expected identity normalization', () => {
  const valid = probe({ guid: GUID.toLowerCase(), age: 1, path: 'app.pdb' }, { withPdb: false });
  assert.equal(valid.identity.expected, `${GUID}/1`);

  const malformed = probe({ guid: [GUID], age: [1], path: 'app.pdb' }, { withPdb: false });
  assert.equal(malformed.identity.expected, null);
  assert.equal(malformed.identity.verdict, 'companion-missing');
});
