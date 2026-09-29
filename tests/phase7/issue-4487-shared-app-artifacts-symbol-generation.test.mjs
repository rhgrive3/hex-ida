import assert from 'node:assert/strict';
import { SymbolIndex } from '../../js/symbols.js';
import { installSharedAppArtifacts } from '../../js/analysis/shared-app-artifacts.js';
import { investigationServiceFor } from '../../js/analysis/investigation-service.js';

console.log('[phase7] running shared ProgramIndex symbol-generation regression for #4487...');

function makeApp(scanProgram, ensureFunctions = async () => {}) {
  const symbols = new SymbolIndex({
    funcs: new BigUint64Array([0x1000n]),
    functionStartsComplete: true,
    regions: [{ id: 'text', vmAddr: 0x1000n, size: 0x100n }],
  });
  const app = {
    backend: { gen: 0, scanProgram },
    ensureFunctions,
    store: { get: () => null },
    programRegions: () => [{ id: 'text', exec: true, size: 0x100n, section: '__text', vmAddr: 0x1000n }],
    symbols,
  };
  return { app, symbols };
}

{
  let scans = 0;
  const { app, symbols } = makeApp((regionId) => {
    scans++;
    return Promise.resolve({ regionId });
  });
  installSharedAppArtifacts(app);

  const first = await app.ensureProgram();
  assert.equal(first.gen, symbols.gen);
  assert.equal(first.functionStartOf(0x1000n), 0x1000n);
  assert.strictEqual(await app.ensureProgram(), first, 'same symbol generation must reuse one ProgramIndex');
  assert.equal(scans, 1);

  symbols.addFunctions([0x1100n], { source: 'objc-runtime', confidence: 1, confirmed: true });
  const nextGeneration = symbols.gen;
  const second = await app.ensureProgram();
  assert.notStrictEqual(second, first, 'symbol refinement must not reuse the previous ProgramIndex');
  assert.equal(second.gen, nextGeneration);
  assert.equal(second.functionStartOf(0x1100n), 0x1100n, 'the refreshed ProgramIndex must observe new function starts');
  assert.equal(scans, 2, 'the generation-keyed producer scans the current generation once');
  assert.strictEqual(await app.ensureProgram(), second);
  assert.equal(scans, 2);

  symbols.rename(0x1000n, 'renamed-main');
  const renamed = await app.ensureProgram();
  assert.notStrictEqual(renamed, second, 'rename generation changes must invalidate the projection');
  assert.equal(renamed.gen, symbols.gen);
  assert.equal(scans, 3);
}

{
  let scans = 0;
  let discoveryRuns = 0;
  const { app, symbols } = makeApp(
    (regionId) => {
      scans++;
      return Promise.resolve({ regionId });
    },
    async () => {
      discoveryRuns++;
      symbols.addFunctions([0x1100n], { source: 'mandatory-discovery', confidence: 1, confirmed: true });
    },
  );
  installSharedAppArtifacts(app);

  const first = await app.ensureProgram();
  assert.equal(discoveryRuns, 1);
  assert.equal(first.gen, symbols.gen, 'the first projection must use the post-discovery generation');
  assert.equal(first.functionStartOf(0x1100n), 0x1100n);
  assert.equal(scans, 1);
  assert.strictEqual(await app.ensureProgram(), first, 'the post-discovery generation must be reusable');
  assert.equal(scans, 1);
}

{
  let scans = 0;
  let discoveryRuns = 0;
  const { app, symbols } = makeApp(
    (regionId) => {
      scans++;
      return Promise.resolve({ regionId });
    },
    async () => {
      discoveryRuns++;
      await Promise.resolve();
      symbols.addFunctions([0x1150n], { source: 'mandatory-async-discovery', confidence: 1, confirmed: true });
    },
  );
  installSharedAppArtifacts(app);

  const first = await app.ensureProgram();
  assert.equal(discoveryRuns, 1);
  assert.equal(first.gen, symbols.gen, 'async discovery generation must be adopted before program scanning');
  assert.equal(first.functionStartOf(0x1150n), 0x1150n);
  assert.equal(scans, 1);
  assert.strictEqual(await app.ensureProgram(), first, 'async post-discovery generation must remain reusable');
  assert.equal(scans, 1);
}

{
  let release;
  let scans = 0;
  const firstScan = new Promise((resolve) => { release = resolve; });
  const { app, symbols } = makeApp((regionId) => {
    scans++;
    return scans === 1 ? firstScan.then(() => ({ regionId })) : Promise.resolve({ regionId });
  });
  installSharedAppArtifacts(app);

  const stale = app.ensureProgram();
  symbols.addFunctions([0x1200n], { source: 'swift-metadata', confidence: 1, confirmed: true });
  const current = app.ensureProgram();
  release();

  await assert.rejects(stale, /stale shared program symbols/);
  const refreshed = await current;
  assert.equal(refreshed.gen, symbols.gen);
  assert.equal(refreshed.functionStartOf(0x1200n), 0x1200n);
  assert.equal(scans, 2, 'the stale generation must not publish or satisfy the current generation');
}

{
  let release;
  let markStarted;
  let scans = 0;
  const firstScan = new Promise((resolve) => { release = resolve; });
  const scanStarted = new Promise((resolve) => { markStarted = resolve; });
  const { app, symbols } = makeApp((regionId) => {
    scans++;
    if (scans === 1) markStarted();
    return scans === 1 ? firstScan.then(() => ({ regionId })) : Promise.resolve({ regionId });
  });
  installSharedAppArtifacts(app);

  const investigationProgram = investigationServiceFor(app).buildProgram();
  await scanStarted;
  symbols.addFunctions([0x1300n], { source: 'background-refinement', confidence: 1, confirmed: true });
  release();

  const refreshed = await investigationProgram;
  assert.equal(refreshed.gen, symbols.gen, 'investigation must transparently rebind to the newest symbol generation');
  assert.equal(refreshed.functionStartOf(0x1300n), 0x1300n);
  assert.equal(scans, 2, 'investigation retries the stale program scan exactly once after one refinement');
}

console.log('  ok #4487 shared ProgramIndex symbol-generation regression passed');
