import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMachOSource, clearMachOSourceCache } from '../../../js/binary/index.js';
import { makeFatMachOFixture } from '../../universal-binary.mjs';
import { __demandDrivenInternalsForTests } from '../../../js/analysis/demand-driven-runtime.js';
import { __investigationInternalsForTests } from '../../../js/analysis/investigation-service.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = (name) => fs.readFileSync(path.join(root, name), 'utf8');

class SpySource {
  constructor(bytes) { this.bytes = bytes; this.size = BigInt(bytes.length); this.reads = []; }
  async read(offset, length) {
    this.reads.push({ offset:BigInt(offset), length });
    const start = Number(offset);
    return this.bytes.subarray(start, start + length);
  }
}

async function testMachOSelectedSliceSingleFlight() {
  const spy = new SpySource(makeFatMachOFixture());
  const options = { sliceIndex:0, ranges:{ pageSize:128, maxPageSize:1024, maxCachedBytes:2 * 1024 * 1024, maxReads:4096 } };
  clearMachOSourceCache(spy);
  const first = await parseMachOSource(spy, options);
  const readsAfterFirst = spy.reads.length;
  assert.ok(readsAfterFirst > 0, 'first selected-slice parse must read source bytes');
  const second = await parseMachOSource(spy, options);
  assert.equal(second, first, 'same source/slice must reuse the immutable BinaryImage artifact');
  assert.equal(spy.reads.length, readsAfterFirst, 'cached selected slice must not re-read source bytes');
}

function testRecognitionInputIdentity() {
  const app = { backend:{ gen:3 }, symbols:{ gen:7 }, fields:{}, objcModel:{}, swiftModel:{} };
  const before = __demandDrivenInternalsForTests.recognitionInputKey(app);
  app.fields = {};
  const after = __demandDrivenInternalsForTests.recognitionInputKey(app);
  assert.notEqual(after, before, 'FieldIndex generation/object replacement must invalidate recognition identity');
}

function testInvestigationDependencyPlan() {
  assert.equal(__investigationInternalsForTests.needsShapeEvidence({ id:'network', expects:{ call:true } }), false);
  assert.equal(__investigationInternalsForTests.needsShapeEvidence({ id:'hp', expects:{ numeric:true, store:true } }), true);
}

function testCanonicalWiring() {
  const panels = source('js/panels.js');
  assert.match(panels, /showSearch.*ui\/panels\/search\.js/s, 'Search must use canonical typed panel');
  assert.match(panels, /showCandidates, showOverview.*ui\/panels\/investigation\.js/s, 'Investigate/Overview must use typed service panel');

  const runtime = source('js/analysis/demand-driven-runtime.js');
  assert.match(runtime, /scope:'active-neighborhood'/, 'local xref/caller query must advertise partial neighborhood scope');
  assert.match(runtime, /request\.cancel\?\.\(\)/, 'AbortSignal must reach cancellable backend requests');
  assert.match(runtime, /executableRegions\(app\)/, 'shape producer must enumerate executable regions');
  assert.match(runtime, /scheduleBackgroundIdentity\(options\.signal\)/, 'content identity must be scheduled behind interactive work');
  assert.match(runtime, /ensureContentHash\(options\.onProgress, options\.signal/, 'BinaryId must reuse worker-backed content hashing');
  assert.match(runtime, /RECOGNITION_INPUTS_CHANGED/, 'recognition must reject publication after input-version races');
  assert.match(runtime, /function installCancellableFunctionDiscovery\(app\)/, 'function discovery must have one runtime owner');
  assert.match(runtime, /entry\.request\.cancel\?\.\(\)/, 'last discovery waiter must cancel its producer');
  assert.match(runtime, /const key = recognitionInputKey\(app\)[\s\S]*const after = recognitionInputKey\(app\)[\s\S]*after === key/,
    'recognition must publish only when start/end input identity matches');

  const service = source('js/analysis/investigation-service.js');
  assert.match(service, /const programP = metadataP\.then\(\(\) => this\.buildProgram\(options\)\)/,
    'Program/function discovery must wait for required metadata');
  assert.match(service, /Promise\.all\(\[stringsP, programP, shapesP\]\)/,
    'independent producers must remain parallel after dependency ordering');
  assert.match(service, /discoverFunctions\(options = \{\}\)/, 'Investigation must preserve function-discovery denominator');
  assert.doesNotMatch(service, /backend\.guessFunctions/, 'Investigation must not create a second function-discovery producer');
  assert.match(service, /return this\.app\.ensureFunctions\(region/, 'Investigation must reuse the canonical discovery owner');
  assert.match(service, /await this\.discoverFunctions\(\{ \.\.\.options, signal \}\)/, 'program scan must reuse cancellable discovery');
  assert.match(service, /analysisQueries\.snapshot/, 'investigation result must bind to one AnalysisSnapshot');
  assert.match(service, /analysisQueries\.binaryInfo\(context\.snapshot/, 'snapshot must be revalidated before publication');
  assert.match(service, /entry\.waiters === 0.*controller\.abort/s, 'shared producer cancels only after last consumer detaches');

  const explorer = source('js/ui/explorer-index.js');
  assert.doesNotMatch(explorer, /new WeakMap\(\).*function/s, 'function search must not own a frontend-private whole-function index');
  assert.match(explorer, /analysisQueries\.functions/, 'function search must use AnalysisQueryAPI');

  const product = source('js/ui/product.js');
  assert.doesNotMatch(product, /function functionSource\(app\)/, 'Product Explorer must not keep a direct recognition/symbol function source');
  assert.match(product, /async function matchingFunctionItems[\s\S]*return queryFunctions\(app, q, options\);/,
    'empty and filtered Product function views must share the canonical query path');

  const search = source('js/ui/panels/search.js');
  assert.match(search, /analysisQueries\.search/, 'standard Search panel must use AnalysisQueryAPI.search');
  assert.match(search, /controller\.abort\('search-sheet-closed'\)/, 'Search close must abort its consumer');

  for (const name of [
    'patch-product-explorer-2505.yml',
    'one-shot-function-discovery-owner.yml',
    'one-shot-investigation-dag.yml',
    'one-shot-fix-investigation-dag.yml',
  ]) {
    assert.equal(fs.existsSync(path.join(root, '.github/workflows', name)), false,
      `${name} must not ship in the final branch`);
  }
}

await testMachOSelectedSliceSingleFlight();
testRecognitionInputIdentity();
testInvestigationDependencyPlan();
testCanonicalWiring();
console.log('issues-2502-2522-demand-analysis: PASS');
