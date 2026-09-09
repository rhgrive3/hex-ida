import assert from 'node:assert/strict';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
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
function paddedTypeList({ entries, count = entries.length, buildOptions } = {}) {
  const built = buildDex(buildOptions ?? {
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

// (1) Multiple interfaces: the decoded row order is preserved as written, not
// sorted or deduplicated into a set — it is part of the type identity.
const multiIfaceBuildOptions = {
  classNames: ['LTest;'],
  methods: [{ classType: 'LTest;', name: 'caller', returnType: 'V', params: [], flags: 9, words: [0x000e] }],
  fields: [
    { classType: 'LTest;', type: 'I', name: 'x' },
    { classType: 'LTest;', type: 'LJ;', name: 'y' },
    { classType: 'LTest;', type: 'LI;', name: 'z' },
  ],
};
// typeNames: ['I','LI;','LJ;','LTest;','V'] → ti('LI;')=1, ti('LJ;')=2.
const multiIface = parseDex(paddedTypeList({ entries: [1, 2], buildOptions: multiIfaceBuildOptions }), { binaryId: 'multi' });
assert.deepEqual(multiIface.classes[0].interfaceTypes, ['LI;', 'LJ;']);
const multiIfaceReversed = parseDex(paddedTypeList({ entries: [2, 1], buildOptions: multiIfaceBuildOptions }), { binaryId: 'multi' });
assert.deepEqual(multiIfaceReversed.classes[0].interfaceTypes, ['LJ;', 'LI;']);
assert.notDeepEqual(multiIface.classes, multiIfaceReversed.classes);

// (2) Array interface entries are forbidden: only class descriptors
// ('L...;') are valid implemented-interface rows.
const arrayEntry = parseDexSafe(paddedTypeList({
  entries: [2], // typeNames: ['LTest;','V','[LI;'] → ti('[LI;')=2
  buildOptions: {
    classNames: ['LTest;'],
    methods: [{ classType: 'LTest;', name: 'caller', returnType: 'V', params: [], flags: 9, words: [0x000e] }],
    fields: [{ classType: 'LTest;', type: '[LI;', name: 'arr' }],
  },
}));
assert.equal(arrayEntry, 'dex-invalid-interface-type');

// (3) External interface descriptors (referenced by interfaces_off but with
// no class_def in this file) keep their exact identity through parse and
// frontend enumeration — they are not dropped or resolved away.
const externalBuildOptions = {
  classNames: ['LTest;'],
  methods: [{ classType: 'LTest;', name: 'caller', returnType: 'V', params: [], flags: 9, words: [0x000e] }],
  fields: [{ classType: 'LTest;', type: 'LExt;', name: 'ref' }],
};
// typeNames: ['LExt;','LTest;','V'] → ti('LExt;')=0.
const external = parseDex(paddedTypeList({ entries: [0], buildOptions: externalBuildOptions }), { binaryId: 'external' });
assert.deepEqual(external.classes[0].interfaceTypes, ['LExt;']);
const externalFrontend = new DexFrontend();
const externalTypes = [];
for await (const t of externalFrontend.enumerateTypes(external)) externalTypes.push(t);
assert.ok(!externalTypes.some((t) => t.classType === 'LExt;'), 'external interface must not gain a fabricated class_def');
const externalEnumerated = externalTypes.find((t) => t.classType === 'LTest;');
assert.ok(externalEnumerated, 'LTest; enumerated');
assert.deepEqual(externalEnumerated.interfaceTypes, ['LExt;']);
// Identity control: a bogus type_idx for the external descriptor fails closed.
assert.equal(parseDexSafe(paddedTypeList({ entries: [7], buildOptions: externalBuildOptions })), 'dex-invalid-interface-type-index');

// (4) Real consumer route: invoke-interface dispatch evidence flows from the
// class_def interfaces_off authority into the lifted call effects.
function consumerFixture({ withInterface }) {
  const built = buildDex({
    classNames: ['LTest;'],
    methods: [
      // invoke-static {v0}, method@1; then invoke-interface {v0, v1},
      // method@1 (methods[1] = LI;->go(LI;)V); then return-void. 35c format:
      // AG/op, BBBB, FEDC — A sits in the AG nibble of the first unit.
      { classType: 'LTest;', name: 'caller', returnType: 'V', params: ['LI;'], flags: 9, words: [0x1071, 0x0001, 0x0000, 0x2072, 0x0001, 0x0010, 0x000e] },
      { classType: 'LI;', name: 'go', returnType: 'V', params: ['LI;'], defined: false },
    ],
    strings: ['LI;'],
  });
  const bytes = built.bytes.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const typeListOff = built.layout.maps.find(([type]) => type === 0x1001)[2];
  if (withInterface) view.setUint32(built.layout.classes + 12, typeListOff, true);
  return bytes;
}
const dispatchImage = parseDex(consumerFixture({ withInterface: true }), { binaryId: 'dispatch' });
const dispatchFn = liftDexMethod(0, dispatchImage);
const dispatchCall = dispatchFn.bundles.flatMap((b) => b.callEffects).find((c) => c.dispatchKind === 'interface');
assert.ok(dispatchCall, 'invoke-interface decoded');
assert.equal(dispatchCall.target, 'LI;->go');
assert.deepEqual(dispatchCall.interfaceTypes, ['LI;']);
assert.equal(dispatchCall.enclosingClassImplementsTarget, true);
assert.equal(dispatchCall.unresolved, true);
// Without the interfaces_off edge the candidate set is empty and the derived
// assignability fact is false — never silently inherited from elsewhere.
const plainDispatch = liftDexMethod(0, parseDex(consumerFixture({ withInterface: false }), { binaryId: 'dispatch' }));
const plainCall = plainDispatch.bundles.flatMap((b) => b.callEffects).find((c) => c.dispatchKind === 'interface');
assert.deepEqual(plainCall.interfaceTypes, []);
assert.equal(plainCall.enclosingClassImplementsTarget, false);
// The interface-rows evidence attaches specifically to the invoke-interface
// dispatch site; the static site at the same method reference stays clean.
const staticCall = dispatchFn.bundles.flatMap((b) => b.callEffects).find((c) => c.dispatchKind === 'static');
assert.ok(staticCall, 'invoke-static decoded');
assert.equal(staticCall.target, 'LI;->go');
assert.ok(!('interfaceTypes' in staticCall));
assert.ok(!('enclosingClassImplementsTarget' in staticCall));

function parseDexSafe(bytes) {
  try {
    parseDex(bytes, { binaryId: 'negative' });
    return null;
  } catch (error) {
    return error.message;
  }
}

console.log('dex member-name grammar #7619 + interfaces_off #7620: PASS');
