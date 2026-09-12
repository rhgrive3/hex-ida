// #7578: TypeRef (0x01) / AssemblyRef (0x23) external type identity authority.
import assert from 'node:assert/strict';

import { buildCil, collect } from '../fixtures/medium-cil.mjs';
import { parseCil, probeCil } from '../../../js/managed/cil/parser.js';
import { CilFrontend } from '../../../js/managed/cil/frontend.js';

const utf8 = (s) => [...new TextEncoder().encode(s), 0];

const STR = (() => {
  const strings = [0];
  const index = {};
  for (const s of ['Base', 'N', 'LibA', 'LibB', 'en-US']) {
    index[s] = strings.length;
    strings.push(...utf8(s));
  }
  return index;
})();

const BLOB = (() => {
  const bytes = [0, 3, 0, 0, 1, 2, 6, 8];
  const index = {};
  for (const [name, payload] of [
    ['pkA', [0x01, 0x02]], ['hashA', [0xaa]],
    ['pkB', [0x03, 0x04]], ['hashB', [0xbb, 0xcc]],
  ]) {
    index[name] = bytes.length;
    bytes.push(payload.length, ...payload);
  }
  return index;
})();

const typeRefRow = (scope, nameIndex = STR.Base, namespaceIndex = STR.N) => {
  const bytes = new Uint8Array(6), v = new DataView(bytes.buffer);
  v.setUint16(0, scope, true);
  v.setUint16(2, nameIndex, true);
  v.setUint16(4, namespaceIndex, true);
  return bytes;
};

const assemblyRefRows = ({ corruptNameIndex, corruptPublicKeyIndex, corruptHashIndex } = {}) => {
  const bytes = new Uint8Array(40), v = new DataView(bytes.buffer);
  v.setUint16(0, 1, true);
  v.setUint16(12, corruptPublicKeyIndex ?? BLOB.pkA, true);
  v.setUint16(14, STR.LibA, true);
  v.setUint16(16, 0, true);
  v.setUint16(18, BLOB.hashA, true);
  v.setUint16(20, 2, true);
  v.setUint16(22, 3, true);
  v.setUint16(24, 4, true);
  v.setUint16(26, 5, true);
  v.setUint32(28, 1, true);
  v.setUint16(32, BLOB.pkB, true);
  v.setUint16(34, corruptNameIndex ?? STR.LibB, true);
  v.setUint16(36, STR['en-US'], true);
  v.setUint16(38, corruptHashIndex ?? BLOB.hashB, true);
  return bytes;
};

const baseFixture = (typeRefBytes, assemblyRefBytes) => buildCil({
  methods: [{ name: 'Run', body: [0x2a] }],
  types: [{ name: 'Derived', namespace: 'N', methodList: 1, fieldList: 1, extends: 5 }],
  leadingStrings: ['Base', 'N', 'LibA', 'LibB', 'en-US'],
  blobs: [[0x01, 0x02], [0xaa], [0x03, 0x04], [0xbb, 0xcc]],
  extraRows: [
    [0x00, { count: 1, bytes: new Uint8Array(10) }],
    [0x1a, { count: 1, bytes: new Uint8Array(2) }],
    [0x23, { count: 2, bytes: assemblyRefBytes ?? assemblyRefRows() }],
    [0x01, { count: 1, bytes: typeRefBytes }],
  ],
}).bytes;

const SCOPE_MODULE = (1 << 2) | 0;
const SCOPE_MODULEREF = (1 << 2) | 1;
const SCOPE_ASSEMBLYREF_A = (1 << 2) | 2;
const SCOPE_ASSEMBLYREF_B = (2 << 2) | 2;
const SCOPE_TYPEREF = (1 << 2) | 3;
const SCOPE_OUT_OF_RANGE = (3 << 2) | 2;

const projection = (image) => {
  const { rawBytes, ...rest } = image;
  return JSON.stringify(rest);
};

const probe = { supported: true, confidence: 1, formatVersion: 'pe-cli', vmSpecEdition: 'clr-v4' };

const aBytes = baseFixture(typeRefRow(SCOPE_ASSEMBLYREF_A));
const bBytes = baseFixture(typeRefRow(SCOPE_ASSEMBLYREF_B));

