import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCil } from '../fixtures/medium-cil.mjs';
import { parseCil, probeCil } from '../../../js/managed/cil/parser.js';

const METHOD_TOKEN = 0x06000001;

function methodEntry(signature, flags = 0x0016) {
  return buildCil({
    methods: [{ name: 'Main', body: [0x2a], signature, flags }],
    cliFlags: 0x00000001,
    entryPointToken: METHOD_TOKEN,
  });
}

function expectUnsupported(built) {
  assert.equal(probeCil(built.bytes).supported, false);
  assert.throws(() => parseCil(built.bytes), /cil-unsupported-binary|cil-entrypoint-/);
}

test('#7735 entry MethodDef must be static', () => {
  expectUnsupported(methodEntry([0x20, 0x00, 0x01], 0x0006)); // instance void Main()
});

test('#7735 entry MethodDef return type is limited to void/int32/uint32', () => {
  expectUnsupported(methodEntry([0x00, 0x00, 0x0a])); // static int64 Main()
});

test('#7735 entry MethodDef parameter shape is limited to no args or string[]', () => {
  expectUnsupported(methodEntry([0x00, 0x01, 0x01, 0x08])); // static void Main(int32)
  expectUnsupported(methodEntry([0x00, 0x01, 0x01, 0x0e])); // static void Main(string)
});

test('#7735 permitted managed entry signatures remain accepted', () => {
  for (const signature of [
    [0x00, 0x00, 0x01], // static void Main()
    [0x00, 0x00, 0x08], // static int32 Main()
    [0x00, 0x00, 0x09], // static uint32 Main()
    [0x00, 0x01, 0x01, 0x1d, 0x0e], // static void Main(string[])
  ]) {
    const image = parseCil(methodEntry(signature).bytes);
    assert.equal(image.entryTargetKind, 'method-def');
    assert.equal(image.entryMethodToken, '0x06000001');
  }
});

test('#7735 File entry token is bound to the actual File table row count', () => {
  const fileRow = new Uint8Array(8);
  const fileView = new DataView(fileRow.buffer);
  fileView.setUint32(0, 0, true); // ContainsMetaData
  fileView.setUint16(4, 1, true); // first leading string
  fileView.setUint16(6, 1, true); // existing non-zero blob
  const make = (rid) => buildCil({
    methods: [{ name: 'Helper', body: [0x2a], signature: [0x00, 0x00, 0x01] }],
    leadingStrings: ['module.netmodule'],
    extraRows: [[0x26, { count: 1, bytes: fileRow }]],
    cliFlags: 0x00000001,
    entryPointToken: (0x26 << 24) | rid,
  });

  const valid = parseCil(make(1).bytes);
  assert.equal(valid.entryTargetKind, 'file');
  assert.equal(valid.entryPointToken, 0x26000001);
  expectUnsupported(make(2));
});
