import assert from 'node:assert/strict';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { buildDex } from '../fixtures/medium-dex.mjs';

console.log('[phase11] running DEX identity-table ordering regression #8717...');

const errorCode = (code) => (error) =>
  error instanceof TypeError && error.message === code;

function expectDexError(bytes, code) {
  assert.throws(() => parseDex(bytes), errorCode(code));
}

function dataView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function cloneBuilt(options) {
  // Emit tables exactly in input order: these cases build mis-ordered tables on purpose.
  const built = buildDex({ rawOrder: true, ...options });
  return { ...built, bytes: built.bytes.slice() };
}

// A fully ordered fixture remains unchanged and publishes one canonical
// identity per class and method.
const valid = cloneBuilt({
  classNames: ['LA;', 'LB;'],
  fields: [
    { classType: 'LA;', type: 'I', name: 'a' },
    { classType: 'LB;', type: 'I', name: 'b' },
  ],
  methods: [
    { classType: 'LA;', name: 'aMethod', returnType: 'I', params: [], flags: 9, words: [0x000e] },
    { classType: 'LB;', name: 'bMethod', returnType: 'V', params: [], flags: 9, words: [0x000e] },
  ],
});
const validImage = parseDex(valid.bytes, { binaryId: '8717-valid' });
assert.deepEqual(validImage.classes.map((entry) => entry.classType), ['LA;', 'LB;']);
assert.deepEqual(validImage.fields.map((entry) => [entry.classType, entry.name, entry.type]), [
  ['LA;', 'a', 'I'],
  ['LB;', 'b', 'I'],
]);
assert.deepEqual(validImage.methods.map((entry) => [entry.classType, entry.name, entry.proto.returnType]), [
  ['LA;', 'aMethod', 'I'],
  ['LB;', 'bMethod', 'V'],
]);
{
  const frontend = new DexFrontend();
  const types = [];
  const methods = [];
  for await (const type of frontend.enumerateTypes(validImage)) types.push(type);
  for await (const method of frontend.enumerateMethods(validImage)) methods.push(method);
  assert.equal(new Set(types.map((entry) => entry.id)).size, types.length);
  assert.equal(new Set(methods.map((entry) => entry.id)).size, methods.length);
}

// string_ids: the comparison is over decoded UTF-16 contents, so sharing one
// string_data_item is rejected before type_ids can observe an alias.
{
  const built = cloneBuilt({ classNames: ['LA;', 'LB;'], fields: [], methods: [] });
  const view = dataView(built.bytes);
  const first = built.layout.stringsList.indexOf('LA;');
  const second = built.layout.stringsList.indexOf('LB;');
  view.setUint32(built.layout.strings + second * 4, view.getUint32(built.layout.strings + first * 4, true), true);
  expectDexError(built.bytes, 'dex-string-ids-order-invalid');
}
{
  const built = cloneBuilt({ classNames: ['LA;', 'LB;'], fields: [], methods: [] });
  const view = dataView(built.bytes);
  const first = built.layout.stringsList.indexOf('LA;');
  const second = built.layout.stringsList.indexOf('LB;');
  const firstOffset = view.getUint32(built.layout.strings + first * 4, true);
  const secondOffset = view.getUint32(built.layout.strings + second * 4, true);
  view.setUint32(built.layout.strings + first * 4, secondOffset, true);
  view.setUint32(built.layout.strings + second * 4, firstOffset, true);
  expectDexError(built.bytes, 'dex-string-ids-order-invalid');
}

// type_ids: raw descriptor_idx order is authoritative after string-table
// validation, and both duplicates and descending rows fail closed.
{
  const built = cloneBuilt({ classNames: ['LA;', 'LB;'], fields: [], methods: [] });
  const view = dataView(built.bytes);
  view.setUint32(built.layout.types + 4, view.getUint32(built.layout.types, true), true);
  expectDexError(built.bytes, 'dex-type-ids-order-invalid');
}
{
  const built = cloneBuilt({ classNames: ['LA;', 'LB;'], fields: [], methods: [] });
  const view = dataView(built.bytes);
  const first = view.getUint32(built.layout.types, true);
  const second = view.getUint32(built.layout.types + 4, true);
  view.setUint32(built.layout.types, second, true);
  view.setUint32(built.layout.types + 4, first, true);
  expectDexError(built.bytes, 'dex-type-ids-order-invalid');
}

