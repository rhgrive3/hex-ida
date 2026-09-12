import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCil } from '../../../js/managed/cil/parser.js';
import { CilFrontend } from '../../../js/managed/cil/frontend.js';
import { buildCil, collect } from '../fixtures/medium-cil.mjs';

// #7555: GenericParam (0x2A) and GenericParamConstraint (0x2C) rows were
// layout-walked but never semantically decoded, so `where T : A` and
// `where T : B` collapsed to the identical canonical image — generic
// parameter ownership, names, flags and constraint targets were irreversibly
// lost (ECMA-335 II.9.11, II.22.20, II.22.21).

const project = (image) => JSON.stringify({
  types: image.types,
  methods: image.methods,
  fields: image.fields,
  methodBodies: image.methodBodies,
});

const genericParamRow = ({ number = 0, flags = 0, ownerBase, nameIndex }) => {
  const bytes = new Uint8Array(8);
  const v = new DataView(bytes.buffer);
  v.setUint16(0, number, true);
  v.setUint16(2, flags, true);
  v.setUint16(4, ownerBase, true);
  v.setUint16(6, nameIndex, true);
  return bytes;
};
const constraintRow = (ownerRid, targetBase) => {
  const bytes = new Uint8Array(4);
  const v = new DataView(bytes.buffer);
  v.setUint16(0, ownerRid, true);
  v.setUint16(2, targetBase, true);
  return bytes;
};
const TYPE_DEF = (rid) => (rid << 2) | 0;
const TYPE_REF = (rid) => (rid << 2) | 1;
const TYPE_SPEC = (rid) => (rid << 2) | 2;
const TYPEDEF_OWNER = (rid) => (rid << 1) | 0;
const METHODDEF_OWNER = (rid) => (rid << 1) | 1;

const base = {
  leadingStrings: ['TP'],
  methods: [{ name: 'Run', body: [0x2a] }],
  types: [
    { name: 'G`1', namespace: 'T', fieldList: 1, methodList: 1 },
    { name: 'A', namespace: 'T', fieldList: 1, methodList: 2 },
    { name: 'B', namespace: 'T', fieldList: 1, methodList: 2 },
  ],
};
const nameIndex = 1;
const paramName = (overrides = {}) => genericParamRow({ ownerBase: TYPEDEF_OWNER(1), nameIndex, ...overrides });

test('#7555 a GenericParam row decodes owner, number, flags and name exactly', () => {
  const image = parseCil(buildCil({
    ...base,
    extraRows: new Map([
      [0x2a, { count: 1, bytes: paramName() }],
      [0x2c, { count: 1, bytes: constraintRow(1, TYPE_DEF(2)) }],
    ]),
  }).bytes);
  assert.deepEqual(image.types[0].genericParams, [{
    rid: 1,
    token: '0x2a000001',
    number: 0,
    flags: 0,
    ownerToken: '0x02000001',
    name: 'TP',
    constraintTokens: ['0x02000002'],
  }]);
  assert.deepEqual(image.types[1].genericParams, undefined);
});

test('#7555 the canonical image keeps standalone generic parameter and constraint tables', () => {
  const image = parseCil(buildCil({
    ...base,
    extraRows: new Map([
      [0x2a, { count: 1, bytes: paramName() }],
      [0x2c, { count: 1, bytes: constraintRow(1, TYPE_DEF(2)) }],
    ]),
  }).bytes);
  assert.deepEqual(image.genericParams.map((row) => [row.rid, row.token, row.name]), [[1, '0x2a000001', 'TP']]);
  assert.deepEqual(image.genericParamConstraints, [{
    rid: 1, token: '0x2c000001', ownerToken: '0x2a000001', constraintToken: '0x02000002',
  }]);
});

