import assert from 'node:assert/strict';
import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/product-adapter.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const region = { id:'text', exec:true };
const gate = deferred();
let discoveryCalls = 0;
const symbols = {
  gen:1,
  funcs:[0x1000n],
  functionStartsComplete:false,
  functionDiscovery:{ complete:false },
  nameAt:() => 'fn_1000',
  functionAt:(address) => ({ start:BigInt(address), end:BigInt(address) + 4n }),
  functionEvidence:() => null,
};
const app = {
  backend:{ gen:7 },
  symbols,
  store:{ get(key) { return key === 'currentRegion' ? region : null; } },
  programRegions:() => [region],
  codeRegion:() => region,
  async ensureFunctions() {
    discoveryCalls++;
    await gate.promise;
    symbols.functionStartsComplete = true;
    symbols.functionDiscovery = { complete:true };
    return symbols;
  },
};

const adapter = createAppAnalysisQueryAdapter(app);
const controllers = Array.from({ length:10 }, () => new AbortController());
const requests = controllers.map((controller) => adapter.functions(
  {},
  {},
  { offset:0, limit:1 },
  { signal:controller.signal },
));

await Promise.resolve();
await Promise.resolve();
assert.equal(discoveryCalls, 1, 'rapid compatible consumers must share one discovery producer');

for (let i = 0; i < 9; i++) controllers[i].abort('superseded-search');
const cancelled = await Promise.allSettled(requests.slice(0, 9));
assert.ok(cancelled.every((item) => item.status === 'rejected' && item.reason?.name === 'AbortError'),
  'superseded consumers must detach promptly with AbortError');
assert.equal(discoveryCalls, 1, 'consumer abort must not restart or cancel the shared producer');

gate.resolve();
const survivor = await requests[9];
assert.equal(survivor.value.length, 1);
assert.equal(survivor.value[0].address, 0x1000n);
assert.equal(discoveryCalls, 1, 'surviving consumer must reuse the original producer');

console.log('issue 2503 function discovery single-flight: PASS');
