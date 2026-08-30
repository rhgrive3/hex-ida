import { performance } from 'node:perf_hooks';
import { __demandDrivenInternalsForTests as demand } from '../../js/analysis/demand-driven-runtime.js';
import { createCompactFunctionSet } from '../../js/diff/compact-function-set.js';

export function runClosureAuditBenchmark() {
  const regions = Array.from({ length:512 }, (_, index) => ({
    id:`R${index}`,
    exec:true,
    vmAddr:BigInt(index) * 0x400000n,
    size:0x400000n,
  }));
  const values = new Map([['regions',regions], ['currentRegion',regions[1]]]);
  const app = {
    store:{ get:(key) => values.get(key) },
    programRegions:() => regions,
    executableRegionFor:(address) => regions.find((region) => address >= region.vmAddr && address < region.vmAddr + region.size),
  };
  const target = regions[400].vmAddr + 64n;
  const q0 = performance.now();
  const outgoing = demand.localRegionPlan(app, target, 'callees');
  const incoming = demand.localRegionPlan(app, target, 'xrefs');
  const q1 = performance.now();

  const f0 = performance.now();
  const funcs = Array.from({ length:350000 }, (_, index) => BigInt(index * 4));
  const f1 = performance.now();
  const compact = createCompactFunctionSet({ funcs, addrs:funcs, names:[], functionStartsComplete:true }, 'arm64', 350000);
  const f2 = performance.now();

  return Object.freeze({
    localQuery:Object.freeze({
      totalRegions:regions.length,
      totalExecutableBytes:regions.length * 4 * 1024 * 1024,
      calleesRegionsBeforeFirstPage:outgoing.local.length,
      xrefsRegionsBeforeFirstPage:incoming.local.length,
      xrefsUnscannedRegions:incoming.unscanned.length,
      planningMs:q1 - q0,
    }),
    recognition:Object.freeze({
      denominatorFunctions:funcs.length,
      corpusMaterializationMs:f1 - f0,
      ordinaryOpenRecognitionStarts:0,
      policy:'whole-binary recognition is explicit-consumer/background work, not applySlice work',
    }),
    binaryIdentity:Object.freeze({
      fixtureSizes:[100,500,1024].map((m) => m * 1024 * 1024),
      policy:'verified full-content digest remains platform-worker owned; no main-realm SHA-256 fallback',
    }),
    diffBaseline:Object.freeze({
      denominatorFunctions:compact.count,
      mainRealmFunctionObjectsAllocated:Object.prototype.hasOwnProperty.call(compact, 'functions') ? compact.functions.length : 0,
      compactDescriptorMs:f2 - f1,
      policy:'route/request cancellation owns baseline backend lifetime',
    }),
  });
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  console.log(JSON.stringify(runClosureAuditBenchmark(), null, 2));
}
