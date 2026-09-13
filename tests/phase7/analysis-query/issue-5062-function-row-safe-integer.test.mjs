import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/app-adapter.js';
import { createAnalysisSnapshot } from '../../../js/analysis/query/snapshot.js';

// The ARM64 legacy producer converts BigInt function ranges into JavaScript
// Number row indices. A row index beyond Number.MAX_SAFE_INTEGER silently
// rounds to a neighboring instruction row, so the producer analyzed and
// published a different function than the one requested (#5062). Such ranges
// must fail closed.

function makeApp({ start, end, region, chunks }) {
  return {
    store: {
      get(key) {
        if (key === 'canDisassemble') return true;
        if (key === 'instructionAlignment') return 4;
        if (key === 'architecture') return 'arm64';
        return null;
      },
    },
    backend: {
      binaryId: 'bin-5062',
      async fetchChunk(id, c) { return chunks?.(c) ?? { mn: [], ops: [] }; },
      async readAt() { return { found: false, bytes: null }; },
    },
    symbols: { functionCount: 1, nameAt: () => null },
    executableRegionFor: (addr) => (addr === start ? region : null),
    validatedFunctionRange: (address) => ({
      ok: true, start, end, region, function: { start, end }, complete: true, reason: null, provenance: 'test',
    }),
  };
}

async function produce(app, start) {
  const adapter = createAppAnalysisQueryAdapter(app);
  const snapshot = createAnalysisSnapshot({ binaryId: 'bin-5062' });
  return adapter.functionById(snapshot, start, {});
}

test('a function range beyond the safe-integer row domain fails closed (#5062)', async () => {
  const ROW = 9007199254740993n; // 2^53 + 1
  const START = ROW * 4n;
  const END = START + 4n;
  const region = { id: 'text', vmAddr: 0n, size: 4n * (ROW + 2n), exec: true };
  const result = await produce(makeApp({ start: START, end: END, region }), START);
  assert.equal(result?.status?.completeness, 'unsupported');
  assert.equal(result?.status?.reason, 'function-row-index-unrepresentable');
  assert.equal(result?.value, null);
});

test('an ordinary function range still analyzes the exact requested rows (#5062)', async () => {
  const START = 0x1000n;
  const END = START + 4n;
  const region = { id: 'text', vmAddr: 0n, size: 0x10000n, exec: true };
  const result = await produce(makeApp({
    start: START,
    end: END,
    region,
    chunks: (c) => (c === 0 ? { mn: ['nop'], ops: [''], bytes: ['1f2003d5'] } : { mn: [], ops: [] }),
  }), START);
  assert.equal(result?.status?.completeness, 'complete');
  assert.equal(result?.value?.startAddress, START);
  assert.equal(result?.value?.startAddr, START, 'the analysis must begin at the requested row, not a rounded neighbor');
});
