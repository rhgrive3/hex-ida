import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WIRE_TYPE,
  BINEXPORT2_FIELDS,
  CALL_GRAPH_VERTEX_TYPE,
  EXPRESSION_TYPE,
  FLOW_GRAPH_EDGE_TYPE,
  COMMENT_TYPE,
  encodeBinExport2,
  decodeBinExport2,
} from '../js/ui/binexport2-writer.js';
import {
  EXPORT_FORMATS,
  exportBinExport2,
  importBinExport2,
  createExportInteropController,
} from '../js/ui/export-interop.js';

/**
 * Parses top-level Protobuf field tags `(fieldNumber << 3) | wireType` directly
 * from raw binary bytes to assert exact 1:1 compliance with binexport2.proto.
 */
function inspectTopLevelTags(bytes) {
  const tags = [];
  let pos = 0;
  function readVarint() {
    let val = 0n;
    let shift = 0n;
    while (pos < bytes.length) {
      const b = bytes[pos++];
      val |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return val;
      shift += 7n;
    }
    throw new Error('Unexpected EOF reading varint');
  }
  while (pos < bytes.length) {
    const rawTag = readVarint();
    const wireType = Number(rawTag & 7n);
    const fieldNumber = Number(rawTag >> 3n);
    tags.push({ rawTag: Number(rawTag), fieldNumber, wireType });
    if (wireType === WIRE_TYPE.VARINT) readVarint();
    else if (wireType === WIRE_TYPE.FIXED64) pos += 8;
    else if (wireType === WIRE_TYPE.LEN) { const len = Number(readVarint()); pos += len; }
    else if (wireType === WIRE_TYPE.FIXED32) pos += 4;
    else throw new Error(`Unknown wireType ${wireType}`);
  }
  return tags;
}

