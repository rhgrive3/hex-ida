import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCil } from '../../../js/managed/cil/parser.js';
import { parseCil as parseCilBase } from '../../../js/managed/cil/parser-base.js';
import { overlayCilMetadata } from '../../../js/managed/cil/parser-overlay.js';
import { buildCil } from '../fixtures/medium-cil.mjs';

// #8956: the GenericParam (0x2A) per-owner parameter-number duplicate check and
// the InterfaceImpl (0x09) per-class interface-token duplicate check both used a
// linear `Array.prototype.includes()` scan over the rows already recorded for
// that owner. A *valid* table is precisely the worst case: one owner carrying a
// contiguous 0..N-1 numbering, or one class listing N distinct interfaces,
// contains no duplicate at all yet forces
//   0 + 1 + ... + (N-1)
// comparisons. Because `Number` is a u16 and interface tokens are bounded by the
// TypeRef/TypeDef/TypeSpec row counts, a small (well under 2 MiB) but valid image
// could therefore convert the supported metadata-relation budget into Θ(N²)
// synchronous work before any semantic decode happens.
//
// The repair keeps the same fail-closed semantics but makes the membership test
// O(1) per row, so the published projection is unchanged while the cost becomes
// linear. The scaling assertions below are ratios measured in one process, so
// they stay meaningful on a fast or a slow machine; the absolute allowance is
// only a "does not run away" guard.

const TYPEDEF_OWNER = (rid) => (rid << 1) | 0;

// A valid owner carrying the contiguous numbering 0..count-1. Every row is
// well-formed and no parameter number is ever duplicated.
function contiguousGenericParamRows(count) {
  const bytes = new Uint8Array(count * 8);
  const v = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) {
    v.setUint16(i * 8 + 0, i, true);
    v.setUint16(i * 8 + 2, 0, true);
    v.setUint16(i * 8 + 4, TYPEDEF_OWNER(1), true);
    v.setUint16(i * 8 + 6, 1, true);
  }
  return bytes;
}

function genericParamImage(count, { duplicateLast = false } = {}) {
  const rows = contiguousGenericParamRows(count + (duplicateLast ? 1 : 0));
  if (duplicateLast) {
    // Repeat the first owner/number pair as the physically last row, so a
    // detection that only checks the tail cannot pass by accident.
    const v = new DataView(rows.buffer);
    v.setUint16(count * 8 + 0, 0, true);
    v.setUint16(count * 8 + 4, TYPEDEF_OWNER(1), true);
    v.setUint16(count * 8 + 6, 1, true);
  }
  const total = count + (duplicateLast ? 1 : 0);
  return buildCil({
    leadingStrings: ['TP'],
    // A bodyless TypeDef keeps the fixture's method-body region from colliding
    // with the enlarged metadata streams.
    methods: [{ name: 'Run', body: null }],
    types: [{ name: 'G`N', namespace: 'T', fieldList: 1, methodList: 1 }],
    imageSize: 0x2000 + total * 16 + 0x8000,
    metadataSize: 0x1400 + total * 12,
    extraRows: new Map([[0x2a, { count: total, bytes: rows }]]),
  }).bytes;
}

// One class listing `count` distinct interfaces. All targets are distinct
// TypeRef rows, so no edge repeats.
function interfaceImplImage(count, { duplicateLast = false } = {}) {
  const total = count + (duplicateLast ? 1 : 0);
  // Keep the TypeRef count below the 2-byte coded-index cutoff (0x4000) so every
  // InterfaceImpl row keeps the ordinary 2-byte Class + 2-byte Interface layout.
  assert.ok(total < 0x4000, 'fixture must stay inside the 2-byte coded index range');
  const rows = new Uint8Array(total * 4);
  const rv = new DataView(rows.buffer);
  for (let i = 0; i < total; i++) {
    rv.setUint16(i * 4 + 0, 2, true);
    // Class implements TypeRef RID (i + 1); the duplicate repeats the first one.
    const rid = duplicateLast && i === total - 1 ? 1 : i + 1;
    rv.setUint16(i * 4 + 2, (rid << 2) | 1, true);
  }
  const typeRefs = new Uint8Array(total * 6);
  const tv = new DataView(typeRefs.buffer);
  for (let i = 0; i < total; i++) tv.setUint16(i * 6 + 2, 1, true);
  return buildCil({
    leadingStrings: ['IR'],
    methods: [{ name: 'Run', body: null }],
    types: [
      { name: 'I', namespace: 'T', fieldList: 1, methodList: 1, flags: 0x81 },
      { name: 'K', namespace: 'T', fieldList: 1, methodList: 1 },
    ],
    imageSize: 0x2000 + total * 16 + 0x8000,
    metadataSize: 0x1400 + total * 12,
    extraRows: new Map([[0x01, { count: total, bytes: typeRefs }], [0x09, { count: total, bytes: rows }]]),
  }).bytes;
}

