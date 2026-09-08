// Regression for #5402: analyzeFunction() started the backend fetchChunk
// operation BEFORE awaitAbortable() attempted listener registration, so a
// truthy malformed signal ({aborted:false}) produced a raw TypeError after the
// operation had begun — operation.cancel() was unreachable and the analysis
// request kept running.
// Contract now: AbortSignal compatibility is input validation at the entry
// point (canonical analysisAbortSignalMethods, same error as the cached
// variant and the shared producer-wait boundary, #3646/#5395 pattern), before
// any backend work.
import assert from 'node:assert/strict';
import { analyzeFunction, analyzeFunctionCached } from '../js/analyze.js';

const region = { id: 'r1', exec: true, vmAddr: 0x1000n, size: 0x100n };

function countingBackend() {
  const state = { started: 0, cancelled: 0 };
  state.backend = {
    fetchChunk() {
      state.started++;
      return { cancel() { state.cancelled++; } };
    },
  };
  return state;
}
const MALFORMED = [
  ['truthy object without listener methods', { aborted: false }],
  ['boolean true', true],
  ['string', 'signal'],
  ['number', 1],
];

for (const [label, signal] of MALFORMED) {
  // 1. analyzeFunction rejects before any backend operation starts.
  {
    const state = countingBackend(); const backend = state.backend;
    await assert.rejects(
      () => analyzeFunction(backend, region, 0, 10, null, null, { signal }),
      (error) => {
        assert.equal(error instanceof TypeError, true, `${label}: expected TypeError, got ${error.constructor.name}: ${error.message}`);
        assert.equal(error.message, 'analysis-invalid-abort-signal', `${label}: canonical error expected`);
        return true;
      },
      `analyzeFunction must reject a malformed signal (${label})`,
    );
    assert.equal(state.started, 0, `${label}: no backend operation may start`);
    assert.equal(state.cancelled, 0);
  }

  // 2. The cached variant shares the same entry validation.
  await assert.rejects(
    () => analyzeFunctionCached(countingBackend().backend, region, 0, 10, null, null, { signal }),
    /analysis-invalid-abort-signal/,
    `analyzeFunctionCached must reject a malformed signal (${label})`,
  );
}

// 3. Real AbortSignals keep working end to end.
{
  const state = countingBackend(); const backend = state.backend;
  const controller = new AbortController();
  const result = await analyzeFunction(backend, region, 0, 10, null, null, { signal: controller.signal });
  assert.ok(result, 'analysis completes with a real signal');
  assert.equal(state.started >= 1, true, 'the backend was reached');
}

// 4. Omitted signal keeps the unabortable path.
{
  const state = countingBackend(); const backend = state.backend;
  backend.fetchChunk = () => ({ cancel() { state.cancelled++; }, rows: [], complete: true });
  const result = await analyzeFunction(backend, region, 0, 10, null, null, {});
  assert.ok(result, 'analysis completes without a signal');
}

console.log('issue-5402 analysis signal validated before operation start: ok');
