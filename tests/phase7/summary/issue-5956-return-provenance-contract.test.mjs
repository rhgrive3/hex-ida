import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/app-adapter.js';
import { installDemandDrivenAnalysis } from '../../../js/analysis/demand-driven-runtime.js';

// Issue 5991: callees() scans only the validated function range. When the
// function extent itself is unproven (analysis window or region clip), the
// scan cannot be complete no matter how the local scan ended.

const region = { id: 'text', vmAddr: 0x1000n, size: 0x1000n, exec: true };

function scanForRegion() {
  return {
    regionId: 'text',
    vmAddr: 0x1000n,
    complete: true,
    callCount: 1,
    callFrom: BigUint64Array.of(0x1010n),
    callTo: BigUint64Array.of(0x2000n),
    refCount: 0,
    refFrom: BigUint64Array.of(),
    refTo: BigUint64Array.of(),
    refKind: Uint8Array.of(),
    words: 0,
    kinds: new Uint8Array(0),
    kindsCovered: 0,
  };
}

function makeApp({ rangeComplete, rangeReason, fnEnd = null }) {
  const calleesPage = [{ addr: 0x2000n, site: 0x1010n, count: 1 }];
  Object.defineProperty(calleesPage, 'complete', { value: true });
  Object.defineProperty(calleesPage, 'queryLimited', { value: false });
  return {
    store: { get: (key) => (key === 'regions' ? [region] : key === 'architecture' ? 'arm64' : null), currentRegion: region },
    backend: {
      gen: 0,
      formatId: 'elf',
      binaryId: 'bin-5991',
      scanProgram() { return scanForRegion(); },
    },
    analysisEpoch: 0,
    projectRevision: 0,
    symbols: {
      gen: 0,
      funcs: [0x1000n],
      functionStartsComplete: true,
      functionCount: 1,
      nameAt() { return 'fn'; },
      functionAt(addr) { return { start: addr, end: fnEnd }; },
    },
    programRegions() { return [region]; },
    executableRegionFor(addr) { return addr >= 0x1000n && addr < 0x2000n ? region : null; },
    validatedFunctionRange(addr) {
      return {
        ok: true, start: 0x1000n, end: 0x1100n, region,
        function: { start: 0x1000n, end: fnEnd },
        complete: rangeComplete,
        reason: rangeReason,
        provenance: rangeComplete ? 'executable-region+proven-function-extent' : 'executable-region+analysis-window',
      };
    },
    ensureProgram: async () => ({
      calleesOf(_start, _end, cap) { return calleesPage.slice(0, Math.min(cap, calleesPage.length)); },
    }),
  };
}

test('5991: demand callees stay partial while the function end is unproven', async () => {
  const app = makeApp({ rangeComplete: false, rangeReason: 'function-end-unproven', fnEnd: null });
  installDemandDrivenAnalysis(app);
  const snapshot = await app.analysisQueries.snapshot();
  const result = await app.analysisQueries.callees(snapshot, 0x1000n, {}, {});
  assert.equal(result.status.completeness, 'partial',
    'a complete local scan cannot prove callees of an unproven function extent');
  assert.equal(result.status.reason, 'function-end-unproven');
  assert.equal(result.value.length, 1, 'the discovered callee is still served');
});

test('5991: demand callees stay partial when the symbol range is region-clipped', async () => {
  const app = makeApp({ rangeComplete: false, rangeReason: 'symbol-range-crosses-executable-region', fnEnd: 0x1800n });
  installDemandDrivenAnalysis(app);
  const snapshot = await app.analysisQueries.snapshot();
  const result = await app.analysisQueries.callees(snapshot, 0x1000n, {}, {});
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.reason, 'symbol-range-crosses-executable-region');
});

test('5991: demand callees stay complete for a proven function extent', async () => {
  const app = makeApp({ rangeComplete: true, rangeReason: null, fnEnd: 0x1100n });
  installDemandDrivenAnalysis(app);
  const snapshot = await app.analysisQueries.snapshot();
  const result = await app.analysisQueries.callees(snapshot, 0x1000n, {}, {});
  assert.equal(result.status.completeness, 'complete');
});

test('5991: the base adapter callees keeps the same range-completeness rule', async () => {
  const adapter = createAppAnalysisQueryAdapter(makeApp({
    rangeComplete: false, rangeReason: 'function-end-unproven', fnEnd: null,
  }));
  const result = await adapter.callees(null, 0x1000n, {}, {});
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.reason, 'function-end-unproven');
});
