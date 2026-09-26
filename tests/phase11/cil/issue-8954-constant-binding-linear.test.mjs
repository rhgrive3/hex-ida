import assert from 'node:assert/strict';
import test from 'node:test';
import { bindCilMetadataTables } from '../../../js/managed/cil/metadata-definitions-core.js';

// #8954: the Constant binding loop in bindCilMetadataTables() resolved each
// row's declared type with global linear scans — `methods.find()` per Param
// Constant and a full `fields.filter()` per enum Constant — and re-materialized
// every shared #Blob value per row (UTF-16 string OOM under 30MB of aliased
// constants). Owner resolution must be indexed, `value__` proof cached per
// enum type with identical exactness, and immutable scalar materialization
// shared per (type, blob) alias.

function blobHeap(...blobs) {
  const bytes = [0];
  const indexes = [];
  for (const blob of blobs) {
    assert.ok(blob.length < 0x80, 'fixture only uses one-byte compressed lengths');
    indexes.push(bytes.length);
    bytes.push(blob.length, ...blob);
  }
  return { heap: new Uint8Array(bytes), indexes };
}

function defs({ types, fields = [], methods = [], params = [], properties = [], constants = [], nestedClasses = [] }) {
  return {
    types, fields, methods, params, properties, constants,
    classLayouts: [], fieldLayouts: [], nestedClasses,
    assembly: { name: 'System.Private.CoreLib' },
    assemblyRefs: [{ token: '0x23000001', rid: 1, name: 'System.Private.CoreLib' }],
    typeRefs: [], typeSpecs: [],
  };
}

const METHOD_SIG = [0x20, 0x01, 0x01, 0x08]; // HASTHIS+DEFAULT, 1 param, void, I4
const FIELD_I4_SIG = [0x06, 0x08];
const FIELD_STR_SIG = [0x06, 0x0e];

function timeBind(d, heap) {
  const started = process.hrtime.bigint();
  const result = bindCilMetadataTables(d, heap);
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, result };
}

// ── root 1: Param owner global scan ──────────────────────────────────────────

function paramConstantsFixture(m) {
  const { heap, indexes } = blobHeap(METHOD_SIG, [42, 0, 0, 0]);
  const types = [{ token: '0x02000001', rid: 1, accessFlags: 0x101 }];
  const methods = Array.from({ length: m }, (_, i) => ({
    rid: i + 1, token: `0x06${String(i + 1).padStart(6, '0')}`,
    // ced02c5f requires unique owner/name/signature identities; each
    // performance-fixture MethodDef therefore needs its own valid name.
    name: `M${i}`, signatureBlobIndex: indexes[0], declaringTypeToken: '0x02000001', accessFlags: 0x06,
  }));
  const params = Array.from({ length: m }, (_, i) => ({
    rid: i + 1, token: `0x08${String(i + 1).padStart(6, '0')}`,
    ownerToken: methods[i].token, sequence: 1, flags: 0,
  }));
  const constants = Array.from({ length: m }, (_, i) => ({
    rid: i + 1, token: `0x0b${String(i + 1).padStart(6, '0')}`,
    type: 0x08, parent: { table: 0x08, rid: i + 1, token: params[i].token }, valueIndex: indexes[1],
  }));
  return { heap, d: defs({ types, methods, params, constants }) };
}

test('#8954 Param Constant owner lookup is indexed, not a per-row methods scan', () => {
  const a = paramConstantsFixture(2000);
  const small = timeBind(a.d, a.heap);
  assert.equal(small.result.constants.length, 2000);
  assert.equal(small.result.constants[0].value, 42);
  const b = paramConstantsFixture(8000);
  const large = timeBind(b.d, b.heap);
  assert.equal(large.result.constants[7999].value, 42);
  assert.ok(large.ms < small.ms * 12 + 60,
    `Param owner lookup scaled quadratically: 2k=${small.ms.toFixed(1)}ms 8k=${large.ms.toFixed(1)}ms`);
});

test('#8954 indexed owner lookup keeps the exact fail-closed authority', () => {
  const { heap, indexes } = blobHeap(METHOD_SIG, [42, 0, 0, 0]);
  const d = defs({
    types: [{ token: '0x02000001', rid: 1, accessFlags: 0x101 }],
    methods: [{ rid: 1, token: '0x06000001', signatureBlobIndex: indexes[0], accessFlags: 0x06 }],
    params: [{ rid: 1, token: '0x08000001', ownerToken: '0x06000099', sequence: 1, flags: 0 }],
    constants: [{ rid: 1, token: '0x0b000001', type: 0x08, parent: { table: 0x08, rid: 1, token: '0x08000001' }, valueIndex: indexes[1] }],
  });
  assert.throws(() => bindCilMetadataTables(d, heap), /cil-constant-parent-type-unprovable/);
});

