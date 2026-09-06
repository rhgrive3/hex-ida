import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../../js/app.js', import.meta.url), 'utf8');
const methodStart = appSource.indexOf('  async ensureFunctions(region, onProgress) {');
const methodEnd = appSource.indexOf('\n  /** Build one global ProgramIndex', methodStart);
assert.ok(methodStart >= 0 && methodEnd > methodStart, 'ensureFunctions source must remain discoverable');
const methodSource = appSource.slice(methodStart, methodEnd);

const EMPTY_INDEX = Symbol('empty-index');
class UnusedSymbolIndex {}
const Harness = new Function(
  'EMPTY_INDEX',
  'SymbolIndex',
  'FUNCTION_DISCOVERY_GLOBAL_CAP',
  `return class Harness {\n${methodSource}\n}`,
)(EMPTY_INDEX, UnusedSymbolIndex, 400_000);

function makeHarness(responses) {
  const app = new Harness();
  const region = { id: 'text', exec: true, section: '__text', fileOffset: 0n, vmAddr: 0n, size: 64n };
  const queue = [...responses];
  let calls = 0;
  app.backend = {
    gen: 1,
    async guessFunctions() {
      calls += 1;
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(app);
      return next;
    },
  };
  app.symbolsReady = null;
  app.symbols = {
    functionCount: 0,
    functionStartsComplete: false,
    functionStartsCapped: false,
    functionDiscovery: null,
    addFunctions(starts) { this.functionCount += starts.length; },
  };
  app.store = { get: (key) => key === 'regions' ? [region] : null };
  app.viewer = { setSymbols() {} };
  app.programRegions = () => [region];
  return { app, region, calls: () => calls };
}

{
  const { app, region, calls } = makeHarness([
    { starts: [0n], complete: false, truncationReason: 'backend-partial' },
    { starts: [4n], complete: true },
  ]);
  await app.ensureFunctions(region);
  assert.equal(app.symbols.functionDiscovery.complete, false);
  assert.equal(calls(), 1);
  await app.ensureFunctions(region);
  assert.equal(calls(), 2, 'incomplete discovery must retry on the same region set');
  assert.equal(app.symbols.functionDiscovery.complete, true);
  assert.equal(app.symbols.functionStartsComplete, true);
  assert.equal(app.symbols.functionCount, 2);
  await app.ensureFunctions(region);
  assert.equal(calls(), 2, 'complete discovery must remain deduplicated');
}

{
  const { app, region, calls } = makeHarness([
    new Error('temporary worker failure'),
    { starts: [0n], complete: true },
  ]);
  await app.ensureFunctions(region);
  assert.equal(app.symbols.functionDiscovery.complete, false);
  assert.match(app.symbols.functionDiscovery.reasons.join('\n'), /function-discovery-failed/);
  await app.ensureFunctions(region);
  assert.equal(calls(), 2, 'failed discovery must retry on the same region set');
  assert.equal(app.symbols.functionStartsComplete, true);
}

{
  const { app, region, calls } = makeHarness([
    { starts: [], complete: false, capped: true, truncationReason: 'result-budget' },
    { starts: [0n], discoveryComplete: true },
  ]);
  await app.ensureFunctions(region);
  assert.equal(app.symbols.functionStartsCapped, true);
  await app.ensureFunctions(region);
  assert.equal(calls(), 2, 'capped discovery must be eligible for a later retry');
  assert.equal(app.symbols.functionStartsComplete, true);
  assert.equal(app.symbols.functionStartsCapped, false);
}

{
  const { app, region, calls } = makeHarness([
    (instance) => {
      instance.backend.gen += 1;
      return { starts: [0n], complete: true };
    },
  ]);
  const result = await app.ensureFunctions(region);
  assert.equal(result, null, 'epoch changes must keep the stale-result guard');
  assert.equal(calls(), 1);
  assert.equal(app.symbols.functionDiscovery, null, 'stale discovery must not publish completion metadata');
  assert.equal(app.symbols.functionCount, 0, 'stale discovery must not add function starts');
}

console.log('issue-4631 app function discovery retry regression: ok');
