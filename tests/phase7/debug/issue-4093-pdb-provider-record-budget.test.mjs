import assert from 'node:assert/strict';
import test from 'node:test';

import { PdbDebugInfoProvider } from '../../../js/analysis/debug/pdb.js';

const BLOCK_SIZE = 4096;
const MSF_MAGIC = 'Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0';
const GUID = '11111111-2222-3333-4444-555555555555';
const S_PUB32 = 0x110e;
const S_LPROC32 = 0x110f;
const UNKNOWN_TPI_LEAF = 0x1234;

function concat(...chunks) {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function publicRecord(name) {
  const encoded = new TextEncoder().encode(`${name}\0`);
  const bytes = new Uint8Array(14 + encoded.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, bytes.length - 2, true);
  view.setUint16(2, S_PUB32, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, 0x10, true);
  view.setUint16(12, 1, true);
  bytes.set(encoded, 14);
  return bytes;
}

function procedureRecord(name) {
  const encoded = new TextEncoder().encode(`${name}\0`);
  const bytes = new Uint8Array(39 + encoded.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, bytes.length - 2, true);
  view.setUint16(2, S_LPROC32, true);
  view.setUint32(16, 16, true);
  view.setUint32(28, 0x0074, true);
  view.setUint32(32, 0x1000, true);
  view.setUint16(36, 1, true);
  bytes.set(encoded, 39);
  return bytes;
}

function moduleStream(...records) {
  return concat(new Uint8Array(4), ...records);
}

function tpiStream(recordCount) {
  const records = Array.from({ length: recordCount }, () => {
    const bytes = new Uint8Array(4);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 2, true);
    view.setUint16(2, UNKNOWN_TPI_LEAF, true);
    return bytes;
  });
  const body = concat(...records);
  const bytes = new Uint8Array(56 + body.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 56, true);
  view.setUint32(8, 0x1000, true);
  view.setUint32(12, 0x1000 + recordCount, true);
  view.setUint32(16, body.length, true);
  bytes.set(body, 56);
  return bytes;
}

function infoStream() {
  const bytes = new Uint8Array(28);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 20000404, true);
  view.setUint32(8, 1, true);
  view.setUint32(12, 0x11111111, true);
  view.setUint16(16, 0x2222, true);
  view.setUint16(18, 0x3333, true);
  bytes.set([0x44, 0x44, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55], 20);
  return bytes;
}

function dbiStream(moduleStreams) {
  const moduleBytes = [];
  for (let index = 0; index < moduleStreams.length; index += 1) {
    const bytes = new Uint8Array(72);
    const view = new DataView(bytes.buffer);
    view.setUint16(34, 5 + index, true);
    view.setUint32(36, moduleStreams[index].length, true);
    bytes.set(new TextEncoder().encode(`mod\0obj\0`), 64);
    moduleBytes.push(bytes);
  }
  const modules = concat(...moduleBytes);
  const bytes = new Uint8Array(64 + modules.length);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, -1, true);
  view.setUint32(4, 19990903, true);
  view.setUint32(8, 1, true);
  view.setUint16(12, 0xffff, true);
  view.setUint16(16, 0xffff, true);
  view.setUint16(20, 4, true);
  view.setInt32(24, modules.length, true);
  bytes.set(modules, 64);
  return bytes;
}

function buildPdb({ globalRecords = [], modules = [], tpiRecords = 0 } = {}) {
  const moduleStreams = modules.map((records) => moduleStream(...records));
  const streams = new Map([
    [1, infoStream()],
    [2, tpiStream(tpiRecords)],
    [3, dbiStream(moduleStreams)],
    [4, concat(...globalRecords)],
  ]);
  moduleStreams.forEach((bytes, index) => streams.set(5 + index, bytes));

  const streamCount = 5 + moduleStreams.length;
  const directoryBytes = 4 + streamCount * 4 + [...streams.values()].reduce(
    (total, bytes) => total + Math.ceil(bytes.length / BLOCK_SIZE) * 4,
    0,
  );
  const directoryBlockCount = Math.ceil(directoryBytes / BLOCK_SIZE);
  const blockMapAddr = 1;
  const directoryStart = 2;
  const dataStart = directoryStart + directoryBlockCount;
  const dataBlocks = [...streams.values()].reduce(
    (total, bytes) => total + Math.ceil(bytes.length / BLOCK_SIZE),
    0,
  );
  const bytes = new Uint8Array((dataStart + dataBlocks) * BLOCK_SIZE);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(MSF_MAGIC), 0);
  view.setUint32(32, BLOCK_SIZE, true);
  view.setUint32(36, 1, true);
  view.setUint32(40, dataStart + dataBlocks, true);
  view.setUint32(44, directoryBytes, true);
  view.setUint32(52, blockMapAddr, true);

  const map = new DataView(bytes.buffer, blockMapAddr * BLOCK_SIZE, BLOCK_SIZE);
  for (let index = 0; index < directoryBlockCount; index += 1) {
    map.setUint32(index * 4, directoryStart + index, true);
  }

  const directory = new DataView(bytes.buffer, directoryStart * BLOCK_SIZE, directoryBytes);
  directory.setUint32(0, streamCount, true);
  for (let index = 0; index < streamCount; index += 1) {
    directory.setUint32(4 + index * 4, streams.has(index) ? streams.get(index).length : 0xffffffff, true);
  }
  let directoryCursor = 4 + streamCount * 4;
  let nextDataBlock = dataStart;
  for (let streamIndex = 0; streamIndex < streamCount; streamIndex += 1) {
    const stream = streams.get(streamIndex);
    if (!stream) continue;
    for (let offset = 0; offset < stream.length; offset += BLOCK_SIZE) {
      directory.setUint32(directoryCursor, nextDataBlock, true);
      directoryCursor += 4;
      bytes.set(stream.subarray(offset, offset + BLOCK_SIZE), nextDataBlock * BLOCK_SIZE);
      nextDataBlock += 1;
    }
  }
  return bytes;
}