test('#7555 changing the constraint target changes the canonical projection', () => {
  const constraintA = parseCil(buildCil({
    ...base,
    extraRows: new Map([
      [0x2a, { count: 1, bytes: paramName() }],
      [0x2c, { count: 1, bytes: constraintRow(1, TYPE_DEF(2)) }],
    ]),
  }).bytes);
  const constraintB = parseCil(buildCil({
    ...base,
    extraRows: new Map([
      [0x2a, { count: 1, bytes: paramName() }],
      [0x2c, { count: 1, bytes: constraintRow(1, TYPE_DEF(3)) }],
    ]),
  }).bytes);
  assert.deepEqual(constraintA.types[0].genericParams[0].constraintTokens, ['0x02000002']);
  assert.deepEqual(constraintB.types[0].genericParams[0].constraintTokens, ['0x02000003']);
  assert.notEqual(project(constraintA), project(constraintB));
});

test('#7555 one generic parameter keeps multiple constraints losslessly', () => {
  const image = parseCil(buildCil({
    ...base,
    extraRows: new Map([
      [0x2a, { count: 1, bytes: paramName() }],
      [0x2c, {
        count: 2,
        bytes: Uint8Array.of(...constraintRow(1, TYPE_DEF(2)), ...constraintRow(1, TYPE_DEF(3))),
      }],
    ]),
  }).bytes);
  assert.deepEqual(image.types[0].genericParams[0].constraintTokens, ['0x02000002', '0x02000003']);
});

test('#7555 a MethodDef-owned generic parameter binds to its method', () => {
  const image = parseCil(buildCil({
    ...base,
    extraRows: new Map([
      [0x2a, { count: 1, bytes: paramName({ ownerBase: METHODDEF_OWNER(1) }) }],
      [0x2c, { count: 1, bytes: constraintRow(1, TYPE_DEF(2)) }],
    ]),
  }).bytes);
  assert.deepEqual(image.methods[0].genericParams, [{
    rid: 1,
    token: '0x2a000001',
    number: 0,
    flags: 0,
    ownerToken: '0x06000001',
    name: 'TP',
    constraintTokens: ['0x02000002'],
  }]);
  assert.deepEqual(image.types[0].genericParams, undefined);
});

test('#7555 special constraint flags are preserved exactly', () => {
  const image = parseCil(buildCil({
    ...base,
    extraRows: new Map([
      [0x2a, { count: 3, bytes: Uint8Array.of(
        ...paramName({ number: 0, flags: 0x0004 }),
        ...paramName({ number: 1, flags: 0x0008 }),
        ...paramName({ number: 2, flags: 0x0010 }),
      ) }],
    ]),
  }).bytes);
  assert.deepEqual(image.types[0].genericParams.map((row) => row.flags), [0x0004, 0x0008, 0x0010]);
});

test('#7555 constraint targets keep TypeDef / TypeRef / TypeSpec token identity', () => {
  // TypeRef RID 1: ResolutionScope (null) + name 'R' + namespace null.
  const typeRefRow = Uint8Array.of(0, 0, 2, 0, 0, 0);
  // TypeSpec RID 1: Signature blob index 8 -> SZArray of I4.
  const typeSpecRow = Uint8Array.of(8, 0);
  const image = parseCil(buildCil({
    ...base,
    leadingStrings: ['TP', 'R'],
    blobs: [[0x1d, 0x08]],
    extraRows: new Map([
      [0x01, { count: 1, bytes: typeRefRow }],
      [0x1b, { count: 1, bytes: typeSpecRow }],
      [0x2a, { count: 2, bytes: Uint8Array.of(...paramName(), ...paramName({ number: 1 })) }],
      [0x2c, { count: 2, bytes: Uint8Array.of(...constraintRow(1, TYPE_REF(1)), ...constraintRow(2, TYPE_SPEC(1))) }],
    ]),
  }).bytes);
  assert.deepEqual(image.types[0].genericParams[0].constraintTokens, ['0x01000001']);
  assert.deepEqual(image.types[0].genericParams[1].constraintTokens, ['0x1b000001']);
});

