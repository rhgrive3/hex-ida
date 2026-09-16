import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEBUG_DEFAULT_BUDGET } from '../../../js/analysis/debug/provider.js';
import { describeTypeIndex, PdbDebugInfoProvider } from '../../../js/analysis/debug/pdb.js';

const MSF_MAGIC = 'Microsoft C/C++ MSF 7.00\r\n\u001aDS\0\0\0';
const CODE_VIEW_GUID = '01234567-89AB-CDEF-0123-456789ABCDEF';
const CODE_VIEW_AGE = 1;
const TPI_FIRST_INDEX = 0x1000;
const INT32_TYPE = 0x0074;
const LF_POINTER = 0x1002;
const LF_PROCEDURE = 0x1008;
const LF_ARGLIST = 0x1201;
const S_LPROC32 = 0x110f;
const BLOCK_SIZE = 512;
const GLOBAL_SYMBOL_STREAM_INDEX = 4;
const MODULE_SYMBOL_STREAM_INDEX = 5;
const SECTION_HEADER_STREAM_INDEX = 6;
const MIN_SYNTHETIC_PDB_BLOCKS = 56;

function concatBytes(...chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function typeRecord(leaf, body) {
  const length = 2 + body.length;
  const out = new Uint8Array(2 + length);
  const view = new DataView(out.buffer);
  view.setUint16(0, length, true);
  view.setUint16(2, leaf, true);
  out.set(body, 4);
  return out;
}

function buildTpiStream(depth, { argumentFanout = 2 } = {}) {
  assert.ok(Number.isSafeInteger(argumentFanout) && argumentFanout >= 0);
  const records = [];
  let previous = INT32_TYPE;
  for (let level = 1; level <= depth; level += 1) {
    const pointerIndex = TPI_FIRST_INDEX + (level - 1) * 3;
    const argListIndex = pointerIndex + 1;
    const procedureIndex = pointerIndex + 2;

    const pointerBody = new Uint8Array(8);
    const pointerView = new DataView(pointerBody.buffer);
    pointerView.setUint32(0, previous, true);
    // PointerKind = Near64 (0x0c), SizeOf = 8. The attributes are valid so
    // the test reaches the renderer rather than being rejected as malformed.
    pointerView.setUint32(4, (8 << 13) | 0x0c, true);
    records.push(typeRecord(LF_POINTER, pointerBody));

    const argListBody = new Uint8Array(4 + argumentFanout * 4);
    const argListView = new DataView(argListBody.buffer);
    argListView.setUint32(0, argumentFanout, true);
    for (let argument = 0; argument < argumentFanout; argument += 1) {
      argListView.setUint32(4 + argument * 4, pointerIndex, true);
    }
    records.push(typeRecord(LF_ARGLIST, argListBody));

    const procedureBody = new Uint8Array(12);
    const procedureView = new DataView(procedureBody.buffer);
    procedureView.setUint32(0, pointerIndex, true);
    procedureView.setUint8(4, 0); // canonical near-C calling convention
    procedureView.setUint8(5, 0); // no function options
    procedureView.setUint16(6, argumentFanout, true);
    procedureView.setUint32(8, argListIndex, true);
    records.push(typeRecord(LF_PROCEDURE, procedureBody));
    previous = procedureIndex;
  }

  const body = concatBytes(...records);
  const header = new Uint8Array(56);
  const view = new DataView(header.buffer);
  view.setUint32(4, 56, true);
  view.setUint32(8, TPI_FIRST_INDEX, true);
  view.setUint32(12, TPI_FIRST_INDEX + records.length, true);
  view.setUint32(16, body.length, true);
  return concatBytes(header, body);
}

function guidBytes(guid) {
  const [first, second, third, fourth, fifth] = guid.split('-');
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setUint32(0, Number.parseInt(first, 16), true);
  view.setUint16(4, Number.parseInt(second, 16), true);
  view.setUint16(6, Number.parseInt(third, 16), true);
  for (let index = 0; index < 2; index += 1) {
    out[8 + index] = Number.parseInt(fourth.slice(index * 2, index * 2 + 2), 16);
  }
  for (let index = 0; index < 6; index += 1) {
    out[10 + index] = Number.parseInt(fifth.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function buildInfoStream() {
  const out = new Uint8Array(28);
  const view = new DataView(out.buffer);
  view.setUint32(0, 20000404, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, CODE_VIEW_AGE, true);
  out.set(guidBytes(CODE_VIEW_GUID), 12);
  return out;
}

function buildProcedureSymbol(typeIndex) {
  const name = new TextEncoder().encode('dag_depth_root\0');
  // S_*PROC32 has its NUL-terminated name at byte 39.
  const total = 39 + name.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, total - 2, true);
  view.setUint16(2, S_LPROC32, true);
  view.setUint32(16, 0x100, true); // procedure extent
  view.setUint32(28, typeIndex, true);
  view.setUint32(32, 0, true);
  view.setUint16(36, 1, true);
  out.set(name, 39);
  return out;
}

function buildModuleStream(typeIndex) {
  const symbolBytes = concatBytes(new Uint8Array(4), buildProcedureSymbol(typeIndex));
  const names = new TextEncoder().encode('synthetic.obj\0synthetic.cpp\0');
  const unaligned = 64 + names.length;
  const moduleSize = (unaligned + 3) & ~3;
  const out = new Uint8Array(moduleSize);
  const view = new DataView(out.buffer);
  view.setUint16(34, MODULE_SYMBOL_STREAM_INDEX, true); // ModuleSymStream
  view.setUint32(36, symbolBytes.length, true); // SymByteSize
  out.set(names, 64);
  return { moduleBytes: symbolBytes, moduleSubstream: out };
}

function buildDbiStream(typeIndex, moduleBytes, moduleSubstream) {
  const optionalDebugHeader = new Uint8Array(12);
  new DataView(optionalDebugHeader.buffer).setUint16(10, SECTION_HEADER_STREAM_INDEX, true);
  const header = new Uint8Array(64);
  const view = new DataView(header.buffer);
  view.setInt32(0, -1, true);
  view.setUint32(4, 19990903, true);
  view.setUint32(8, CODE_VIEW_AGE, true);
  view.setUint16(12, 0xffff, true);
  view.setUint16(16, 0xffff, true);
  view.setUint16(20, GLOBAL_SYMBOL_STREAM_INDEX, true);
  view.setInt32(24, moduleSubstream.length, true);
  view.setInt32(48, optionalDebugHeader.length, true);
  // Keep the argument in the helper signature so accidental fixture changes
  // cannot silently stop carrying the procedure stream's declared size.
  assert.ok(moduleBytes.length > 4 && typeIndex >= TPI_FIRST_INDEX);
  return concatBytes(header, moduleSubstream, optionalDebugHeader);
}

function buildSectionHeaderStream() {
  const out = new Uint8Array(40);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode('.text\0'), 0);
  view.setUint32(8, 0x100000, true);
  view.setUint32(12, 0x1000, true);
  view.setUint32(16, 0x100000, true);
  return out;
}

function buildMsf(streams) {
  const directoryBlock = 2;
  let nextBlock = 3;
  const allocations = streams.map((stream) => {
    const count = Math.ceil(stream.length / BLOCK_SIZE);
    const blocks = Array.from({ length: count }, (_, index) => nextBlock + index);
    nextBlock += count;
    return blocks;
  });
  const directoryBytes = 4 + streams.length * 4
    + allocations.reduce((sum, blocks) => sum + blocks.length * 4, 0);
  const directory = new Uint8Array(directoryBytes);
  const directoryView = new DataView(directory.buffer);
  directoryView.setUint32(0, streams.length, true);
  let cursor = 4;
  for (const stream of streams) {
    directoryView.setUint32(cursor, stream.length, true);
    cursor += 4;
  }
  for (const blocks of allocations) {
    for (const block of blocks) {
      directoryView.setUint32(cursor, block, true);
      cursor += 4;
    }
  }

  // Keep the container at the issue's reported 28 KiB size. The unused tail
  // represents ordinary free MSF blocks and must not affect TPI acceptance.
  const numBlocks = Math.max(nextBlock, MIN_SYNTHETIC_PDB_BLOCKS);
  const out = new Uint8Array(numBlocks * BLOCK_SIZE);
  const superblock = new DataView(out.buffer);
  out.set(Uint8Array.from(Buffer.from(MSF_MAGIC, 'latin1')), 0);
  superblock.setUint32(32, BLOCK_SIZE, true);
  superblock.setUint32(36, 1, true);
  superblock.setUint32(40, numBlocks, true);
  superblock.setUint32(44, directory.length, true);
  superblock.setUint32(52, 1, true);
  new DataView(out.buffer, BLOCK_SIZE, BLOCK_SIZE).setUint32(0, directoryBlock, true);
  out.set(directory, directoryBlock * BLOCK_SIZE);

  for (let streamIndex = 0; streamIndex < streams.length; streamIndex += 1) {
    const stream = streams[streamIndex];
    for (let block = 0; block < allocations[streamIndex].length; block += 1) {
      const start = block * BLOCK_SIZE;
      const chunk = stream.subarray(start, start + BLOCK_SIZE);
      out.set(chunk, allocations[streamIndex][block] * BLOCK_SIZE);
    }
  }
  return out;
}

function syntheticPdb(depth, { argumentFanout = 2 } = {}) {
  const tpi = buildTpiStream(depth, { argumentFanout });
  const rootTypeIndex = TPI_FIRST_INDEX + (depth - 1) * 3 + 2;
  const { moduleBytes, moduleSubstream } = buildModuleStream(rootTypeIndex);
  const dbi = buildDbiStream(rootTypeIndex, moduleBytes, moduleSubstream);
  const streams = [
    new Uint8Array(0),
    buildInfoStream(),
    tpi,
    dbi,
    new Uint8Array(0),
    moduleBytes,
    buildSectionHeaderStream(),
  ];
  return {
    identity: {
      codeView: { guid: CODE_VIEW_GUID, age: CODE_VIEW_AGE, path: 'synthetic-dag.pdb' },
    },
    pdbBytes: buildMsf(streams),
    imageBase: 0x140000000n,
    snapshotId: 'issue-8729-depth-' + depth,
  };
}

function childSummary(depth) {
  const image = syntheticPdb(depth);
  const provider = new PdbDebugInfoProvider();
  const result = provider.probe(image);
  const page = provider.types(result, { pageSize: 1 });
  const record = page.records[0];
  return {
    depth,
    pdbBytes: image.pdbBytes.length,
    tpiBytes: result.parsed.tpi.types.size,
    identity: result.identity.verdict,
    pageTruncated: page.truncated,
    incompleteReason: page.incompleteReason ?? null,
    statusCompleteness: page.status?.completeness ?? null,
    recordComplete: record?.descriptor?.complete ?? null,
    recordName: record?.descriptor?.claim?.name ?? null,
    typeRender: page.typeRender ?? null,
  };
}

test('small procedure DAG remains renderable', () => {
  const summary = childSummary(2);
  assert.equal(summary.identity, 'matched-authoritative');
  assert.equal(summary.pageTruncated, false);
  assert.equal(summary.incompleteReason, null);
  assert.equal(summary.statusCompleteness, null);
  assert.equal(summary.recordComplete, true);
  assert.ok(summary.recordName.includes('(*)(int *'));
});

test('deep procedure DAG is bounded and published as partial', () => {
  const summary = childSummary(14);
  assert.equal(summary.identity, 'matched-authoritative');
  assert.equal(summary.pageTruncated, false);
  assert.equal(summary.incompleteReason, 'pdb-type-render-budget');
  assert.equal(summary.statusCompleteness, 'truncated');
  assert.equal(summary.recordComplete, false);
  assert.ok(summary.typeRender.work <= summary.typeRender.maxWork);
  assert.ok(summary.typeRender.outputChars <= summary.typeRender.maxOutputChars);
});

test('wide procedure argument lists are bounded before expansion', () => {
  const image = syntheticPdb(1, { argumentFanout: DEBUG_DEFAULT_BUDGET.maxTypeWork + 10 });
  const provider = new PdbDebugInfoProvider();
  const result = provider.probe(image);
  const page = provider.types(result, { pageSize: 1 });
  assert.equal(page.incompleteReason, 'pdb-type-render-budget');
  assert.equal(page.status?.completeness, 'truncated');
  assert.equal(page.records[0].descriptor.complete, false);
  assert.ok(page.typeRender.work <= page.typeRender.maxWork);
});

test('direct type description stops on an active cycle', () => {
  const types = new Map([
    [0x2000, { kind: 'procedure', returnType: 0x2000, argumentList: 0x2001, parameterCount: 0,
      callingConvention: 0, functionOptions: 0 }],
    [0x2001, { kind: 'arg-list', complete: true, arguments: [] }],
  ]);
  const described = describeTypeIndex(0x2000, types);
  assert.equal(described.complete, false);
  assert.equal(described.name, 'unknown (*)()');
});
