import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DBI_HEADER_SIZE,
  PdbDebugInfoProvider,
  parseDbiHeader,
  parseModuleInfo,
  parseMsf,
} from '../../../js/analysis/debug/pdb.js';
import {
  loadPdbFixtures,
  pdbImage,
} from '../../../tools/validation/phase7/lanes/debug.mjs';

const variant = loadPdbFixtures().variants[0];
const provider = new PdbDebugInfoProvider();

function fixtureBytes() {
  return new Uint8Array(Buffer.from(variant.pdb, 'base64'));
}

function msfLayout(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blockSize = view.getUint32(32, true);
  const directoryBytes = view.getUint32(44, true);
  const blockMapAddr = view.getUint32(52, true);
  const directoryBlockCount = Math.ceil(directoryBytes / blockSize);
  const directory = new Uint8Array(directoryBytes);
  let written = 0;
  for (let index = 0; index < directoryBlockCount; index += 1) {
    const blockIndex = view.getUint32(blockMapAddr * blockSize + index * 4, true);
    const take = Math.min(blockSize, directoryBytes - written);
    directory.set(bytes.subarray(blockIndex * blockSize, blockIndex * blockSize + take), written);
    written += take;
  }

  const directoryView = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const streamCount = directoryView.getUint32(0, true);
  const sizes = [];
  let cursor = 4;
  for (let index = 0; index < streamCount; index += 1) {
    const rawSize = directoryView.getUint32(cursor, true);
    sizes.push(rawSize === 0xffffffff ? 0 : rawSize);
    cursor += 4;
  }
  const blocks = [];
  for (const size of sizes) {
    const streamBlocks = [];
    for (let index = 0; index < Math.ceil(size / blockSize); index += 1) {
      streamBlocks.push(directoryView.getUint32(cursor, true));
      cursor += 4;
    }
    blocks.push(streamBlocks);
  }
  return { blockSize, blocks };
}

function streamFileOffset(layout, streamIndex, streamOffset) {
  const blockOrdinal = Math.floor(streamOffset / layout.blockSize);
  const blockIndex = layout.blocks[streamIndex]?.[blockOrdinal];
  assert.notEqual(blockIndex, undefined, `stream ${streamIndex} offset ${streamOffset} must be materialized`);
  return blockIndex * layout.blockSize + (streamOffset % layout.blockSize);
}

function dbiModuleEntryOffsets(dbiBytes, dbi) {
  const offsets = [];
  const end = Math.min(DBI_HEADER_SIZE + dbi.moduleSubstreamSize, dbiBytes.length);
  let offset = DBI_HEADER_SIZE;
  while (offset + 64 <= end) {
    offsets.push(offset);
    let cursor = offset + 64;
    for (let name = 0; name < 2; name += 1) {
      while (cursor < end && dbiBytes[cursor] !== 0) cursor += 1;
      if (cursor >= end) return offsets;
      cursor += 1;
    }
    cursor = (cursor + 3) & ~3;
    if (cursor <= offset) break;
    offset = cursor;
  }
  return offsets;
}

function firstRecordByteLength(bytes) {
  assert.ok(bytes?.length >= 4, 'record stream must contain one record');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0, true);
  assert.ok(length >= 2 && length + 2 <= bytes.length, 'first record must fit the stream');
  return length + 2;
}

function mutateFixture({ disableGlobal = false, moduleMode = 'full', emptyTpi = false } = {}) {
  const original = fixtureBytes();
  const msf = parseMsf(original);
  assert.equal(msf.complete, true);
  const dbiBytes = msf.streams[3].read();
  const dbi = parseDbiHeader(dbiBytes);
  assert.ok(dbi);
  const modules = parseModuleInfo(dbiBytes, dbi).modules;
  assert.ok(modules.length >= 2, 'fixture must expose multiple module streams');
  const moduleEntryOffsets = dbiModuleEntryOffsets(dbiBytes, dbi);
  assert.equal(moduleEntryOffsets.length, modules.length);
  const layout = msfLayout(original);
  const patched = original.slice();
  const view = new DataView(patched.buffer, patched.byteOffset, patched.byteLength);

  if (disableGlobal) {
    view.setUint16(streamFileOffset(layout, 3, 20), 0xffff, true);
  }

  for (let index = 0; index < modules.length; index += 1) {
    let symbolByteSize = modules[index].symbolByteSize;
    if (moduleMode === 'empty') {
      symbolByteSize = 4;
    } else if (moduleMode === 'one-record') {
      const moduleBytes = msf.streams[modules[index].streamIndex].read();
      symbolByteSize = 4 + firstRecordByteLength(moduleBytes.subarray(4, modules[index].symbolByteSize));
    }
    view.setUint32(streamFileOffset(layout, 3, moduleEntryOffsets[index] + 36), symbolByteSize, true);
  }

  if (emptyTpi) {
    const tpiBytes = msf.streams[2].read();
    const tpiView = new DataView(tpiBytes.buffer, tpiBytes.byteOffset, tpiBytes.byteLength);
    const firstIndex = tpiView.getUint32(8, true);
    view.setUint32(streamFileOffset(layout, 2, 12), firstIndex, true);
    view.setUint32(streamFileOffset(layout, 2, 16), 0, true);
  }

  return patched;
}

