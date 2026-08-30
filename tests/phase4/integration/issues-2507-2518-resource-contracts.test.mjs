import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSharedWorkerBinaryIdentity } from '../../../js/analysis/shared-binary-identity.js';
import { InvestigationService } from '../../../js/analysis/investigation-service.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function store(values = {}) {
  return { get:key => values[key] ?? null, set:next => Object.assign(values, next || {}) };
}

async function waitUntil(predicate, turns = 20) {
  for (let i = 0; i < turns; i++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail('condition did not become true');
}

async function testSharedBinaryIdentityConsumers() {
  let started = 0;
  let producerAborts = 0;
  let releaseHash;
  const backend = {
    binaryId:null,
    file:{ size:500 * 1024 * 1024 },
    gen:4,
    ensureContentHash(_progress, signal) {
      started++;
      return new Promise((resolve, reject) => {
        releaseHash = resolve;
        signal?.addEventListener('abort', () => {
          producerAborts++;
          const error = new Error('hash aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once:true });
      });
    },
  };
  installSharedWorkerBinaryIdentity({ backend });

  const a = new AbortController();
  const b = new AbortController();
  const first = backend.ensureBinaryId({ signal:a.signal });
  const second = backend.ensureBinaryId({ signal:b.signal });
  await waitUntil(() => started === 1);
  a.abort('first-consumer-closed');
  await assert.rejects(first, (error) => error?.name === 'AbortError');
  assert.equal(producerAborts, 0, 'one consumer must not cancel a producer still needed by another consumer');
  releaseHash('ab'.repeat(32));
  const binaryId = await second;
  assert.ok(binaryId.includes('ab'.repeat(32)));
  assert.equal(started, 1, 'compatible BinaryId consumers must share one worker hash');

  let lastStarted = 0;
  let lastAborted = 0;
  const lastBackend = {
    binaryId:null,
    file:{ size:1000 * 1024 * 1024 },
    gen:8,
    ensureContentHash(_progress, signal) {
      lastStarted++;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          lastAborted++;
          const error = new Error('hash aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once:true });
      });
    },
  };
  installSharedWorkerBinaryIdentity({ backend:lastBackend });
  const only = new AbortController();
  const pending = lastBackend.ensureBinaryId({ signal:only.signal });
  await waitUntil(() => lastStarted === 1);
  only.abort('last-consumer-closed');
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.equal(lastAborted, 1, 'last consumer departure must cancel the worker hash producer');
}

async function testInvestigationPriorityAndBudget() {
  const priorScheduler = globalThis.scheduler;
  const priorities = [];
  globalThis.scheduler = {
    postTask(fn, options = {}) {
      priorities.push(options.priority);
      if (options.signal?.aborted) {
        const error = new Error('aborted'); error.name = 'AbortError';
        return Promise.reject(error);
      }
      return Promise.resolve().then(fn);
    },
  };
  try {
    const regions = [
      { id:'S', vmAddr:0x1000n, size:4096n, exec:false, cstrings:true, section:'__cstring' },
      { id:'X', vmAddr:0x2000n, size:4096n, exec:true, section:'__text' },
    ];
    let stringParams = null;
    let programLimits = null;
    let discoveryOptions = null;
    const symbols = {
      gen:1, functionStartsComplete:false, functionDiscovery:null,
      get functionCount() { return 0; },
    };
    const app = {
      backend:{
        gen:1,
        strings(params) {
          stringParams = params;
          const request = Promise.resolve({ complete:true, scannedBytes:params.maxBytes, results:[] });
          request.cancel = () => {};
          return request;
        },
        scanProgram(_regionId, _progress, limits) {
          programLimits = limits;
          const request = Promise.resolve({
            regionId:'X', vmAddr:0x2000n, complete:true, completeness:{ complete:true, reasons:[] },
            callCount:0, callFrom:new BigUint64Array(0), callTo:new BigUint64Array(0),
            refCount:0, refFrom:new BigUint64Array(0), refTo:new BigUint64Array(0), refKind:new Uint8Array(0),
            words:0, kinds:new Uint8Array(0), kindsCovered:0,
          });
          request.cancel = () => {};
          return request;
        },
      },
      store:store({ regions, currentRegion:regions[1], sliceIndex:0 }),
      symbols,
      fields:{},
      programRegions:() => [regions[1]],
      codeRegion:() => regions[1],
      ensureFunctions:async (_region, options) => {
        discoveryOptions = options;
        symbols.functionStartsComplete = true;
        return symbols;
      },
      ensureShapes:async () => null,
      viewer:{ setSymbols() {} },
    };
    const service = new InvestigationService(app);
    const budget = {
      strings:{ inputBytes:1024, resultLimit:5, estimatedHeapBytes:2048 },
      program:{ calls:11, refs:13, kindWords:17 },
      pinpoint:7,
    };
    await service.collectStrings({ priority:'background', budget });
    assert.equal(priorities[0], 'background', 'producer start must preserve requested scheduler priority');
    assert.equal(stringParams.maxBytes, 1024, 'explicit string byte budget must reach the backend producer');

    await service.buildProgram({ priority:'user-blocking', budget });
    assert.ok(priorities.includes('user-blocking'), 'interactive Program producer must be scheduled at requested priority');
    assert.deepEqual(programLimits, { callLimit:11, refLimit:13, kindLimit:17 });
    assert.equal(discoveryOptions.priority, 'user-blocking');
    assert.equal(discoveryOptions.budget, budget, 'function discovery must receive the same explicit budget contract');
  } finally {
    if (priorScheduler === undefined) delete globalThis.scheduler;
    else globalThis.scheduler = priorScheduler;
  }
}

function testProductionBootstrapWiring() {
  const ux = source('js/ux.js');
  assert.match(ux, /installDemandDrivenAnalysis\(window\.__app\);[\s\S]*installSharedWorkerBinaryIdentity\(window\.__app\);/,
    'product bootstrap must install ref-counted worker BinaryId ownership after demand runtime');
  const service = source('js/analysis/investigation-service.js');
  assert.match(service, /scheduleProducer\(options, controller\.signal\)/, 'shared Investigation producers must honor scheduler priority');
  assert.match(service, /budgetConfig\(options, 'strings'/, 'Strings must accept the shared budget contract');
  assert.match(service, /budgetConfig\(options, 'program'/, 'Program must accept the shared budget contract');
  assert.match(service, /priority:priorityOf\(options\)[\s\S]*budget:options\.budget/, 'dependency options must propagate priority and budget');
}

await testSharedBinaryIdentityConsumers();
await testInvestigationPriorityAndBudget();
testProductionBootstrapWiring();
console.log('issues-2507-2518-resource-contracts: PASS');
