import assert from 'node:assert/strict';
import test from 'node:test';

import { describeTypeIndex, parseTpiStream } from '../../../js/analysis/debug/pdb.js';

const LF_PROCEDURE = 0x1008;
const LF_ARGLIST = 0x1201;
const LF_FIELDLIST = 0x1203;
const LF_ENUMERATE = 0x1502;
const LF_ENUM = 0x1507;
const LF_STMEMBER = 0x150e;
const CLASS_OPTION_FORWARD_REFERENCE = 0x0080;
const CLASS_OPTION_HAS_UNIQUE_NAME = 0x0200;

function u16(value) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function cstring(value) {
  return [...Buffer.from(value, 'utf8'), 0];
}

function record(leaf, body) {
  const length = 2 + body.length;
  return Uint8Array.from([...u16(length), ...u16(leaf), ...body]);
}

function enumRecord({
  memberCount = 0,
  properties = 0,
  underlying = 0x0074,
  fieldList = 0,
  name = 'Color',
  uniqueName = null,
} = {}) {
  const body = [
    ...u16(memberCount),
    ...u16(properties),
    ...u32(underlying),
    ...u32(fieldList),
    ...cstring(name),
  ];
  if ((properties & CLASS_OPTION_HAS_UNIQUE_NAME) !== 0 && uniqueName != null) {
    body.push(...cstring(uniqueName));
  }
  return record(LF_ENUM, body);
}

function argList(args = []) {
  return record(LF_ARGLIST, [...u32(args.length), ...args.flatMap(u32)]);
}

function enumerate(name, value, attributes = 0) {
  return [
    ...u16(LF_ENUMERATE),
    ...u16(attributes),
    ...u16(value),
    ...cstring(name),
  ];
}

function fieldList(entries = []) {
  return record(LF_FIELDLIST, entries.flat());
}

function procedure({ returnType = 0x1000, argumentList = 0x1001, parameterCount = 0 } = {}) {
  return record(LF_PROCEDURE, [
    ...u32(returnType),
    0, // near-C calling convention
    0, // no function options
    ...u16(parameterCount),
    ...u32(argumentList),
  ]);
}

function tpi(records) {
  const payload = Uint8Array.from(records.flatMap((entry) => [...entry]));
  const bytes = new Uint8Array(56 + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 20040203, true);
  view.setUint32(4, 56, true);
  view.setUint32(8, 0x1000, true);
  view.setUint32(12, 0x1000 + records.length, true);
  view.setUint32(16, payload.length, true);
  bytes.set(payload, 56);
  return bytes;
}

test('#4058: LF_ENUM validates its LF_FIELDLIST/LF_ENUMERATE authority before rendering complete', () => {
  const parsed = parseTpiStream(tpi([
    enumRecord({ memberCount: 2, fieldList: 0x1001 }),
    fieldList([enumerate('Red', 1), enumerate('Blue', 2, 3)]),
  ]));

  assert.equal(parsed.complete, true);
  assert.deepEqual(parsed.types.get(0x1000), {
    leaf: LF_ENUM,
    kind: 'enum',
    memberCount: 2,
    properties: 0,
    underlying: 0x0074,
    fieldList: 0x1001,
    name: 'Color',
    uniqueName: null,
    complete: true,
  });
  assert.deepEqual(parsed.types.get(0x1001).enumerators, [
    { name: 'Red', value: 1, attributes: 0 },
    { name: 'Blue', value: 2, attributes: 3 },
  ]);
  assert.deepEqual(describeTypeIndex(0x1000, parsed.types), {
    name: 'enum Color',
    widthBits: 32,
    class: 'integer',
    complete: true,
  });
});

test('#4058: procedures returning enums no longer collapse to unknown signatures', () => {
  const parsed = parseTpiStream(tpi([
    enumRecord(),
    argList(),
    procedure(),
  ]));

  assert.equal(parsed.complete, true);
  assert.deepEqual(describeTypeIndex(0x1002, parsed.types), {
    name: 'enum Color (*)()',
    class: 'code',
    complete: true,
  });
});

test('#4058: unresolved enum underlying types preserve the enum name but fail closed', () => {
  const parsed = parseTpiStream(tpi([enumRecord({ underlying: 0xdeadbeef })]));
  assert.equal(parsed.complete, true, 'the record itself is structurally complete');
  assert.deepEqual(describeTypeIndex(0x1000, parsed.types), {
    name: 'enum Color',
    widthBits: undefined,
    class: undefined,
    complete: false,
  });
});

