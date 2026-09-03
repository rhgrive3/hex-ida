import assert from 'node:assert/strict';
import { fieldAccessRegion, fieldAccessAcrossExecutableRegions } from '../js/analysis/field-access-artifact.js';
import { InvestigationService, __investigationInternalsForTests } from '../js/analysis/investigation-service.js';
import { STRING_SCAN_BUDGET } from '../js/string-budget.js';
import { PROGRAM_MERGE_LIMITS } from '../js/program.js';

const { budgetConfig, captureAnalysisBinding, analysisBindingCurrent, completenessFor } = __investigationInternalsForTests;

// --- Test 1: #3984 FieldAccessArtifact unsupported:true fail-closed ---
{
  const backend = {
    fieldAccess() {
      return Promise.resolve({ results: [], unsupported: true });
    },
  };
  const region = { id: 'text1' };
  const res = await fieldAccessRegion(backend, region, 0x10, 4);
  assert.equal(res.complete, false, '#3984: unsupported:true must yield complete=false');
  assert.equal(res.reason, 'field-access-unsupported', '#3984: reason must be field-access-unsupported');

  // completeness undeclared
  const backend2 = {
    fieldAccess() {
      return Promise.resolve({ results: [] });
    },
  };
  const res2 = await fieldAccessRegion(backend2, region, 0x10, 4);
  assert.equal(res2.complete, false, '#3984: undeclared completeness must fail closed');

  // normal complete
  const backend3 = {
    fieldAccess() {
      return Promise.resolve({ results: [{ offset: 0x10 }], complete: true });
    },
  };
  const res3 = await fieldAccessRegion(backend3, region, 0x10, 4);
  assert.equal(res3.complete, true, '#3984: explicit complete:true is preserved');

  // Multi-region aggregation with unsupported region
  const app = {
    store: {
      get(k) {
        if (k === 'regions') {
          return [
            { id: 'r1', exec: true, size: 0x1000 },
            { id: 'r2', exec: true, size: 0x1000 },
          ];
        }
        return null;
      },
    },
    backend: {
      fieldAccess({ regionId }) {
        if (regionId === 'r1') return Promise.resolve({ results: [{ offset: 0 }], complete: true });
        return Promise.resolve({ results: [], unsupported: true });
      },
    },
  };
  const agg = await fieldAccessAcrossExecutableRegions(app, 0, 4);
  assert.equal(agg.complete, false, '#3984: multi-region with unsupported source must not be complete');
  assert.equal(agg.reason, 'field-access-unsupported');
  console.log('✔ #3984 FieldAccessArtifact unsupported:true fail-closed passed');
}

// --- Test 2: #4765 & #4785 InvestigationService shared producer lifecycle & cancellation ---
{
  const app = {
    backend: { gen: 1 },
    store: { get: () => null },
    programRegions: () => [{ id: 'r1', exec: true, size: 100, cstrings: true }],
    stringIndex: null,
  };
  const service = new InvestigationService(app);

  // #4785: pre-aborted caller before entry creation
  const preAborted = AbortSignal.abort(new Error('pre-aborted'));
  await assert.rejects(
    async () => service.collectStrings({ signal: preAborted }),
    (err) => err.name === 'AbortError' || err.message === 'pre-aborted'
  );
  assert.equal(service.shared.size, 0, '#4785: pre-aborted caller must not create entry');

  // #4765: sole waiter aborts, new consumer immediately requests same key
  let producerResolve;
  const mockApp = {
    backend: {
      gen: 1,
      scanStrings: () => new Promise((resolve) => { producerResolve = resolve; }),
    },
    store: { get: () => null },
    programRegions: () => [{ id: 'r1', exec: true, size: 100, cstrings: true }],
  };
  const service2 = new InvestigationService(mockApp);
  const c1 = new AbortController();
  const p1 = service2.collectStrings({ signal: c1.signal });
  // c1 is now the sole waiter on this shared entry
  c1.abort('cancel-c1');
  await assert.rejects(p1, (err) => err.name === 'AbortError' || err.message === 'cancel-c1');

  // Immediately attach new consumer c2 for same key
  const c2 = new AbortController();
  let completed2 = false;
  mockApp.backend.scanStrings = () => Promise.resolve({ results: [], complete: true, scannedBytes: 100 });
  const p2 = service2.collectStrings({ signal: c2.signal }).then((res) => {
    completed2 = true;
    return res;
  });
  const res2 = await p2;
  assert.equal(completed2, true, '#4765: new consumer must succeed with fresh producer instead of reusing aborted entry');
  console.log('✔ #4765 & #4785 InvestigationService shared cancellation & fresh retry passed');
}