test('#7555 the frontend exposes generic parameters from the canonical image', async () => {
  const image = parseCil(buildCil({
    ...base,
    extraRows: new Map([
      [0x2a, { count: 1, bytes: paramName() }],
      [0x2c, { count: 1, bytes: constraintRow(1, TYPE_DEF(2)) }],
    ]),
  }).bytes);
  const types = await collect(new CilFrontend().enumerateTypes(image));
  assert.deepEqual(types[0].genericParams[0].constraintTokens, ['0x02000002']);
});

test('#7555 a binary without generic tables keeps its projection unchanged', () => {
  const image = parseCil(buildCil({ ...base }).bytes);
  assert.equal(image.genericParams, undefined);
  assert.equal(image.genericParamConstraints, undefined);
  for (const type of image.types) assert.equal(type.genericParams, undefined);
  for (const method of image.methods) assert.equal(method.genericParams, undefined);
});

test('#7555 malformed GenericParam rows fail closed', () => {
  // Owner TypeDef RID 9 with three TypeDef rows.
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([[0x2a, { count: 1, bytes: paramName({ ownerBase: TYPEDEF_OWNER(9) }) }]]),
  }).bytes), /cil-unsupported-binary/);
  // Owner tag MethodDef RID 2 with a single method.
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([[0x2a, { count: 1, bytes: paramName({ ownerBase: METHODDEF_OWNER(2) }) }]]),
  }).bytes), /cil-unsupported-binary/);
  // Owner index 0 resolves to nothing.
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([[0x2a, { count: 1, bytes: paramName({ ownerBase: 0 }) }]]),
  }).bytes), /cil-unsupported-binary/);
  // Null name.
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([[0x2a, { count: 1, bytes: paramName({ nameIndex: 0 }) }]]),
  }).bytes), /cil-unsupported-binary/);
  // Reserved flag bit.
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([[0x2a, { count: 1, bytes: paramName({ flags: 0x0020 }) }]]),
  }).bytes), /cil-unsupported-binary/);
  // Invalid variance encoding (0x3).
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([[0x2a, { count: 1, bytes: paramName({ flags: 0x0003 }) }]]),
  }).bytes), /cil-unsupported-binary/);
  // Duplicate parameter Number for one owner.
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([[0x2a, { count: 2, bytes: Uint8Array.of(...paramName(), ...paramName()) }]]),
  }).bytes), /cil-unsupported-binary/);
  // Parameter Numbers must be contiguous from 0 per owner.
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([[0x2a, { count: 2, bytes: Uint8Array.of(
      ...paramName({ number: 0 }), ...paramName({ number: 2 }),
    ) }]]),
  }).bytes), /cil-unsupported-binary/);
});

test('#7555 malformed GenericParamConstraint rows fail closed', () => {
  const generic = [0x2a, { count: 1, bytes: paramName() }];
  // Constraint owner GenericParam RID 2 with a single GenericParam row.
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([generic, [0x2c, { count: 1, bytes: constraintRow(2, TYPE_DEF(2)) }]]),
  }).bytes), /cil-unsupported-binary/);
  // Target coded index 0 resolves to nothing.
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([generic, [0x2c, { count: 1, bytes: constraintRow(1, 0) }]]),
  }).bytes), /cil-unsupported-binary/);
  // Target tag 3 is not a TypeDefOrRef kind.
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([generic, [0x2c, { count: 1, bytes: constraintRow(1, (1 << 2) | 3) }]]),
  }).bytes), /cil-unsupported-binary/);
  // Target TypeDef RID 9 with three TypeDef rows.
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([generic, [0x2c, { count: 1, bytes: constraintRow(1, TYPE_DEF(9)) }]]),
  }).bytes), /cil-unsupported-binary/);
  // Duplicate constraint edge for the same parameter.
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([generic, [0x2c, { count: 2, bytes: Uint8Array.of(
      ...constraintRow(1, TYPE_DEF(2)), ...constraintRow(1, TYPE_DEF(2)),
    ) }]]),
  }).bytes), /cil-unsupported-binary/);
});
