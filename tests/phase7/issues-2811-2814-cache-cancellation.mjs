import assert from 'node:assert/strict';
import { InvestigationService } from '../../js/analysis/investigation-service.js';
import { __demandDrivenInternalsForTests } from '../../js/analysis/demand-driven-runtime.js';

// #2811: a partial low-budget string scan must not poison the epoch cache.
{
  let calls = 0;
  const region = { id:'r', size:100n, section:'__cstring', cstrings:true };
  const app = {
    backend:{ gen:1, strings:async({ maxBytes }) => { calls++; return { complete:maxBytes >= 100, scannedBytes:maxBytes, results:[{ addr:1n, text:'abc' }] }; } },
    store:{ get(key) { if (key === 'regions') return [region]; if (key === 'currentRegion') return region; return null; } },
  };
  const service = new InvestigationService(app);
  const partial = await service.collectStrings({ budget:{ strings:{ inputBytes:1, resultLimit:10, estimatedHeapBytes:10000 } } });
  assert.equal(partial.complete, false);
  assert.equal(app.stringIndex, undefined);
  const complete = await service.collectStrings();
  assert.equal(complete.complete, true);
  assert.equal(calls, 2);
  assert.equal(app.stringIndex, complete);
}

// #2814: aborting one waiter must not cancel the shared BinaryId producer while another waiter remains.
{
  let resolveHash, producerSignal;
  const backend = {
    file:{ name:'x' }, gen:1,
    ensureContentHash(_progress, signal) {
      producerSignal = signal;
      return new Promise((resolve, reject) => {
        resolveHash = resolve;
        signal.addEventListener('abort', () => reject(Object.assign(new Error('hash aborted'), { name:'AbortError' })), { once:true });
      });
    },
  };
  __demandDrivenInternalsForTests.installWorkerBackedIdentity({ backend });
  const a = new AbortController();
  const b = new AbortController();
  const first = backend.ensureBinaryId({ signal:a.signal });
  const second = backend.ensureBinaryId({ signal:b.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  a.abort('consumer-a-left');
  await assert.rejects(first, (error) => error?.name === 'AbortError');
  assert.equal(producerSignal.aborted, false);
  resolveHash('a'.repeat(64));
  assert.equal(typeof await second, 'string');
}

console.log('issues 2811/2814 cache cancellation: PASS');
