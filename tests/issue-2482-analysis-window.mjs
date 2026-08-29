/*
 * issue-2482 regression guard: bounded analysis windows.
 *
 * #2458 (issue #2409) stopped getFunctionEnd from falling back to the next
 * function start. That is correct as an extent assertion, but callers that
 * needed an *analysis window* fell back to a blind 512-row span. On binaries
 * without proven extents (battlecats: 0/102852) every window then crossed
 * dozens of functions and the dataflow/origin pipeline went quadratic → OOM.
 *
 * Pinned here:
 *   1. SymbolIndex.nextFunctionStart gives callers a bounded window without
 *      claiming an extent (the #2409 contract stays intact).
 *   2. makePinpointAnalyzer clamps an unproven window to the next function
 *      start (and only falls back to 512 rows for the final function).
 *
 *   node tests/issue-2482-analysis-window.mjs
 */
import assert from 'node:assert/strict';
import { SymbolIndex } from '../js/symbols.js';
import { makePinpointAnalyzer } from '../js/ui/pinpoint-runtime.js';

/* ── 1. nextFunctionStart ──────────────────────────────────────────── */
{
  const region = { id: 'text', vmAddr: 0x1000n, size: 0x2000n, exec: true };
  const symbols = new SymbolIndex({ funcs: new BigUint64Array([0x1000n, 0x1100n, 0x1200n]), regions: [region] });
  assert.equal(symbols.nextFunctionStart(0x1000n), 0x1100n);
  assert.equal(symbols.nextFunctionStart(0x1080n), 0x1100n);
  assert.equal(symbols.nextFunctionStart(0x1100n), 0x1200n);
  assert.equal(symbols.nextFunctionStart(0x1200n), null, 'final function has no next start');
  assert.equal(symbols.nextFunctionStart(0x500n), null, 'below all starts has no floor');
  // The window helper must not change extent assertions (#2409 contract).
  assert.deepEqual(symbols.functionAt(0x1000n), { start: 0x1000n, end: null, index: 0 });
  assert.equal(symbols.functionAt(0x1080n), null, 'next-function-start must not become an extent claim');
}

/* ── 2. pinpoint window clamping ───────────────────────────────────── */
{
  const region = { id: 'text', vmAddr: 0x1000n, size: 0x10000n };
  const symbols = new SymbolIndex({ funcs: new BigUint64Array([0x1000n, 0x1100n, 0x1200n]), regions: [region] });
  const calls = [];
  const app = {
    store: { get: () => true },
    symbols,
    backend: {},
  };
  const analyze = async (_backend, _region, startRow, endRow) => {
    calls.push({ startRow, endRow });
    return { model: {} };
  };
  const analyzer = makePinpointAnalyzer(app, region, null, analyze);
  await analyzer(0x1100n, null);
  assert.deepEqual(calls[0], { startRow: 64, endRow: 127 }, 'unproven window must stop at the next function start');
  await analyzer(0x1200n, null);
  assert.deepEqual(calls[1], { startRow: 128, endRow: 640 }, 'final function keeps the 512-row last-resort window');
  await analyzer(0x1000n, 0x1010n);
  assert.deepEqual(calls[2], { startRow: 0, endRow: 3 }, 'a caller-supplied end must be respected unchanged');
}

console.log('issue-2482 analysis-window regression passed');