test('BinExport2: full encode -> decode round-trip with 64-bit BigInt VAs, CallGraph, FlowGraph, Sections, Libraries & Comments', () => {
  const input = {
    metaInformation: {
      executableName: 'target_arm64.macho',
      executableId: 'deadbeef0123456789abcdef',
      architectureName: 'aarch64-64',
      timestamp: 1732700000,
    },
    expression: [
      { type: EXPRESSION_TYPE.REGISTER, symbol: 'x0' },
      { type: EXPRESSION_TYPE.IMMEDIATE_INT, immediate: 0x100004000n, parentIndex: 0, isRelocation: true },
    ],
    operand: [
      { expressionIndex: [0, 1] },
    ],
    mnemonic: [
      { name: 'bl' },
      { name: 'ret' },
    ],
    instruction: [
      {
        address: 0x100004000n,
        callTarget: [0x100008000n],
        mnemonicIndex: 0,
        operandIndex: [0],
        rawBytes: new Uint8Array([0x00, 0x10, 0x00, 0x94]),
        commentIndex: [0],
      },
      {
        address: 0x100004004n,
        mnemonicIndex: 1,
        rawBytes: new Uint8Array([0xc0, 0x03, 0x5f, 0xd6]),
      },
    ],
    basicBlock: [
      { instructionIndex: [{ beginIndex: 0, endIndex: 2 }] },
    ],
    flowGraph: [
      {
        entryBasicBlockIndex: 0,
        basicBlockIndex: [0],
        edge: [
          {
            sourceBasicBlockIndex: 0,
            targetBasicBlockIndex: 0,
            type: FLOW_GRAPH_EDGE_TYPE.CONDITION_TRUE,
            isBackEdge: true,
          },
        ],
      },
    ],
    // Deliberately unsorted vertices to verify BinDiff ascending-address sort + edge index remapping
    callGraph: {
      vertex: [
        {
          address: 0x100008000n,
          type: CALL_GRAPH_VERTEX_TYPE.LIBRARY,
          mangledName: '_ZN3Foo3barEv',
          demangledName: 'Foo::bar()',
          libraryIndex: 0,
          moduleIndex: 0,
        },
        {
          address: 0x100004000n,
          type: CALL_GRAPH_VERTEX_TYPE.NORMAL,
          mangledName: '_main',
          demangledName: 'main',
        },
      ],
      edge: [
        // Original index 1 (0x100004000) calls original index 0 (0x100008000)
        { sourceVertexIndex: 1, targetVertexIndex: 0 },
      ],
    },
    stringTable: ['entry function comment', 'hello world'],
    section: [
      { address: 0x100000000n, size: 0x20000n, flagR: true, flagW: false, flagX: true },
      { address: 0x100020000n, size: 0x4000n, flagR: true, flagW: true, flagX: false },
    ],
    library: [
      { isStatic: true, loadAddress: 0x100000000n, name: 'libfoo.a' },
    ],
    dataReference: [
      { instructionIndex: 0, address: 0x100020010n },
    ],
    module: [{ name: 'com.example.App' }],
    comment: [
      {
        instructionIndex: 0,
        instructionOperandIndex: 0,
        operandExpressionIndex: 0,
        stringTableIndex: 0,
        repeatable: true,
        type: COMMENT_TYPE.FUNCTION,
      },
    ],
    mdIndex: [
      { address: 0x100004000n, mdIndex: 42.75 },
    ],
  };

  const bytes = encodeBinExport2(input);
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.byteLength > 0);

  // Direct byte-level verification of top-level Protobuf tags against third_party/binexport/binexport2.proto
  const tags = inspectTopLevelTags(bytes);
  const expectedTagSet = new Set([
    (BINEXPORT2_FIELDS.META_INFORMATION << 3) | WIRE_TYPE.LEN, // 1 -> 0x0a
    (BINEXPORT2_FIELDS.EXPRESSION << 3) | WIRE_TYPE.LEN,       // 2 -> 0x12
    (BINEXPORT2_FIELDS.OPERAND << 3) | WIRE_TYPE.LEN,          // 3 -> 0x1a
    (BINEXPORT2_FIELDS.MNEMONIC << 3) | WIRE_TYPE.LEN,         // 4 -> 0x22
    (BINEXPORT2_FIELDS.INSTRUCTION << 3) | WIRE_TYPE.LEN,      // 5 -> 0x2a
    (BINEXPORT2_FIELDS.BASIC_BLOCK << 3) | WIRE_TYPE.LEN,      // 6 -> 0x32
    (BINEXPORT2_FIELDS.FLOW_GRAPH << 3) | WIRE_TYPE.LEN,       // 7 -> 0x3a
    (BINEXPORT2_FIELDS.CALL_GRAPH << 3) | WIRE_TYPE.LEN,       // 8 -> 0x42
    (BINEXPORT2_FIELDS.STRING_TABLE << 3) | WIRE_TYPE.LEN,     // 9 -> 0x4a
    (BINEXPORT2_FIELDS.SECTION << 3) | WIRE_TYPE.LEN,          // 13 -> 0x6a
    (BINEXPORT2_FIELDS.LIBRARY << 3) | WIRE_TYPE.LEN,          // 14 -> 0x72
    (BINEXPORT2_FIELDS.DATA_REFERENCE << 3) | WIRE_TYPE.LEN,   // 15 -> 0x7a
    (BINEXPORT2_FIELDS.COMMENT << 3) | WIRE_TYPE.LEN,          // 17 -> 0x8a (varint)
  ]);
  const actualRawTags = new Set(tags.map((t) => t.rawTag));
  for (const expectedTag of expectedTagSet) {
    assert.ok(actualRawTags.has(expectedTag), `Missing expected Protobuf tag 0x${expectedTag.toString(16)}`);
  }

  // Decode and verify full round-trip fidelity
  const decoded = decodeBinExport2(bytes);
  assert.equal(decoded.metaInformation.executableName, 'target_arm64.macho');
  assert.equal(decoded.metaInformation.executableId, 'deadbeef0123456789abcdef');
  assert.equal(decoded.metaInformation.architectureName, 'aarch64-64');
  assert.equal(decoded.metaInformation.timestamp, 1732700000n);

  assert.equal(decoded.expression.length, 2);
  assert.equal(decoded.expression[1].immediate, 0x100004000n);
  assert.equal(decoded.expression[1].isRelocation, true);
  assert.equal(decoded.operand.length, 1);
  assert.deepEqual(decoded.operand[0].expressionIndex, [0, 1]);
  assert.deepEqual(decoded.mnemonic.map((m) => m.name), ['bl', 'ret']);
  assert.equal(decoded.instruction[0].address, 0x100004000n);
  assert.deepEqual(decoded.instruction[0].callTarget, [0x100008000n]);
  assert.deepEqual([...decoded.instruction[0].rawBytes], [0x00, 0x10, 0x00, 0x94]);

  assert.equal(decoded.basicBlock[0].instructionIndex[0].beginIndex, 0);
  assert.equal(decoded.basicBlock[0].instructionIndex[0].endIndex, 2);
  assert.equal(decoded.flowGraph[0].entryBasicBlockIndex, 0);
  assert.equal(decoded.flowGraph[0].edge[0].type, FLOW_GRAPH_EDGE_TYPE.CONDITION_TRUE);
  assert.equal(decoded.flowGraph[0].edge[0].isBackEdge, true);

  // CallGraph vertices sorted ascending + edge remapped from (1 -> 0) to (0 -> 1)
  assert.equal(decoded.callGraph.vertex[0].address, 0x100004000n);
  assert.equal(decoded.callGraph.vertex[0].mangledName, '_main');
  assert.equal(decoded.callGraph.vertex[1].address, 0x100008000n);
  assert.equal(decoded.callGraph.vertex[1].demangledName, 'Foo::bar()');
  assert.equal(decoded.callGraph.vertex[1].libraryIndex, 0);
  assert.equal(decoded.callGraph.vertex[1].moduleIndex, 0);
  assert.deepEqual(decoded.callGraph.edge, [{ sourceVertexIndex: 0, targetVertexIndex: 1 }]);

  assert.deepEqual(decoded.stringTable, ['entry function comment', 'hello world']);
  assert.equal(decoded.section[0].address, 0x100000000n);
  assert.equal(decoded.section[0].size, 0x20000n);
  assert.equal(decoded.section[0].flagR, true);
  assert.equal(decoded.section[0].flagW, false);
  assert.equal(decoded.section[0].flagX, true);
  assert.equal(decoded.library[0].isStatic, true);
  assert.equal(decoded.library[0].name, 'libfoo.a');
  assert.equal(decoded.dataReference[0].address, 0x100020010n);
  assert.equal(decoded.comment[0].type, COMMENT_TYPE.FUNCTION);
  assert.equal(decoded.comment[0].repeatable, true);
  assert.equal(decoded.mdIndex[0].mdIndex, 42.75);
});

