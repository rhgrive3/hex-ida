/*
 * Invariant 3 — same-address symbol identity must not depend on raw input
 * order.
 *
 * Fixture: one ELF64 AArch64 image whose symbol table puts a local STT_NOTYPE
 * zero-sized mapping marker and a local STT_FUNC symbol with a real size at the
 * same address, in both orders. The full path is exercised:
 *   parseELF -> analysisFromBinaryImage -> SymbolIndex.
 *
 * The canonical identity (name, kind, function start, provenance) must be the
 * same for both inputs, and it must be the real function that owns the address.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseELF } from '../../js/binary/elf.js';
import { analysisFromBinaryImage } from '../../js/platform/analysis-result.js';
import { SymbolIndex } from '../../js/symbols.js';
import {
  SYMBOL_ADDRESS,
  SYMBOL_FUNCTION_SIZE,
  aarch64SymbolRecords,
  buildAarch64Elf,
} from './invariant-fixtures.mjs';

const REAL_FUNCTION_NAME = 'synthetic_tick_core';
const MAPPING_MARKER_NAME = '$x';
const ORDINARY_ADDRESS = SYMBOL_ADDRESS + 0x40n;
const ORDINARY_NAME = 'synthetic_ordinary_symbol';

const text = (value) => (value == null ? null : String(value));

function analyze(order, extraRecords = []) {
  const image = parseELF(buildAarch64Elf([...aarch64SymbolRecords(order), ...extraRecords]));
  const analysis = analysisFromBinaryImage(image);
  const index = new SymbolIndex(analysis);
  return { image, analysis, index };
}

function canonicalIdentity({ analysis, index }) {
  const located = index.functionAt(SYMBOL_ADDRESS);
  return {
    addrs: Array.from(analysis.addrs, text),
    names: [...analysis.names],
    kinds: Array.from(analysis.kinds),
    flags: Array.from(analysis.flags),
    funcs: Array.from(analysis.funcs, text),
    funcEnds: Array.from(analysis.funcEnds, text),
    symbolCount: analysis.symbolCount,
    funcCount: analysis.funcCount,
    nameAt: index.nameAt(SYMBOL_ADDRESS),
    isFunctionStart: index.isFunctionStart(SYMBOL_ADDRESS),
    functionAt: located == null ? null : { start: text(located.start), end: text(located.end), index: located.index },
    nameEvidence: index.nameEvidence(SYMBOL_ADDRESS),
    functionEvidence: index.functionEvidence(SYMBOL_ADDRESS),
  };
}

/* ── Controls: each record alone stays intact ───────────────────────────── */

test('control: a mapping marker alone keeps its own address identity', () => {
  const { analysis, index } = analyze('marker-only');

  assert.equal(index.nameAt(SYMBOL_ADDRESS), MAPPING_MARKER_NAME,
    'a lone mapping marker keeps its own name at its address');
  assert.equal(index.isFunctionStart(SYMBOL_ADDRESS), false,
    'a zero-sized mapping marker is not a function start');
  assert.equal(analysis.funcCount, 0, 'a mapping marker must not mint a function start');
});

test('control: a real function symbol alone keeps its name, start and extent', () => {
  const { analysis, image, index } = analyze('function-only');

  assert.equal(index.nameAt(SYMBOL_ADDRESS), REAL_FUNCTION_NAME, 'the real function owns its address');
  assert.equal(index.isFunctionStart(SYMBOL_ADDRESS), true, 'the real function symbol is a function start');
  const located = index.functionAt(SYMBOL_ADDRESS);
  assert.equal(text(located?.end), text(SYMBOL_ADDRESS + SYMBOL_FUNCTION_SIZE),
    'the real function extent must survive into the symbol index');
  assert.equal(index.functionEvidence(SYMBOL_ADDRESS)?.source, 'symbol',
    'the exact function-start evidence must be the symbol itself');
  assert.ok(Array.from(analysis.funcs).includes(SYMBOL_ADDRESS), 'the function start must be indexed');
  assert.equal(image.metadata?.aarch64MappingSymbols?.evidence, 'missing',
    'a function-only fixture has no mapping-symbol evidence');
});

