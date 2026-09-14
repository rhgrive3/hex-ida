import assert from 'node:assert/strict';
import test from 'node:test';

import { describeTypeIndex, parseTpiStream } from '../../../js/analysis/debug/pdb.js';

const LF_PROCEDURE = 0x1008;
const LF_ARGLIST = 0x1201;

function u16(value) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function record(leaf, body) {
  const length = 2 + body.length;
  return Uint8Array.from([...u16(length), ...u16(leaf), ...body]);
}

function argList(args) {
  return record(LF_ARGLIST, [...u32(args.length), ...args.flatMap(u32)]);
}

function procedure({ returnType = 0x0074, callingConvention = 0, functionOptions = 0, parameterCount = 0, argumentList = 0x1000 } = {}) {
  return record(LF_PROCEDURE, [
    ...u32(returnType), callingConvention, functionOptions, ...u16(parameterCount), ...u32(argumentList),
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

test('#4210: LF_ARGLIST arguments are retained and LF_PROCEDURE renders them', () => {
  const parsed = parseTpiStream(tpi([
    argList([0x0074, 0x0041]),
    procedure({ parameterCount: 2 }),
  ]));

  assert.equal(parsed.complete, true);
  assert.deepEqual(parsed.types.get(0x1000), {
    leaf: LF_ARGLIST,
    kind: 'arg-list',
    arguments: [0x0074, 0x0041],
    complete: true,
  });
  assert.deepEqual(parsed.types.get(0x1001), {
    leaf: LF_PROCEDURE,
    kind: 'procedure',
    returnType: 0x0074,
    callingConvention: 0,
    functionOptions: 0,
    parameterCount: 2,
    argumentList: 0x1000,
  });

  const described = describeTypeIndex(0x1001, parsed.types);
  assert.equal(described.name, 'int (*)(int, double)');
  assert.equal(described.class, 'code');
  assert.equal(described.complete, true);
});

test('#4210: zero-parameter procedure remains an exact empty signature', () => {
  const parsed = parseTpiStream(tpi([
    argList([]),
    procedure({ parameterCount: 0 }),
  ]));
  assert.equal(parsed.complete, true);
  assert.deepEqual(describeTypeIndex(0x1001, parsed.types), {
    name: 'int (*)()', class: 'code', complete: true,
  });
});

test('#4210: parameterCount/ArgList mismatch fails closed', () => {
  const types = new Map([
    [0x1000, { kind: 'arg-list', arguments: [0x0074, 0x0041], complete: true }],
    [0x1001, {
      kind: 'procedure', returnType: 0x0074, callingConvention: 0, functionOptions: 0,
      parameterCount: 1, argumentList: 0x1000,
    }],
  ]);
  const described = describeTypeIndex(0x1001, types);
  assert.equal(described.name, 'int (*)(int, double)');
  assert.equal(described.complete, false);
});

test('#4210: missing or unmodelled ArgList cannot yield complete procedure evidence', () => {
  for (const argRecord of [undefined, { kind: 'unmodelled' }, { kind: 'arg-list', arguments: [], complete: false }]) {
    const types = new Map([
      [0x1001, {
        kind: 'procedure', returnType: 0x0074, callingConvention: 0, functionOptions: 0,
        parameterCount: 1, argumentList: 0x1000,
      }],
    ]);
    if (argRecord) types.set(0x1000, argRecord);
    const described = describeTypeIndex(0x1001, types);
    assert.equal(described.complete, false);
  }
});

test('#4210: incomplete argument type propagates to the procedure', () => {
  const types = new Map([
    [0x1000, { kind: 'arg-list', arguments: [0x1002], complete: true }],
    [0x1001, {
      kind: 'procedure', returnType: 0x0074, callingConvention: 0, functionOptions: 0,
      parameterCount: 1, argumentList: 0x1000,
    }],
    [0x1002, { kind: 'array', elementType: 0x0074, sizeBytes: 4 }],
  ]);
  const described = describeTypeIndex(0x1001, types);
  assert.equal(described.name, 'int (*)(int[])');
  assert.equal(described.complete, false);
});

test('#4210: unrendered calling-convention/options semantics keep the signature incomplete', () => {
  for (const [callingConvention, functionOptions] of [[1, 0], [0, 1], [0xff, 0xff]]) {
    const types = new Map([
      [0x1000, { kind: 'arg-list', arguments: [], complete: true }],
      [0x1001, {
        kind: 'procedure', returnType: 0x0074, callingConvention, functionOptions,
        parameterCount: 0, argumentList: 0x1000,
      }],
    ]);
    const described = describeTypeIndex(0x1001, types);
    assert.equal(described.name, 'int (*)()');
    assert.equal(described.complete, false);
  }
});

test('#4210: truncated LF_ARGLIST fails closed without reading the next record', () => {
  // Count claims two TypeIndex entries but the record owns only one.
  const shortArgs = record(LF_ARGLIST, [...u32(2), ...u32(0x0074)]);
  const parsed = parseTpiStream(tpi([shortArgs, procedure({ parameterCount: 0, argumentList: 0x1000 })]));
  assert.equal(parsed.types.size, 0);
  assert.equal(parsed.complete, false);
});

test('#4210 adversarial: leaf-only legacy ArgList remains non-authoritative', () => {
  const leafOnlyArgs = record(LF_ARGLIST, []);
  const parsed = parseTpiStream(tpi([leafOnlyArgs, procedure({ parameterCount: 0 })]));
  assert.equal(parsed.complete, true, 'legacy stream walking compatibility is preserved');
  assert.deepEqual(parsed.types.get(0x1000), {
    leaf: LF_ARGLIST, kind: 'arg-list', arguments: [], complete: false,
  });
  assert.equal(describeTypeIndex(0x1001, parsed.types).complete, false);
});

test('#4210 adversarial: sparse argument vectors cannot mint complete signatures', () => {
  const sparse = new Array(1);
  const types = new Map([
    [0x1000, { kind: 'arg-list', arguments: sparse, complete: true }],
    [0x1001, {
      kind: 'procedure', returnType: 0x0074, callingConvention: 0, functionOptions: 0,
      parameterCount: 1, argumentList: 0x1000,
    }],
  ]);
  const described = describeTypeIndex(0x1001, types);
  assert.equal(described.complete, false);
});
