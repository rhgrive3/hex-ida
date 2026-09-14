import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCil } from '../../../js/managed/cil/parser.js';
import { CilFrontend } from '../../../js/managed/cil/frontend.js';
import { buildCil, collect } from '../fixtures/medium-cil.mjs';

// #7491 / #7506 / #7522: the InterfaceImpl (0x09), MethodImpl (0x19) and
// ImplMap (0x1C) metadata tables were layout-walked but never decoded, so the
// `implements` / explicit-override / P/Invoke relationships vanished from the
// canonical image — a row could be added, changed or removed with the
// projection staying byte-identical.

const project = (image) => JSON.stringify({
  types: image.types,
  methods: image.methods,
  fields: image.fields,
  methodBodies: image.methodBodies,
});

test('#7491 an InterfaceImpl row produces the canonical implements edge', () => {
  const base = { types: [{ name:'I', namespace:'T', flags:0x81 }, { name:'J', namespace:'T', flags:1 }], methods: [] };
  const image = parseCil(buildCil({
    ...base,
    // Class = TypeDef RID 2 (T.J), Interface = TypeDefOrRef(TypeDef RID 1) = (1 << 2) | 0
    extraRows: new Map([[0x09, { count:1, bytes: Uint8Array.of(2,0, 4,0) }]]),
  }).bytes);
  assert.deepEqual(image.types[1].interfaceTokens, ['0x02000001']);
  assert.deepEqual(image.types[0].interfaceTokens, []);
});

test('#7491 InterfaceImpl rows reach the frontend type enumeration', async () => {
  const image = parseCil(buildCil({
    types: [{ name:'I', namespace:'T', flags:0x81 }, { name:'J', namespace:'T', flags:1 }],
    methods: [],
    extraRows: new Map([[0x09, { count:1, bytes: Uint8Array.of(2,0, 4,0) }]]),
  }).bytes);
  const types = await collect(new CilFrontend().enumerateTypes(image));
  assert.deepEqual(types[1].interfaceTokens, ['0x02000001']);
});

test('#7491 multiple and inherited interface edges stay in row order', () => {
  const image = parseCil(buildCil({
    types: [{ name:'I', namespace:'T', flags:0x81 }, { name:'J', namespace:'T', flags:0x81 }, { name:'K', namespace:'T', flags:1 }],
    methods: [],
    extraRows: new Map([[0x09, {
      count: 2,
      // K implements I, then J (interface inheritance is the same table).
      bytes: Uint8Array.of(3,0, (1 << 2) | 0, 0, 3,0, (2 << 2) | 0, 0),
    }]]),
  }).bytes);
  assert.deepEqual(image.types[2].interfaceTokens, ['0x02000001', '0x02000002']);
});

test('#7491 malformed InterfaceImpl rows fail closed', () => {
  const base = { types: [{ name:'I', namespace:'T', flags:0x81 }, { name:'J', namespace:'T', flags:1 }], methods: [] };
  // Class RID 9 is out of range.
  assert.throws(() => parseCil(buildCil({ ...base, extraRows: new Map([[0x09, { count:1, bytes: Uint8Array.of(9,0, 4,0) }]]) }).bytes), /cil-unsupported-binary/);
  // Interface coded index resolves to nothing (tag 3 = TypeSpec with 0 rows).
  assert.throws(() => parseCil(buildCil({ ...base, extraRows: new Map([[0x09, { count:1, bytes: Uint8Array.of(2,0, (0 << 2) | 3, 0) }]]) }).bytes), /cil-unsupported-binary/);
  // Duplicate edge.
  assert.throws(() => parseCil(buildCil({ ...base, extraRows: new Map([[0x09, { count:2, bytes: Uint8Array.of(2,0, 4,0, 2,0, 4,0) }]]) }).bytes), /cil-unsupported-binary/);
});

test('#7506 a MethodImpl row preserves the explicit override binding', () => {
  const base = {
    types: [
      { name:'Base', namespace:'T', methodList:1, fieldList:1, flags:0x81 },
      { name:'Child', namespace:'T', methodList:2, fieldList:1, extends:4, flags:1 },
    ],
    methods: [{ name:'M', body:null, flags:0x5c6 }, { name:'Impl', body:[0x2a], flags:0x0c6 }],
  };
  const image = parseCil(buildCil({
    ...base,
    // Class = TypeDef RID 2, MethodBody = MethodDefOrRef(MethodDef RID 2) = (2<<1)|0, Declaration = (1<<1)|0
    extraRows: new Map([[0x19, { count:1, bytes: Uint8Array.of(2,0, 4,0, 2,0) }]]),
  }).bytes);
  assert.deepEqual(image.types[1].methodImpls, [{
    rid: 1,
    token: '0x19000001',
    classToken: '0x02000002',
    methodBodyToken: '0x06000002',
    methodDeclarationToken: '0x06000001',
  }]);
  // The implementing method carries the explicit override as well.
  assert.deepEqual(image.methods[1].explicitOverrideTokens, ['0x06000001']);
});

