/*
 * issue-2484 regression guard: bounded analysis windows.
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
 *   node tests/issue-2484-analysis-window.mjs
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

/* ── 1b. functionStartAt: containment without extent claims ─────────── */
{
  const region = { id: 'text', vmAddr: 0x1000n, size: 0x2000n, exec: true };
  const symbols = new SymbolIndex({ funcs: new BigUint64Array([0x1000n, 0x1100n, 0x1200n]), regions: [region] });
  // Mid-function addresses resolve to their owning start even when the end
  // is unproven — this is containment, not the extent assertion #2409 froze.
  assert.equal(symbols.functionStartAt(0x1080n), 0x1000n);
  assert.equal(symbols.functionStartAt(0x1000n), 0x1000n);
  assert.equal(symbols.functionStartAt(0x1180n), 0x1100n);
  assert.equal(symbols.functionStartAt(0x500n), null, 'below all starts has no floor');
  // A proven end still bounds containment.
  const proven = new SymbolIndex({
    funcs: new BigUint64Array([0x1000n, 0x1100n]),
    funcEnds: new BigUint64Array([0x1040n, 0x0n]),
    regions: [region],
  });
  assert.equal(proven.functionStartAt(0x1040n), null, 'past a proven end is not inside that function');
  assert.equal(proven.functionStartAt(0x1020n), 0x1000n);
  // Region gaps still refuse containment (#464): a next start that leaves the
  // start's executable region is no local boundary, so mid-addresses unproven
  // are not owned — exactly the pre-#2458 window rule.
  const gap = new SymbolIndex({
    funcs: new BigUint64Array([0x1000n, 0x5000n]),
    regions: [
      { id: 'text-a', vmAddr: 0x1000n, size: 0x100n, exec: true },
      { id: 'data', vmAddr: 0x2000n, size: 0x1000n, exec: false },
    ],
  });
  assert.equal(gap.functionStartAt(0x1000n), 0x1000n, 'exact start is always owned');
  assert.equal(gap.functionStartAt(0x1080n), null, 'next start across a gap is no boundary');
  // A next start inside the same region is a real boundary, so mid-addresses
  // up to it are owned (this is what made #2484 formula resolve again).
  const bounded = new SymbolIndex({
    funcs: new BigUint64Array([0x1000n, 0x10C0n]),
    regions: [{ id: 'text-a', vmAddr: 0x1000n, size: 0x1000n, exec: true }],
  });
  assert.equal(bounded.functionStartAt(0x1080n), 0x1000n);
}

/* ── 1c. ProgramIndex callers resolve through functionStartOf ───────── */
{
  const { ProgramIndex } = await import('../js/program.js');
  const region = { id: 'text', vmAddr: 0x1000n, size: 0x2000n, exec: true };
  const symbols = new SymbolIndex({ funcs: new BigUint64Array([0x1000n, 0x1100n]), regions: [region] });
  const program = new ProgramIndex({
    vmAddr: region.vmAddr, words: Number(region.size / 4n), kindsCovered: 0,
    kinds: new Uint8Array(0),
    callFrom: new BigUint64Array([0x1080n]), callTo: new BigUint64Array([0x1100n]),
    refFrom: new BigUint64Array([0x1084n]), refTo: new BigUint64Array([0x9000n]),
    refKind: new Uint8Array([1]),
  }, symbols, region);
  // A call/ref site mid-function (end unproven) must still name its caller.
  assert.equal(program.functionStartOf(0x1080n), 0x1000n,
    'reference owners must resolve without an extent claim (this made #2484 formula null)');
  const refs = program.functionsReferencing(0x9000n, 1n, 8);
  assert.equal(refs[0].addr, 0x1000n, 'functionsReferencing must resolve the owning start');
  assert.equal(refs[0].site, 0x1084n, 'the raw site is still reported for audit');
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

console.log('issue-2484 analysis-window regression passed');
