import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCil, cilTables } from '../fixtures/medium-cil.mjs';
import { parseCil, probeCil } from '../../../js/managed/cil/parser.js';

// #7803 / #7800 — the manifest's File (0x26) and ExportedType (0x27) tables
// were physically laid out but never semantically decoded, so multi-module
// file identity + hash authority (#7803) and exported type / type-forwarder
// declarations (#7800) vanished from the canonical image: two manifests
// differing only in a File name, a File hash payload, or an ExportedType
// name collapsed to identical semantic state.

const align = (n) => Math.ceil(n / 4) * 4;
const pad = (b) => { const p = new Uint8Array(align(b.length)); p.set(b); return p; };
const utf8 = (s) => [...new TextEncoder().encode(s), 0];

// #Strings: [0]'' [1]'A.netmodule' [13]'B.netmodule' [25]'Widget' [32]'Example' [40]'T'
// #Blob:    [0]reserved [1] = 3-byte hash payload
function manifestFixture({
  file1NameIndex = 1,
  exportedTypeNameIndex = 25,
  hashByte = 0xaa,
  fileFlags = 0,
  fileFlagsRow,
  exportedRow,
  fileHashIndex = 1,
} = {}) {
  const strings = [0, ...utf8('A.netmodule'), ...utf8('B.netmodule'), ...utf8('Widget'), ...utf8('Example'), ...utf8('T')];
  const blob = Uint8Array.from([0, 0x03, hashByte, 0xbb, 0xcc]);
  const files = new Uint8Array(8), fv = new DataView(files.buffer);
  fv.setUint32(0, fileFlags, true);
  fv.setUint16(4, file1NameIndex, true);
  fv.setUint16(6, fileHashIndex, true);
  // ExportedType: Flags(4) TypeDefId(4) TypeName(2) TypeNamespace(2) Implementation(2)
  const exported = new Uint8Array(14), ev = new DataView(exported.buffer);
  ev.setUint32(0, 0x00200001, true); // Public | Forwarder
  ev.setUint32(4, 0, true);          // TypeDefId
  ev.setUint16(8, exportedTypeNameIndex, true);
  ev.setUint16(10, 32, true);        // 'Example'
  ev.setUint16(12, 5, true);         // Implementation = AssemblyRef #1 (tag 1)
  // AssemblyRef: Major(2) Minor(2) Build(2) Rev(2) Flags(4) PublicKey(2) Name(2) Culture(2) HashValue(2)
  const assemblyRefs = new Uint8Array(20), av = new DataView(assemblyRefs.buffer);
  av.setUint16(0, 1, true);
  av.setUint16(14, 25, true); // 'Widget'
  const tables = cilTables(new Map([
    [0x23, { count: 1, bytes: assemblyRefs }],
    [0x26, { count: 1, bytes: fileFlagsRow ?? files }],
    [0x27, { count: 1, bytes: exportedRow ?? exported }],
  ]));
  return buildCil({
    methods: [{ name: 'Run', body: [0x2a] }],
    streams: [
      { name: '#~', bytes: tables.bytes },
      { name: '#Strings', bytes: pad(Uint8Array.from(strings)) },
      { name: '#Blob', bytes: pad(blob) },
    ],
  }).bytes;
}

const semantic = (image) => {
  const { rawBytes, ...rest } = image;
  return JSON.stringify(rest);
};

test('#7803 File row is decoded as multi-module file identity', () => {
  const image = parseCil(manifestFixture(), { binaryId: 'files' });
  assert.equal(image.files.length, 1);
  assert.deepEqual(image.files[0], {
    rid: 1,
    token: '0x26000001',
    flags: 0, // ContainsMetaData
    name: 'A.netmodule',
    hashValueBlobIndex: 1,
    hashValue: new Uint8Array([0xaa, 0xbb, 0xcc]),
  });
});

test('#7803 File.Name distinguishes manifests (previously collapsed)', () => {
  const a = parseCil(manifestFixture({ file1NameIndex: 1 }), { binaryId: 'same' });
  const b = parseCil(manifestFixture({ file1NameIndex: 13 }), { binaryId: 'same' });
  assert.equal(a.files[0].name, 'A.netmodule');
  assert.equal(b.files[0].name, 'B.netmodule');
  assert.notEqual(semantic(a), semantic(b));
});

