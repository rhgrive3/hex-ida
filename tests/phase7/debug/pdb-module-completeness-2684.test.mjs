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
  const module = parseModuleInfo(dbiBytes, dbi).modules.find((entry) => (
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


const DBI_HEADER_SIZE = 64;

function lastObjectNameTerminator(dbiBytes, dbi) {
  const end = Math.min(DBI_HEADER_SIZE + dbi.moduleSubstreamSize, dbiBytes.length);
  let offset = DBI_HEADER_SIZE;
  let last = -1;
  while (offset + 64 <= end) {
    let cursor = offset + 64;
    let complete = true;
    for (let name = 0; name < 2; name++) {
      while (cursor < end && dbiBytes[cursor] !== 0) cursor += 1;
      if (cursor >= end) {
        complete = false;
        break;
      }
      if (name === 1) last = cursor;
      cursor += 1;
    }
    if (!complete) break;
    cursor = (cursor + 3) & ~3;
    if (cursor <= offset) break;
    offset = cursor;
  }
  return last;
}

test('PDB provider downgrades a malformed module list while global evidence remains valid', () => {
  const variant = loadPdbFixtures().variants[0];
  const original = new Uint8Array(Buffer.from(variant.pdb, 'base64'));
  const msf = parseMsf(original);
  assert.equal(msf.complete, true);

  const dbiBytes = msf.streams[3].read();
  const dbi = parseDbiHeader(dbiBytes);
  assert.ok(dbi, 'fixture DBI header must be valid');
  const objectTerminator = lastObjectNameTerminator(dbiBytes, dbi);
  assert.ok(objectTerminator >= DBI_HEADER_SIZE, 'fixture must contain a module object name');

  // Remove the final object-name terminator inside the declared module
  // substream. Other streams (global symbols, TPI, and section headers) stay
  // byte-for-byte valid, but the module walk must become incomplete.
  const corrupted = original.slice();
  const { blockSize, blocks } = msfStreamBlocks(original);
  const blockIndex = blocks[3]?.[Math.floor(objectTerminator / blockSize)];
  assert.notEqual(blockIndex, undefined, 'DBI object name must have a physical block');
  corrupted[blockIndex * blockSize + (objectTerminator % blockSize)] = 0x41;

  const result = new PdbDebugInfoProvider().probe({ ...pdbImage(variant), pdbBytes: corrupted });
  assert.equal(result.identity.verdict, 'matched-authoritative');
  assert.equal(result.parsed.tpi.complete, true, 'unrelated TPI evidence remains complete');
  assert.equal(result.parsed.symbols.complete, false, 'malformed module evidence must make symbols partial');
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.stopReason, 'evidence-missing');
  assert.match(result.diagnostics.join('\\n'), /module list is incomplete/);
});
