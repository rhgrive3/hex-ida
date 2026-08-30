import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSharedAppArtifacts, __sharedAppArtifactInternalsForTests } from '../js/analysis/shared-app-artifacts.js';
import { globalReferenceStats } from '../js/analysis/global-ref-stats.js';
import { recoverSchemasForUi, clearSchemaRecoveryTasks } from '../js/analysis/schema-recovery-task.js';
import { installAutoReportIdentityBoundary } from '../js/analysis/auto-report-identity.js';
import { createSymmetricCodeFunctionSet, SYMMETRIC_CODE_PROFILE } from '../js/diff/symmetric-function-set.js';
import { __symmetricWorkspaceInternalsForTests } from '../js/diff/symmetric-workspace-runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

{
  const dataRegion = { id:'data', name:'__data', section:'__data', vmAddr:0x2000n, size:0x100n, exec:false };
  const ranges = [{ region:dataRegion, lo:0x2000n, hi:0x2100n }];
  const counts = new Map();
  const scan = {
    refCount:4,
    refFrom:new BigUint64Array([0x1000n,0x1004n,0x1008n,0x100cn]),
    refTo:new BigUint64Array([0x2008n,0x2008n,0x3000n,0x200cn]),
    refKind:new Uint8Array([1,1,1,1]),
  };
  const scanned = await __sharedAppArtifactInternalsForTests.accumulateGlobalRefs(counts, scan, ranges);
  assert.equal(scanned, 4);
  assert.equal(counts.get(String(0x2008n)).refs, 2);
  assert.equal(counts.get(String(0x200cn)).refs, 1);
  assert.equal(counts.has(String(0x3000n)), false);

  const derived = { counts, scannedRefs:4, complete:true, reason:null, producer:'program-region-ref-aggregate/v1' };
  const program = { globalReferenceStats:derived };
  Object.defineProperty(program, 'refTo', { get() { throw new Error('globalReferenceStats must not re-scan ProgramIndex refs'); } });
  assert.equal(await globalReferenceStats(program, []), derived);
}

{
  // A large ref aggregate must yield often enough for cancellation to run instead
  // of pinning the main realm until the whole reference set has been counted.
  const total = 50_000;
  const dataRegion = { id:'data', section:'__data', vmAddr:0x2000n, size:0x100n, exec:false };
  const ranges = [{ region:dataRegion, lo:0x2000n, hi:0x2100n }];
  const scan = {
    refCount:total,
    refFrom:new BigUint64Array(total),
    refTo:new BigUint64Array(total).fill(0x2008n),
    refKind:new Uint8Array(total),
  };
  const controller = new AbortController();
  const work = __sharedAppArtifactInternalsForTests.accumulateGlobalRefs(new Map(), scan, ranges, {
    signal:controller.signal,
    yieldEvery:1024,
  });
  setTimeout(() => controller.abort('aggregate-cancelled'), 0);
  await assert.rejects(work, (error) => error?.name === 'AbortError');
}

{
  let cancelCount = 0;
  let scanStarted = false;
  let functionOptions = null;
  let scanLimits = null;
  const pendingScan = new Promise(() => {});
  pendingScan.cancel = () => { cancelCount++; };
  const execRegion = { id:'text', section:'__text', vmAddr:0x1000n, size:0x100n, exec:true };
  const dataRegion = { id:'data', section:'__data', vmAddr:0x2000n, size:0x100n, exec:false };
  const store = new Map([
    ['regions',[execRegion,dataRegion]],
    ['currentRegion',execRegion],
    ['architecture','arm64'],
  ]);
  const symbols = { gen:7, functionStartsComplete:true, functionCount:0 };
  const producerBudget = { maxSchemas:123 };
  const app = {
    backend:{
      gen:3,
      scanProgram(_id, _progress, limits) { scanStarted = true; scanLimits = limits; return pendingScan; },
      strings() { throw new Error('not used'); },
    },
    store:{ get:(key) => store.get(key) },
    symbols,
    programRegions:() => [execRegion],
    ensureFunctions:async (_region, options) => { functionOptions = options; return symbols; },
  };
  installSharedAppArtifacts(app);
  const first = new AbortController();
  const second = new AbortController();
  const p1 = app.ensureProgram({ signal:first.signal, priority:'interactive', budget:producerBudget });
  const p2 = app.ensureProgram({ signal:second.signal });
  await tick();
  assert.equal(scanStarted, true);
  assert.equal(functionOptions.priority, 'interactive');
  assert.equal(functionOptions.budget, producerBudget);
  assert.equal(scanLimits.analysisPriority, 'interactive');
  first.abort('first-consumer-left');
  await assert.rejects(p1, (error) => error?.name === 'AbortError');
  assert.equal(cancelCount, 0, 'shared producer must survive while another consumer remains');
  second.abort('last-consumer-left');
  await assert.rejects(p2, (error) => error?.name === 'AbortError');
  await tick();
  assert.equal(cancelCount, 1, 'last consumer must cancel the backend producer exactly once');
}

{
  const seen = {};
  const strings = [];
  Object.assign(strings, { complete:true });
  const budget = { maxSchemas:123 };
  const app = {
    backend:{ gen:11 },
    ensureStrings:async (options) => { seen.strings = options; return strings; },
    ensureProgram:async (options) => { seen.program = options; return null; },
    store:{ get:() => null },
  };
  const controller = new AbortController();
  const schemas = await recoverSchemasForUi(app, { signal:controller.signal, priority:'interactive', budget });
  assert.equal(seen.strings.signal, seen.program.signal);
  assert.equal(seen.strings.priority, 'interactive');
  assert.equal(seen.program.priority, 'interactive');
  assert.equal(seen.strings.budget, budget);
  assert.equal(seen.program.budget, budget);
  assert.equal(schemas.complete, false);
  assert.equal(schemas.incompleteReason, 'program-partial');
  clearSchemaRecoveryTasks(app);
}

