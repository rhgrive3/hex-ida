import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PdbDebugInfoProvider,
  parseDbiHeader,
  parseModuleInfo,
  parseMsf,
} from '../../../js/analysis/debug/pdb.js';
import {
  loadPdbFixtures,
  pdbImage,
} from '../../../tools/validation/phase7/lanes/debug.mjs';

function msfStreamBlocks(bytes) {
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

test('PDB provider propagates incomplete per-module symbol streams', () => {
  const variant = loadPdbFixtures().variants[0];
  const original = new Uint8Array(Buffer.from(variant.pdb, 'base64'));
  const msf = parseMsf(original);
  assert.equal(msf.complete, true);

  const dbiBytes = msf.streams[3].read();
  const dbi = parseDbiHeader(dbiBytes);
  const module = parseModuleInfo(dbiBytes, dbi).find((entry) => (
    entry.streamIndex >= 0
    && entry.symbolByteSize > 8
    && msf.streams[entry.streamIndex]?.size > 8
  ));
  assert.ok(module, 'fixture must contain a module symbol stream');

  const { blockSize, blocks } = msfStreamBlocks(original);
  const firstBlock = blocks[module.streamIndex]?.[0];
  assert.notEqual(firstBlock, undefined, 'module stream must have a physical block');

  const corrupted = original.slice();
  const recordOffset = firstBlock * blockSize + 4; // skip the module stream signature
  new DataView(corrupted.buffer, corrupted.byteOffset, corrupted.byteLength)
    .setUint16(recordOffset, 0xffff, true);

  const provider = new PdbDebugInfoProvider();
  const result = provider.probe({ ...pdbImage(variant), pdbBytes: corrupted });

  assert.equal(result.identity.verdict, 'matched-authoritative');
  assert.equal(result.parsed.symbols.complete, false,
    'module parser incompleteness must reach the canonical symbol accumulator');
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.stopReason, 'evidence-missing');
});