assert.deepEqual(probeCil(aBytes), probe);
assert.deepEqual(probeCil(bBytes), probe);

const a = parseCil(aBytes, { binaryId: 'same' });
const b = parseCil(bBytes, { binaryId: 'same' });

assert.ok(Array.isArray(a.typeRefs), 'image.typeRefs must exist');
assert.ok(Array.isArray(b.typeRefs), 'image.typeRefs must exist');
assert.ok(Array.isArray(a.assemblyRefs), 'image.assemblyRefs must exist');
assert.ok(Array.isArray(b.assemblyRefs), 'image.assemblyRefs must exist');

assert.deepEqual(a.typeRefs[0], {
  rid: 1,
  token: '0x01000001',
  resolutionScope: { table: 0x23, rid: 1, token: '0x23000001' },
  name: 'Base',
  namespace: 'N',
});
assert.deepEqual(b.typeRefs[0].resolutionScope, { table: 0x23, rid: 2, token: '0x23000002' });

assert.deepEqual(a.assemblyRefs, [
  {
    rid: 1,
    token: '0x23000001',
    majorVersion: 1,
    minorVersion: 0,
    buildNumber: 0,
    revisionNumber: 0,
    flags: 0,
    publicKeyOrTokenBlobIndex: BLOB.pkA,
    publicKeyOrToken: new Uint8Array([0x01, 0x02]),
    name: 'LibA',
    culture: null,
    hashValueBlobIndex: BLOB.hashA,
    hashValue: new Uint8Array([0xaa]),
  },
  {
    rid: 2,
    token: '0x23000002',
    majorVersion: 2,
    minorVersion: 3,
    buildNumber: 4,
    revisionNumber: 5,
    flags: 1,
    publicKeyOrTokenBlobIndex: BLOB.pkB,
    publicKeyOrToken: new Uint8Array([0x03, 0x04]),
    name: 'LibB',
    culture: 'en-US',
    hashValueBlobIndex: BLOB.hashB,
    hashValue: new Uint8Array([0xbb, 0xcc]),
  },
]);

assert.equal(a.types[0].extendsToken, '0x01000001');
assert.equal(a.types[0].extendsTypeRef, a.typeRefs[0]);
assert.equal(b.types[0].extendsTypeRef, b.typeRefs[0]);
assert.equal(a.types[0].extendsTypeRef.name, 'Base');
assert.equal(a.types[0].extendsTypeRef.namespace, 'N');
assert.notEqual(
  a.types[0].extendsTypeRef.resolutionScope.token,
  b.types[0].extendsTypeRef.resolutionScope.token,
);

assert.notEqual(projection(a), projection(b),
  '[LibA]N.Base and [LibB]N.Base must not collapse to one canonical state');

const frontend = new CilFrontend();
const fa = await collect(frontend.enumerateTypes(a));
const fb = await collect(frontend.enumerateTypes(b));
assert.equal(fa[0].extendsTypeRef.resolutionScope.token, '0x23000001');
assert.equal(fb[0].extendsTypeRef.resolutionScope.token, '0x23000002');
assert.equal(fa[0].extendsTypeRef.name, 'Base');

const cBytes = baseFixture(typeRefRow(SCOPE_MODULE));
const dBytes = baseFixture(typeRefRow(SCOPE_MODULEREF));
const c = parseCil(cBytes, { binaryId: 'same' });
const d = parseCil(dBytes, { binaryId: 'same' });
assert.deepEqual(c.typeRefs[0].resolutionScope, { table: 0x00, rid: 1, token: '0x00000001' });
assert.deepEqual(d.typeRefs[0].resolutionScope, { table: 0x1a, rid: 1, token: '0x1a000001' });
assert.notEqual(projection(a), projection(c));
assert.notEqual(projection(a), projection(d));
assert.notEqual(projection(c), projection(d));

assert.throws(() => parseCil(baseFixture(typeRefRow(SCOPE_OUT_OF_RANGE)), { binaryId: 'badscope' }),
  /cil-typeref-resolution-scope-invalid|cil-unsupported-binary/);
