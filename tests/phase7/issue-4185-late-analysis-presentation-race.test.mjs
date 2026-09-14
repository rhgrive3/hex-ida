// Regression for #4185 (legacy path): App.analyzeFunctionAt verified only
// `sliceIndex` and region containment after the awaited analysis, so when
// function A (slow) and function B (fast) were opened back to back, A's late
// resolution overwrote `app.semantic` and the block overlay while the user
// was looking at B. Contract now: a completed analysis may only repaint
// presentation while the selection still sits inside that same function;
// the analysis result itself is still returned to the caller.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { App } from '../../js/app.js';

const region = Object.freeze({ id: 'text', vmAddr: 0x1000n, size: 0x100n, exec: true });
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

function makeApp() {
  const state = { selectedRow: 0 };
  const overlays = [];
  let chunkCalls = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const app = Object.create(App.prototype);
  app.backend = {
    gen: 1,
    binaryId: `issue-4185-race-${appSequence++}`,
    async fetchChunk() {
      chunkCalls += 1;
      if (chunkCalls === 1) await firstGate;
      return chunkPage();
    },
  };
  app.symbols = {
    functionCount: 2,
    funcs: [FN_A.start, FN_B.start],
    functionAt(address) {
      const a = BigInt(address);
      for (const fn of [FN_A, FN_B]) if (a >= fn.start && a < fn.end) return { start: fn.start, end: fn.end };
      return null;
    },
    nameAt() { return null; },
    label() { return null; },
  };
  app.store = {
    get(key) {
      return ({
        architecture: 'arm64',
        canDisassemble: true,
        instructionAlignment: 4,
        sliceIndex: 0,
        currentRegion: region,
        regions: [region],
        selectedRow: state.selectedRow,
      })[key] ?? null;
    },
  };
  app.viewer = {
    rowAddress(row) { return region.vmAddr + BigInt(row) * 4n; },
    setBlockOverlay(regionId) { overlays.push(regionId); },
  };
  app.validatedFunctionRange = (addr) => {
    const a = BigInt(addr);
    const fn = a === FN_A.start ? FN_A : a === FN_B.start ? FN_B : null;
    return fn
      ? { ok: true, start: fn.start, end: fn.end, region, complete: true, reason: null, provenance: 'issue-4185-test' }
      : { ok: false, reason: 'function-symbol-missing' };
  };
  app.executableRegionFor = () => region;
  return { app, state, overlays, releaseFirst };
}

function presentationRows(app) {
  return (app.semantic?.model?.instructions ?? []).map((insn) => insn.row);
}

test('#4185 a late analysis of another function must not repaint the current presentation', async () => {
  const { app, state, overlays, releaseFirst } = makeApp();
  const pendingA = app.analyzeFunctionAt(FN_A.start);

  state.selectedRow = 16;
  const resultB = await app.analyzeFunctionAt(FN_B.start);
  assert.ok(resultB?.model, 'the fast analysis of B completes');
  assert.deepEqual(presentationRows(app), [16, 17, 18, 19], 'B is the presented function');
  assert.equal(overlays.length, 1);

  releaseFirst();
  const resultA = await pendingA;
  assert.ok(resultA?.model, 'the late result is still returned to its own caller');
  assert.deepEqual(presentationRows(app), [16, 17, 18, 19],
    "A's late resolution must not replace the presentation for the function under selection");
  assert.equal(overlays.length, 1, 'the stale A overlay must not be repainted');
});

test('#4185 an analysis whose function is still selected keeps applying presentation', async () => {
  const { app, overlays, releaseFirst } = makeApp();
  const pending = app.analyzeFunctionAt(FN_A.start);
  releaseFirst();
  const result = await pending;
  assert.ok(result?.model, 'analysis completes');
  assert.deepEqual(presentationRows(app), [0, 1, 2, 3], 'precision: the current function still gets its overlay');
  assert.equal(overlays.length, 1);
});
