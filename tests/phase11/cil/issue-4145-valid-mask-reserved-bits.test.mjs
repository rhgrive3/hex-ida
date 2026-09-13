import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCilCallMetadataIndex } from '../../../js/managed/cil/call-signature-metadata.js';
import { parseCil, probeCil } from '../../../js/managed/cil/parser.js';
import { overlayCilMetadata } from '../../../js/managed/cil/parser-overlay.js';
import { buildCil } from '../fixtures/medium-cil.mjs';

const MODULE_GUID = Uint8Array.from([
  0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
  0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
]);

function moduleRow() {
  const bytes = new Uint8Array(10), view = new DataView(bytes.buffer);
  view.setUint16(2, 1, true); // #Strings[1] is the fixture Module name.
  view.setUint16(4, 1, true); // #GUID[1] is the fixture MVID.
  return bytes;
}

function validFixture(options = {}) {
  const extraRows = new Map([[0x00, { count: 1, bytes: moduleRow() }], ...(options.extraRows ?? [])]);
  return buildCil({
    ...options,
    leadingStrings: ['issue-4145.netmodule', ...(options.leadingStrings ?? [])],
    extraRows,
    extraStreams: [{ name: '#GUID', bytes: MODULE_GUID }, ...(options.extraStreams ?? [])],
  });
}

const parsedImage = () => ({ imageId: 'issue-4145-fixture', methodBodies: [], entryPointToken: 0 });

function fixtureWithTable(table, { tableName = '#~', count = 0 } = {}) {
  return validFixture({
    methods: [],
    types: [],
    tableName,
    extraRows: new Map([[table, { count, bytes: new Uint8Array(0) }]]),
  }).bytes;
}

function reservedFixtures() {
  const out = [];
  for (const tableName of ['#~', '#-']) {
    for (let table = 0x2d; table <= 0x3f; table++) {
      out.push({ table, tableName, bytes: fixtureWithTable(table, { tableName, count: 0 }) });
    }
  }
  return out;
}

test('#4145: public CIL probe/parse reject every reserved metadata-table Valid bit', () => {
  for (const { table, tableName, bytes } of reservedFixtures()) {
    const label = `${tableName} table 0x${table.toString(16)}`;
    assert.equal(probeCil(bytes).supported, false, label);
    assert.throws(() => parseCil(bytes), /cil-unsupported-binary/, label);
  }
});

test('#4145: metadata overlay rejects reserved Valid bits before consuming row counts', () => {
  const bytes = fixtureWithTable(0x3f, { count: 0 });
  assert.throws(
    () => overlayCilMetadata(bytes, parsedImage()),
    /cil-metadata-valid-mask-invalid/,
  );
});

test('#4145: call-signature metadata index rejects reserved Valid bits', () => {
  const bytes = fixtureWithTable(0x2d, { tableName: '#-', count: 0 });
  assert.throws(() => buildCilCallMetadataIndex(bytes), /cil-call-signature-valid-mask-invalid/);
});

test('#4145: every defined metadata table Valid bit remains accepted when its row count is zero', () => {
  for (const tableName of ['#~', '#-']) {
    // Module (0x00) has a separate exactly-one-row identity contract.
    for (let table = 0x01; table <= 0x2c; table++) {
      const bytes = fixtureWithTable(table, { tableName, count: 0 });
      const label = `${tableName} table 0x${table.toString(16)}`;
      assert.equal(probeCil(bytes).supported, true, label);
      assert.doesNotThrow(() => parseCil(bytes), label);
      assert.doesNotThrow(() => overlayCilMetadata(bytes, parsedImage()), label);
      assert.doesNotThrow(() => buildCilCallMetadataIndex(bytes), label);
    }
  }
});

test('#4145: reserved-bit validation precedes row-count reads', () => {
  const fixture = validFixture({
    methods: [],
    types: [],
    extraRows: new Map([[0x3f, { count: 0, bytes: new Uint8Array(0) }]]),
  });
  const tables = fixture.layout.streams.find((stream) => stream.name === '#~');
  new DataView(fixture.bytes.buffer).setUint32(tables.header + 4, 24, true);
  assert.throws(
    () => overlayCilMetadata(fixture.bytes, parsedImage()),
    /cil-metadata-valid-mask-invalid/,
  );
  assert.throws(
    () => buildCilCallMetadataIndex(fixture.bytes),
    /cil-call-signature-valid-mask-invalid/,
  );
});

test('#4145: a valid MethodDef cannot mask a reserved Valid bit', () => {
  const bytes = validFixture({ extraRows: new Map([[0x2d, { count: 0, bytes: new Uint8Array(0) }]]) }).bytes;
  assert.equal(probeCil(bytes).supported, false);
  assert.throws(() => parseCil(bytes), /cil-unsupported-binary/);
});

test('#4145: valid empty metadata table mask remains accepted', () => {
  const bytes = validFixture({ methods: [], types: [] }).bytes;
  assert.equal(probeCil(bytes).supported, true);
  assert.doesNotThrow(() => parseCil(bytes));
  assert.doesNotThrow(() => overlayCilMetadata(bytes, parsedImage()));
  assert.doesNotThrow(() => buildCilCallMetadataIndex(bytes));
});
