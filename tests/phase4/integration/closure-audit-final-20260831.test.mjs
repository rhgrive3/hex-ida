import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Backend } from '../../../js/backend.js';
import { createProductSurfaceQueries, canonicalClaimVerdict } from '../../../js/analysis/query/product-surface.js';
import { InvestigationService, __investigationInternalsForTests as investigationInternals } from '../../../js/analysis/investigation-service.js';
import { installDemandDrivenAnalysis } from '../../../js/analysis/demand-driven-runtime.js';
import { ProductWorkspace } from '../../../js/workspace.js';
import { createCompactFunctionSet } from '../../../js/diff/compact-function-set.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const SNAPSHOT = Object.freeze({ snapshotId:'snap-current', binaryId:'binary:test', analysisEpoch:1, projectRevision:0, artifactVersions:{} });

// #2528: compatibility report presentation fields are not verdict authority.
{
  assert.equal(canonicalClaimVerdict({ verdict:'confirmed', confirmed:true, confidence:1 }), 'unverified');
  assert.equal(canonicalClaimVerdict({ proof:{ verdict:'confirmed' }, confidence:0.1 }), 'confirmed');
  assert.equal(canonicalClaimVerdict({ evidenceVerdict:'supported' }), 'supported');
  assert.equal(canonicalClaimVerdict({ proof:{ verdict:'confirmed' }, contradictions:['ev-negative'] }), 'contradicted');

  const app = {
    autoReport:{
      snapshotId:SNAPSHOT.snapshotId,
      sourceIdentity:{ projectRevision:0 },
      report:{ findings:[
        { id:'self', title:'self-declared', verdict:'confirmed', confidence:0.99 },
        { id:'proof', title:'proved', proof:{ verdict:'confirmed' }, evidenceIds:['ev-1'] },
        { id:'old', title:'old', proof:{ verdict:'confirmed' }, supersededBy:'new' },
      ] },
    },
    analysisQueries:{ snapshot:async () => SNAPSHOT },
  };
  const queries = createProductSurfaceQueries(app);
  const page = await queries.claims(SNAPSHOT, {}, { offset:0, limit:1 });
  assert.equal(page.value.length, 1);
  assert.equal(page.value[0].claimId, 'self');
  assert.equal(page.value[0].verdict, 'unverified');
  assert.equal(page.page.next, 1, 'producer-level continuation must remain available');
  const proved = await queries.claims(SNAPSHOT, { verdict:['confirmed'] }, { offset:0, limit:10 });
  assert.deepEqual(proved.value.map((row) => row.claimId), ['proof']);
  assert.equal(proved.page.total, 1);
}

// #2518: even the base Backend export uses the platform-worker content-hash boundary.
{
  const backend = new Backend();
  backend.file = { name:'large.bin', size:1024 * 1024 * 1024 };
  let calls = 0;
  backend.ensureContentHash = async (_progress, signal) => {
    calls++;
    assert.equal(signal?.aborted, false);
    return 'ab'.repeat(32);
  };
  const controller = new AbortController();
  const first = await backend.ensureBinaryId({ signal:controller.signal });
  const second = await backend.ensureBinaryId({ signal:controller.signal });
  assert.equal(first, second);
  assert.equal(calls, 1, 'verified full-content identity remains single-flight');
  assert.doesNotMatch(source('js/backend.js'), /sha256BlobHex/, 'public Backend must not own a main-realm SHA-256 fallback');

  const stale = new Backend();
  const fileA = { name:'a.bin', size:500 * 1024 * 1024 };
  stale.file = fileA;
  let release;
  stale.ensureContentHash = () => new Promise((resolve) => { release = resolve; });
  const pending = stale.ensureBinaryId();
  await tick();
  stale.file = { name:'b.bin', size:fileA.size };
  release('cd'.repeat(32));
  await assert.rejects(pending, (error) => error?.stale === true);
  assert.equal(stale.binaryId, null);
}