// ── root 2: enum value__ global scan ─────────────────────────────────────────

function enumConstantsFixture(n) {
  const { heap, indexes } = blobHeap([0x06, 0x11, 0x04], FIELD_I4_SIG, [7, 0, 0, 0]);
  const extendsTypeRef = { token: '0x01000001', rid: 1, name: 'Enum', namespace: 'System', resolutionScope: { table: 0x23, rid: 1, token: '0x23000001' } };
  const types = [];
  for (let i = 0; i < 2 * n; i++) {
    types.push({
      rid: i + 1, token: `0x02${String(i + 1).padStart(6, '0')}`, accessFlags: 0x101,
      name: `T${i}`, namespace: 'Example', extendsTypeRef,
    });
  }
  const fields = [];
  const constants = [];
  for (let i = 0; i < n; i++) {
    const enumToken = `0x02${String(2 * i + 1).padStart(6, '0')}`;   // E_i (odd rid)
    const holderToken = `0x02${String(2 * i + 2).padStart(6, '0')}`; // H_i carries the enum-typed literal
    fields.push({
      rid: fields.length + 1, token: `0x04${String(fields.length + 1).padStart(6, '0')}`,
      accessFlags: 0x0606, name: 'value__', declaringTypeToken: enumToken, signatureBlobIndex: indexes[1],
    });
    fields.push({
      rid: fields.length + 1, token: `0x04${String(fields.length + 1).padStart(6, '0')}`,
      accessFlags: 0x8056, name: `Lit${i}`, declaringTypeToken: holderToken, signatureBlobIndex: indexes[0],
    });
    const lit = fields[fields.length - 1];
    constants.push({
      rid: i + 1, token: `0x0b${String(i + 1).padStart(6, '0')}`, type: 0x08,
      parent: { table: 0x04, rid: lit.rid, token: lit.token },
      valueIndex: indexes[2],
    }); // Constant on the Lit field whose VALUETYPE points at E_i
  }
  return { heap, d: defs({ types, fields, constants }) };
}

test('#8954 enum value__ resolution indexes fields per enum type, no global rescans', () => {
  const a = enumConstantsFixture(800);
  const small = timeBind(a.d, a.heap);
  assert.equal(small.result.constants.length, 800);
  assert.equal(small.result.constants[0].value, 7);
  const b = enumConstantsFixture(3200);
  const large = timeBind(b.d, b.heap);
  assert.equal(large.result.constants[3199].value, 7);
  assert.ok(large.ms < small.ms * 12 + 60,
    `enum value__ lookup scaled quadratically: 800=${small.ms.toFixed(1)}ms 3200=${large.ms.toFixed(1)}ms`);
});

test('#8954 cached value__ index keeps the unique/flags proof exact', () => {
  const FIELD_I8_SIG = [0x06, 0x0a];
  const { heap, indexes } = blobHeap([0x06, 0x11, 0x04], FIELD_I4_SIG, [7, 0, 0, 0], FIELD_I8_SIG);
  const enumToken = '0x02000001'; // E declares System.Enum; Holder (rid 2) carries the literal
  const extendsTypeRef = { token: '0x01000001', rid: 1, name: 'Enum', namespace: 'System', resolutionScope: { table: 0x23, rid: 1, token: '0x23000001' } };
  const mk = (valueFields) => defs({
    types: [
      { rid: 1, token: enumToken, accessFlags: 0x101, name: 'E', namespace: 'Example', extendsTypeRef },
      { rid: 2, token: '0x02000002', accessFlags: 0x101, name: 'Holder', namespace: 'Example', extendsTypeRef },
    ],
    fields: [
      ...valueFields.map((f, i) => ({ ...f, rid: i + 1, token: `0x04${String(i + 1).padStart(6, '0')}`, declaringTypeToken: enumToken })),
      { rid: valueFields.length + 1, token: `0x04${String(valueFields.length + 1).padStart(6, '0')}`, accessFlags: 0x8056, name: 'Lit', declaringTypeToken: '0x02000002', signatureBlobIndex: indexes[0] },
    ],
    constants: [{ rid: 1, token: '0x0b000001', type: 0x08, parent: { table: 0x04, rid: valueFields.length + 1, token: `0x04${String(valueFields.length + 1).padStart(6, '0')}` }, valueIndex: indexes[2] }],
  });
  const good = mk([{ accessFlags: 0x0606, name: 'value__', declaringTypeToken: enumToken, signatureBlobIndex: indexes[1] }]);
  assert.equal(bindCilMetadataTables(good, heap).constants[0].value, 7);
  // Two value__ rows do not prove one unique enum underlying type.
  const dup = mk([
    { accessFlags: 0x0606, name: 'value__', declaringTypeToken: enumToken, signatureBlobIndex: indexes[1] },
    { accessFlags: 0x0606, name: 'value__', declaringTypeToken: enumToken, signatureBlobIndex: indexes[1] },
  ]);
  assert.throws(() => bindCilMetadataTables(dup, heap), /cil-constant-type-mismatch/);
  // The static candidate has a distinct signature so the metadata identities
  // remain unique; flags must exclude it and leave the instance candidate.
  const staticExcluded = mk([
    { accessFlags: 0x0616, name: 'value__', declaringTypeToken: enumToken, signatureBlobIndex: indexes[3] },
    { accessFlags: 0x0606, name: 'value__', declaringTypeToken: enumToken, signatureBlobIndex: indexes[1] },
  ]);
  assert.equal(bindCilMetadataTables(staticExcluded, heap).constants[0].value, 7);
  const allStatic = mk([
    { accessFlags: 0x0616, name: 'value__', declaringTypeToken: enumToken, signatureBlobIndex: indexes[1] },
  ]);
  assert.throws(() => bindCilMetadataTables(allStatic, heap), /cil-constant-type-mismatch/);
});

