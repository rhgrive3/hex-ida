import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installDemandDrivenAnalysis } from '../js/analysis/demand-driven-runtime.js';

// #6111: waitForShared must attach producer observers before the
// post-registration abort recheck cancels the producer.
{
  const source = fs.readFileSync(new URL('../js/analysis/demand-driven-runtime.js', import.meta.url), 'utf8');
  const start = source.indexOf('function waitForShared(entry, signal)');
  const end = source.indexOf('function mergeMapCounts', start);
  const wait = source.slice(start, end);
  const attachAt = wait.indexOf('entry.promise.then');
  const recheckAt = wait.indexOf('if (signal?.aborted && !settled) onAbort();');
  assert.ok(attachAt !== -1 && recheckAt !== -1 && attachAt < recheckAt, 'observer must precede recheck');
}

function makeRaceSignal(reason) {
  let aborted = false;
  return {
    get aborted() { return aborted; },
    get reason() { return aborted ? reason : undefined; },
    addEventListener() { aborted = true; },
    removeEventListener() {},
  };
}

{
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const app = {
      backend: {
        gen: 1,
        async guessFunctions() {
          let rejectFn;
          const pending = new Promise((_, reject) => { rejectFn = reject; });
          pending.cancel = () => rejectFn(new Error('producer aborted'));
          return pending;
        },
      },
      symbols: { functionStartsComplete: false, functionCount: 0, addFunctions() {} },
      symbolsReady: Promise.resolve(),
      programRegions: () => [{ id: 'r1', exec: true, size: 0x1000n, vmAddr: 0x1000n }],
      viewer: {},
    };
    installDemandDrivenAnalysis(app);
    const reason = Object.assign(new Error('consumer abort'), { name: 'AbortError' });
    await assert.rejects(app.ensureFunctions(null, { signal: makeRaceSignal(reason) }), (e) => e === reason);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(unhandled.length, 0, `race cancel must not leave unhandled rejection: ${unhandled.map((e) => e?.message)}`);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
}

{
  const app = {
    backend: {
      gen: 2,
      async guessFunctions() {
        return { starts: [], discoveryComplete: true };
      },
    },
    symbols: {
      functionStartsComplete: false,
      functionCount: 0,
      addFunctions() {},
      functionDiscovery: undefined,
    },
    symbolsReady: Promise.resolve(),
    programRegions: () => [{ id: 'r1', exec: true, size: 0x1000n, vmAddr: 0x1000n }],
    viewer: { setSymbols() {} },
  };
  installDemandDrivenAnalysis(app);
  const controller = new AbortController();
  const result = await app.ensureFunctions(null, { signal: controller.signal });
  assert.ok(result);
}

console.log('issue-6111: PASS');