test('#7803 File.HashValue payload distinguishes manifests', () => {
  const a = parseCil(manifestFixture({ hashByte: 0xaa }), { binaryId: 'same' });
  const b = parseCil(manifestFixture({ hashByte: 0xdd }), { binaryId: 'same' });
  assert.deepEqual([...a.files[0].hashValue], [0xaa, 0xbb, 0xcc]);
  assert.deepEqual([...b.files[0].hashValue], [0xdd, 0xbb, 0xcc]);
  assert.notEqual(semantic(a), semantic(b));
});

test('#7803 File flags and empty hash fail closed', () => {
  // Reserved flag bits must be rejected, not silently carried.
  assert.throws(() => parseCil(manifestFixture({ fileFlags: 0x00000002 }), { binaryId: 'badflags' }),
    /cil-file-flags-invalid|cil-unsupported-binary/);
  // A File row's HashValue blob index must resolve inside the heap: an
  // out-of-range index fails closed instead of publishing an unresolvable
  // hash authority.
  const strings = [0, ...utf8('A.netmodule'), ...utf8('B.netmodule'), ...utf8('Widget'), ...utf8('Example'), ...utf8('T')];
  const files = new Uint8Array(8), fv = new DataView(files.buffer);
  fv.setUint32(0, 0, true);
  fv.setUint16(4, 1, true);
  fv.setUint16(6, 5, true); // past the 5-byte heap
  const tables = cilTables(new Map([[0x26, { count: 1, bytes: files }]]));
  const bytes = buildCil({
    methods: [{ name: 'Run', body: [0x2a] }],
    streams: [
      { name: '#~', bytes: tables.bytes },
      { name: '#Strings', bytes: pad(Uint8Array.from(strings)) },
      { name: '#Blob', bytes: pad(Uint8Array.of(0)) },
    ],
  }).bytes;
  assert.throws(() => parseCil(bytes, { binaryId: 'badhash' }), /cil-file-hash-blob-invalid|cil-unsupported-binary/);
});

test('#7800 ExportedType row is decoded as forwarder identity', () => {
  const image = parseCil(manifestFixture(), { binaryId: 'exported' });
  assert.equal(image.exportedTypes.length, 1);
  assert.deepEqual(image.exportedTypes[0], {
    rid: 1,
    token: '0x27000001',
    flags: 0x00200001,
    typeDefId: 0,
    typeName: 'Widget',
    typeNamespace: 'Example',
    implementation: { table: 0x23, rid: 1, token: '0x23000001' },
    isForwarder: true,
  });
});

test('#7800 ExportedType.TypeName distinguishes assemblies (previously collapsed)', () => {
  const a = parseCil(manifestFixture({ exportedTypeNameIndex: 25 }), { binaryId: 'same' });
  const b = parseCil(manifestFixture({ exportedTypeNameIndex: 40 }), { binaryId: 'same' });
  assert.equal(a.exportedTypes[0].typeName, 'Widget');
  assert.equal(b.exportedTypes[0].typeName, 'T');
  assert.notEqual(semantic(a), semantic(b));
});

test('#7800 a null ExportedType implementation fails closed', () => {
  // Implementation is a coded index over [File, AssemblyRef, ExportedType];
  // 0 (null) is invalid for ExportedType rows.
  const exported = new Uint8Array(14), ev = new DataView(exported.buffer);
  ev.setUint32(0, 0x00200001, true);
  ev.setUint32(4, 0, true);
  ev.setUint16(8, 25, true);
  ev.setUint16(10, 32, true);
  ev.setUint16(12, 0, true);
  assert.throws(() => parseCil(manifestFixture({ exportedRow: exported }), { binaryId: 'nullimpl' }),
    /cil-exported-type-implementation-required|cil-unsupported-binary/);
});

test('#7803/#7800 probe stays exact with manifest tables present', () => {
  assert.deepEqual(probeCil(manifestFixture()), {
    supported: true,
    confidence: 1,
    formatVersion: 'pe-cli',
    vmSpecEdition: 'clr-v4',
  });
});