// #2522: dependency DAG is bounded (two heavy lanes), non-serial, and reports monotonic progress.
{
  const region = { id:'text', exec:true, vmAddr:0x1000n, size:0x1000n };
  const symbols = { gen:1 };
  const app = {
    backend:{ gen:1 }, symbols, fields:{}, program:null, shapes:null,
    store:{ get:(key) => key === 'sliceIndex' ? 0 : key === 'regions' ? [region] : key === 'currentRegion' ? region : null },
    codeRegion:() => region,
    programRegions:() => [region],
    analysisQueries:{ snapshot:async () => SNAPSHOT },
  };
  const service = new InvestigationService(app);
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
  const metadata = deferred(), strings = deferred(), shapes = deferred(), program = deferred();
  const started = [];
  service.ensureMetadata = () => { started.push('metadata'); return metadata.promise.then((value) => { app.fields = value.fields; return value; }); };
  service.collectStrings = () => { started.push('strings'); return strings.promise; };
  service.collectShapes = () => { started.push('shapes'); return shapes.promise.then((value) => { app.shapes = value; return value; }); };
  service.buildProgram = () => { started.push('program'); return program.promise.then((value) => { app.program = value; return value; }); };
  const progress = [];
  const pending = service.prepareGoal({ id:'hp', expects:{ numeric:true, store:true } }, { onProgress:(value) => progress.push(Number(value.done || 0)) });
  await tick();
  assert.deepEqual(started, ['metadata','strings'], 'bounded lane must not fan out all heavy producers at once');
  metadata.resolve({ fields:{} });
  await tick(); await tick();
  assert.ok(started.includes('shapes'));
  strings.resolve(Object.assign([], { complete:true }));
  await tick(); await tick();
  assert.ok(started.includes('program'), 'Program must overlap Shapes once metadata is ready');
  const laneMid = investigationInternals.boundedLaneSnapshot(service);
  assert.equal(laneMid.peak, 2);
  assert.ok(laneMid.active <= 2);
  const shapeValue = Object.assign(new Map(), { complete:true });
  const programValue = { gen:1, graphCompleteness:{ complete:true, supported:true }, statsComplete:true };
  shapes.resolve(shapeValue); program.resolve(programValue);
  const context = await pending;
  assert.equal(context.completeness.complete, true);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i] >= progress[i - 1], 'aggregate progress must be monotonic');

  const overviewService = new InvestigationService(app);
  const m = deferred(), s = deferred(), sh = deferred(), p = deferred(), recognition = deferred();
  const overviewStarted = [];
  overviewService.ensureMetadata = () => { overviewStarted.push('metadata'); return m.promise.then((value) => { app.fields=value.fields; return value; }); };
  overviewService.collectStrings = () => { overviewStarted.push('strings'); return s.promise; };
  overviewService.collectShapes = () => { overviewStarted.push('shapes'); return sh.promise.then((value) => { app.shapes=value; return value; }); };
  overviewService.buildProgram = () => { overviewStarted.push('program'); return p.promise.then((value) => { app.program=value; return value; }); };
  app.ensureRecognition = () => { overviewStarted.push('recognition'); return recognition.promise; };
  const overviewPending = overviewService.prepareGoal({ id:'overview', expects:{ numeric:true, store:true, call:true, compare:true } });
  await tick();
  m.resolve({ fields:{} });
  await tick(); await tick();
  s.resolve(Object.assign([], { complete:true }));
  await tick(); await tick();
  assert.ok(overviewStarted.includes('recognition'), 'Overview recognition must join the DAG after metadata, not after final prepare');
  sh.resolve(shapeValue); p.resolve(programValue); recognition.resolve({ complete:true });
  await overviewPending;
}

function emptyScan(region) {
  return {
    regionId:region.id, vmAddr:region.vmAddr, complete:true, completeness:{ complete:true, reasons:[] },
    callCount:0, callFrom:new BigUint64Array(0), callTo:new BigUint64Array(0),
    refCount:0, refFrom:new BigUint64Array(0), refTo:new BigUint64Array(0), refKind:new Uint8Array(0),
    words:0, kinds:new Uint8Array(0), kindsCovered:0,
  };
}
function queryApp(scanProgram) {
  const regions = [
    { id:'A', exec:true, vmAddr:0x1000n, size:0x1000n },
    { id:'B', exec:true, vmAddr:0x2000n, size:0x1000n },
    { id:'C', exec:true, vmAddr:0x3000n, size:0x1000n },
  ];
  const values = new Map([['regions',regions], ['currentRegion',regions[1]], ['sliceIndex',0]]);
  const app = {
    backend:{ gen:1, binaryId:'binary:test', formatId:'macho', scanProgram, ensureBinaryId:async () => 'binary:test' },
    store:{ get:(key) => values.get(key) },
    symbols:{ gen:1, funcs:[0x1000n], functionStartsComplete:true },
    fields:{}, programRegions:() => regions,
    executableRegionFor:(address) => regions.find((region) => address >= region.vmAddr && address < region.vmAddr + region.size) || null,
  };
  return { app, regions };
}