test('#4058: forward-reference enums are never complete type claims', () => {
  const parsed = parseTpiStream(tpi([enumRecord({ properties: CLASS_OPTION_FORWARD_REFERENCE })]));
  assert.equal(parsed.complete, true);
  const record_ = parsed.types.get(0x1000);
  assert.equal(record_.complete, false);
  assert.equal(describeTypeIndex(0x1000, parsed.types).complete, false);
});

test('#4058: HasUniqueName consumes and retains the second CodeView name', () => {
  const parsed = parseTpiStream(tpi([enumRecord({
    properties: CLASS_OPTION_HAS_UNIQUE_NAME,
    uniqueName: '.?AW4Color@@',
  })]));
  assert.equal(parsed.complete, true);
  assert.equal(parsed.types.get(0x1000).name, 'Color');
  assert.equal(parsed.types.get(0x1000).uniqueName, '.?AW4Color@@');
  assert.equal(parsed.types.get(0x1000).complete, true);
});

test('#4058: dangling enum FieldList references fail closed', () => {
  const parsed = parseTpiStream(tpi([enumRecord({ memberCount: 1, fieldList: 0x1001 })]));
  assert.equal(parsed.complete, false);
  assert.equal(parsed.types.get(0x1000).complete, false);
  assert.equal(describeTypeIndex(0x1000, parsed.types).complete, false);
});

test('#4058: enum FieldList references reject the wrong record kind', () => {
  const parsed = parseTpiStream(tpi([
    enumRecord({ memberCount: 1, fieldList: 0x1001 }),
    argList(),
  ]));
  assert.equal(parsed.complete, false);
  assert.equal(parsed.types.get(0x1000).complete, false);
});

test('#4058: enum NumEnumerators must agree with validated LF_ENUMERATE children', () => {
  const parsed = parseTpiStream(tpi([
    enumRecord({ memberCount: 2, fieldList: 0x1001 }),
    fieldList([enumerate('Only', 7)]),
  ]));
  assert.equal(parsed.complete, false);
  assert.equal(parsed.types.get(0x1000).complete, false);
});

test('#4058: unsupported enum field-list children keep enumerator authority partial', () => {
  const parsed = parseTpiStream(tpi([
    enumRecord({ memberCount: 1, fieldList: 0x1001 }),
    fieldList([[...u16(LF_STMEMBER), 0, 0]]),
  ]));
  assert.equal(parsed.complete, false);
  assert.equal(parsed.types.get(0x1000).complete, false);
  assert.equal(parsed.unmodelled.has(LF_STMEMBER), true);
});

test('#4058 adversarial: truncated enum fixed fields or missing name terminator fail closed', () => {
  const shortFixed = record(LF_ENUM, [
    ...u16(1), ...u16(0), ...u32(0x0074), // no FieldList
  ]);
  const unterminatedName = record(LF_ENUM, [
    ...u16(1), ...u16(0), ...u32(0x0074), ...u32(0),
    ...Buffer.from('Color', 'utf8'),
  ]);

  for (const malformed of [shortFixed, unterminatedName]) {
    const parsed = parseTpiStream(tpi([malformed]));
    assert.equal(parsed.types.size, 0);
    assert.equal(parsed.complete, false);
  }
});

test('#4058 adversarial: HasUniqueName without its second string fails closed', () => {
  const parsed = parseTpiStream(tpi([enumRecord({ properties: CLASS_OPTION_HAS_UNIQUE_NAME })]));
  assert.equal(parsed.types.size, 0);
  assert.equal(parsed.complete, false);
});

test('#4058 adversarial: unknown ClassOptions do not mint complete enum evidence', () => {
  const parsed = parseTpiStream(tpi([enumRecord({ properties: 0x0800 })]));
  assert.equal(parsed.complete, true, 'record framing remains structurally valid');
  assert.equal(parsed.unmodelled.has(LF_ENUM), true, 'unknown enum semantics are surfaced');
  assert.equal(parsed.types.get(0x1000).complete, false);
  assert.equal(describeTypeIndex(0x1000, parsed.types).complete, false);
});

test('#4058 adversarial: non-integral underlying types are not exposed as enum machine facts', () => {
  const parsed = parseTpiStream(tpi([enumRecord({ underlying: 0x0040 })])); // float
  assert.equal(parsed.complete, true);
  assert.deepEqual(describeTypeIndex(0x1000, parsed.types), {
    name: 'enum Color',
    widthBits: undefined,
    class: undefined,
    complete: false,
  });
});