test('#7506 malformed MethodImpl rows fail closed', () => {
  const base = {
    types: [{ name:'Base', namespace:'T', methodList:1, fieldList:1, flags:0x81 }, { name:'Child', namespace:'T', methodList:2, fieldList:1, extends:4, flags:1 }],
    methods: [{ name:'M', body:null, flags:0x5c6 }, { name:'Impl', body:[0x2a], flags:0x0c6 }],
  };
  // Class RID 9 out of range.
  assert.throws(() => parseCil(buildCil({ ...base, extraRows: new Map([[0x19, { count:1, bytes: Uint8Array.of(9,0, 4,0, 2,0) }]]) }).bytes), /cil-unsupported-binary/);
  // MethodBody tag 1 (MemberRef) with no MemberRef rows.
  assert.throws(() => parseCil(buildCil({ ...base, extraRows: new Map([[0x19, { count:1, bytes: Uint8Array.of(2,0, (1 << 1) | 1, 0, 2,0) }]]) }).bytes), /cil-unsupported-binary/);
});

test('#7506 a non-virtual MethodImpl body fails closed (II.22.27)', () => {
  const base = {
    types: [
      { name:'Base', namespace:'T', methodList:1, fieldList:1, flags:0x81 },
      { name:'Child', namespace:'T', methodList:2, fieldList:1, extends:4, flags:1 },
    ],
    methods: [{ name:'M', body:null, flags:0x5c6 }, { name:'Impl', body:[0x2a], flags:0x086 }],
  };
  // Child::Impl without the Virtual attribute may not carry an explicit
  // override: the row must fail closed instead of publishing exact authority.
  assert.throws(
    () => parseCil(buildCil({ ...base, extraRows: new Map([[0x19, { count:1, bytes: Uint8Array.of(2,0, 4,0, 2,0) }]]) }).bytes),
    /cil-unsupported-binary/,
  );
});

test('#7506 two MethodImpl rows for one declaration with different bodies fail closed', () => {
  const base = {
    types: [
      { name:'Base', namespace:'T', methodList:1, fieldList:1, flags:0x81 },
      { name:'Child', namespace:'T', methodList:3, fieldList:1, extends:4, flags:1 },
    ],
    methods: [
      { name:'M', body:null, flags:0x5c6 },
      { name:'Impl1', body:[0x2a], flags:0x0c6 },
      { name:'Impl2', body:[0x2a], flags:0x0c6 },
    ],
  };
  // Same Class + MethodDeclaration with a second, different body: the
  // dispatch target is ambiguous and must be rejected.
  assert.throws(
    () => parseCil(buildCil({
      ...base,
      extraRows: new Map([[0x19, { count:2, bytes: Uint8Array.of(2,0, 4,0, 2,0, 2,0, 6,0, 2,0) }]]),
    }).bytes),
    /cil-unsupported-binary/,
  );
});

test('#7506 a decodable but unequal MethodImpl signature pair fails closed', () => {
  const base = {
    types: [
      { name:'Base', namespace:'T', methodList:1, fieldList:1, flags:0x81 },
      { name:'Child', namespace:'T', methodList:2, fieldList:1, extends:4, flags:1 },
    ],
    // Both signatures decode cleanly, but they disagree on the return shape —
    // the mismatch must be enforced, not swallowed by the undecodable-sig
    // degradation.
    methods: [
      { name:'M', body:null, flags:0x5c6, signature:[0x00, 0x00, 0x1c] },
      { name:'Impl', body:[0x2a], flags:0x0c6, signature:[0x00, 0x00, 0x08] },
    ],
  };
  assert.throws(
    () => parseCil(buildCil({ ...base, extraRows: new Map([[0x19, { count:1, bytes: Uint8Array.of(2,0, 4,0, 2,0) }]]) }).bytes),
    /cil-unsupported-binary/,
  );
});