function medianParseMs(bytes, runs = 5) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    parseCil(bytes);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

// A true Θ(N²) grew ~29x-139x across the 8x row increase on the observed
// hardware; the linear repair stayed at ~6x-11x. 18x separates the two without
// depending on absolute machine speed.
const LINEAR_WORK_RATIO_LIMIT = 18;

test('#8956 a large valid GenericParam table does not cost quadratic duplicate-scan work', () => {
  const small = medianParseMs(genericParamImage(6000));
  const large = medianParseMs(genericParamImage(48000));
  const ratio = large / small;
  assert.ok(
    ratio < LINEAR_WORK_RATIO_LIMIT,
    `8x more valid GenericParam rows cost ${ratio.toFixed(1)}x the time (${small.toFixed(1)} ms -> ${large.toFixed(1)} ms); ` +
    'the per-owner duplicate check must not rescan the numbers already seen',
  );
  assert.ok(large < 20_000, `48,000 valid GenericParam rows took ${large.toFixed(1)} ms`);
});

test('#8956 a large valid InterfaceImpl table does not cost quadratic duplicate-scan work', () => {
  const small = medianParseMs(interfaceImplImage(1500));
  const large = medianParseMs(interfaceImplImage(12000));
  const ratio = large / small;
  assert.ok(
    ratio < LINEAR_WORK_RATIO_LIMIT,
    `8x more valid InterfaceImpl rows cost ${ratio.toFixed(1)}x the time (${small.toFixed(1)} ms -> ${large.toFixed(1)} ms); ` +
    'the per-class duplicate check must not rescan the tokens already seen',
  );
  assert.ok(large < 20_000, `12,000 valid InterfaceImpl rows took ${large.toFixed(1)} ms`);
});

test('#8956 the large valid GenericParam projection stays exact', () => {
  const count = 12000;
  const image = parseCil(genericParamImage(count));
  assert.equal(image.genericParams.length, count);
  assert.deepEqual(
    image.genericParams.map((row) => [row.rid, row.number]),
    Array.from({ length: count }, (_unused, i) => [i + 1, i]),
  );
  assert.equal(image.genericParams[0].token, '0x2a000001');
  assert.equal(image.genericParams[count - 1].token, `0x2a${(count).toString(16).padStart(6, '0')}`);
  // Every row is owned by and bound to the same TypeDef, in parameter order.
  const bound = image.types[0].genericParams;
  assert.equal(bound.length, count);
  assert.ok(bound.every((row) => row.ownerToken === '0x02000001' && row.name === 'TP'));
  assert.deepEqual(bound.map((row) => row.number), Array.from({ length: count }, (_unused, i) => i));
  assert.equal(image.methods[0].genericParams, undefined);
});

test('#8956 the large valid InterfaceImpl projection stays exact and in row order', () => {
  const count = 12000;
  const image = parseCil(interfaceImplImage(count));
  const tokens = image.types[1].interfaceTokens;
  assert.equal(tokens.length, count);
  assert.deepEqual(tokens, Array.from({ length: count }, (_unused, i) => `0x01${(i + 1).toString(16).padStart(6, '0')}`));
  // A class with no InterfaceImpl rows still publishes the empty projection.
  assert.deepEqual(image.types[0].interfaceTokens, []);
});

test('#8956 a duplicated GenericParam number is still rejected after many valid rows', () => {
  const bytes = genericParamImage(4000, { duplicateLast: true });
  assert.throws(() => parseCil(bytes), /cil-unsupported-binary/);
  // Prove the specific fail-closed reason: the duplicate check, not the
  // contiguous-numbering check that would also reject this table.
  assert.throws(
    () => overlayCilMetadata(bytes, parseCilBase(bytes)),
    (error) => error instanceof TypeError && error.message === 'cil-generic-param-number-duplicate',
  );
});

test('#8956 a duplicated InterfaceImpl edge is still rejected after many valid rows', () => {
  const bytes = interfaceImplImage(4000, { duplicateLast: true });
  assert.throws(() => parseCil(bytes), /cil-unsupported-binary/);
  assert.throws(
    () => overlayCilMetadata(bytes, parseCilBase(bytes)),
    (error) => error instanceof TypeError && error.message === 'cil-interfaceimpl-duplicate',
  );
});