{
  const values = new Map([['sliceIndex',0], ['fileInfo',{ binaryId:'bin-a' }]]);
  let currentSnapshotId = 'snapshot-a';
  const app = {
    backend:{ gen:4, binaryId:'bin-a' },
    store:{ get:(key) => values.get(key) },
    workspace:{ bindingRevision:2, project:{ revision:9 } },
    analysisQueries:{ snapshot:async () => ({ snapshotId:currentSnapshotId }) },
  };
  installAutoReportIdentityBoundary(app);
  const report = { snapshotId:'snapshot-a', findings:[] };
  app.autoReport = { report, snapshotId:'snapshot-a' };
  await app.analysisQueries.snapshot();
  assert.equal(app.autoReport?.sourceIdentity?.sliceIndex, 0);
  assert.equal(app.autoReport?.sourceIdentity?.projectRevision, 9);

  currentSnapshotId = 'snapshot-b';
  await app.analysisQueries.snapshot();
  assert.equal(app.autoReport, null, 'snapshot change must retire the previous report even when slice/epoch remain stable');
  assert.equal(app.historicalAutoReport?.snapshotId, 'snapshot-a');

  currentSnapshotId = 'snapshot-c';
  await app.analysisQueries.snapshot();
  const frozenReport = Object.freeze({ snapshotId:'snapshot-c', findings:[] });
  assert.doesNotThrow(() => { app.autoReport = { report:frozenReport, snapshotId:'snapshot-c' }; });
  assert.equal(app.autoReport?.snapshotId, 'snapshot-c');

  values.set('sliceIndex', 1);
  assert.equal(app.autoReport, null, 'slice change must retire the previous report from current Results authority');
  assert.equal(app.historicalAutoReport?.snapshotId, 'snapshot-c');

  currentSnapshotId = 'snapshot-d';
  await app.analysisQueries.snapshot();
  app.autoReport = { report:{ snapshotId:'snapshot-d', findings:[] }, restored:true, snapshotId:'snapshot-d' };
  assert.ok(app.autoReport, 'identity-bound restored reports may be shown on the exact current snapshot');
  app.workspace.project.revision = 10;
  assert.equal(app.autoReport, null, 'project revision change must retire stale restored findings');
}

{
  const region = { id:'text', vmAddr:0x1000n, size:8n, exec:true };
  const bytes = new Uint8Array([1,2,3,4,5,6,7,8]);
  const symbols = {
    funcs:[0x1000n,0x1004n],
    functionStartsComplete:true,
    nameAt:(address) => address === 0x1000n ? '_a' : '_b',
  };
  const backend = {
    readAt(address, length) {
      const offset = Number(BigInt(address) - 0x1000n);
      return Promise.resolve({ found:true, bytes:bytes.slice(offset, offset + length) });
    },
  };
  const set = await createSymmetricCodeFunctionSet({ backend, symbols, regions:[region], architecture:'arm64' });
  assert.equal(set.evidenceProfile, SYMMETRIC_CODE_PROFILE);
  assert.equal(set.complete, true);
  assert.equal(set.length, 2);
  assert.ok(set[0].normalizedBytesHash);
  assert.ok(set[1].normalizedBytesHash);
  assert.notEqual(set[0].exactBytesHash, set[1].exactBytesHash);
  assert.equal(set[0].evidenceCompleteness, 'complete');

  const missing = await createSymmetricCodeFunctionSet({
    backend:{ readAt:async () => ({ found:false, bytes:null }) },
    symbols,
    regions:[region],
    architecture:'arm64',
  });
  assert.equal(missing.complete, false);
  assert.equal(missing.truncationReason, 'function-bytes-unavailable');
  assert.ok(missing.every((row) => row.evidenceCompleteness === 'partial'));
}

{
  const input = {
    deleted:[{ before:{ address:1n }, changeType:'deleted' }],
    new:[{ after:{ address:2n }, changeType:'new' }],
    changes:[{ before:{ address:1n }, changeType:'deleted' }, { after:{ address:2n }, changeType:'new' }],
  };
  const result = __symmetricWorkspaceInternalsForTests.demoteIncompleteAbsenceClaims(input, 'incomplete-symmetric-code-evidence');
  assert.equal(result.deleted.length, 0);
  assert.equal(result.new.length, 0);
  assert.equal(result.unresolved.length, 2);
}

{
  const ux = fs.readFileSync(path.join(root, 'js/ux.js'), 'utf8');
  const field = fs.readFileSync(path.join(root, 'js/ui/panels/field-access.js'), 'utf8');
  const globals = fs.readFileSync(path.join(root, 'js/ui/tools/globals.js'), 'utf8');
  const stats = fs.readFileSync(path.join(root, 'js/analysis/global-ref-stats.js'), 'utf8');
  assert.match(ux, /installSharedAppArtifacts\(window\.__app\)/);
  assert.match(ux, /installAutoReportIdentityBoundary\(window\.__app\)/);
  assert.match(ux, /installSymmetricWorkspaceDiff\(window\.__app\)/);
  assert.doesNotMatch(field, /ensureProgram\?\.\(/, 'Field Access must not start a global ProgramIndex just to render partial results');
  assert.match(globals, /ensureProgram\?\.\(\{ signal:controller\.signal/);
  assert.doesNotMatch(stats, /program\.refCount|program\.refTo\[/, 'Globals stats must consume producer aggregate, not re-scan every ref');
}

console.log('close-audit #2520/#2528/#2530/#2543/#2545 regression tests passed');