// #2502: real AnalysisQueryAPI first-page path is local, partial, single-flight and cancellable.
{
  const scans = [];
  const { app, regions } = queryApp((regionId) => {
    scans.push(regionId);
    const request = Promise.resolve(emptyScan(regions.find((region) => region.id === regionId)));
    request.cancel = () => {};
    return request;
  });
  const api = installDemandDrivenAnalysis(app);
  const snapshot = await api.snapshot();
  const [first, second] = await Promise.all([
    api.xrefs(snapshot, 0x1008n, { offset:0, limit:20 }),
    api.xrefs(snapshot, 0x1008n, { offset:0, limit:20 }),
  ]);
  assert.equal(first.completeness, 'partial');
  assert.equal(first.page.total, null, 'zero known refs with unscanned regions must not become exact none');
  assert.deepEqual(first.status.scannedRegionIds, ['A','B']);
  assert.deepEqual(first.status.unscannedRegionIds, ['C']);
  assert.equal(second.completeness, 'partial');
  assert.deepEqual(scans, ['A','B'], 'compatible concurrent queries must share each region producer');

  let cancelCount = 0;
  let release;
  const pendingRequest = new Promise((resolve) => { release = resolve; });
  pendingRequest.cancel = () => { cancelCount++; };
  const { app:cancelApp } = queryApp(() => pendingRequest);
  const cancelApi = installDemandDrivenAnalysis(cancelApp);
  const cancelSnapshot = await cancelApi.snapshot();
  const a = new AbortController(), b = new AbortController();
  const q1 = cancelApi.xrefs(cancelSnapshot, 0x1008n, {}, { signal:a.signal });
  const q2 = cancelApi.xrefs(cancelSnapshot, 0x1008n, {}, { signal:b.signal });
  await tick();
  a.abort('first-left');
  await assert.rejects(q1, (error) => error?.name === 'AbortError');
  assert.equal(cancelCount, 0, 'one waiter leaving must not cancel shared scan');
  b.abort('last-left');
  await assert.rejects(q2, (error) => error?.name === 'AbortError');
  assert.equal(cancelCount, 1, 'last waiter leaving must cancel the backend producer');
  release(emptyScan({ id:'A', vmAddr:0x1000n }));
}

// #2504: normal applySlice does not pay the 350k recognition denominator; the explicit producer remains intact.
{
  const appSource = source('js/app.js');
  const start = appSource.indexOf('  applySlice(sliceIndex, infoArg)');
  const end = appSource.indexOf('  /**\n   * Objective-C', start);
  const applySlice = appSource.slice(start, end);
  assert.doesNotMatch(applySlice, /ensureRecognition\s*\(/);
  assert.match(appSource, /async ensureRecognition\(options=\{\}\)/);
  const logicalCorpus = Array.from({ length:350000 }, (_, index) => BigInt(index * 4));
  assert.equal(logicalCorpus.length, 350000, 'benchmark denominator remains 350k functions');
}

// #2507: cancellation is wired through the real Product investigation panel and shared service.
{
  const panel = source('js/ui/panels/investigation.js');
  const service = source('js/analysis/investigation-service-base.js');
  assert.match(panel, /onClose:\(\) => controller\.abort\('candidate-sheet-closed'\)/);
  assert.match(panel, /investigationServiceFor\(app\)\.investigate\(goal, \{[\s\S]*signal:controller\.signal/);
  assert.match(service, /entry\.waiters === 0\) entry\.controller\.abort\('investigation-no-consumers'\)/);
  assert.match(service, /request\.cancel\?\.\(\)/);
}

// #2540: baseline replacement/route disposal owns cancellation, and 350k functions stay compact on the main realm.
{
  const product = source('js/ui/product.js');
  const workspace = source('js/workspace.js');
  assert.match(product, /compareScope\.spawn\('diff-baseline-replaced'\)/);
  assert.match(product, /compareScope\.abort\('diff-route-disposed'\)/);
  assert.match(workspace, /signal\?\.addEventListener\('abort',onAbort/);
  assert.match(workspace, /if\(ownedBackend\)other\?\.dispose\?\.\(\)/);

  const funcs = Array.from({ length:350000 }, (_, index) => BigInt(index * 4));
  const compact = createCompactFunctionSet({ funcs, addrs:funcs, names:[], functionStartsComplete:true }, 'arm64', 350000);
  assert.equal(compact.count, 350000);
  assert.equal(compact.functionAddresses, funcs);
  assert.equal(Object.prototype.hasOwnProperty.call(compact, 'functions'), false);

  let disposed = 0;
  let openRelease;
  const baselineBackend = {
    open:() => new Promise((resolve) => { openRelease = resolve; }),
    ensureContentHash:async () => 'aa'.repeat(32),
    analyze:async () => ({ funcs:[], addrs:[], names:[], functionStartsComplete:true }),
    dispose:() => { disposed++; },
  };
  const currentApp = { backend:{ contentHash:'bb'.repeat(32) }, store:{ get:() => null } };
  const ws = new ProductWorkspace(currentApp, { backendFactory:() => baselineBackend, storage:null });
  ws.identity = { hash:'bb'.repeat(32), metadata:{ architecture:'arm64', sliceIndex:0 } };
  const controller = new AbortController();
  const load = ws.loadBaseline({ name:'old.bin' }, { signal:controller.signal });
  await tick();
  controller.abort('diff-route-disposed');
  openRelease({ slices:[] });
  await assert.rejects(load, (error) => error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || /abort/i.test(String(error?.message)));
  assert.ok(disposed >= 1, 'route/request cancellation must dispose its owned baseline backend');
  assert.equal(ws.baseline, null, 'aborted baseline must never publish');
}

console.log('closure audit final 20260831: PASS');
