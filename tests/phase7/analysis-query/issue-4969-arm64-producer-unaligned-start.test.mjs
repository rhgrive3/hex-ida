import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/app-adapter.js';

const region = { id: 'text', exec: true, vmAddr: 0x1000n, size: 0x100n };

function makeApp({ start, end }) {
  const fetchCalls = [];
  const app = {
    store: {
      get(key) {
        if (key === 'architecture') return 'arm64';
        if (key === 'instructionAlignment') return 4;
        if (key === 'canDisassemble') return true;
        return null;
      },
    },
    backend: {
      async fetchChunk(regionId, chunk) {
        fetchCalls.push({ regionId, chunk });
        return { mn: ['ret'], ops: [''], bytes: new Uint8Array([0xc0, 0x03, 0x5f, 0xd6]) };
      },
    },
    symbols: { functionCount: 1, nameAt() { return 'fn'; } },
    validatedFunctionRange() {
      return {
        ok: true, start: BigInt(start), end: BigInt(end), region,
        function: { start: BigInt(start), end: BigInt(end) },
        complete: true, provenance: 'fixture',
      };
    },
  };
  return { app, fetchCalls };
}

test('#4969 unaligned ARM64 function starts fail closed without analyzing the preceding row', async () => {
  for (const start of [0x1001, 0x1002, 0x1003, 0x1005]) {
    const { app, fetchCalls } = makeApp({ start, end: start + 8 });
    const query = createAppAnalysisQueryAdapter(app);
    const result = await query.functionById(null, BigInt(start));
    assert.equal(result.status.completeness, 'unsupported', `start ${start} must be unsupported`);
    assert.equal(result.status.reason, 'arm64-function-start-unaligned');
    assert.deepEqual(fetchCalls, [], `start ${start} must not reach the backend`);
  }
});

test('#4969 aligned ARM64 function starts keep the canonical producer path', async () => {
  const { app, fetchCalls } = makeApp({ start: 0x1004, end: 0x100c });
  const query = createAppAnalysisQueryAdapter(app);
  const result = await query.functionById(null, 0x1004n);
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.value.startAddress, 0x1004n);
  assert.equal(result.value.startRow, 1);
  assert.deepEqual(fetchCalls, [{ regionId: 'text', chunk: 0 }]);
});
