import assert from 'node:assert/strict';
import { createSymmetricCodeFunctionSet } from '../js/diff/symmetric-function-set.js';
import { __symmetricWorkspaceInternalsForTests } from '../js/diff/symmetric-workspace-runtime.js';
import { runDiffInWorker } from '../js/diff/runtime.js';

function registrationRaceSignal() {
  let aborted = false;
  let removals = 0;
  return {
    signal: {
      get aborted() { return aborted; },
      addEventListener(type) {
        assert.equal(type, 'abort');
        // Model the check -> subscribe window: abort happens during listener
        // registration, but the already-fired event is not replayed.
        aborted = true;
      },
      removeEventListener(type) {
        assert.equal(type, 'abort');
        removals++;
      },
    },
    get removals() { return removals; },
  };
}

const symbols = {
  funcs: [0n],
  functionStartsComplete: true,
  nameAt() { return null; },
};
const region = { id: 'text', exec: true, vmAddr: 0n, size: 1n };

{
  const race = registrationRaceSignal();
  let cancelled = 0;
  const request = Promise.reject(new Error('late backend rejection'));
  request.cancel = () => { cancelled++; };
  await assert.rejects(
    createSymmetricCodeFunctionSet({
      backend: { readAt() { return request; } },
      symbols,
      regions: [region],
      architecture: 'arm64',
      signal: race.signal,
    }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(cancelled, 1, 'fingerprint request must be cancelled when registration races with abort');
  assert.equal(race.removals, 1, 'fingerprint abort listener must be cleaned up once');
}

{
  const race = registrationRaceSignal();
  let cancelled = 0;
  const request = Promise.reject(new Error('late baseline rejection'));
  request.cancel = () => { cancelled++; };
  const baseline = {
    symbols: { functionStartsComplete: false, functionCount: 0, addFunctions() {} },
    slice: { regions: [region] },
    backend: { guessFunctions() { return request; } },
  };
  await assert.rejects(
    __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, { signal: race.signal }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(cancelled, 1, 'baseline discovery request must be cancelled on registration race');
  assert.equal(race.removals, 1, 'baseline abort listener must be cleaned up once');
}

{
  const race = registrationRaceSignal();
  let posted = 0;
  let terminated = 0;
  const worker = {
    terminate() { terminated++; },
    postMessage() { posted++; },
  };
  await assert.rejects(
    runDiffInWorker({}, {}, { signal: race.signal, workerFactory: () => worker }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(posted, 0, 'worker diff must not start after a registration-race abort');
  assert.equal(terminated, 1, 'worker diff must terminate the worker on the race');
  assert.equal(race.removals, 1, 'worker abort listener must be cleaned up once');
}

const normal = await createSymmetricCodeFunctionSet({
  backend: { readAt() { return Promise.resolve({ found: true, bytes: new Uint8Array([0]) }); } },
  symbols,
  regions: [region],
  architecture: 'arm64',
});
assert.equal(normal.length, 1, 'non-aborted fingerprinting must still resolve normally');
assert.equal(normal.complete, true);

const preAborted = new AbortController();
preAborted.abort(new Error('pre-aborted'));
await assert.rejects(
  createSymmetricCodeFunctionSet({
    backend: { readAt() { throw new Error('read must not start'); } },
    symbols,
    regions: [region],
    architecture: 'arm64',
    signal: preAborted.signal,
  }),
  /pre-aborted|aborted/i,
);

console.log('issue #4512 diff abort registration race: PASS');