test('control: an ordinary symbol at another address is unaffected by the same-address pair', () => {
  const ordinary = { name: ORDINARY_NAME, info: 0x12, value: ORDINARY_ADDRESS, size: 8n };
  for (const order of ['marker-first', 'function-first']) {
    const { index } = analyze(order, [ordinary]);
    assert.equal(index.nameAt(ORDINARY_ADDRESS), ORDINARY_NAME,
      `${order}: an unrelated ordinary symbol keeps its name`);
    assert.equal(index.isFunctionStart(ORDINARY_ADDRESS), true,
      `${order}: an unrelated ordinary function keeps its start`);
  }
});

/* ── The invariant: identity is order-independent ───────────────────────── */

test('same-address canonical identity is identical for both raw symbol orders', () => {
  const markerFirst = canonicalIdentity(analyze('marker-first'));
  const functionFirst = canonicalIdentity(analyze('function-first'));

  assert.deepEqual(markerFirst, functionFirst,
    'the canonical identity of a same-address symbol set must not depend on raw input order');
});

test('a zero-sized local NOTYPE marker never outranks a real local function at the same address', () => {
  for (const order of ['marker-first', 'function-first']) {
    const { index } = analyze(order);
    assert.equal(index.nameAt(SYMBOL_ADDRESS), REAL_FUNCTION_NAME,
      `${order}: the real function must own the shared address, not the mapping marker`);
    assert.notEqual(index.nameAt(SYMBOL_ADDRESS), MAPPING_MARKER_NAME,
      `${order}: a mapping marker must never be published as the function name`);
  }
});

test('the real function start and extent survive in both orders', () => {
  for (const order of ['marker-first', 'function-first']) {
    const { analysis, index } = analyze(order);
    assert.equal(index.isFunctionStart(SYMBOL_ADDRESS), true, `${order}: function start must be indexed`);
    assert.ok(Array.from(analysis.funcs).includes(SYMBOL_ADDRESS), `${order}: funcs must carry the start`);
    assert.equal(index.functionEvidence(SYMBOL_ADDRESS)?.source, 'symbol',
      `${order}: the function start must keep its symbol-backed provenance`);
    assert.equal(text(index.functionAt(SYMBOL_ADDRESS)?.end), text(SYMBOL_ADDRESS + SYMBOL_FUNCTION_SIZE),
      `${order}: the function extent must survive the same-address merge`);
  }
});

test('mapping-symbol metadata is preserved next to the canonical function identity', () => {
  for (const order of ['marker-first', 'function-first']) {
    const { image } = analyze(order);
    const mappings = image.metadata?.aarch64MappingSymbols;
    assert.equal(mappings?.evidence, 'mapping-symbol', `${order}: mapping evidence must remain published`);
    assert.equal(mappings.mappings.length, 1, `${order}: exactly one mapping marker is present`);
    assert.equal(mappings.mappings[0].name, MAPPING_MARKER_NAME, `${order}: the marker keeps its name`);
    assert.equal(mappings.mappings[0].kind, 'instruction', `${order}: the marker keeps its kind`);
    assert.equal(text(mappings.mappings[0].address), text(SYMBOL_ADDRESS), `${order}: the marker keeps its address`);

    const markerRecord = image.symbols.find((symbol) => symbol.name === MAPPING_MARKER_NAME);
    assert.ok(markerRecord, `${order}: the raw mapping marker record must not be consumed`);
    assert.equal(markerRecord.kind, 'type-0', `${order}: the marker keeps STT_NOTYPE identity`);
    assert.equal(markerRecord.size, 0n, `${order}: the marker keeps its zero size`);
    const functionRecord = image.symbols.find((symbol) => symbol.name === REAL_FUNCTION_NAME);
    assert.equal(functionRecord?.kind, 'function', `${order}: the function keeps STT_FUNC identity`);
    assert.equal(functionRecord?.size, SYMBOL_FUNCTION_SIZE, `${order}: the function keeps its size`);
  }
});
