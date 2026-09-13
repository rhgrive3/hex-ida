// Regression for #4185 (routed query path): the analysis-query adapter's
// `analyzeFunctionAt` replacement applies presentation through
// `applyLegacyPresentation` unconditionally, so a classification/route query
// for a function the user is not viewing overwrote `app.semantic` and, when
// both functions live in the current region, repainted the block overlay with
// the wrong model. Contract now: presentation writes stay bound to the
// currently selected function; the query value itself is still returned.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AnalysisQueryAPI, createAppAnalysisQueryAdapter } from '../../../js/analysis/query/index.js';

const region = Object.freeze({ id: 'issue-4185-text', vmAddr: 0x1000n, size: 0x100n, exec: true });
const FN_A = { start: 0x1000n, end: 0x1010n };
const FN_B = { start: 0x1040n, end: 0x1050n };
const ROW_COUNT = Number(region.size / 4n);

function chunkPage() {
  const mn = new Array(ROW_COUNT).fill('');
  const ops = new Array(ROW_COUNT).fill('');
  for (let row = 0; row <= 3; row++) { mn[row] = 'add'; ops[row] = 'x0, x1, #1'; }
  for (let row = 16; row <= 19; row++) { mn[row] = 'ret'; ops[row] = ''; }
  return { mn, ops };
}

let appSequence = 0;

function createRoutedApp() {
  const state = { selectedRow: 16 };
  const overlays = [];
  const app = {
    store: {
      get(key) {
        return ({
          architecture: 'arm64',
          canDisassemble: true,
          instructionAlignment: 4,
          currentRegion: region,
          regions: [region],
          sliceIndex: 0,
          selectedRow: state.selectedRow,
        })[key] ?? null;
      },
    },
    backend: {
      binaryId: `issue-4185-routed-${appSequence++}`,
      gen: 1,
      async fetchChunk() { return chunkPage(); },
    },
    symbols: {
      functionCount: 2,
      funcs: [FN_A.start, FN_B.start],
      functionAt(address) {
        const a = BigInt(address);
        for (const fn of [FN_A, FN_B]) if (a >= fn.start && a < fn.end) return { start: fn.start, end: fn.end };
        return null;
      },
      nameAt() { return null; },
      label() { return null; },
    },
    validatedFunctionRange(address) {
      const a = BigInt(address);
      const fn = a === FN_A.start ? FN_A : a === FN_B.start ? FN_B : null;
      return fn
        ? { ok: true, start: fn.start, end: fn.end, region, complete: true, provenance: 'issue-4185-test' }
        : { ok: false, reason: 'function-symbol-missing' };
    },
    executableRegionFor(address) {
      const a = BigInt(address);
      return a >= region.vmAddr && a < region.vmAddr + region.size ? region : null;
    },
    viewer: {
      rowAddress(row) { return region.vmAddr + BigInt(row) * 4n; },
      setBlockOverlay(regionId, overlay) { overlays.push({ regionId, overlay }); },
    },
    async analyzeFunctionAt() {
      throw new Error('the routed query path must not call the legacy entry point');
    },
  };
  const api = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
  app.analysisQueries = api;
  return { app, state, overlays };
}

function presentationRows(app) {
  return (app.semantic?.model?.instructions ?? []).map((insn) => insn.row);
}

test('#4185 a routed query for a non-displayed function must not overwrite presentation', async () => {
  const { app, overlays } = createRoutedApp();
  const value = await app.analyzeFunctionAt(FN_A.start);
  assert.ok(value?.model, 'the query still returns A for its own consumer');
  assert.ok(app.semantic == null,
    'a query for a function the user is not viewing must not replace app.semantic');
  assert.equal(overlays.length, 0, 'a query must not repaint the viewer with the non-selected function');
});

test('#4185 a routed query whose function is still selected applies presentation', async () => {
  const { app, state, overlays } = createRoutedApp();
  state.selectedRow = 0;
  const value = await app.analyzeFunctionAt(FN_A.start);
  assert.ok(value?.model, 'the query completes');
  assert.deepEqual(presentationRows(app), [0, 1, 2, 3], 'the selected function keeps its presentation');
  assert.equal(overlays.length, 1);
});