// ── root 3: shared STRING blob repeated decode/retention ────────────────────

function stringConstantsFixture(n) {
  // One shared 100-byte UTF-16 value blob aliased by n distinct Field rows.
  const value = [];
  for (let i = 0; i < 50; i++) value.push(0x61, 0x00);
  const { heap, indexes } = blobHeap(FIELD_STR_SIG, value);
  const types = [{ rid: 1, token: '0x02000001', accessFlags: 0x101 }];
  const fields = Array.from({ length: n }, (_, i) => ({
    rid: i + 1, token: `0x04${String(i + 1).padStart(6, '0')}`,
    accessFlags: 0x8056, name: `S${i}`, declaringTypeToken: '0x02000001', signatureBlobIndex: indexes[0],
  }));
  const constants = Array.from({ length: n }, (_, i) => ({
    rid: i + 1, token: `0x0b${String(i + 1).padStart(6, '0')}`, type: 0x0e,
    parent: { table: 0x04, rid: i + 1, token: fields[i].token }, valueIndex: indexes[1],
  }));
  return { heap, d: defs({ types, fields, constants }), fields };
}

test('#8954 shared STRING Constant blob materializes one value object, not N decodes', () => {
  const a = stringConstantsFixture(2000);
  const small = timeBind(a.d, a.heap);
  assert.equal(small.result.constants.length, 2000);
  assert.equal(small.result.constants[0].value.length, 50);
  const b = stringConstantsFixture(8000);
  const large = timeBind(b.d, b.heap);
  assert.ok(large.ms < small.ms * 8 + 40,
    `shared string materialization scaled with rows: 2k=${small.ms.toFixed(1)}ms 8k=${large.ms.toFixed(1)}ms`);
  // Retention: every alias row shares ONE frozen value authority.
  const first = large.result.fields[0].constant;
  assert.ok(Object.isFrozen(first));
  for (let i = 1; i < 8000; i++) assert.equal(large.result.fields[i].constant, first);
  // Width/parity validation still runs per row before materialization.
  const oddValue = [0x61, 0x00, 0x62]; // 3 bytes: odd UTF-16 length
  const { heap: badHeap, indexes: badIndexes } = blobHeap(FIELD_STR_SIG, oddValue);
  const sigIdx = badIndexes[0], valueIdx = badIndexes[1];
  const bad = defs({
    types: [{ rid: 1, token: '0x02000001', accessFlags: 0x101 }],
    fields: [
      { rid: 1, token: '0x04000001', accessFlags: 0x8056, name: 'A', declaringTypeToken: '0x02000001', signatureBlobIndex: sigIdx },
      { rid: 2, token: '0x04000002', accessFlags: 0x8056, name: 'B', declaringTypeToken: '0x02000001', signatureBlobIndex: sigIdx },
    ],
    constants: [
      { rid: 1, token: '0x0b000001', type: 0x0e, parent: { table: 0x04, rid: 1, token: '0x04000001' }, valueIndex: valueIdx },
    ],
  });
  assert.throws(() => bindCilMetadataTables(bad, badHeap), /cil-constant-blob-length-invalid/);
});
