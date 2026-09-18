import assert from 'node:assert/strict';
import test from 'node:test';

import { readCilDefinitions } from '../../../js/managed/cil/metadata-definitions.js';
import { readCilManifestSecurityDefinitions } from '../../../js/managed/cil/metadata-manifest-security.js';

const TYPE_HAS_SECURITY = 0x00040000;
const METHOD_HAS_SECURITY = 0x4000;

function decodeDeclSecurity({
  action = 0x000d,
  parent = 'type',
  typeFlags = 0x00000001 | TYPE_HAS_SECURITY,
  methodFlags = METHOD_HAS_SECURITY,
} = {}) {
  const counts = Array(64).fill(0);
  counts[0x02] = 1;
  counts[0x06] = 1;
  counts[0x0e] = 1;
  counts[0x20] = 1;

  const offsets = Array(64).fill(0);
  offsets[0x02] = 0;
  offsets[0x06] = 14;
  offsets[0x20] = 28;
  offsets[0x0e] = 50;

  const rowSizes = Array(64).fill(0);
  rowSizes[0x02] = 14;
  rowSizes[0x06] = 14;
  rowSizes[0x20] = 22;
  rowSizes[0x0e] = 6;

  const bytes = new Uint8Array(59);
  const view = new DataView(bytes.buffer);

  // TypeDef: Flags, Name, Namespace, Extends, FieldList, MethodList.
  view.setUint32(0, typeFlags, true);
  view.setUint16(10, 1, true);
  view.setUint16(12, 1, true);

  // MethodDef: RVA, ImplFlags, Flags, Name, Signature, ParamList.
  view.setUint16(20, methodFlags, true);
  view.setUint16(26, 1, true);

  // Assembly row at 28 stays zero-valued; identity fields may be absent in this focused fixture.

  const tags = { type: 0, method: 1, assembly: 2 };
  view.setUint16(50, action, true);
  view.setUint16(52, (1 << 2) | tags[parent], true);
  view.setUint16(54, 1, true);

  const layout = { rowCounts: counts, tableOffsets: offsets, rowSizes, heapSizes: 0 };
  bytes.set(Uint8Array.of(0, 1, 0xaa), 56);
  const blobStream = { offset: 56, size: 3 };
  const defs = readCilDefinitions(bytes, view, layout, null, blobStream);
  return readCilManifestSecurityDefinitions(bytes, view, layout, null, blobStream, defs).declSecurity[0];
}

test('#7632 preserves the complete declared action domain using legal scopes', () => {
  for (const action of [0x0002, 0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x000d, 0x000e, 0x000f]) {
    assert.equal(decodeDeclSecurity({ action, parent: 'type' }).action, action);
  }
  for (const action of [0x0008, 0x0009, 0x000a, 0x000b, 0x000c]) {
    assert.equal(decodeDeclSecurity({ action, parent: 'assembly' }).action, action);
  }
  // Reserved/choice values remain lossless raw authority rather than disappearing.
  for (const action of [0x0001, 0x0010, 0x0011, 0x0012]) {
    assert.equal(decodeDeclSecurity({ action, parent: 'type' }).action, action);
  }
  assert.throws(() => decodeDeclSecurity({ action: 0x0000 }), /cil-declsecurity-action-invalid/);
  assert.throws(() => decodeDeclSecurity({ action: 0x0013 }), /cil-declsecurity-action-invalid/);
});

test('#7632 RequestMinimum/Optional/Refuse require Assembly scope', () => {
  for (const action of [0x0008, 0x0009, 0x000a]) {
    assert.equal(decodeDeclSecurity({ action, parent: 'assembly' }).parent.table, 0x20);
    assert.throws(
      () => decodeDeclSecurity({ action, parent: 'type' }),
      /cil-declsecurity-parent-scope-invalid/,
    );
    assert.throws(
      () => decodeDeclSecurity({ action, parent: 'method' }),
      /cil-declsecurity-parent-scope-invalid/,
    );
  }
});

test('#7632 Method/Type actions cannot be laundered onto Assembly scope', () => {
  for (const action of [0x0002, 0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x000d, 0x000e, 0x000f]) {
    assert.throws(
      () => decodeDeclSecurity({ action, parent: 'assembly' }),
      /cil-declsecurity-parent-scope-invalid/,
    );
  }
  assert.equal(decodeDeclSecurity({ action: 0x0002, parent: 'type' }).parent.table, 0x02);
  assert.equal(decodeDeclSecurity({ action: 0x0002, parent: 'method' }).parent.table, 0x06);
});

test('#7632 TypeDef DeclSecurity parent requires HasSecurity', () => {
  assert.throws(
    () => decodeDeclSecurity({ parent: 'type', typeFlags: 0x00000001 }),
    /cil-declsecurity-parent-security-flag-missing/,
  );
  assert.equal(decodeDeclSecurity({ parent: 'type' }).parent.table, 0x02);
});

test('#7632 MethodDef DeclSecurity parent requires HasSecurity', () => {
  assert.throws(
    () => decodeDeclSecurity({ parent: 'method', methodFlags: 0 }),
    /cil-declsecurity-parent-security-flag-missing/,
  );
  assert.equal(decodeDeclSecurity({ parent: 'method' }).parent.table, 0x06);
});
