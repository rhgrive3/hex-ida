import assert from 'node:assert/strict';
import { buildCil } from './phase11/fixtures/medium-cil.mjs';
import { parseCil, probeCil } from '../js/managed/cil/parser.js';

const TYPE_HAS_SECURITY = 0x00040000;
const METHOD_HAS_SECURITY = 0x4000;

const blobHeap = Uint8Array.from([0, 3, 0xaa, 0xbb, 0xcc]);

function declSecurityRow(action, parentCoded, blobIndex = 1) {
  const row = new Uint8Array(6);
  const v = new DataView(row.buffer);
  v.setUint16(0, action, true);
  v.setUint16(2, parentCoded, true);
  v.setUint16(4, blobIndex, true);
  return row;
}

function fixture({
  action = 0x0002,
  parent = 'type',
  typeFlags = 0x00000001 | TYPE_HAS_SECURITY,
  methodFlags = 0x00000016 | METHOD_HAS_SECURITY,
  blobIndex = 1,
} = {}) {
  const extraRows = [];
  const parentTag = { type: 0, method: 1, assembly: 2 }[parent];
  extraRows.push([0x0e, { count: 1, bytes: declSecurityRow(action, (1 << 2) | parentTag, blobIndex) }]);
  if (parent === 'assembly') {
    extraRows.push([0x20, { count: 1, bytes: new Uint8Array(22) }]);
  }
  return buildCil({
    types: [{ name: 'Secured', namespace: 'N', flags: typeFlags, fieldList: 1, methodList: 1 }],
    methods: [{ name: 'Run', body: [0x2a], flags: methodFlags }],
    fields: [],
    blobBytes: blobHeap,
    extraRows,
  }).bytes;
}

const semantic = (image) => {
  const { rawBytes, ...rest } = image;
  return JSON.stringify(rest);
};

const demand = parseCil(fixture({ action: 0x0002 }), { binaryId: 'issue-7632-demand' });
assert.equal(demand.declSecurity.length, 1);
assert.deepEqual(demand.declSecurity[0], {
  rid: 1,
  token: '0x0e000001',
  action: 0x0002,
  parent: { table: 0x02, rid: 1, token: '0x02000001' },
  permissionSetBlobIndex: 1,
  permissionSet: new Uint8Array([0xaa, 0xbb, 0xcc]),
});

const asserted = parseCil(fixture({ action: 0x0003 }), { binaryId: 'same' });
assert.equal(asserted.declSecurity[0].action, 0x0003);
assert.notEqual(semantic(demand), semantic(asserted));

for (const action of [0x0002, 0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x000d, 0x000e, 0x000f]) {
  const image = parseCil(fixture({ action, parent: 'type' }), { binaryId: 'same' });
  assert.equal(image.declSecurity[0].action, action);
  assert.equal(image.declSecurity[0].parent.table, 0x02);
}

const assemblyScope = parseCil(fixture({ action: 0x0008, parent: 'assembly' }), { binaryId: 'same' });
assert.equal(assemblyScope.declSecurity[0].action, 0x0008);
assert.equal(assemblyScope.declSecurity[0].parent.table, 0x20);

const methodScope = parseCil(fixture({ action: 0x0002, parent: 'method' }), { binaryId: 'same' });
assert.equal(methodScope.declSecurity[0].parent.table, 0x06);
assert.equal(methodScope.declSecurity[0].parent.token, '0x06000001');

assert.throws(() => parseCil(fixture({ action: 0x0013 }), { binaryId: 'badaction' }),
  /cil-declsecurity-action-invalid|cil-unsupported-binary/);
assert.throws(() => parseCil(fixture({ action: 0x0000 }), { binaryId: 'zeroaction' }),
  /cil-declsecurity-action-invalid|cil-unsupported-binary/);
assert.throws(() => parseCil(fixture({ action: 0x0002, typeFlags: 0x00000001 }), { binaryId: 'noflag' }),
  /cil-declsecurity-parent-security-flag-missing|cil-unsupported-binary/);
assert.throws(() => parseCil(fixture({ action: 0x0002, parent: 'method', methodFlags: 0x00000016 }), { binaryId: 'noflagmethod' }),
  /cil-declsecurity-parent-security-flag-missing|cil-unsupported-binary/);
assert.throws(() => parseCil(fixture({ action: 0x0008, parent: 'type' }), { binaryId: 'laundry' }),
  /cil-declsecurity-parent-scope-invalid|cil-unsupported-binary/);
assert.throws(() => parseCil(fixture({ action: 0x0002, blobIndex: 0 }), { binaryId: 'noset' }),
  /cil-declsecurity-permission-set-required|cil-unsupported-binary/);

assert.deepEqual(probeCil(fixture()), {
  supported: true,
  confidence: 1,
  formatVersion: 'pe-cli',
  vmSpecEdition: 'clr-v4',
});

console.log('issue-7632-declsecurity-action-authority: PASS');