test('#7506 MethodImpl signature mismatch fails closed on generic arity delta with identical params/return', () => {
  const base = {
    types: [
      { name:'Base', namespace:'T', methodList:1, fieldList:1, flags:0x81 },
      { name:'Child', namespace:'T', methodList:2, fieldList:1, extends:4, flags:1 },
    ],
    // Both signatures decode cleanly and share () -> void, but generic arities differ (1 vs 2).
    methods: [
      { name:'M', body:null, flags:0x5c6, signature:[0x10, 0x01, 0x00, 0x01] },
      { name:'Impl', body:[0x2a], flags:0x0c6, signature:[0x10, 0x02, 0x00, 0x01] },
    ],
  };
  assert.throws(
    () => parseCil(buildCil({ ...base, extraRows: new Map([[0x19, { count:1, bytes: Uint8Array.of(2,0, 4,0, 2,0) }]]) }).bytes),
    /cil-unsupported-binary/,
  );
});

test('#7506 MethodImpl signature mismatch fails closed on calling convention delta with identical params/return', () => {
  const base = {
    types: [
      { name:'Base', namespace:'T', methodList:1, fieldList:1, flags:0x81 },
      { name:'Child', namespace:'T', methodList:2, fieldList:1, extends:4, flags:1 },
    ],
    // Both signatures decode cleanly and share () -> void, but calling conventions differ (DEFAULT vs HASTHIS).
    methods: [
      { name:'M', body:null, flags:0x5c6, signature:[0x00, 0x00, 0x01] },
      { name:'Impl', body:[0x2a], flags:0x0c6, signature:[0x20, 0x00, 0x01] },
    ],
  };
  assert.throws(
    () => parseCil(buildCil({ ...base, extraRows: new Map([[0x19, { count:1, bytes: Uint8Array.of(2,0, 4,0, 2,0) }]]) }).bytes),
    /cil-unsupported-binary/,
  );
});

test('#7522 an ImplMap row binds the P/Invoke target to the method', () => {
  const image = parseCil(buildCil({
    types: [{ name:'KERNEL32', namespace:'Interop', methodList:1, fieldList:1 }],
    methods: [{ name:'Beep', body:null, flags:0x2016 }],
    extraRows: new Map([
      [0x1a, { count:1, bytes: Uint8Array.of(1,0) }],
      [0x1c, { count:1, bytes: Uint8Array.of(0,1, 3,0, 1,0, 1,0) }],
    ]),
  }).bytes);
  assert.equal(image.methods[0].pinvoke.importName, 'Beep');
  assert.equal(image.methods[0].pinvoke.mappingFlags, 0x0100);
  assert.equal(image.methods[0].pinvoke.memberForwardedToken, '0x06000001');
  assert.ok(image.methods[0].pinvoke.importScope, 'module ref name resolves');
});

test('#7522 ImplMap validation is fail-closed', () => {
  const base = {
    types: [{ name:'KERNEL32', namespace:'Interop', methodList:1, fieldList:1 }],
    methods: [{ name:'Beep', body:null, flags:0x2016 }],
  };
  // MemberForwarded tag 0 (Field) is not a MethodDef.
  assert.throws(() => parseCil(buildCil({ ...base, extraRows: new Map([
    [0x1a, { count:1, bytes: Uint8Array.of(1,0) }],
    [0x1c, { count:1, bytes: Uint8Array.of(0,1, (1 << 1) | 0, 0, 1,0, 1,0) }],
  ]) }).bytes), /cil-unsupported-binary/);
  // MethodDef RID 9 out of range.
  assert.throws(() => parseCil(buildCil({ ...base, extraRows: new Map([
    [0x1a, { count:1, bytes: Uint8Array.of(1,0) }],
    [0x1c, { count:1, bytes: Uint8Array.of(0,1, (9 << 1) | 1, 0, 1,0, 1,0) }],
  ]) }).bytes), /cil-unsupported-binary/);
  // ImportScope RID 2 with a single ModuleRef row.
  assert.throws(() => parseCil(buildCil({ ...base, extraRows: new Map([
    [0x1a, { count:1, bytes: Uint8Array.of(1,0) }],
    [0x1c, { count:1, bytes: Uint8Array.of(0,1, 3,0, 1,0, 2,0) }],
  ]) }).bytes), /cil-unsupported-binary/);
  // Duplicate mapping for the same method.
  assert.throws(() => parseCil(buildCil({ ...base, extraRows: new Map([
    [0x1a, { count:1, bytes: Uint8Array.of(1,0) }],
    [0x1c, { count:2, bytes: Uint8Array.of(0,1, 3,0, 1,0, 1,0, 0,1, 3,0, 1,0, 1,0) }],
  ]) }).bytes), /cil-unsupported-binary/);
});

