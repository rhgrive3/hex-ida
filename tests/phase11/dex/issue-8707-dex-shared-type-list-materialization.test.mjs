/**
 * #8707 regression: one physical DEX `type_list` is one semantic object however
 * many rows alias it. `parseDex()` used to re-materialize `parameters_off` per
 * `proto_id_item` (fresh array + full walk + fresh `dexPrototypeShorty()`
 * derivation) and retained every copy, so a ~70 KiB input could hold hundreds of
 * MiB. Protos and `interfaces_off` now share an interned, immutable material and
 * unique entries are charged against an aggregate budget before allocation.
 */
import assert from 'node:assert/strict';
import { buildDex } from '../fixtures/medium-dex.mjs';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { applyDexIntegrity } from '../fixtures/dex-integrity.mjs';

const paramList = (count, last) => [
  ...Array.from({ length: count - 1 }, () => 'I'),
  last,
];

// DEX forbids duplicate proto rows, so aliased protos differ by return type
// while every `parameters_off` is patched onto one physical type_list.
function dexWithAliasedProtos(protoCount, paramsSize) {
  const pad = String(protoCount - 1).length;
  const classNames = ['LTest;', ...Array.from({ length: protoCount }, (_, i) => `LR${String(i).padStart(pad, '0')};`)].sort();
  const params = Array.from({ length: paramsSize }, () => 'I');
  return buildDex({
    classNames,
    fields: [],
    methods: classNames.slice(1).map((returnType, i) => ({
      classType: 'LTest;', name: `m${String(i).padStart(pad, '0')}`, returnType, params, flags: 9, words: [0x000e],
    })),
  });
}

function dexWithProtos(methods, extra = {}) {
  return buildDex({
    classNames: ['LTest;', ...new Set(methods.map((_, i) => `LR${i};`))].sort(),
    fields: [],
    methods: methods.map((params, i) => ({
      classType: 'LTest;', name: `m${i}`, returnType: `LR${i};`, params, flags: 9, words: [0x000e],
    })),
    ...extra,
  });
}

function aliasAllParamsToFirst(bytes, layout, protoCount) {
  const v = new DataView(bytes.buffer);
  const shared = v.getUint32(layout.protos + 8, true);
  assert.ok(shared !== 0, 'fixture needs at least one parameter list');
  for (let i = 1; i < protoCount; i++) v.setUint32(layout.protos + i * 12 + 8, shared, true);
  const mapCount = v.getUint32(layout.mapOff, true);
  for (let i = 0; i < mapCount; i++) {
    const p = layout.mapOff + 4 + i * 12;
    if (v.getUint16(p, true) === 0x1001) v.setUint32(p + 4, 1, true);
  }
  return applyDexIntegrity(bytes);
}

// 1. Aliased `parameters_off` materializes once: every proto shares the same
//    immutable array instead of a private copy.
{
  const { bytes, layout } = dexWithAliasedProtos(200, 100);
  const image = parseDex(aliasAllParamsToFirst(bytes, layout, 200), { binaryId: 'aliased-params' });
  assert.equal(image.protos.length, 200);
  assert.ok(image.protos.every((proto) => proto.params.length === 100), 'parameter lists stay lossless');
  assert.equal(new Set(image.protos.map((proto) => proto.params)).size, 1,
    'one physical type_list must produce one materialized array, not 200 copies');
  assert.ok(Object.isFrozen(image.protos[0].params), 'shared material must be immutable');
  assert.throws(() => { image.protos[0].params.push('I'); }, TypeError, 'shared array cannot be mutated');
}

// 2. The aggregate charge counts *unique* materialization, so a heavily aliased
//    image fits a budget sized to its physical data, and the same budget refuses
//    an image whose unique entries exceed it (before any array is allocated).
{
  const { bytes, layout } = dexWithAliasedProtos(200, 100);
  const aliased = aliasAllParamsToFirst(bytes, layout, 200);
  assert.doesNotThrow(() => parseDex(aliased, { binaryId: 'budget-fits', maxTypeListEntries: 100 }),
    '200 aliases of one 100-entry list must cost 100 entries, not 20 000');
  assert.throws(
    () => parseDex(aliased, { binaryId: 'budget-undershoot', maxTypeListEntries: 99 }),
    /dex-type-list-materialization-budget-exceeded/,
  );

  const distinct = dexWithProtos(
    ['B', 'C', 'S', 'F', 'J', 'D', 'Z', 'Ljava/lang/Object;'].map((last) => paramList(300, last)),
  );
  assert.doesNotThrow(() => parseDex(distinct.bytes, { binaryId: 'distinct-default' }),
    'unique lists inside the default budget still parse');
  assert.throws(
    () => parseDex(distinct.bytes, { binaryId: 'distinct-budget', maxTypeListEntries: 1000 }),
    /dex-type-list-materialization-budget-exceeded/,
    'unique parameter entries must be admitted before duplication',
  );
  assert.doesNotThrow(() => parseDex(distinct.bytes, { binaryId: 'distinct-within-default' }),
    'the default aggregate budget admits ordinary unique parameter data');
}