test('BinExport2: boundary validation rejects truncated streams, non-finite numbers & negative uint64s', () => {
  assert.throws(() => encodeBinExport2({ mdIndex: [{ address: 0x1000n, mdIndex: Number.NaN }] }));
  assert.throws(() => encodeBinExport2({ section: [{ address: -1n, size: 16n }] }));
  assert.throws(() => decodeBinExport2(new Uint8Array([0x0a, 0x7f, 0x01]))); // truncated length-delimited
  assert.throws(() => decodeBinExport2(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]))); // >10B varint

  // Malicious control chars stripped safely
  const bytes = encodeBinExport2({
    metaInformation: { executableName: 'evil\x00\x07\nbin.exe' },
  });
  const dec = decodeBinExport2(bytes);
  assert.equal(dec.metaInformation.executableName, 'evil bin.exe');
});

test('export-interop.js: binexport2 format export, import & controller integration', () => {
  assert.ok(EXPORT_FORMATS.includes('binexport2'));

  const model = {
    binaryName: 'app_arm64',
    binarySha256: '0123456789abcdef',
    arch: 'aarch64-64',
    functions: [
      { va: '0x100004000', name: 'init_game', comment: 'boot entry' },
      { va: '0xffff000010000008', name: 'kernel_hook' },
    ],
    sections: [
      { address: '0x100000000', size: 0x10000, flagR: true, flagW: false, flagX: true },
    ],
    libraries: [{ isStatic: false, name: 'libSystem.B.dylib' }],
  };

  const exported = exportBinExport2(model);
  assert.ok(exported.bytes instanceof Uint8Array);
  assert.ok(exported.byteLength > 0);
  assert.ok(exported.base64.length > 0);

  const importedFromBytes = importBinExport2(exported.bytes);
  assert.equal(importedFromBytes.ok, true);
  assert.equal(importedFromBytes.model.binaryName, 'app_arm64');
  assert.equal(importedFromBytes.model.functions.length, 2);
  assert.equal(importedFromBytes.model.functions[1].va, '0xffff000010000008');

  const ctrl = createExportInteropController({ model });
  ctrl.open({ format: 'binexport2' });
  const snap = ctrl.getState();
  assert.equal(snap.format, 'binexport2');
  assert.equal(snap.previewText, exported.base64);

  const applied = ctrl.applyImport(exported.base64);
  assert.equal(applied.ok, true);
  assert.equal(applied.model.functions[0].name, 'init_game');
});