function probe(bytes, maxRecords) {
  return provider.probe({ ...pdbImage(variant), pdbBytes: bytes }, { budget: { maxRecords } });
}

function assertRecordBudgetStop(result, contextPattern) {
  assert.equal(result.status.completeness, 'truncated');
  assert.equal(result.status.stopReason, 'budget-exhausted');
  assert.match(result.diagnostics.join('\n'), /record budget exhausted/);
  if (contextPattern) assert.match(result.diagnostics.join('\n'), contextPattern);
}

test('#4093: one provider maxRecords budget is shared across global symbols, modules, and TPI', () => {
  const result = probe(fixtureBytes(), 1);
  assertRecordBudgetStop(result);
  assert.ok(result.counts.symbols + result.counts.types <= 1,
    'provider must not spend maxRecords independently in symbol and TPI parsers');
});

test('#4093: separate module streams cannot each reuse the same record budget', () => {
  const bytes = mutateFixture({ disableGlobal: true, moduleMode: 'one-record', emptyTpi: true });
  const result = probe(bytes, 1);
  assertRecordBudgetStop(result, /module symbol stream/);
  assert.equal(result.counts.types, 0);
});

test('#4093: global-only exhaustion is explicit and exact cap is not a false exhaustion', () => {
  const bytes = mutateFixture({ moduleMode: 'empty', emptyTpi: true });
  const exhausted = probe(bytes, 10); // fixture global symbol stream contains 11 records
  assertRecordBudgetStop(exhausted, /global symbol stream/);

  const exact = probe(bytes, 11);
  assert.notEqual(exact.status.stopReason, 'budget-exhausted');
  assert.doesNotMatch(exact.diagnostics.join('\n'), /record budget exhausted/);
});

test('#4093: TPI-only traversal consumes the same provider record authority', () => {
  const bytes = mutateFixture({ disableGlobal: true, moduleMode: 'empty' });
  const exhausted = probe(bytes, 9); // fixture TPI stream declares 10 records
  assertRecordBudgetStop(exhausted, /TPI stream/);

  const exact = probe(bytes, 10);
  assert.notEqual(exact.status.stopReason, 'budget-exhausted');
});

test('#4093: unmodelled CodeView records still consume provider record budget', () => {
  const bytes = mutateFixture({ disableGlobal: true, moduleMode: 'one-record' });
  const result = probe(bytes, 1);
  assertRecordBudgetStop(result, /module symbol stream|TPI stream/);
  assert.equal(result.counts.symbols, 0, 'the first module record is intentionally unmodelled');
  assert.equal(result.counts.types, 0, 'an unmodelled symbol record must still consume the sole record slot');
});

test('#4093: default budget preserves the existing real-fixture parse', () => {
  const result = provider.probe(pdbImage(variant));
  assert.equal(result.identity.verdict, 'matched-authoritative');
  assert.equal(result.counts.symbols, 6);
  assert.equal(result.counts.types, 10);
  assert.notEqual(result.status.stopReason, 'budget-exhausted');
});

test('#4093: pre-aborted probe still cancels before consuming any provider budget', () => {
  const controller = new AbortController();
  controller.abort();
  const result = provider.probe(pdbImage(variant), { budget: { maxRecords: 1 }, signal: controller.signal });
  assert.equal(result.status.stopReason, 'cancelled');
  assert.equal(result.authoritative, false);
});
