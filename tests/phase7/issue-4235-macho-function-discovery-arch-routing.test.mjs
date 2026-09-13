import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { Backend } from '../../js/backend.js';

// Issue #4235: Mach-O function discovery (`guessFunctions`) must be routed by
// the active slice architecture, not by format. The legacy worker is a fixed
// ARM64 prologue/word heuristic scanner; running it over x86_64/RISC-V bytes
// injects false heuristic function starts into SymbolIndex, which downstream
// uses for ranges / call graph / AI evidence. Non-ARM64 must go to the platform
// producer, which returns only exact known seeds with complete:false and never
// promotes exhaustive heuristic discovery.

function machoBackend(architecture) {
  const backend = new Backend();
  backend.formatId = 'macho';
  const routes = [];
  backend._callTo = (worker, t, payload) => {
    routes.push({ worker, t, payload });
    return Promise.resolve(worker === 'platform'
      ? { starts: new BigUint64Array(0), cancelled: false, complete: false, discoveryComplete: false,
          completeness: { complete: false, reasons: ['platform-function-discovery-not-exhaustive'] } }
      : { starts: new BigUint64Array(0), cancelled: false, complete: true });
  };
  if (architecture != null) backend._activeMachArchitecture = architecture;
  return { backend, routes };
}

test('x86_64 Mach-O guessFunctions routes to the platform producer, not the legacy ARM64 scanner (#4235)', async () => {
  const { backend, routes } = machoBackend('x86_64');
  await backend.guessFunctions('text', 100, null);
  assert.equal(routes.at(-1).worker, 'platform', 'non-ARM64 function discovery must not use the ARM64 heuristic scanner');
  assert.equal(routes.at(-1).t, 'guessFunctions');
  backend.dispose();
});

test('riscv64 Mach-O guessFunctions routes to the platform producer (#4235)', async () => {
  const { backend, routes } = machoBackend('riscv64');
  await backend.guessFunctions('text', 100, null);
  assert.equal(routes.at(-1).worker, 'platform');
  backend.dispose();
});

test('arm64 / arm64e / arm64_32 Mach-O guessFunctions keeps the legacy heuristic route (#4235)', async () => {
  for (const architecture of ['arm64', 'arm64e', 'arm64_32']) {
    const { backend, routes } = machoBackend(architecture);
    await backend.guessFunctions('text', 100, null);
    assert.equal(routes.at(-1).worker, 'legacy', `${architecture} must keep the existing legacy ARM64 heuristic discovery`);
    backend.dispose();
  }
});

test('explicit architecture option overrides the active slice and is forwarded to the worker (#4235)', async () => {
  const { backend, routes } = machoBackend(null);
  await backend.guessFunctions('text', 100, null, { architecture: 'X86_64' });
  assert.equal(routes.at(-1).worker, 'platform');
  assert.equal(routes.at(-1).payload.architecture, 'x86_64', 'the chosen architecture is part of the request contract');
  backend.dispose();
});

test('only confirmed ARM64 uses the legacy ARM64 scanner: unknown discovery fails closed to the platform producer (#4235)', async () => {
  const { backend, routes } = machoBackend('unknown');
  await backend.guessFunctions('text', 100, null);
  assert.equal(routes.at(-1).worker, 'platform', 'an unconfirmed architecture must not reach the ARM64 heuristic scanner');
  backend.dispose();
});

test('a Mach-O with no architecture information at all preserves the current legacy route (#4235)', async () => {
  const { backend, routes } = machoBackend(null);
  await backend.guessFunctions('text', 100, null);
  assert.equal(routes.at(-1).worker, 'legacy', 'absence of architecture keeps the established default routing');
  backend.dispose();
});

test('analyze(sliceIndex) records the active Mach-O slice architecture so unmodified callers route correctly (#4235)', async () => {
  const backend = new Backend();
  backend.formatId = 'macho';
  backend.platformInfo = { slices: [{ capability: { architecture: 'arm64' } }, { capability: { architecture: 'x86_64' } }] };
  backend._analyzeCurrent = () => Promise.resolve({});
  backend._analyzeArtifact = () => Promise.resolve({});
  backend._analyzeArtifactPublic = () => Promise.resolve({});
  await backend.analyze(0);
  assert.equal(backend._activeMachArchitecture, 'arm64');
  await backend.analyze(1, { route: 'current' });
  assert.equal(backend._activeMachArchitecture, 'x86_64', 'switching the active slice updates the routing architecture');
  const routes = [];
  backend._callTo = (worker, t, payload) => { routes.push(worker); return Promise.resolve({ starts: new BigUint64Array(0) }); };
  await backend.guessFunctions('text', 100, null);
  assert.equal(routes.at(-1), 'platform', 'the active-slice architecture drives discovery without any caller change');
  backend.dispose();
});

test('App.ensureFunctions does not promote functionStartsComplete from a non-exhaustive platform producer (#4235)', () => {
  const app = fs.readFileSync(new URL('../../js/app.js', import.meta.url), 'utf8');
  // The consumer already separates "exact known seeds" from "exhaustive": it only
  // promotes completeness when discoveryComplete/completeness.complete/complete is
  // true, so a platform complete:false result cannot mark function starts complete.
  assert.match(app, /discoveryComplete===true\s*\|\|\s*res\?\.completeness\?\.complete===true\s*\|\|\s*res\?\.complete===true/);
  assert.match(app, /sym\.functionStartsComplete\s*=\s*complete\b/);
});

test('both consumers use one Backend.guessFunctions route so demand and interactive discovery agree (#4235)', () => {
  const demand = fs.readFileSync(new URL('../../js/analysis/demand-driven-runtime.js', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../../js/app.js', import.meta.url), 'utf8');
  assert.match(demand, /backend\.guessFunctions\(/);
  assert.match(app, /backend\.guessFunctions\(/);
});
