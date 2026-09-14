import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const readRepositorySource = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function staticImports(rel, readSource = readRepositorySource) {
  const src = readSource(rel);
  const out = [];
  const from = /(?:import|export)\s+[^;]*?\bfrom\s+['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = from.exec(src))) out.push(m[1]);
  const bare = /import\s+['"](\.[^'"]+)['"]/g;
  while ((m = bare.exec(src))) out.push(m[1]);
  return out;
}

function staticGraph(entry, banned = [], readSource = readRepositorySource) {
  const seen = new Set();
  const walk = (rel) => {
    const resolved = path.resolve(ROOT, rel);
    const relative = path.relative(ROOT, resolved);
    if (seen.has(resolved) || banned.includes(relative)) return;
    seen.add(resolved);
    for (const imp of staticImports(relative, readSource)) {
      walk(path.join(path.dirname(relative), imp));
    }
  };
  walk(entry);
  return new Set([...seen].map((f) => path.relative(ROOT, f)));
}

test('#2622 static graph follows export-from edges without an arbitrary depth cutoff', () => {
  const edges = staticImports('js/ir.js');
  assert.ok(edges.includes('./ir-public-base.js'), 'export * from must count as a static startup edge');
  const graph = staticGraph('js/ir.js');
  assert.ok(graph.has('js/ir-public-base.js'));

  // The old implementation stopped recursively after depth 15. Use an
  // in-memory 18-module re-export chain so this regression fails if that
  // arbitrary cutoff is restored, without adding fixture files to production.
  const sources = new Map();
  for (let index = 0; index < 17; index++) {
    sources.set(`virtual/level-${index}.js`, `export { sentinel } from './level-${index + 1}.js';`);
  }
  sources.set('virtual/level-17.js', 'export const sentinel = true;');
  const deepGraph = staticGraph(
    'virtual/level-0.js',
    [],
    (rel) => sources.get(rel) ?? '',
  );
  assert.equal(deepGraph.size, 18, 'all modules beyond the historical depth-15 cutoff must be traversed');
  assert.ok(deepGraph.has('virtual/level-17.js'), 'terminal dependency beyond depth 15 must be reachable');
});

test('#2622 app.js startup graph excludes optional script/sandbox/plugin feature modules', () => {
  const graph = staticGraph('js/app.js');
  for (const optional of [
    'js/script.js', 'js/sandbox.js', 'js/emu.js', 'js/decompile.js', 'js/decompile-base.js',
    'js/decompile-legacy.js', 'js/tools-base.js', 'js/dataflow.js', 'js/semantic.js',
    'js/auto.js', 'js/pinpoint.js', 'js/analysis/investigation-service.js',
    'js/targets/architecture/index.js',
  ]) {
    assert.ok(!graph.has(optional), `${optional} must not be in the startup module graph`);
  }
  assert.ok(graph.size < 150, `startup graph should stay bounded, got ${graph.size}`);
});

test('#2622 plugins.js keeps script/sandbox behind a dynamic import boundary', () => {
  const source = fs.readFileSync(path.join(ROOT, 'js/plugins.js'), 'utf8');
  assert.doesNotMatch(source, /import\s+\{[^}]*createApi[^}]*\}\s+from\s+'\.\.\/js\/script\.js'|import\s+\{[^}]*createApi[^}]*\}\s+from\s+'\.\/script\.js'/);
  assert.doesNotMatch(source, /import\s+\{[^}]*runInSandbox[^}]*\}\s+from\s+'\.\/sandbox\.js'/);
  assert.match(source, /import\('\.\/script\.js'\)/);
  assert.match(source, /import\('\.\/sandbox\.js'\)/);
  assert.match(source, /await loadScriptSandbox\(\)/);
});

test('#2622 plugin install/run still route through the sandbox with the shared loader', () => {
  const source = fs.readFileSync(path.join(ROOT, 'js/plugins.js'), 'utf8');
  assert.match(source, /const \{ runInSandbox \} = await loadScriptSandbox\(\)/);
  assert.match(source, /const \{ createApi, runInSandbox \} = await loadScriptSandbox\(\)/);
  assert.match(source, /mode: 'discover'/);
  assert.match(source, /mode: 'plugin'/);
});