// 3. Distinct physical lists remain semantically distinct.
{
  const { bytes } = dexWithProtos([paramList(3, 'B'), paramList(3, 'S'), paramList(2, 'I')]);
  const image = parseDex(bytes, { binaryId: 'distinct-lists' });
  assert.equal(image.protos.length, 3);
  assert.deepEqual([...image.protos[0].params], ['I', 'I', 'B']);
  assert.deepEqual([...image.protos[1].params], ['I', 'I', 'S']);
  assert.deepEqual([...image.protos[2].params], ['I', 'I']);
  assert.notEqual(image.protos[0].params, image.protos[1].params);
  assert.equal(image.protos[0].shorty, 'LIIB');
  assert.equal(image.protos[2].shorty, 'LII');
}

// 4. Exactness is preserved: shorty mismatch and malformed type indices keep
//    their existing fail-closed authority through the interned path.
{
  const { bytes, layout } = dexWithProtos([paramList(4, 'B')]);
  const corrupted = Uint8Array.from(bytes);
  // Point the shorty at a wrong string without changing the parameter facts.
  const v = new DataView(corrupted.buffer);
  const wrongShorty = v.getUint32(layout.strings + 4, true); // some other string_data_id
  v.setUint32(layout.protos + 0, (wrongShorty - layout.strings) / 4, true);
  assert.throws(() => parseDex(applyDexIntegrity(corrupted), { binaryId: 'shorty-mismatch' }), /dex-invalid-proto-shorty/);

  const { bytes: badTypeBytes, layout: badLayout } = dexWithProtos([paramList(4, 'B')]);
  const bad = Uint8Array.from(badTypeBytes);
  const paramsOff = new DataView(bad.buffer).getUint32(badLayout.protos + 8, true);
  new DataView(bad.buffer).setUint16(paramsOff + 4, 60000, true); // type_idx outside type_ids
  assert.throws(() => parseDex(applyDexIntegrity(bad), { binaryId: 'bad-param-type' }), /dex-invalid-proto-param-type-index/);

  const { bytes: rangeBytes, layout: rangeLayout } = dexWithProtos([paramList(4, 'B')]);
  const truncated = Uint8Array.from(rangeBytes);
  const listOff = new DataView(truncated.buffer).getUint32(rangeLayout.protos + 8, true);
  new DataView(truncated.buffer).setUint32(listOff, 40000, true); // declared size beyond the file
  assert.throws(() => parseDex(applyDexIntegrity(truncated), { binaryId: 'bad-params-range' }), /dex-invalid-proto-params-range/);
}

// 5. The same interning applies to `class_def_item.interfaces_off` (#7620
//    validation authority must survive sharing).
{
  const interfaceParams = ['Ljava/lang/Object;', 'Ljava/lang/Runnable;'];
  const { bytes, layout } = buildDex({
    classNames: ['LTest;', 'LOther;'].sort(),
    fields: [],
    methods: [{ classType: 'LTest;', name: 'm', returnType: 'I', params: interfaceParams, flags: 9, words: [0x000e] }],
  });
  const v = new DataView(bytes.buffer);
  const sharedList = v.getUint32(layout.protos + 8, true);
  for (const classIndex of [0, 1]) v.setUint32(layout.classes + classIndex * 32 + 12, sharedList, true);
  const image = parseDex(applyDexIntegrity(bytes), { binaryId: 'shared-interfaces' });
  assert.deepEqual([...image.classes[0].interfaceTypes], interfaceParams);
  assert.deepEqual([...image.classes[1].interfaceTypes], interfaceParams);
  assert.equal(image.classes[0].interfaceTypes, image.classes[1].interfaceTypes,
    'one physical interface list must not be re-materialized per class');

  // A primitive-entry list is still rejected as an interface list.
  const primitive = buildDex({
    classNames: ['LTest;'],
    fields: [],
    methods: [{ classType: 'LTest;', name: 'm', returnType: 'I', params: ['I', 'I'], flags: 9, words: [0x000e] }],
  });
  const pv = new DataView(primitive.bytes.buffer);
  pv.setUint32(primitive.layout.classes + 12, pv.getUint32(primitive.layout.protos + 8, true), true);
  assert.throws(
    () => parseDex(applyDexIntegrity(primitive.bytes), { binaryId: 'primitive-interface' }),
    /dex-invalid-interface-type|dex-invalid-class-definer-type/,
  );
}

// 6. Map topology validation still runs over the interned sections.
{
  const { bytes, layout } = dexWithProtos([paramList(4, 'B')]);
  const bad = Uint8Array.from(bytes);
  new DataView(bad.buffer).setUint32(layout.mapOff, 0, true); // zero map items
  assert.throws(() => parseDex(applyDexIntegrity(bad), { binaryId: 'bad-map' }), (error) => /^dex-/.test(error.message) && !/checksum|signature/.test(error.message));
}

console.log('ok #8707 aliased DEX type lists are interned and uniquely budgeted');
