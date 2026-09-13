import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCil, probeCil } from '../../../js/managed/cil/parser.js';
import { overlayCilMetadata } from '../../../js/managed/cil/parser-overlay.js';
import { parseCil as parseCilBase } from '../../../js/managed/cil/parser-base.js';
import { CilFrontend } from '../../../js/managed/cil/frontend.js';
import { buildCil } from '../fixtures/medium-cil.mjs';

function moduleRow({ nameIndex = 1, mvidGuidIndex = 1, generation = 0, encId = 0, encBaseId = 0 } = {}) {
  const row = new Uint8Array(10); // 2 + s(2) + g(2)*3
  const v = new DataView(row.buffer);
  v.setUint16(0, generation, true);
  v.setUint16(2, nameIndex, true);
  v.setUint16(4, mvidGuidIndex, true);
  v.setUint16(6, encId, true);
  v.setUint16(8, encBaseId, true);
  return row;
}

const SAMPLE_GUID_1 = new Uint8Array([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
]);
const SAMPLE_GUID_2 = new Uint8Array([
  0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22,
  0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0x00,
]);

function fixture(row, { guidBytes = SAMPLE_GUID_1, leadingStrings = ['Foo.netmodule', 'Bar.netmodule'] } = {}) {
  return buildCil({
    leadingStrings,
    extraRows: new Map([[0x00, { count: 1, bytes: row }]]),
    extraStreams: [{ name: '#GUID', bytes: guidBytes }],
  }).bytes;
}

function overlayError(bytes) {
  try {
    overlayCilMetadata(bytes, parseCilBase(bytes, { binaryId: 'bad' }));
    return null;
  } catch (error) {
    return error.message;
  }
}

test('7689: valid Module #1.Name parses to canonical Module.name', () => {
  const bytes1 = fixture(moduleRow({ nameIndex: 1 }));
  assert.equal(probeCil(bytes1).supported, true);
  const a = parseCil(bytes1, { binaryId: 'test-bin' });
  assert.ok(a.module, 'image.module must exist');
  assert.equal(a.module.name, 'Foo.netmodule');
  assert.equal(a.module.rid, 1);
  assert.equal(a.module.token, '0x00000001');
  assert.equal(a.module.generation, 0);
  assert.equal(a.module.encId, 0);
  assert.equal(a.module.encBaseId, 0);
  assert.ok(a.module.mvid, 'mvid must be non-null');
  assert.equal(a.moduleName, 'Foo.netmodule');
});

test('7689: Module.Name changes module projection, moduleId, and frontend name', async () => {
  const bytes1 = fixture(moduleRow({ nameIndex: 1 })); // Foo.netmodule
  const bytes2 = fixture(moduleRow({ nameIndex: 1 + 'Foo.netmodule'.length + 1 })); // Bar.netmodule

  const a = parseCil(bytes1, { binaryId: 'same' });
  const b = parseCil(bytes2, { binaryId: 'same' });

  assert.equal(a.module.name, 'Foo.netmodule');
  assert.equal(b.module.name, 'Bar.netmodule');
  assert.notEqual(a.moduleId, b.moduleId);
  assert.ok(a.moduleId.includes('Foo.netmodule'));
  assert.ok(b.moduleId.includes('Bar.netmodule'));

  const frontend = new CilFrontend();
  const modulesA = [];
  for await (const m of frontend.enumerateModules(a)) modulesA.push(m);
  const modulesB = [];
  for await (const m of frontend.enumerateModules(b)) modulesB.push(m);

  assert.equal(modulesA.length, 1);
  assert.equal(modulesA[0].name, 'Foo.netmodule');
  assert.equal(modulesB.length, 1);
  assert.equal(modulesB[0].name, 'Bar.netmodule');
});

test('7689: non-null MVID GUID is preserved and changes with guid bytes', () => {
  const bytes1 = fixture(moduleRow({ nameIndex: 1 }), { guidBytes: SAMPLE_GUID_1 });
  const bytes2 = fixture(moduleRow({ nameIndex: 1 }), { guidBytes: SAMPLE_GUID_2 });

  const a = parseCil(bytes1, { binaryId: 'same' });
  const b = parseCil(bytes2, { binaryId: 'same' });

  assert.ok(a.module.mvid);
  assert.ok(b.module.mvid);
  assert.notEqual(a.module.mvid, b.module.mvid);
  assert.notDeepEqual(a.module.mvidBytes, b.module.mvidBytes);
  assert.deepEqual(a.module.mvidBytes, SAMPLE_GUID_1);
  assert.deepEqual(b.module.mvidBytes, SAMPLE_GUID_2);
});

test('7689: fail-closed validations on Module table', () => {
  // Multi-row Module table
  const twoRows = new Uint8Array(20);
  twoRows.set(moduleRow({ nameIndex: 1 }), 0);
  twoRows.set(moduleRow({ nameIndex: 1 }), 10);
  assert.equal(
    overlayError(buildCil({
      extraRows: new Map([[0x00, { count: 2, bytes: twoRows }]]),
      extraStreams: [{ name: '#GUID', bytes: SAMPLE_GUID_1 }],
    }).bytes),
    'cil-module-table-multi-row',
  );

  // 0-row Module table declared in valid mask
  assert.equal(
    overlayError(buildCil({
      extraRows: new Map([[0x00, { count: 0, bytes: new Uint8Array(0) }]]),
      extraStreams: [{ name: '#GUID', bytes: SAMPLE_GUID_1 }],
    }).bytes),
    'cil-module-table-empty',
  );

  // zero Name index
  assert.equal(
    overlayError(fixture(moduleRow({ nameIndex: 0 }))),
    'cil-module-name-missing',
  );

  // invalid Name index
  assert.equal(
    overlayError(fixture(moduleRow({ nameIndex: 999 }))),
    'cil-definition-string-index-invalid',
  );

  // zero Mvid GUID index
  assert.equal(
    overlayError(fixture(moduleRow({ mvidGuidIndex: 0 }))),
    'cil-module-mvid-missing',
  );

  // out-of-range Mvid GUID index
  assert.equal(
    overlayError(fixture(moduleRow({ mvidGuidIndex: 5 }))),
    'cil-module-mvid-invalid',
  );

  // missing #GUID stream
  const noGuidStream = buildCil({
    leadingStrings: ['Foo.netmodule'],
    extraRows: new Map([[0x00, { count: 1, bytes: moduleRow({ nameIndex: 1, mvidGuidIndex: 1 }) }]]),
  }).bytes;
  assert.equal(
    overlayError(noGuidStream),
    'cil-module-guid-heap-missing',
  );

  // non-zero generation
  assert.equal(
    overlayError(fixture(moduleRow({ generation: 1 }))),
    'cil-module-generation-invalid',
  );

  // non-zero encId
  assert.equal(
    overlayError(fixture(moduleRow({ encId: 1 }))),
    'cil-module-encid-invalid',
  );

  // non-zero encBaseId
  assert.equal(
    overlayError(fixture(moduleRow({ encBaseId: 1 }))),
    'cil-module-encbaseid-invalid',
  );
});
