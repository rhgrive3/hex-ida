import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createLazyAppAnalysisQueryAPI } from '../../../js/analysis/query/lazy-app-adapter.js';

const ROOT = path.resolve(new URL('../../../', import.meta.url).pathname);
const readSource = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function staticImports(rel) {
  const src = readSource(rel);
  const out = [];
  const from = /(?:import|export)\s+[^;]*?\bfrom\s+['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = from.exec(src))) out.push(m[1]);
  const bare = /import\s+['"](\.[^'"]+)['"]/g;
  while ((m = bare.exec(src))) out.push(m[1]);
  return out;
}

function staticGraph(entry) {
  const seen = new Set();
  const walk = (rel) => {
    const resolved = path.resolve(ROOT, rel);
    const relative = path.relative(ROOT, resolved);
    if (seen.has(resolved) || !fs.existsSync(resolved)) return;
    seen.add(resolved);
    for (const imp of staticImports(relative)) {
      walk(path.join(path.dirname(relative), imp));
    }
  };
  walk(entry);
  return new Set([...seen].map((f) => path.relative(ROOT, f)));
}

// 1. #8712 ingress: the startup graph of js/app.js must not statically reach
// the product-evidence adapter chain (the #2622 forbidden modules).
const appGraph = staticGraph('js/app.js');
assert.ok(!appGraph.has('js/analysis/query/product-evidence-adapter.js'),
  'product-evidence adapter must stay behind the demand boundary at startup');
assert.ok(!appGraph.has('js/analysis/query/index.js'),
  'app.js must not import the heavy AnalysisQuery barrel at startup');
for (const forbidden of [
  'js/emu.js', 'js/decompile.js', 'js/decompile-base.js', 'js/decompile-legacy.js',
  'js/semantic.js', 'js/dataflow-semantic.js', 'js/targets/architecture/index.js',
  'js/runtime/app-runtime.js', 'js/adapters/index.js',
]) {
  assert.ok(!appGraph.has(forbidden), `${forbidden} must not be in the startup module graph`);
}
assert.ok(appGraph.has('js/analysis/query/lazy-app-adapter.js'),
  'the lazy boundary itself is what app.js imports');
assert.ok(appGraph.has('js/analysis/query/api.js'),
  'the lightweight query contract stays available at startup');
assert.ok(appGraph.size < 150, `startup graph should stay bounded, got ${appGraph.size}`);

// The demand boundary itself must not statically re-import what it defers.
const lazyGraph = staticGraph('js/analysis/query/lazy-app-adapter.js');
assert.ok(!lazyGraph.has('js/analysis/query/product-evidence-adapter.js'),
  'lazy-app-adapter.js must keep the product-evidence edge dynamic only');

// 2. The barrel keeps its historical exports; #8712 moves the app edge, it
// does not remove the public surface other owners import (issue-2519 audits
// the barrel text itself).
assert.match(readSource('js/analysis/query/index.js'),
  /export \{ createAppAnalysisQueryAdapter \} from "\.\/product-evidence-adapter\.js";/);

// 3. Demand semantics: nothing loads at construction; the first awaited query
// loads exactly once; later calls reuse the constructed API and forward the
// method name and arguments through the real AnalysisQueryAPI.
const identity = { binaryId: 'binary-8712', projectRevision: 0, analysisEpoch: 0, artifactVersions: {} };
const calls = [];
let loads = 0;
const adapter = {
  currentIdentity: async () => identity,
  binaryInfo: async (pinned) => { calls.push(['binaryInfo', pinned.binaryId]); return { value: { ok: true } }; },
  instructions: async (pinned, range, page, options) => {
    calls.push(['instructions', pinned.binaryId, range, page, { signal: options?.signal ?? null }]);
    return { value: [] };
  },
};
const api = createLazyAppAnalysisQueryAPI({ id: 'app-under-test' }, async (app) => {
  loads += 1;
  assert.equal(app.id, 'app-under-test', 'the lazy boundary binds the owning App at first load');
  return adapter;
});
assert.ok(api instanceof AnalysisQueryAPI, 'the facade keeps the AnalysisQueryAPI identity');
assert.equal(api.then, undefined, 'the facade must never look thenable');
assert.equal(loads, 0, 'construction must not import the adapter implementation');
const snapshot = await api.snapshot();
assert.equal(snapshot.binaryId, identity.binaryId);
assert.equal(loads, 1);
await api.binaryInfo(snapshot);
await api.instructions(snapshot, { start: 0x1000n, end: 0x1004n }, { limit: 10 }, {});
assert.equal(loads, 1, 'first capability use loads the implementation once');
assert.deepEqual(calls.map((row) => row[0]), ['binaryInfo', 'instructions']);
assert.equal(calls[1][2].start, 0x1000n, 'query arguments forward through the boundary');

// 4. A real load failure is surfaced to the first query and memoized: later
// queries see the same error without re-importing.
let attempts = 0;
const failing = createLazyAppAnalysisQueryAPI(null, async () => {
  attempts += 1;
  throw new Error('adapter-load-failed-8712');
});
await assert.rejects(failing.snapshot(), /adapter-load-failed-8712/);
await assert.rejects(failing.snapshot(), /adapter-load-failed-8712/);
assert.equal(attempts, 1, 'a failed demand load must not silently retry the import');

// 5. An adapter missing the required identity method is still rejected by the
// real AnalysisQueryAPI constructor semantics (#8712 must not weaken the API).
const invalid = createLazyAppAnalysisQueryAPI(null, async () => ({}));
await assert.rejects(invalid.snapshot(), /analysis-query-adapter-required/);

console.log('issue-8712 startup product-evidence lazy boundary: OK');
