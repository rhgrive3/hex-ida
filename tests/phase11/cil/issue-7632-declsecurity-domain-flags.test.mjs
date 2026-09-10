import assert from 'node:assert/strict';
import test from 'node:test';

import { readCilDefinitions } from '../../../js/managed/cil/metadata-definitions.js';

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

  const offsets = Array(64).fill(0);
  offsets[0x02] = 0;
  offsets[0x06] = 14;
  offsets[0x0e] = 28;

  const rowSizes = Array(64).fill(0);
  rowSizes[0x02] = 14;
  rowSizes[0x06] = 14;
  rowSizes[0x0e] = 6;

  const bytes = new Uint8Array(37);
  const view = new DataView(bytes.buffer);

  // TypeDef: Flags, Name, Namespace, Extends, FieldList, MethodList.
  view.setUint32(0, typeFlags, true);
  view.setUint16(10, 1, true);
  view.setUint16(12, 1, true);

  // MethodDef: RVA, ImplFlags, Flags, Name, Signature, ParamList.
  view.setUint16(20, methodFlags, true);
  view.setUint16(26, 1, true);

  // DeclSecurity: Action, HasDeclSecurity parent, PermissionSet blob index.
  view.setUint16(28, action, true);
  view.setUint16(30, (1 << 2) | (parent === 'method' ? 1 : 0), true);
  view.setUint16(32, 1, true);

  const layout = { rowCounts: counts, tableOffsets: offsets, rowSizes, heapSizes: 0 };
  bytes.set(Uint8Array.of(0, 1, 0xaa), 34);
  return readCilDefinitions(bytes, view, layout, null, { offset: 34, size: 3 }).declSecurity[0];
}

test('#7632 accepts the complete defined CorDeclSecurity action domain', () => {
  for (const action of [0x000b, 0x000c, 0x000d, 0x000e, 0x000f, 0x0010, 0x0011, 0x0012]) {
    assert.equal(decodeDeclSecurity({ action }).action, action);
  }
  assert.throws(() => decodeDeclSecurity({ action: 0x0000 }), /cil-declsecurity-action-invalid/);
  assert.throws(() => decodeDeclSecurity({ action: 0x0013 }), /cil-declsecurity-action-invalid/);
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
