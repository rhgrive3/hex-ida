import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DBI_HEADER_SIZE,
  PdbDebugInfoProvider,
  parseModuleInfo,
} from '../../../js/analysis/debug/pdb.js';

const BLOCK_SIZE = 4096;
const MSF_MAGIC = 'Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0';
const HIGH_STREAM_INDEX = 0x8000;
const GUID = '11111111-2222-3333-4444-555555555555';

function moduleInfoBytes(streamIndex, symbolByteSize = 4) {
  const bytes = new Uint8Array(DBI_HEADER_SIZE + 72);
  const view = new DataView(bytes.buffer);
  view.setUint16(DBI_HEADER_SIZE + 34, streamIndex, true);
  view.setUint32(DBI_HEADER_SIZE + 36, symbolByteSize, true);
  bytes.set(new TextEncoder().encode('mod\0obj\0'), DBI_HEADER_SIZE + 64);
  return bytes;
}

function procedureStream() {
  const name = new TextEncoder().encode('high_proc\0');
  const record = new Uint8Array(39 + name.length);
  const view = new DataView(record.buffer);
  view.setUint16(0, record.length - 2, true);
  view.setUint16(2, 0x110f, true); // S_LPROC32
  view.setUint32(16, 16, true); // code length
  view.setUint32(28, 0x0074, true); // primitive int type index
  view.setUint32(32, 0x1000, true);
  view.setUint16(36, 1, true);
  record.set(name, 39);
  const stream = new Uint8Array(4 + record.length);
  stream.set(record, 4); // module stream signature occupies the first 4 bytes
  return stream;
}

function infoStream() {
  const bytes = new Uint8Array(28);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 20000404, true);
  view.setUint32(4, 0, true);
  view.setUint32(8, 1, true);
  view.setUint32(12, 0x11111111, true);
  view.setUint16(16, 0x2222, true);
  view.setUint16(18, 0x3333, true);
  bytes.set([0x44, 0x44, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55], 20);
  return bytes;
}

function tpiStream() {
  const bytes = new Uint8Array(56);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 56, true);
  view.setUint32(8, 0x1000, true);
  view.setUint32(12, 0x1000, true);
  view.setUint32(16, 0, true);
  return bytes;
}

function dbiStream(streamIndex, symbolByteSize) {
  const bytes = moduleInfoBytes(streamIndex, symbolByteSize);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, -1, true);
  view.setUint32(4, 19990903, true);
  view.setUint32(8, 1, true);
  view.setUint16(12, 0xffff, true);
  view.setUint16(16, 0xffff, true);
  view.setUint16(20, 4, true); // empty global symbol stream
  view.setInt32(24, 72, true); // one ModInfo record
  return bytes;
}

function buildSyntheticPdb({
  moduleStreamIndex = HIGH_STREAM_INDEX,
  streamCount = 0xffff,
  moduleSymbolByteSize = procedureStream().length,
} = {}) {
  const module = procedureStream();
  const streams = new Map([
    [1, infoStream()],
    [2, tpiStream()],
    [3, dbiStream(moduleStreamIndex, moduleSymbolByteSize)],
  ]);
  if (moduleStreamIndex < streamCount) streams.set(moduleStreamIndex, module);
  const directoryBytes = 4 + streamCount * 4 + [...streams.values()].reduce(
    (total, bytes) => total + Math.ceil(bytes.length / BLOCK_SIZE) * 4, 0,
  );
  const directoryBlockCount = Math.ceil(directoryBytes / BLOCK_SIZE);
  const blockMapAddr = 1;
  const directoryStart = 2;
  const dataStart = directoryStart + directoryBlockCount;
  const dataBlocks = [...streams.values()].reduce(
    (total, bytes) => total + Math.ceil(bytes.length / BLOCK_SIZE), 0,
  );
  const numBlocks = dataStart + dataBlocks;
  const bytes = new Uint8Array(numBlocks * BLOCK_SIZE);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(MSF_MAGIC), 0);
  view.setUint32(32, BLOCK_SIZE, true);
  view.setUint32(40, numBlocks, true);
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
  for (const [streamIndex, stream] of streams) {
    directory.setUint32(directoryCursor, nextDataBlock, true);
    directoryCursor += 4;
    bytes.set(stream, nextDataBlock * BLOCK_SIZE);
    nextDataBlock += Math.ceil(stream.length / BLOCK_SIZE);
    assert.ok(streamIndex < streamCount, `stream ${streamIndex} must fit the directory`);
  }
  return bytes;
}

test('DBI ModuleSymStream is an unsigned uint16 with an explicit nil sentinel', () => {
  for (const streamIndex of [0x7fff, 0x8000, 0xfffe, 0xffff]) {
    const result = parseModuleInfo(moduleInfoBytes(streamIndex), { moduleSubstreamSize: 72 });
    assert.equal(result.complete, true);
    assert.equal(result.modules[0]?.streamIndex, streamIndex);
  }
});

test('high-index module symbols reach the provider symbol and type views', () => {
  const provider = new PdbDebugInfoProvider();
  const result = provider.probe({
    snapshotId: 'issue-4431',
    identity: { codeView: { guid: GUID, age: 1 } },
    pdbBytes: buildSyntheticPdb(),
  });

  assert.equal(result.identity.verdict, 'matched-authoritative');
  assert.equal(result.parsed.symbols.complete, true);
  assert.ok(result.parsed.symbols.symbols.some((symbol) => (
    symbol.name === 'high_proc' && symbol.recordOffset === `${HIGH_STREAM_INDEX}:0`
  )));
  assert.ok(provider.symbols(result, {}).records.some((record) => record.name === 'high_proc'));
  assert.ok(provider.types(result, {}).records.some((record) => (
    record.name === 'high_proc' && record.descriptor.claim.name === 'int'
  )));
});

test('an unsigned module stream index beyond the directory fails closed', () => {
  const result = new PdbDebugInfoProvider().probe({
    snapshotId: 'issue-4431-out-of-range',
    identity: { codeView: { guid: GUID, age: 1 } },
    pdbBytes: buildSyntheticPdb({ moduleStreamIndex: 0xfffe, streamCount: 5 }),
  });

  assert.equal(result.identity.verdict, 'matched-authoritative');
  assert.equal(result.parsed.symbols.complete, false);
  assert.equal(result.parsed.symbols.symbols.some((symbol) => symbol.name === 'high_proc'), false);
});

test('0xffff module stream sentinel does not publish a missing stream as symbols', () => {
  const result = new PdbDebugInfoProvider().probe({
    snapshotId: 'issue-4431-sentinel',
    identity: { codeView: { guid: GUID, age: 1 } },
    pdbBytes: buildSyntheticPdb({ moduleStreamIndex: 0xffff, moduleSymbolByteSize: 4 }),
  });

  assert.equal(result.identity.verdict, 'matched-authoritative');
  assert.equal(result.parsed.symbols.complete, true);
  assert.equal(result.parsed.symbols.symbols.some((symbol) => symbol.name === 'high_proc'), false);
});

console.log('issue #4431 PDB unsigned ModuleSymStream regressions: PASS');