// The full string -> type -> class chain cannot reach DexFrontend with two
// rows carrying the same canonical type identity.
{
  const built = cloneBuilt({ classNames: ['LA;', 'LB;'], fields: [], methods: [] });
  const view = dataView(built.bytes);
  const firstString = built.layout.stringsList.indexOf('LA;');
  const secondString = built.layout.stringsList.indexOf('LB;');
  view.setUint32(
    built.layout.strings + secondString * 4,
    view.getUint32(built.layout.strings + firstString * 4, true),
    true,
  );
  const frontend = new DexFrontend();
  await assert.rejects(
    () => frontend.open(built.bytes, { binaryId: '8717-chain' }),
    errorCode('dex-string-ids-order-invalid'),
  );
}

// proto_ids: return type is the major key and the type-index sequence is the
// lexicographic argument key; the shorty field is not an identity tie-breaker.
{
  const built = cloneBuilt({
    classNames: ['LTest;'],
    fields: [],
    methods: [
      { classType: 'LTest;', name: 'a', returnType: 'V', params: [], flags: 9, words: [0x000e] },
      { classType: 'LTest;', name: 'b', returnType: 'V', params: [], flags: 9, words: [0x000e] },
    ],
  });
  expectDexError(built.bytes, 'dex-proto-ids-order-invalid');
}
{
  const built = cloneBuilt({
    classNames: ['LTest;'],
    fields: [],
    methods: [
      { classType: 'LTest;', name: 'a', returnType: 'V', params: ['LZ;'], flags: 9, words: [0x000e] },
      { classType: 'LTest;', name: 'b', returnType: 'V', params: ['I'], flags: 9, words: [0x000e] },
    ],
  });
  expectDexError(built.bytes, 'dex-proto-ids-order-invalid');
}

// field_ids: (class_idx, name_idx, type_idx) is the complete key.
{
  const built = cloneBuilt({
    classNames: ['LTest;'],
    fields: [
      { classType: 'LTest;', type: 'I', name: 'x' },
      { classType: 'LTest;', type: 'I', name: 'x' },
    ],
    methods: [],
  });
  expectDexError(built.bytes, 'dex-field-ids-order-invalid');
}
{
  const built = cloneBuilt({
    classNames: ['LTest;'],
    fields: [
      { classType: 'LTest;', type: 'I', name: 'z' },
      { classType: 'LTest;', type: 'I', name: 'a' },
    ],
    methods: [],
  });
  expectDexError(built.bytes, 'dex-field-ids-order-invalid');
}

// method_ids: proto_idx is the minor key only after class_idx and name_idx.
// First isolate a method duplicate while keeping proto_ids valid and unique.
{
  const built = cloneBuilt({
    classNames: ['LTest;'],
    fields: [],
    methods: [
      { classType: 'LTest;', name: 'foo', returnType: 'I', params: [], flags: 9, words: [0x000e] },
      { classType: 'LTest;', name: 'foo', returnType: 'V', params: [], flags: 9, words: [0x000e] },
    ],
  });
  const view = dataView(built.bytes);
  view.setUint16(built.layout.methods + 1 * 8 + 2, 0, true);
  expectDexError(built.bytes, 'dex-method-ids-order-invalid');
}
{
  const built = cloneBuilt({
    classNames: ['LTest;'],
    fields: [],
    methods: [
      { classType: 'LTest;', name: 'z', returnType: 'I', params: [], flags: 9, words: [0x000e] },
      { classType: 'LTest;', name: 'a', returnType: 'V', params: [], flags: 9, words: [0x000e] },
    ],
  });
  expectDexError(built.bytes, 'dex-method-ids-order-invalid');
}

// class_defs: class_idx must be strictly increasing, including duplicate
// class definitions which otherwise resolve to the same canonical type.
{
  const built = cloneBuilt({ classNames: ['LDup;', 'LDup;'], fields: [], methods: [] });
  expectDexError(built.bytes, 'dex-class-defs-order-invalid');
}
{
  const built = cloneBuilt({ classNames: ['LB;', 'LA;'], fields: [], methods: [] });
  expectDexError(built.bytes, 'dex-class-defs-order-invalid');
}

console.log('  ok DEX identity-table ordering regression #8717 passed');