test('#7522 a PInvokeImpl flag without an ImplMap row fails closed (II.22.22 rule 4)', () => {
  assert.throws(() => parseCil(buildCil({
    types: [{ name:'KERNEL32', namespace:'Interop', methodList:1, fieldList:1 }],
    methods: [{ name:'Beep', body:null, flags:0x2016 }],
  }).bytes), /cil-unsupported-binary/);
});

test('#7491/#7506/#7522 a row changes the projection (no more invisible metadata)', () => {
  const withEdge = buildCil({
    types: [{ name:'I', namespace:'T', flags:0x81 }, { name:'J', namespace:'T', flags:1 }],
    methods: [],
    extraRows: new Map([[0x09, { count:1, bytes: Uint8Array.of(2,0, 4,0) }]]),
  }).bytes;
  const withoutEdge = buildCil({
    types: [{ name:'I', namespace:'T', flags:0x81 }, { name:'J', namespace:'T', flags:1 }],
    methods: [],
  }).bytes;
  const a = parseCil(withEdge), b = parseCil(withoutEdge);
  assert.notEqual(project(a), project(b));
});

test('#7545 a FieldRVA row binds the static field initial-data RVA', () => {
  const base = { types: [{ name:'K', namespace:'Interop', methodList:1, fieldList:1 }], fields: [{ name:'X', flags:0x0116 }], methods: [] };
  const withRva = parseCil(buildCil({
    ...base,
    // FieldRVA: RVA = 0x3000, Field RID 1.
    extraRows: new Map([[0x1d, { count:1, bytes: Uint8Array.of(0,0x39,0,0, 1,0) }]]),
  }).bytes);
  assert.equal(withRva.fields[0].rva, 0x3900);
});

test('#7545 FieldRVA validation is fail-closed', () => {
  const base = { types: [{ name:'K', namespace:'Interop', methodList:1, fieldList:1 }], fields: [{ name:'X', flags:0x0116 }], methods: [] };
  // Field RID 9 with a single Field row.
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([[0x1d, { count:1, bytes: Uint8Array.of(0,0x30,0,0, 9,0) }]]),
  }).bytes), /cil-unsupported-binary/);
});

test('#7545 changing the RVA changes the canonical projection', () => {
  const base = { types: [{ name:'K', namespace:'Interop', methodList:1, fieldList:1 }], fields: [{ name:'X', flags:0x0116 }], methods: [] };
  const at0x3000 = parseCil(buildCil({
    ...base,
    extraRows: new Map([[0x1d, { count:1, bytes: Uint8Array.of(0,0x39,0,0, 1,0) }]]),
  }).bytes);
  const at0x3010 = parseCil(buildCil({
    ...base,
    extraRows: new Map([[0x1d, { count:1, bytes: Uint8Array.of(0x10,0x39,0,0, 1,0) }]]),
  }).bytes);
  assert.notEqual(at0x3000.fields[0].rva, at0x3010.fields[0].rva);
});

test('#7545 zero, unmapped, metadata-area, and duplicate FieldRVAs fail closed', () => {
  const base = { types: [{ name:'K', namespace:'Interop', methodList:1, fieldList:1 }], fields: [{ name:'X', flags:0x0116 }], methods: [] };
  // RVA = 0: no initial data, not a mapping.
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([[0x1d, { count:1, bytes: Uint8Array.of(0,0,0,0, 1,0) }]]),
  }).bytes), /cil-unsupported-binary/);
  // RVA 0x7f00 maps nowhere in the single 0x2000.. section.
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([[0x1d, { count:1, bytes: Uint8Array.of(0,0x7f,0,0, 1,0) }]]),
  }).bytes), /cil-unsupported-binary/);
  // RVA inside the metadata root area: metadata is not initial data.
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([[0x1d, { count:1, bytes: Uint8Array.of(0,0x23,0,0, 1,0) }]]),
  }).bytes), /cil-unsupported-binary/);
  // Two FieldRVA rows for the same Field: the binding is ambiguous.
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([[0x1d, { count:2, bytes: Uint8Array.of(0,0x39,0,0, 1,0, 0x10,0x39,0,0, 1,0) }]]),
  }).bytes), /cil-unsupported-binary/);
});

test('#7545 a FieldRVA row for a field without HasFieldRVA fails closed', () => {
  const base = { types: [{ name:'K', namespace:'Interop', methodList:1, fieldList:1 }], fields: [{ name:'X', flags:0x0006 }], methods: [] };
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([[0x1d, { count:1, bytes: Uint8Array.of(0,0x39,0,0, 1,0) }]]),
  }).bytes), /cil-unsupported-binary/);
});