// --- Test 3: #4196 & #4191 callback-only ensureFunctions and ensureShapes progress compatibility ---
{
  let ensureFunctionsProgressDelivered = false;
  let ensureShapesProgressDelivered = false;
  let callerProgressFromFunctions = false;
  let callerProgressFromShapes = false;

  const app = {
    backend: { gen: 1 },
    symbols: { gen: 1 },
    codeRegion: () => ({ id: 'r1', exec: true, size: 100 }),
    store: { get: () => null },
    async ensureFunctions(region, onProgress) {
      assert.equal(typeof onProgress, 'function', 'ensureFunctions arg 2 must be callable');
      onProgress({ done: 1, all: 2 });
      ensureFunctionsProgressDelivered = true;
      return this.symbols;
    },
    async ensureShapes(onProgress) {
      assert.equal(typeof onProgress, 'function', 'ensureShapes arg 1 must be callable');
      onProgress({ done: 1, all: 2 });
      ensureShapesProgressDelivered = true;
      return { complete: true };
    },
  };

  const service = new InvestigationService(app);
  await service.discoverFunctions({
    onProgress: (p) => { callerProgressFromFunctions = true; },
  });
  assert.equal(ensureFunctionsProgressDelivered, true, '#4196: ensureFunctions received progress call without TypeError');
  assert.equal(callerProgressFromFunctions, true, '#4196: caller received progress event');

  await service.collectShapes({
    onProgress: (p) => { callerProgressFromShapes = true; },
  });
  assert.equal(ensureShapesProgressDelivered, true, '#4191: ensureShapes received progress call without TypeError');
  assert.equal(callerProgressFromShapes, true, '#4191: caller received shape progress event');
  console.log('✔ #4196 & #4191 ensureFunctions and ensureShapes callable progress passed');
}

// --- Test 4: #3490 metadata producer failure in completenessFor ---
{
  const resultComplete = completenessFor({
    strings: { complete: true },
    program: { graphCompleteness: { complete: true } },
    shapes: { complete: true },
    metadata: { complete: true },
    goal: { id: 'hp', expects: { numeric: true } },
  });
  assert.equal(resultComplete.complete, true, '#3490: all complete should be complete');

  const resultIncomplete = completenessFor({
    strings: { complete: true },
    program: { graphCompleteness: { complete: true } },
    shapes: { complete: true },
    metadata: { complete: false, reasons: ['objc-metadata-failed'] },
    goal: { id: 'hp', expects: { numeric: true } },
  });
  assert.equal(resultIncomplete.complete, false, '#3490: metadata failure must yield complete=false for shape-needed goal');
  assert.ok(resultIncomplete.reasons.includes('objc-metadata-failed'), '#3490: metadata reason must be retained');
  console.log('✔ #3490 metadata failure propagation passed');
}

// --- Test 5: #3657 boundedBudget coercion rejection ---
{
  const config = budgetConfig({
    budget: {
      strings: {
        inputBytes: ['1024'],
        resultLimit: true,
        estimatedHeapBytes: '2048',
      },
    },
  }, 'strings', STRING_SCAN_BUDGET);

  assert.equal(config.inputBytes, STRING_SCAN_BUDGET.inputBytes, '#3657: array inputBytes must fallback to default');
  assert.equal(config.resultLimit, STRING_SCAN_BUDGET.resultLimit, '#3657: boolean resultLimit must fallback to default');
  assert.equal(config.estimatedHeapBytes, STRING_SCAN_BUDGET.estimatedHeapBytes, '#3657: string heapBytes must fallback to default');

  const validConfig = budgetConfig({
    budget: {
      strings: {
        inputBytes: 5000,
        resultLimit: 10,
      },
    },
  }, 'strings', STRING_SCAN_BUDGET);
  assert.equal(validConfig.inputBytes, 5000, '#3657: safe number must be accepted');
  assert.equal(validConfig.resultLimit, 10, '#3657: safe number must be accepted');
  console.log('✔ #3657 budgetConfig strict numeric authority passed');
}

// --- Test 6: #4363 analysisBindingCurrent strict integer validation ---
{
  let slice = 1;
  const symbols = { gen: 1 };
  const app = {
    backend: { gen: 1 },
    symbols,
    store: { get(key) { return key === 'sliceIndex' ? slice : null; } },
    codeRegion() { return { id: 'text' }; },
  };

  const binding = captureAnalysisBinding(app);
  assert.equal(analysisBindingCurrent(app, binding), true, '#4363: valid binding matches current app state');

  // Corrupt generation types to structured / string values
  app.backend.gen = ['1'];
  assert.equal(analysisBindingCurrent(app, binding), false, '#4363: array backend.gen must be stale');
  app.backend.gen = 1;

  slice = '1';
  assert.equal(analysisBindingCurrent(app, binding), false, '#4363: string sliceIndex must be stale');
  slice = 1;

  symbols.gen = ['1'];
  assert.equal(analysisBindingCurrent(app, binding), false, '#4363: array symbols.gen must be stale');
  symbols.gen = 1;

  assert.equal(analysisBindingCurrent(app, binding), true, '#4363: restoring integer values returns true');
  console.log('✔ #4363 analysisBindingCurrent strict integer identity passed');
}

console.log('\nAll analysis-services consolidated regression tests PASSED!');