test('BinExport2 Review Regressions: int64 string bounds, 10th-byte varint overflow, dangling CallGraph edges, strict base64/empty payload & valid Comment.instructionIndex', () => {
  // 1. Out-of-range string int64 -> RangeError
  assert.throws(
    () => encodeBinExport2({ metaInformation: { timestamp: '9223372036854775808' } }),
    RangeError,
  );
  assert.throws(
    () => encodeBinExport2({ metaInformation: { timestamp: '-9223372036854775809' } }),
    RangeError,
  );

  // 2. 10th-byte varint overflow (> 64 bits: b = 0x02 at i = 9) -> RangeError
  const overflowVarint = new Uint8Array([
    0x0a, 12, // field 1 (meta_information), len 12
    0x20,     // field 4 (timestamp), wireType 0 (varint)
    0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02,
  ]);
  assert.throws(() => decodeBinExport2(overflowVarint), RangeError);

  // 3. Out-of-range and negative CallGraph.Edge indices -> RangeError
  assert.throws(
    () => encodeBinExport2({
      callGraph: {
        vertex: [{ address: 0x1000n }],
        edge: [{ sourceVertexIndex: 0, targetVertexIndex: 99 }],
      },
    }),
    RangeError,
  );
  assert.throws(
    () => encodeBinExport2({
      callGraph: {
        vertex: [{ address: 0x1000n }],
        edge: [{ sourceVertexIndex: -1, targetVertexIndex: 0 }],
      },
    }),
    RangeError,
  );

  // 4. Strict base64 & empty payload rejection in importBinExport2
  assert.equal(importBinExport2(new Uint8Array(0)).ok, false);
  assert.equal(importBinExport2('').ok, false);
  assert.equal(importBinExport2('   ').ok, false);
  assert.equal(importBinExport2('abc').ok, false);       // length % 4 !== 0
  assert.equal(importBinExport2('!!!!').ok, false);      // invalid base64 chars

  // 5. buildBinExport2FromModel emits real instruction/basicBlock/flowGraph backing Comment.instructionIndex
  const exported = exportBinExport2({
    binaryName: 'comment_check.bin',
    functions: [
      { va: '0x100004000', name: 'fn_a', comment: 'first fn' },
      { va: '0x100004020', name: 'fn_b', comment: 'second fn' },
    ],
  });
  const imp = importBinExport2(exported.bytes);
  assert.equal(imp.ok, true);
  assert.equal(imp.data.instruction.length, 2);
  assert.equal(imp.data.basicBlock.length, 2);
  assert.equal(imp.data.flowGraph.length, 2);
  assert.equal(imp.data.comment.length, 2);
  for (const c of imp.data.comment) {
    assert.ok(c.instructionIndex >= 0 && c.instructionIndex < imp.data.instruction.length);
    assert.equal(c.type, COMMENT_TYPE.FUNCTION);
  }
});
