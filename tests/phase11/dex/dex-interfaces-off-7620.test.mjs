import assert from 'node:assert/strict';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { buildDex } from '../fixtures/medium-dex.mjs';

// #7620 — class_def_item.interfaces_off is the interface-list authority: the
// referenced type_list must be decoded losslessly and validated fail-closed
// (bounds, class-only entries, no duplicates). Two DEX files differing only
// in interfaces_off must no longer collapse to identical canonical classes.

function fixture({ withInterface, patch = {} } = {}) {
  const built = buildDex({
    classNames: ['LTest;'],
    methods: [{
      classType: 'LTest;', name: 'caller', returnType: 'V', params: ['LI;'],
      flags: 9, words: [0x000e],
    }],
    strings: ['LI;'],
  });
  const bytes = built.bytes.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const typeListOff = built.layout.maps.find(([type]) => type === 0x1001)[2];
  if (withInterface) view.setUint32(built.layout.classes + 12, typeListOff, true);
  Object.assign(view, patch);
  return bytes;
}

const plain = parseDex(fixture({ withInterface: false }), { binaryId: 'same' });
const withIface = parseDex(fixture({ withInterface: true }), { binaryId: 'same' });

assert.deepEqual(plain.classes[0].interfaceTypes, []);
assert.deepEqual(withIface.classes[0].interfaceTypes, ['LI;']);
assert.notDeepEqual(plain.classes, withIface.classes);

// The frontend enumeration must surface the interface edge as well.
const frontend = new DexFrontend();
const types = [];
for await (const t of frontend.enumerateTypes(withIface)) types.push(t);
const enumerated = types.find((t) => t.classType === 'LTest;');
assert.ok(enumerated, 'LTest; enumerated');
assert.deepEqual(enumerated.interfaceTypes, ['LI;']);

// Fail-closed AOSP contract checks on the type_list payload. The negative
// cases use standalone type_lists written into the builder's documented
// padding area so they are referenced only by class_def.interfaces_off and
// do not disturb proto decoding.
function paddedTypeList({ entries, count = entries.length }) {
  const built = buildDex({
    classNames: ['LTest;'],
    methods: [{ classType: 'LTest;', name: 'caller', returnType: 'V', params: ['LI;'], flags: 9, words: [0x000e] }],
    strings: ['LI;'],
  });
  const bytes = built.bytes.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const listOff = Math.ceil(built.layout.stringDataEnd / 4) * 4;
  view.setUint32(listOff, count, true);
  entries.forEach((typeIdx, i) => view.setUint16(listOff + 4 + i * 2, typeIdx, true));
  view.setUint32(built.layout.classes + 12, listOff, true);
  return bytes;
}

// Out-of-range type_idx inside the type_list.
assert.throws(
  () => parseDex(paddedTypeList({ entries: [0xffff] })),
  /dex-invalid-interface-type-index/,
);
// Primitive (non-class) interface entry. Builder type order: ['I','LI;','LTest;','V'].
assert.throws(
  () => parseDex(paddedTypeList({ entries: [0] })), // 'I' is the primitive int type
  /dex-invalid-interface-type/,
);
// Duplicate interface entries are forbidden by the AOSP contract.
assert.throws(
  () => parseDex(paddedTypeList({ entries: [1, 1] })), // ['LI;','LI;']
  /dex-duplicate-interface-type/,
);
// type_list extending past the end of the data section (size lies).
{
  const built = buildDex({
    classNames: ['LTest;'],
    methods: [{ classType: 'LTest;', name: 'caller', returnType: 'V', params: ['LI;'], flags: 9, words: [0x000e] }],
    strings: ['LI;'],
  });
  const bytes = built.bytes.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const listOff = Math.ceil(built.layout.stringDataEnd / 4) * 4;
  view.setUint32(listOff, 0x7fffffff, true);
  view.setUint32(built.layout.classes + 12, listOff, true);
  assert.throws(() => parseDex(bytes), /dex-invalid-interfaces-range/);
}

console.log('dex member-name grammar #7619 + interfaces_off #7620: PASS');