function probe(pdbBytes, maxRecords) {
  return new PdbDebugInfoProvider().probe({
    snapshotId: 'issue-4093',
    identity: { codeView: { guid: GUID, age: 1 } },
    pdbBytes,
  }, { budget: { maxRecords } });
}

function assertBudgetExhausted(result, context) {
  assert.equal(result.status.completeness, 'truncated');
  assert.equal(result.status.stopReason, 'budget-exhausted');
  assert.equal(result.parsed.symbols.complete, false);
  assert.equal(result.parsed.tpi.complete, false);
  assert.match(result.diagnostics.join('\n'), new RegExp(`record budget exhausted.*${context}`, 'i'));
}

test('#4093 global-only records consume one provider-run budget', () => {
  const pdb = buildPdb({ globalRecords: [publicRecord('g0'), publicRecord('g1')] });
  assertBudgetExhausted(probe(pdb, 1), 'global symbol stream');
  const exact = probe(pdb, 2);
  assert.notEqual(exact.status.stopReason, 'budget-exhausted');
  assert.equal(exact.parsed.symbols.symbols.length, 2);
});

test('#4093 module-only budget is shared across module streams', () => {
  const pdb = buildPdb({
    modules: [[procedureRecord('m0')], [procedureRecord('m1')]],
  });
  const capped = probe(pdb, 1);
  assertBudgetExhausted(capped, 'module symbol stream 6');
  assert.equal(capped.parsed.symbols.symbols.length, 1);
  const exact = probe(pdb, 2);
  assert.notEqual(exact.status.stopReason, 'budget-exhausted');
  assert.equal(exact.parsed.symbols.symbols.length, 2);
});

test('#4093 global and multiple modules cannot each reuse maxRecords', () => {
  const pdb = buildPdb({
    globalRecords: [publicRecord('g0')],
    modules: [[procedureRecord('m0')], [procedureRecord('m1')]],
  });
  const capped = probe(pdb, 2);
  assertBudgetExhausted(capped, 'module symbol stream 6');
  assert.equal(capped.parsed.symbols.symbols.length, 2);
});

test('#4093 TPI consumes the same budget after symbol streams', () => {
  const pdb = buildPdb({
    globalRecords: [publicRecord('g0')],
    modules: [[procedureRecord('m0')]],
    tpiRecords: 2,
  });
  const capped = probe(pdb, 3);
  assertBudgetExhausted(capped, 'TPI stream');
  assert.equal(capped.parsed.symbols.symbols.length, 2);
  assert.equal(capped.parsed.tpi.types.size, 1);
});

test('#4093 TPI-only exact boundary is complete, overflow is truncated', () => {
  const pdb = buildPdb({ tpiRecords: 2 });
  const capped = probe(pdb, 1);
  assertBudgetExhausted(capped, 'TPI stream');
  assert.equal(capped.parsed.tpi.types.size, 1);
  const exact = probe(pdb, 2);
  assert.notEqual(exact.status.stopReason, 'budget-exhausted');
  assert.equal(exact.parsed.tpi.complete, true);
  assert.equal(exact.parsed.tpi.types.size, 2);
});

test('#4093 exact cap across global + modules + TPI is not a false exhaustion', () => {
  const pdb = buildPdb({
    globalRecords: [publicRecord('g0')],
    modules: [[procedureRecord('m0')], [procedureRecord('m1')]],
    tpiRecords: 2,
  });
  const exact = probe(pdb, 5);
  assert.notEqual(exact.status.stopReason, 'budget-exhausted');
  assert.equal(exact.parsed.symbols.symbols.length, 3);
  assert.equal(exact.parsed.tpi.types.size, 2);
});

test('#4093 default-sized budget keeps normal mixed PDB parsing intact', () => {
  const pdb = buildPdb({
    globalRecords: [publicRecord('g0')],
    modules: [[procedureRecord('m0')], [procedureRecord('m1')]],
    tpiRecords: 2,
  });
  const result = new PdbDebugInfoProvider().probe({
    snapshotId: 'issue-4093-default',
    identity: { codeView: { guid: GUID, age: 1 } },
    pdbBytes: pdb,
  });
  assert.equal(result.identity.verdict, 'matched-authoritative');
  assert.notEqual(result.status.stopReason, 'budget-exhausted');
  assert.equal(result.parsed.symbols.complete, true);
  assert.equal(result.parsed.symbols.symbols.length, 3);
  assert.equal(result.parsed.tpi.complete, true);
  assert.equal(result.parsed.tpi.types.size, 2);
});

console.log('issue #4093 PDB provider record budget regressions: PASS');