assert.throws(() => parseCil(baseFixture(typeRefRow(SCOPE_ASSEMBLYREF_A, 200)), { binaryId: 'badname' }),
  /cil-definition-string-index-invalid|cil-unsupported-binary/);
assert.throws(() => parseCil(baseFixture(typeRefRow(SCOPE_ASSEMBLYREF_A), assemblyRefRows({ corruptNameIndex: 200 })),
  { binaryId: 'badrefname' }),
  /cil-definition-string-index-invalid|cil-unsupported-binary/);
assert.throws(() => parseCil(baseFixture(typeRefRow(SCOPE_ASSEMBLYREF_A, 0)), { binaryId: 'typeref-null-name' }),
  /cil-typeref-name-required|cil-unsupported-binary/);
assert.throws(() => parseCil(baseFixture(typeRefRow(SCOPE_ASSEMBLYREF_A, STR.N - 1)), { binaryId: 'typeref-empty-name' }),
  /cil-typeref-name-required|cil-unsupported-binary/);
assert.throws(() => parseCil(baseFixture(typeRefRow(SCOPE_ASSEMBLYREF_A), assemblyRefRows({ corruptNameIndex: 0 })),
  { binaryId: 'assemblyref-null-name' }),
  /cil-assembly-ref-name-required|cil-unsupported-binary/);
assert.throws(() => parseCil(baseFixture(typeRefRow(SCOPE_ASSEMBLYREF_A), assemblyRefRows({ corruptNameIndex: STR.N - 1 })),
  { binaryId: 'assemblyref-empty-name' }),
  /cil-assembly-ref-name-required|cil-unsupported-binary/);
assert.throws(() => parseCil(baseFixture(typeRefRow(SCOPE_ASSEMBLYREF_A), assemblyRefRows({ corruptPublicKeyIndex: 100 })),
  { binaryId: 'badpk' }),
  /cil-assembly-ref-public-key-blob-invalid|cil-unsupported-binary/);
assert.throws(() => parseCil(baseFixture(typeRefRow(SCOPE_ASSEMBLYREF_A), assemblyRefRows({ corruptHashIndex: 100 })),
  { binaryId: 'badhash' }),
  /cil-assembly-ref-hash-value-blob-invalid|cil-unsupported-binary/);

const scopeKinds = new Uint8Array(24), kv = new DataView(scopeKinds.buffer);
for (const [i, scope] of [SCOPE_MODULE, SCOPE_MODULEREF, SCOPE_ASSEMBLYREF_A, SCOPE_TYPEREF].entries()) {
  kv.setUint16(i * 6, scope, true);
  kv.setUint16(i * 6 + 2, STR.Base, true);
  kv.setUint16(i * 6 + 4, STR.N, true);
}
const kinds = parseCil(buildCil({
  methods: [{ name: 'Run', body: [0x2a] }],
  leadingStrings: ['Base', 'N', 'LibA', 'LibB', 'en-US'],
  blobs: [[0x01, 0x02], [0xaa], [0x03, 0x04], [0xbb, 0xcc]],
  extraRows: [
    [0x00, { count: 1, bytes: new Uint8Array(10) }],
    [0x1a, { count: 1, bytes: new Uint8Array(2) }],
    [0x23, { count: 1, bytes: assemblyRefRows().subarray(0, 20) }],
    [0x01, { count: 4, bytes: scopeKinds }],
  ],
}).bytes, { binaryId: 'kinds' });
assert.deepEqual(kinds.typeRefs.map((row) => row.resolutionScope), [
  { table: 0x00, rid: 1, token: '0x00000001' },
  { table: 0x1a, rid: 1, token: '0x1a000001' },
  { table: 0x23, rid: 1, token: '0x23000001' },
  { table: 0x01, rid: 1, token: '0x01000001' },
]);
assert.deepEqual(kinds.typeRefs.map((row) => `${row.namespace}.${row.name}`),
  ['N.Base', 'N.Base', 'N.Base', 'N.Base']);
assert.notEqual(projection(kinds.typeRefs[0]), projection(kinds.typeRefs[3]));

console.log('issue 7578 TypeRef/AssemblyRef external type identity regression: PASS');
