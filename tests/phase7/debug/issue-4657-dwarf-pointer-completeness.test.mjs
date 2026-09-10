import assert from 'node:assert/strict';
import test from 'node:test';

import { DwarfDebugInfoProvider } from '../../../js/analysis/debug/dwarf.js';

const TAG = Object.freeze({
  pointer: 0x0f,
  base: 0x24,
  typedef: 0x16,
  const: 0x26,
  volatile: 0x35,
  variable: 0x34,
});
const AT = Object.freeze({ name: 0x03, byteSize: 0x0b, specification: 0x47, type: 0x49 });
const FORM = Object.freeze({ ref4: 0x13 });
const UNIT = Object.freeze({ start: 0, addressSize: 8 });

function attr(value, form = 0x08) {
  return { value, form };
}

function die(offset, tag, attributes = [], complete = true) {
  return {
    offset,
    tag,
    complete,
    unit: UNIT,
    attributes: new Map(attributes),
  };
}

function typeRef(offset) {
  return attr(BigInt(offset), FORM.ref4);
}

function resultFor(dies) {
  return {
    providerId: 'phase7.debug.dwarf',
    providerVersion: 'test',
    identity: { observed: 'build-4657', expected: 'build-4657', verdict: 'matched-authoritative' },
    parsed: { dies: new Map(dies.map((entry) => [entry.offset, entry])) },
  };
}

function typeRecord({ pointer, targets = [], wrapper = null, variableOffset = 1 }) {
  const variableTarget = wrapper?.offset ?? pointer.offset;
  const variable = die(variableOffset, TAG.variable, [
    [AT.name, attr(`v${variableOffset}`)],
    [AT.type, typeRef(variableTarget)],
  ]);
  const dies = [variable, pointer, ...targets, ...(wrapper ? [wrapper] : [])];
  return new DwarfDebugInfoProvider().types(resultFor(dies), {}).records[0];
}

test('#4657 a pointer with an explicit missing target stays incomplete', () => {
  const pointer = die(0x10, TAG.pointer, [[AT.type, typeRef(0x99)]]);
  const record = typeRecord({ pointer });
  assert.equal(record.descriptor.claim.name, 'unknown *');
  assert.equal(record.descriptor.complete, false);
  assert.equal(record.descriptor.machine?.class, 'pointer');
  assert.equal(record.descriptor.machine?.widthBits, 64);
});

test('#4657 an incomplete referenced target keeps the pointer incomplete', () => {
  const pointer = die(0x10, TAG.pointer, [[AT.type, typeRef(0x20)]]);
  const incompleteBase = die(0x20, TAG.base, [[AT.name, attr('opaque-int')]]);
  const record = typeRecord({ pointer, targets: [incompleteBase] });
  assert.equal(record.descriptor.claim.name, 'opaque-int *');
  assert.equal(record.descriptor.complete, false);
});

test('#4657 a complete referenced target keeps the pointer complete', () => {
  const pointer = die(0x10, TAG.pointer, [[AT.type, typeRef(0x20)]]);
  const intType = die(0x20, TAG.base, [
    [AT.name, attr('int32')],
    [AT.byteSize, attr(4n, 0x0b)],
  ]);
  const record = typeRecord({ pointer, targets: [intType] });
  assert.equal(record.descriptor.claim.name, 'int32 *');
  assert.equal(record.descriptor.complete, true);
  assert.equal(record.descriptor.machine?.widthBits, 64);
});

test('#4657 an omitted pointer DW_AT_type is an explicit complete void pointer', () => {
  const pointer = die(0x10, TAG.pointer);
  const record = typeRecord({ pointer });
  assert.equal(record.descriptor.claim.name, 'void *');
  assert.equal(record.descriptor.complete, true);
  assert.equal(record.descriptor.machine?.class, 'pointer');
  assert.equal(record.descriptor.machine?.widthBits, 64);
});


test('#4657 an unresolved specification cannot masquerade as an omitted void pointee', () => {
  const pointer = die(0x10, TAG.pointer, [[AT.specification, typeRef(0x77)]]);
  const record = typeRecord({ pointer });
  assert.equal(record.descriptor.claim.name, 'unknown *');
  assert.equal(record.descriptor.complete, false);
});

test('#4657 a resolved specification may supply the pointer target', () => {
  const pointer = die(0x10, TAG.pointer, [[AT.specification, typeRef(0x30)]]);
  const declaration = die(0x30, TAG.pointer, [[AT.type, typeRef(0x20)]]);
  const intType = die(0x20, TAG.base, [
    [AT.name, attr('int32')],
    [AT.byteSize, attr(4n, 0x0b)],
  ]);
  const record = typeRecord({ pointer, targets: [declaration, intType] });
  assert.equal(record.descriptor.claim.name, 'int32 *');
  assert.equal(record.descriptor.complete, true);
});

test('#4657 typedef and qualifier wrappers still propagate target incompleteness', () => {
  for (const [tag, expected] of [
    [TAG.typedef, 'alias'],
    [TAG.const, 'const opaque-int'],
    [TAG.volatile, 'volatile opaque-int'],
  ]) {
    const pointer = die(0x10, TAG.pointer, [[AT.type, typeRef(0x20)]]);
    const incompleteBase = die(0x20, TAG.base, [[AT.name, attr('opaque-int')]]);
    const wrapper = die(0x30, tag, [
      ...(tag === TAG.typedef ? [[AT.name, attr('alias')]] : []),
      [AT.type, typeRef(0x20)],
    ]);
    const record = typeRecord({ pointer, targets: [incompleteBase], wrapper, variableOffset: 0x40 + tag });
    assert.equal(record.descriptor.claim.name, expected);
    assert.equal(record.descriptor.complete, false);
  }
});
