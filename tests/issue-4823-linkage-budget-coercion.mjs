// Issue #4823 regression: linkage collection budgets were normalized with
// Number(), so numeric strings, Arrays, booleans and plain objects became real
// import/export/global authority (Number(['1']) === 1) and a malformed
// findGlobals limit collapsed global discovery to 0 results. A parsing budget
// is only a primitive finite number; anything else keeps the existing fallback.
import assert from 'node:assert/strict';
import test from 'node:test';

import { SymbolIndex, SYM_STUB } from '../js/symbols.js';
import { ProgramIndex } from '../js/program.js';
import { importList, exportList, findGlobals } from '../js/linkage.js';

const STRUCTURED = ['1', '4000', ['1'], [2], true, false, {}, [], NaN, Infinity, -Infinity];

const THRESHOLDS = ['5', ['5'], [5], '4', ['4'], true, {}, [], Infinity];

function linkageSymbols() {
  return new SymbolIndex({
    funcs: new BigUint64Array([]),
    addrs: new BigUint64Array([0x1000n, 0x1008n, 0x1010n, 0x2000n, 0x2008n, 0x2010n]),
    kinds: new Uint8Array([SYM_STUB, SYM_STUB, SYM_STUB, 0, 0, 0]),
    flags: new Uint8Array([0, 0, 0, 1, 1, 1]),
    names: ['_malloc', '_free', '_open', 'exported_one', 'exported_two', 'exported_three'],
  });
}

const dataRegion = {
  id: 'data', name: '__data', section: '__data', exec: false, read: true, write: true,
  vmAddr: 0x2000n, size: 0x100n, declaredSize: 0x100n,
};

function programWithRefs(refTargets) {
  return new ProgramIndex({
    unsupported: false,
    architecture: 'arm64',
    completeness: { complete: true, reasons: [] },
    refFrom: new BigUint64Array(refTargets.map(() => 0x100n)),
    refTo: new BigUint64Array(refTargets),
    refKind: new Uint8Array(refTargets.length).fill(1),
  }, null, null);
}

test('#4823 structured and non-finite import budgets fall back instead of coercing', () => {
  const symbols = linkageSymbols();
  assert.equal(importList(symbols, null).length, 3);
  assert.equal(importList(symbols, null, 1).length, 1);
  assert.equal(importList(symbols, null, 2).length, 2);
  assert.equal(importList(symbols, null, 0).length, 0);
  for (const bad of STRUCTURED) {
    assert.equal(importList(symbols, null, bad).length, 3, `importList budget ${String(bad)} must fall back to the default`);
  }
});

test('#4823 structured and non-finite export budgets fall back instead of coercing', () => {
  const symbols = linkageSymbols();
  assert.equal(exportList(symbols).length, 3);
  assert.equal(exportList(symbols, 1).length, 1);
  assert.equal(exportList(symbols, 2).length, 2);
  assert.equal(exportList(symbols, 0).length, 0);
  for (const bad of STRUCTURED) {
    assert.equal(exportList(symbols, bad).length, 3, `exportList budget ${String(bad)} must fall back to the default`);
  }
});

test('#4823 malformed global limit never degrades named coverage below the fallback', () => {
  const symbols = linkageSymbols();
  const program = programWithRefs([]);
  assert.equal(findGlobals(symbols, program, [dataRegion], { limit: 1 }).length, 1);
  assert.equal(findGlobals(symbols, program, [dataRegion], { limit: 2 }).length, 2);
  assert.equal(findGlobals(symbols, program, [dataRegion]).length, 3);
  for (const bad of STRUCTURED) {
    assert.equal(findGlobals(symbols, program, [dataRegion], { limit: bad }).length, 3, `findGlobals limit ${String(bad)} must fall back to the default`);
  }
});

test('#4823 malformed global limit does not zero out reference-driven discovery', () => {
  const program = programWithRefs([0x2020n, 0x2020n, 0x2020n]);
  assert.equal(findGlobals(null, program, [dataRegion], { limit: 1, minRefs: 1 }).length, 1);
  assert.equal(findGlobals(null, program, [dataRegion], { minRefs: 1 }).length, 1);
  for (const bad of STRUCTURED) {
    assert.equal(findGlobals(null, program, [dataRegion], { limit: bad }).length, 1, `findGlobals limit ${String(bad)} must not disable discovery`);
  }
});

test('#4823 malformed minRefs stays a fallback threshold', () => {
  const program = programWithRefs([0x2020n, 0x2020n, 0x2020n]);
  assert.equal(findGlobals(null, program, [dataRegion], { minRefs: 1 }).length, 1);
  assert.equal(findGlobals(null, program, [dataRegion], { minRefs: 3 }).length, 1);
  assert.equal(findGlobals(null, program, [dataRegion], { minRefs: 4 }).length, 0);
  assert.equal(findGlobals(null, program, [dataRegion], { minRefs: 2 }).length, 1);
  for (const bad of THRESHOLDS) {
    assert.equal(findGlobals(null, program, [dataRegion], { minRefs: bad }).length, 1, `minRefs ${String(bad)} must fall back to 2`);
  }
});
